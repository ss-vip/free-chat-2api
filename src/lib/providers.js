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

function buildToolPrompt(tools) {
  if (!tools?.length) return ''
  return '\n\nYou have access to the following tools. When you need to use a tool, respond with ONLY a JSON object (no markdown, no extra text):\n' + tools.map(t => {
    if (t.type === 'function') {
      return `- ${t.function.name}: ${t.function.description || ''}  parameters: ${JSON.stringify(t.function.parameters)}`
    }
    return ''
  }).filter(Boolean).join('\n') + '\n\nResponse format: {"name":"tool_name","arguments":{"key":"value"}}'
}

function tryExtractToolCall(text) {
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim()
  try {
    const obj = JSON.parse(cleaned)
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
  const url = provider.base_url.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
  const headers = { 'Content-Type': 'application/json' }
  if (provider.api_key) {
    headers['Authorization'] = 'Bearer ' + provider.api_key
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error('Provider error ' + resp.status + ': ' + text)
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
