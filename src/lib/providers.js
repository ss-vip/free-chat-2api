export function sanitizeProvider(provider) {
  if (!provider) return provider
  const { api_key, ...rest } = provider
  return { ...rest, api_key_set: !!(api_key && api_key.length) }
}

export function findProviderForModel(providers, model) {
  if (model === 'openai') return providers.filter(p => p.enabled).sort((a, b) => b.priority - a.priority)[0] || null
  const sorted = [...providers].filter(p => p.enabled).sort((a, b) => b.priority - a.priority)
  for (const p of sorted) {
    try {
      const models = JSON.parse(p.models)
      if (models.includes(model)) return p
    } catch {}
  }
  const fallback = sorted.find(p => {
    try {
      const models = JSON.parse(p.models)
      return models.length === 0 || models.includes('*')
    } catch { return false }
  })
  return fallback || sorted[0] || null
}

export function findProvidersForModel(providers, model) {
  if (model === 'openai') return [...providers].filter(p => p.enabled).sort((a, b) => b.priority - a.priority)
  const sorted = [...providers].filter(p => p.enabled).sort((a, b) => b.priority - a.priority)
  const exact = sorted.filter(p => {
    try { return JSON.parse(p.models).includes(model) } catch { return false }
  })
  if (exact.length) return exact
  const fallback = sorted.filter(p => {
    try {
      const m = JSON.parse(p.models)
      return m.length === 0 || m.includes('*')
    } catch { return false }
  })
  return fallback
}

function extractToolDef(t) {
  let name, description, parameters
  if (t.type === 'function' && t.function) {
    name = t.function.name; description = t.function.description; parameters = t.function.parameters
  } else if (t.name) {
    name = t.name; description = t.description || ''; parameters = t.parameters || t.inputSchema
  } else {
    return null
  }
  return { name, description: description || '', parameters: parameters || {} }
}

function buildToolPrompt(tools) {
  if (!tools?.length) return ''
  const list = tools.map(extractToolDef).filter(Boolean).map(({ name, description, parameters }) => {
    const entries = parameters?.properties ? Object.entries(parameters.properties) : []
    const requiredKeys = parameters?.required || []
    const args = entries.map(([k, v]) => `${k}: ${v.type || 'any'}${v.description ? ' // ' + v.description : ''}${requiredKeys.includes(k) ? ' (required)' : ''}`).join('\n  ')
    const example = '{"name":"' + name + '","arguments":{' + entries.map(([k]) => '"' + k + '":"..."').join(',') + '}}'
    return '- ' + name + '(' + entries.map(([k]) => k).join(', ') + ')' + (description ? ': ' + description : '') + '\n  ' + args + '\n  Example: ' + example
  }).join('\n\n')
  return '\n[SYSTEM] You have tools available. To call one, output EXACTLY:\n' + list + '\n\nOnly output JSON when calling a tool. Otherwise, respond normally.[/SYSTEM]'
}

function buildArkoToolPrompt(tools) {
  if (!tools?.length) return ''
  const toolDefs = tools.map(extractToolDef).filter(Boolean).map(({ name, description, parameters }) => {
    const entries = parameters?.properties ? Object.entries(parameters.properties) : []
    const requiredKeys = parameters?.required || []
    const paramText = entries.map(([k, v]) => {
      const req = requiredKeys.includes(k) ? ' [REQUIRED]' : ' [optional]'
      const desc = v.description ? ': ' + v.description : ''
      return '  - ' + k + ' (' + (v.type || 'any') + ')' + desc + req
    }).join('\n')
    return '* ' + name + ': ' + description + '\n' + (paramText || '  (no parameters)')
  }).join('\n\n')
  if (!toolDefs) return ''
  return '[Available Tools]\n' + toolDefs + '\n\n[Response Format]\nWhen you need to call a tool, respond ONLY with JSON: {"name":"<tool_name>","arguments":{...}}\nWhen no tool is needed, respond normally.\n---'
}

function tryExtractToolCall(text) {
  if (!text) return null
  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s)
      if (obj?.name && obj?.arguments) {
        return { id: 'call_' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2, 10)), type: 'function', function: { name: obj.name, arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments) } }
      }
      if (obj?.call) {
        const args = { ...obj }; delete args.call
        return { id: 'call_' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2, 10)), type: 'function', function: { name: obj.call, arguments: JSON.stringify(args) } }
      }
    } catch {}
    return null
  }
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim()
  const r = tryParse(cleaned)
  if (r) return r
  let start = -1, depth = 0
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{') {
      if (start === -1) start = i
      depth++
    } else if (cleaned[i] === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        const r2 = tryParse(cleaned.slice(start, i + 1))
        if (r2) return r2
        start = -1
      }
    }
  }
  return null
}

export async function proxyWithFallback(providers, model, path, payload, stream) {
  const candidates = findProvidersForModel(providers, model)
  if (!candidates.length) {
    throw new Error('No enabled provider available for model: ' + model)
  }
  let lastError = null
  for (const provider of candidates) {
    try {
      return await proxyRequest(provider, path, payload, stream)
    } catch (e) {
      lastError = e
    }
  }
  throw new Error('All providers failed for model ' + model + ': ' + (lastError?.message || 'unknown'))
}

export async function proxyRequest(provider, path, payload, stream) {
  if (provider.type === 'chatwithfiction') {
    return proxyChatWithFiction(provider, payload, stream)
  }
  if (provider.type === 'arko') {
    return proxyArko(provider, payload, stream)
  }
  const tools = payload.tools || payload.functions || []
  const toolPrompt = buildToolPrompt(tools)
  const hasTools = !!toolPrompt
  const simPayload = hasTools ? { ...payload } : payload
  if (hasTools) {
    const msgs = [...(payload.messages || [])]
    const sysIdx = msgs.findIndex((m) => m.role === 'system')
    if (sysIdx >= 0) {
      msgs[sysIdx] = { ...msgs[sysIdx], content: msgs[sysIdx].content + '\n\n' + toolPrompt }
    } else {
      msgs.unshift({ role: 'system', content: toolPrompt })
    }
    simPayload.messages = msgs
    delete simPayload.tools
    delete simPayload.functions
    delete simPayload.tool_choice
    simPayload.stream = false
  }
  const url = provider.base_url.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
  const headers = { 'Content-Type': 'application/json' }
  if (provider.api_key) {
    headers['Authorization'] = 'Bearer ' + provider.api_key
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(simPayload),
    signal: AbortSignal.timeout(60000)
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error('Provider error ' + resp.status + ': ' + text)
  }
  if (hasTools) {
    const json = await resp.json()
    const content = json?.choices?.[0]?.message?.content || ''
    const toolCall = tryExtractToolCall(content)
    const model = payload.model || 'unknown'
    if (stream) return openAIStreamResponse(model, content, toolCall)
    return openAICompletion(model, content, toolCall)
  }
  if (stream) {
    const { readable, writable } = new TransformStream()
    resp.body.pipeTo(writable).catch(() => {})
    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    })
  }
  return await resp.json()
}

async function proxyArko(provider, payload, stream) {
  const messages = payload.messages || []
  const hasTools = !!(payload.tools?.length || payload.functions?.length)
  const tools = payload.tools || payload.functions || []
  const toolPromptStr = buildArkoToolPrompt(tools)
  const toolsActive = hasTools && !!toolPromptStr && (payload.tool_choice || 'auto') !== 'none'
  const lastMsg = messages[messages.length - 1] || {}
  const model = payload.model || 'arko'
  const now = Math.floor(Date.now() / 1000)
  const cidStr = (uuid) => 'chatcmpl-' + (uuid?.slice(0, 8) || Math.random().toString(36).slice(2, 10))
  const writeChunks = async (writer, encoder, chunks, extraCid) => {
    if (extraCid) await writer.write(encoder.encode('data: ' + JSON.stringify({ type: 'cid', cid: extraCid }) + '\n\n'))
    for (const chunk of chunks) {
      await writer.write(encoder.encode('data: ' + JSON.stringify({ id: cidStr(crypto.randomUUID?.()), object: 'chat.completion.chunk', created: now, model, choices: chunk.choices }) + '\n\n'))
    }
    await writer.write(encoder.encode('data: [DONE]\n\n'))
    await writer.close()
  }
  let aid
  try { aid = JSON.parse(provider.models)[0] } catch {}
  if (!aid) aid = payload.model
  const url = provider.base_url.replace(/\/+$/, '') + '/v3/messages'
  const headers = { 'Content-Type': 'application/json' }
  if (provider.api_key) headers['Authorization'] = 'Bearer ' + provider.api_key
  const toolChoice = payload.tool_choice
  if (toolsActive && lastMsg.role === 'tool') {
    const lastUserMsg = [...messages].slice(0, messages.length - 1).reverse().find((m) => m.role === 'user')
    const originalUser = lastUserMsg?.content || messages.find((m) => m.role === 'user')?.content || ''
    const toolResult = lastMsg.content || ''
    const toolName = lastMsg.name || lastMsg.tool_call_id || 'tool'
    const content2 = '[Context]\nUser asked: ' + originalUser + '\n\nTool called: ' + toolName + '\nResult: ' + toolResult + '\n[/Context]\n\nPlease respond to the user based on the tool result above.'
    const body2 = { content: content2, stream: false }
    if (payload.cid) body2.cid = payload.cid
    else body2.aid = aid
    const resp2 = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body2), signal: AbortSignal.timeout(60000) })
    if (!resp2.ok) throw new Error('Arko error ' + resp2.status + ': ' + (await resp2.text()))
    const json2 = await resp2.json()
    const assistantMsg2 = json2?.data?.messages?.find((m) => m.role === 'assistant')
    const text2 = assistantMsg2?.content || ''
    const dataCid2 = json2?.data?.chat?.id
    if (stream) {
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const encoder = new TextEncoder()
      ;(async () => writeChunks(writer, encoder, [
        { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: text2 }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ], dataCid2))()
      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
    }
    const result2 = { id: cidStr(crypto.randomUUID?.()), object: 'chat.completion', created: now, model, choices: [{ index: 0, message: { role: 'assistant', content: text2 }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
    if (dataCid2) result2._cid = dataCid2
    return result2
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const baseContent = lastUser?.content || ''
  const content = toolPromptStr ? toolPromptStr + '\n\n' + baseContent : baseContent
  const fetchNonStream = toolsActive
  const body = { content, stream: fetchNonStream ? false : stream !== false, ...(!payload.cid ? { aid } : { cid: payload.cid }) }
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  if (!resp.ok) throw new Error('Arko error ' + resp.status + ': ' + (await resp.text()))
  if (fetchNonStream) {
    const json2 = await resp.json()
    const assistantMsg2 = json2?.data?.messages?.find((m) => m.role === 'assistant')
    const text2 = assistantMsg2?.content || ''
    const dataCid2 = json2?.data?.chat?.id
    const toolCall = tryExtractToolCall(text2)
    if (toolCall) {
      if (stream) {
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()
        ;(async () => writeChunks(writer, encoder, [
          { choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: toolCall.function.arguments } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
        ], dataCid2))()
        return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
      }
      const result3 = { id: cidStr(crypto.randomUUID?.()), object: 'chat.completion', created: now, model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
      if (dataCid2) result3._cid = dataCid2
      return result3
    }
    if (stream) {
      const { readable, writable } = new TransformStream()
      const writer = writable.getWriter()
      const encoder = new TextEncoder()
      ;(async () => writeChunks(writer, encoder, [
        { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: text2 }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ], dataCid2))()
      return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
    }
    const result2 = { id: cidStr(crypto.randomUUID?.()), object: 'chat.completion', created: now, model, choices: [{ index: 0, message: { role: 'assistant', content: text2 }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
    if (dataCid2) result2._cid = dataCid2
    return result2
  }
  if (stream) {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    let cidSent = false, buf = ''
    resp.body.pipeTo(new WritableStream({
      async write(chunk) {
        buf += new TextDecoder().decode(chunk)
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'chat' && event.id && !cidSent) {
              cidSent = true
              await writer.write(encoder.encode('data: ' + JSON.stringify({ type: 'cid', cid: event.id }) + '\n\n'))
            }
            if (event.type === 'delta' && event.content) {
              await writer.write(encoder.encode('data: ' + JSON.stringify({ id: cidStr(crypto.randomUUID?.()), object: 'chat.completion.chunk', created: now, model, choices: [{ index: 0, delta: { content: event.content }, finish_reason: null }] }) + '\n\n'))
            }
            if (event.type === 'error') {
              await writer.write(encoder.encode('data: ' + JSON.stringify({ error: { message: event.message || 'Arko stream error', code: event.code } }) + '\n\n'))
            }
          } catch {}
        }
      },
      async close() {
        try { await writer.write(encoder.encode('data: [DONE]\n\n')) } catch {}
        try { await writer.close() } catch {}
      },
      async abort() {
        try { await writer.close() } catch {}
      }
    })).catch(() => {})
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } })
  }
  const json = await resp.json()
  const assistantMsg = json?.data?.messages?.find((m) => m.role === 'assistant')
  const text = assistantMsg?.content || ''
  const dataCid = json?.data?.chat?.id
  const result = { id: cidStr(crypto.randomUUID?.()), object: 'chat.completion', created: now, model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
  if (dataCid) result._cid = dataCid
  return result
}

function formatMessageForCWF(msg) {
  if (msg.role === 'assistant' && msg.tool_calls?.length) {
    const tc = msg.tool_calls[0]
    let argsObj = {}
    try { argsObj = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments } catch {}
    return { type: 'AI', content: JSON.stringify({ name: tc.function.name, arguments: argsObj }) }
  }
  if (msg.role === 'tool') {
    let label = 'The tool returned'
    if (msg.tool_call_id) label += ' (' + msg.tool_call_id + ')'
    return { type: 'USER', content: label + ': ' + (msg.content || '') }
  }
  return { type: msg.role === 'user' ? 'USER' : 'AI', content: msg.content || '' }
}

async function proxyChatWithFiction(provider, payload, stream) {
  const messages = payload.messages || []
  const tools = payload.tools || payload.functions || []
  const toolContext = buildToolPrompt(tools)
  const prevMessages = []

  let systemContent = 'You are a helpful AI assistant. Respond concisely and accurately.'
  if (toolContext) systemContent += toolContext
  prevMessages.push({ type: 'AI', content: systemContent })

  for (const msg of messages) {
    if (msg.role === 'system') {
      prevMessages[0].content += '\n\n' + (msg.content || '')
      continue
    }
    prevMessages.push(formatMessageForCWF(msg))
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  const hasToolResult = messages.some(m => m.role === 'tool')
  let prompt = lastUserMsg ? lastUserMsg.content : ''
  if (hasToolResult && prompt) {
    prompt = 'Based on the tool result above, ' + prompt
  }
  if (toolContext && !messages.some(m => m.role === 'system')) {
    prompt = toolContext + '\n\n' + prompt
  }

  const resp = await fetch(provider.base_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prevMessages, prompt }),
    signal: AbortSignal.timeout(60000)
  })

  if (!resp.ok) {
    throw new Error('Chat With Fiction error: ' + resp.status + ' ' + (await resp.text()))
  }

  const raw = await resp.text()
  let content = raw
  try { content = JSON.parse(raw) } catch {}

  const text = String(content)
  const model = payload.model || 'chatwithfiction-gpt'
  const toolCall = tools.length ? tryExtractToolCall(text) : null

  if (stream) {
    const encoder = new TextEncoder()
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const chunks = toolCall ? [
      { choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: toolCall.function.arguments } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]
    ;(async () => {
      for (const chunk of chunks) {
        writer.write(encoder.encode('data: ' + JSON.stringify({
          id: 'chatcmpl-' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2)),
          object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: chunk.choices
        }) + '\n\n'))
      }
      writer.write(encoder.encode('data: [DONE]\n\n'))
      writer.close()
    })()
    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    })
  }

  if (toolCall) {
    return {
      id: 'chatcmpl-' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2)),
      object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }
  }

  return {
    id: 'chatcmpl-' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2)),
    object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

function makeCompletionId() {
  return 'chatcmpl-' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2))
}

function openAICompletion(model, text, toolCall) {
  if (toolCall) {
    return {
      id: makeCompletionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }
  }
  return {
    id: makeCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
}

function openAIStreamResponse(model, text, toolCall) {
  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const chunks = toolCall ? [
    { choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: toolCall.function.arguments } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ] : [
    { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]
  ;(async () => {
    for (const chunk of chunks) {
      await writer.write(encoder.encode('data: ' + JSON.stringify({
        id: makeCompletionId(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: chunk.choices
      }) + '\n\n'))
    }
    await writer.write(encoder.encode('data: [DONE]\n\n'))
    await writer.close()
  })()
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  })
}

export async function testProviderConnection(provider) {
  if (provider.type === 'chatwithfiction') {
    try {
      const resp = await fetch(provider.base_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prevMessages: [{ type: 'AI', content: 'test' }, { type: 'USER', content: 'hi' }], prompt: 'hi' }),
        signal: AbortSignal.timeout(10000)
      })
      if (!resp.ok) return { ok: false, status: resp.status }
      const text = await resp.text()
      return { ok: text.length > 0, status: 200 }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
  const url = provider.base_url.replace(/\/+$/, '') + '/v1/models'
  const headers = {}
  if (provider.api_key) {
    headers['Authorization'] = 'Bearer ' + provider.api_key
  }
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    return { ok: resp.ok, status: resp.status }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
