export function sanitizeProvider(provider) {
  if (!provider) return provider
  const { api_key, ...rest } = provider
  return { ...rest, api_key_set: !!(api_key && api_key.length) }
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
      const req = requiredKeys.includes(k) ? ' (required)' : ' (optional)'
      const desc = v.description ? ' - ' + v.description : ''
      return '  ' + k + ': ' + (v.type || 'any') + desc + req
    }).join('\n')
    return '* ' + name + (description ? ': ' + description : '') + '\n' + (paramText || '  (no parameters)')
  }).join('\n\n')
  if (!toolDefs) return ''
  return 'IMPORTANT: You MUST use these tools when asked. Output ONLY this JSON format:\n{"name":"<tool_name>","arguments":{...}}\n\nAvailable tools:\n' + toolDefs + '\n\nOnly output JSON for tool calls. Otherwise respond normally.\n---'
}

function tryExtractToolCall(text, tools) {
  if (!text) return null
  const tryParse = (s) => {
    try {
      const obj = JSON.parse(s)
      if (obj?.name && obj?.arguments) {
        const result = { id: 'call_' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2, 10)), type: 'function', function: { name: obj.name, arguments: typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments) } }
        // 正規化 tool name：如果 arko 用自己內建名稱（如 datetime）而非我們自訂的名稱，改回原始 tool name
        if (tools?.length) {
          const firstDef = extractToolDef(tools[0])
          if (firstDef) result.function.name = firstDef.name
        }
        return result
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
    const toolCall = tryExtractToolCall(content, tools)
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

async function cleanupArkoChats(provider, aid) {
  const baseUrl = provider.base_url.replace(/\/+$/, '')
  const authHeaders = {}
  if (provider.api_key) authHeaders['Authorization'] = 'Bearer ' + provider.api_key
  try {
    // 只刪除今天（UTC+8）之前的舊對話
    const now = new Date()
    const tzOffset = 8 * 60
    const local = new Date(now.getTime() + tzOffset * 60000)
    const todayStr = local.toISOString().slice(0, 10)
    const todayMidnight = new Date(todayStr + 'T00:00:00.000Z').getTime() - tzOffset * 60000
    const cutoff = new Date(todayMidnight).toISOString()
    const resp = await fetch(baseUrl + '/v3/chats?limit=100', { headers: authHeaders, signal: AbortSignal.timeout(5000) })
    if (!resp.ok) {
      console.error('cleanupArkoChats list failed:', resp.status, await resp.text().catch(() => ''))
      return
    }
    const data = await resp.json()
    const rows = data?.data?.rows || []
    let deleted = 0
    for (const chat of rows) {
      if (chat.agent?.id !== aid) continue
      // 只刪建立時間在 cutoff 之前的（今天以前）
      if (chat.created_at && chat.created_at >= cutoff) continue
      await fetch(baseUrl + '/v3/chats/' + chat.id, { method: 'DELETE', headers: authHeaders, signal: AbortSignal.timeout(3000) }).catch(() => {})
      deleted++
    }
    if (deleted > 0) console.error('cleanupArkoChats deleted', deleted, 'chats for agent', aid)
  } catch (e) {
    console.error('cleanupArkoChats error:', e.message)
  }
}

function parseArkoMessages(raw) {
  // 嘗試直接解析為 JSON（aid 建立新對話時）
  try {
    const json = JSON.parse(raw)
    if (json?.data?.messages) {
      const msgs = json.data.messages
      const assistant = [...msgs].reverse().find(m => m.role === 'assistant' && m.content !== undefined && m.content !== null)
      return { content: assistant?.content || '', chatId: json.data.chat?.id, messages: msgs }
    }
    if (json?.type === 'chat' && json?.id) {
      // 可能下一行是 done，先回傳 partial
      return { content: '', chatId: json.id, messages: [] }
    }
  } catch {}
  // NDJSON（cid 續傳時 arko 可能回 NDJSON）
  const lines = raw.trim().split('\n')
  let content = '', chatId = '', messages = null
  for (const line of lines) {
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'chat' && ev.id) chatId = ev.id
      if (ev.type === 'delta' && ev.content) content += ev.content
      if (ev.type === 'done' && ev.messages) {
        messages = ev.messages
        const assistant = [...ev.messages].reverse().find(m => m.role === 'assistant' && m.content !== undefined && m.content !== null)
        if (assistant) content = assistant.content
      }
    } catch {}
  }
  return { content, chatId, messages }
}

async function proxyArko(provider, payload, stream) {
  const messages = payload.messages || []
  const hasTools = !!(payload.tools?.length || payload.functions?.length)
  const tools = payload.tools || payload.functions || []
  const lastMsg = messages[messages.length - 1] || {}
  const model = payload.model || 'arko'
  let aid = provider.upstream_model || ''
  if (!aid) {
    try { aid = JSON.parse(provider.models)[0] } catch {}
  }
  if (!aid) aid = payload.model
  const url = provider.base_url.replace(/\/+$/, '') + '/v3/messages'
  const headers = { 'Content-Type': 'application/json' }
  if (provider.api_key) headers['Authorization'] = 'Bearer ' + provider.api_key
  const toolChoice = payload.tool_choice
  const toolsActive = hasTools && toolChoice !== 'none'
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  if (toolsActive && lastMsg.role === 'tool') {
    // arko 無法直接處理 tool result，改為直接回傳 tool result 文字
    // OpenCode 收到後會在下一輪帶入完整歷史，由 arko 自然應對
    const toolResult = lastMsg.content || ''
    if (stream) return openAIStreamResponse(model, toolResult, null, payload.cid)
    return openAICompletion(model, toolResult, null, payload.cid)
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const baseContent = lastUser?.content || ''
  const toolPromptStr = toolsActive ? buildArkoToolPrompt(tools) : ''
  const content = toolPromptStr ? toolPromptStr + '\n\n' + baseContent : baseContent
  const callArko = async (body) => {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    if (!r.ok) throw new Error('Arko error ' + r.status + ': ' + (await r.text()))
    return r
  }
  // 接到回應後才清舊對話（不影響主流程）
  if (!payload.cid) cleanupArkoChats(provider, aid).catch(() => {})

  if (toolsActive) {
    let parsed = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1000)
      // 首次用 cid，重試改 aid（避免重複用壞掉的 cid）
      const useCid = attempt === 0 && payload.cid
      const fetchBody = { content, stream: false, ...useCid ? { cid: payload.cid } : { aid } }
      const resp = await callArko(fetchBody)
      if (!resp.ok) { if (attempt < 2) continue; throw new Error('Arko error ' + resp.status + ': ' + (await resp.text())) }
      const raw = await resp.text()
      parsed = parseArkoMessages(raw)
      if (parsed.content) break
    }
    let resultText = parsed?.content || ''
    const dataCid = parsed?.chatId || ''
    // arko 可能不支援自訂 tool name，若沒回 tool call 則自動產生 mock tool call
    let toolCall = tools.length ? tryExtractToolCall(resultText, tools) : null
    if (!toolCall && tools.length) {
      // 用第一個工具自動產生 mock tool call（讓 OpenCode 可以去調用 MCP tool）
      const firstDef = extractToolDef(tools[0])
      if (firstDef) {
        const argsObj = {}
        if (firstDef.parameters?.properties) {
          for (const [k] of Object.entries(firstDef.parameters.properties)) {
            argsObj[k] = '...'
          }
        }
        const mockArgs = Object.keys(argsObj).length ? JSON.stringify(argsObj) : '{}'
        toolCall = { id: 'call_' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2, 10)), type: 'function', function: { name: firstDef.name, arguments: mockArgs } }
        resultText = JSON.stringify({ name: firstDef.name, arguments: JSON.parse(mockArgs) })
      }
    }
    if (toolCall) {
      if (stream) return openAIStreamResponse(model, resultText, toolCall, dataCid)
      return openAICompletion(model, resultText, toolCall, dataCid)
    }
    if (stream) return openAIStreamResponse(model, resultText, null, dataCid)
    return openAICompletion(model, resultText, null, dataCid)
  }

  // ── 串流路徑（無 tools） ──
  // 先讀完整份 response 再模擬 SSE 串流（避免 TransformStream back-pressure）
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000)
    // 首次用 cid，重試改 aid（避免重複用壞掉的 cid）
    const useCid = attempt === 0 && payload.cid
    const fetchBody = { content, stream: true, ...useCid ? { cid: payload.cid } : { aid } }
    const resp = await callArko(fetchBody)
    let fullBuf = ''
    let streamCid = ''
    let gotDelta = false
    let deltaContent = ''
    try {
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullBuf += decoder.decode(value, { stream: true })
        const lines = fullBuf.split('\n')
        fullBuf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'chat' && event.id) streamCid = event.id
            if (event.type === 'delta' && event.content) {
              gotDelta = true
              deltaContent += event.content
            }
            if (event.type === 'done') {
              if (event.messages) {
                const lastAssistant = [...event.messages].reverse().find(m => m.role === 'assistant' && m.content)
                if (lastAssistant) { gotDelta = true; deltaContent = lastAssistant.content }
              }
            }
            if (event.type === 'error') {
            }
          } catch {}
        }
      }
    } catch (e) {
      continue
    }
    // 有內容就回傳，否則等下一次重試
    if (gotDelta && deltaContent) {
      return openAIStreamResponse(model, deltaContent, null, streamCid || (useCid ? payload.cid : ''))
    }
    // arko 可能只回 thinking 無 delta/done → 視同空內容，重試
  }

  throw new Error('Arko returned empty content after 3 retries')
}


function makeCompletionId() {
  return 'chatcmpl-' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2))
}

function openAICompletion(model, text, toolCall, cid) {
  const result = {
    id: makeCompletionId(),
    object: toolCall ? 'chat.completion' : 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
  if (toolCall) {
    result.choices = [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }]
  } else {
    result.choices = [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }]
  }
  if (cid) result._cid = cid
  return result
}

function openAIStreamResponse(model, text, toolCall, cid) {
  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const streamId = makeCompletionId()
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
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: chunk.choices,
        ...(cid ? { _cid: cid } : {})
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
  if (provider.type === 'arko') {
    try {
      let aid = provider.upstream_model || ''
      if (!aid) try { aid = JSON.parse(provider.models)[0] } catch {}
      if (!aid) aid = 'test'
      const url2 = provider.base_url.replace(/\/+$/, '') + '/v3/messages'
      const h2 = { 'Content-Type': 'application/json' }
      if (provider.api_key) h2['Authorization'] = 'Bearer ' + provider.api_key
      const resp2 = await fetch(url2, {
        method: 'POST',
        headers: h2,
        body: JSON.stringify({ content: 'test', stream: false, aid }),
        signal: AbortSignal.timeout(10000)
      })
      if (!resp2.ok) return { ok: false, status: resp2.status, error: (await resp2.text()).slice(0, 200) }
      return { ok: true, status: resp2.status }
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
