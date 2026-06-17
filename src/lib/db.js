// ── Token ──────────────────────────────────────────────────────────
export function generateToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return 'sk-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Image generation keywords — used to detect image-gen requests and extend timeout
const IMAGE_GEN_KEYWORDS = [
  'draw', 'generate', 'create', 'make', 'render', 'produce',
  'picture', 'image', 'illustration', 'painting', 'art', 'design',
  'diagram', 'chart', 'graph', 'visual', 'sketch', 'doodle',
  'photo', 'photograph', 'portrait', 'landscape', 'poster', 'flyer',
  'meme', 'cartoon', 'comic', 'animation', 'icon', 'logo', 'banner',
  '繪製', '生成', '創建', '建立', '渲染', '畫', '畫出', '畫一張',
  '圖片', '圖像', '圖案', '插圖', '設計', '海報', 'logo',
  '照片', '肖像', '風景', '漫畫',
]
const likelyImageGen = (content) => {
  if (!content || typeof content !== 'string') return false
  const c = content.toLowerCase().trim()
  if (!c || c.length < 3) return false
  return IMAGE_GEN_KEYWORDS.some(kw => c.includes(kw))
}

// ── AID health tracking (adaptive) ──────────────────────────────
const aidFailureCount = new Map()
const AID_BACKOFF_MS = 30000

function markAidFailure(aid) {
  const now = Date.now()
  const prev = aidFailureCount.get(aid) || { count: 0, lastFailure: 0 }
  aidFailureCount.set(aid, { count: prev.count + 1, lastFailure: now })
}

function markAidSuccess(aid) {
  aidFailureCount.delete(aid)
}

function healthyAids(aids) {
  const now = Date.now()
  return aids.filter(aid => {
    const rec = aidFailureCount.get(aid)
    return !rec || (now - rec.lastFailure) >= AID_BACKOFF_MS
  })
}

// ── Schema init & migrations ──────────────────────────────────────
export async function initDB(db) {
  // Core tables
  await db.prepare(`CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    client_token TEXT NOT NULL DEFAULT '',
    dashboard_password_hash TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT DEFAULT '',
    upstream_model TEXT DEFAULT '',
    models TEXT DEFAULT '["*"]',
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS schema_meta (
    id INTEGER PRIMARY KEY, version INTEGER NOT NULL
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS chat_cids (
    ctx_hash TEXT PRIMARY KEY, cid TEXT NOT NULL, aid TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
  )`).run()

  // Bootstrap config row
  const row = await db.prepare('SELECT version FROM schema_meta WHERE id = 1').first()
  if (!row) {
    await db.prepare('INSERT INTO schema_meta (id, version) VALUES (1, 0)').run()
  }
  const ver = row ? row.version : 0
  if (ver < 1) {
    await db.prepare('INSERT INTO config (id, client_token) VALUES (1, ?)').bind(generateToken()).run()
    await db.prepare('UPDATE schema_meta SET version = 1 WHERE id = 1').run()
  }

  // v10: add provider columns to config, migrate from old providers table
  if (ver < 10) {
    for (const col of ['base_url', 'api_key', 'upstream_model']) {
      try { await db.prepare(`ALTER TABLE config ADD COLUMN ${col} TEXT DEFAULT ''`).run() } catch {}
    }
    try { await db.prepare(`ALTER TABLE config ADD COLUMN models TEXT DEFAULT '["*"]'`).run() } catch {}
    // Copy data from old providers table (old table may lack upstream_model column)
    const { results: tables } = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'").all()
    if (tables?.length) {
      try {
        const p = await db.prepare("SELECT base_url, api_key, upstream_model, models FROM providers WHERE enabled = 1 AND type = 'arko' ORDER BY priority DESC LIMIT 1").first()
        if (p) {
          await db.prepare('UPDATE config SET base_url=?, api_key=?, upstream_model=?, models=? WHERE id=1')
            .bind(p.base_url || '', p.api_key || '', p.upstream_model || '', p.models || '["*"]').run()
        }
      } catch {
        // fallback if upstream_model column doesn't exist in old providers table
        try {
          const p = await db.prepare("SELECT base_url, api_key, models FROM providers WHERE enabled = 1 AND type = 'arko' ORDER BY priority DESC LIMIT 1").first()
          if (p) {
            await db.prepare('UPDATE config SET base_url=?, api_key=?, upstream_model=?, models=? WHERE id=1')
              .bind(p.base_url || '', p.api_key || '', '', p.models || '["*"]').run()
          }
        } catch {}
      }
      await db.prepare("DROP TABLE IF EXISTS providers").run()
    }
    await db.prepare('UPDATE schema_meta SET version = 10 WHERE id = 1').run()
  }

  // v11: ensure provider columns exist (fix for v10 that may have skipped ALTER TABLE)
  if (ver < 11) {
    for (const col of ['base_url', 'api_key', 'upstream_model']) {
      try { await db.prepare(`ALTER TABLE config ADD COLUMN ${col} TEXT DEFAULT ''`).run() } catch {}
    }
    try { await db.prepare(`ALTER TABLE config ADD COLUMN models TEXT DEFAULT '["*"]'`).run() } catch {}
    await db.prepare('UPDATE schema_meta SET version = 11 WHERE id = 1').run()
  }

  // v12: drop orphaned providers table (v10 migration may have failed to drop it)
  if (ver < 12) {
    try { await db.prepare("DROP TABLE IF EXISTS providers").run() } catch {}
    await db.prepare('UPDATE schema_meta SET version = 12 WHERE id = 1').run()
  }

  // Clean expired sessions
  await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run()

  // Clean old chat_cids
  await db.prepare("DELETE FROM chat_cids WHERE updated_at < datetime('now', '-7 days')").run()
}

// ── Session ───────────────────────────────────────────────────────
export async function createSession(db, token) {
  const e = new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  await db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').bind(token, e).run()
  return token
}
export async function getValidSession(db, token) {
  if (!token) return null
  return await db.prepare("SELECT token FROM sessions WHERE token = ? AND expires_at > datetime('now')").bind(token).first()
}
export async function deleteSession(db, token) {
  if (!token) return
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
}
export async function deleteExpiredSessions(db) {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run()
}

// ── Config (auth + provider) ──────────────────────────────────────
let _tokenCache = null
export function invalidateDBCache() { _tokenCache = null }

export async function getClientToken(db) {
  if (_tokenCache !== null) return _tokenCache
  const row = await db.prepare('SELECT client_token FROM config WHERE id = 1').first()
  _tokenCache = row ? row.client_token : ''
  return _tokenCache
}
export async function rotateClientToken(db) {
  const t = generateToken()
  await db.prepare('UPDATE config SET client_token = ?, updated_at = datetime(\'now\') WHERE id = 1').bind(t).run()
  _tokenCache = t; return t
}

export async function getDashboardPasswordHash(db) {
  const row = await db.prepare('SELECT dashboard_password_hash FROM config WHERE id = 1').first()
  return row ? row.dashboard_password_hash : ''
}
export async function setDashboardPasswordHash(db, hash) {
  await db.prepare('UPDATE config SET dashboard_password_hash = ?, updated_at = datetime(\'now\') WHERE id = 1').bind(hash).run()
}

// Provider config (flattened into config table — single arko provider)
export function sanitizeProvider(p) {
  if (!p) return p
  const masked = { ...p }
  masked.api_key = p.api_key ? '••••••' : ''
  masked.api_key_set = !!(p.api_key && p.api_key.length)
  return masked
}

export async function getProvider(db) {
  const row = await db.prepare('SELECT * FROM config WHERE id = 1').first()
  if (!row) return null
  return row
}

export async function updateProvider(db, data) {
  const { upstream_model, models } = data
  const base_url = (data.base_url || '').replace(/\/+$/, '')
  const url = base_url || 'https://arko.arcaelas.com'
  // Preserve existing api_key if not explicitly provided
  let finalApiKey = data.api_key
  if (data.clear_api_key) {
    finalApiKey = ''
  } else if (finalApiKey === undefined) {
    const existing = await db.prepare('SELECT api_key FROM config WHERE id = 1').first()
    finalApiKey = existing?.api_key ?? ''
  }
  await db.prepare(
    'UPDATE config SET base_url=?, api_key=?, upstream_model=?, models=?, updated_at=datetime(\'now\') WHERE id=1'
  ).bind(
    url, finalApiKey, upstream_model ?? '',
    models ? JSON.stringify(models) : '["*"]'
  ).run()
  return await db.prepare('SELECT * FROM config WHERE id = 1').first()
}

// ── Arko stream parsing ──────────────────────────────────────────
function extractDoneContent(json) {
  // Priority: messages-based extraction FIRST, then fall back to direct content fields
  // (done event's json.content is often the user's message, not assistant response)
  // Check messages arrays first for the assistant's actual response
  if (json.data?.messages?.length) {
    const asst = [...json.data.messages].reverse().find(m => m.role === 'assistant' && m.content)
    if (asst?.content) return asst.content
  }
  if (Array.isArray(json.messages)) {
    const asst = [...json.messages].reverse().find(m => m.role === 'assistant' && m.content)
    if (asst?.content) return asst.content
  }
  // Direct content fields (use as last resort)
  if (json.assistant?.content) return json.assistant.content
  if (json.choices?.[0]?.message?.content) return json.choices[0].message.content
  if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content
  if (json.content) return json.content
  if (json.text) return json.text
  return ''
}

function parseArkoJSON(obj) {
  if (obj?.success === true && obj?.data?.messages) {
    const chatId = obj.data.chat?.id || ''
    const msgs = obj.data.messages
    const asst = [...msgs].reverse().find(m => m.role === 'assistant' && m.content !== undefined && m.content !== null)
    return { content: asst?.content || '', chatId, messages: msgs }
  }
  return null
}

export async function readArkoStream(response) {
  const ct = response.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const obj = await response.json()
    const parsed = parseArkoJSON(obj)
    if (parsed) return parsed
    return { content: obj.content || obj.text || JSON.stringify(obj) }
  }
  let full = '', chatId = ''
  let lastError = null
  const reader = response.body?.getReader()
  if (!reader) return { content: '' }
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (buffer) {
        try {
          const json = JSON.parse(buffer)
          if (json.type === 'delta' && json.content) full += json.content
        } catch {}
      }
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines.filter(Boolean)) {
      try {
        const json = JSON.parse(line)
        if (json.type === 'chat' && json.id) chatId = json.id
        else if (json.type === 'delta' && json.content) full += json.content
        else if (json.type === 'error') {
          lastError = json.message || json.code || 'unknown'
        } else if (json.type === 'done') {
          const doneContent = extractDoneContent(json)
          if (doneContent) { full = doneContent; return { content: full.trim(), chatId } }
          if (lastError) throw new Error('Arko error: ' + lastError)
          return { content: full.trim(), chatId }
        }
      } catch {}
    }
  }
  if (!full.trim()) {
    throw new Error(lastError ? 'Arko error: ' + lastError : 'Empty stream from Arko')
  }
  return { content: full.trim(), chatId }
}

// ── CID save helper ───────────────────────────────────────────
async function saveChatCid(db, ctxHash, chatId, currentAid) {
  await db.prepare(
    'INSERT OR REPLACE INTO chat_cids (ctx_hash, cid, aid, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).bind(ctxHash, chatId, currentAid).run()
}

// ── True streaming: NDJSON → SSE (per-token) ───────────────────
function streamArkoToSSE(response, model, sid, cid, db, allUserMsgs, currentAid, ctxHash) {
  const enc = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  ;(async () => {
    try {
      const ct = response.headers.get('content-type') || ''
      if (ct.includes('application/json')) {
        const obj = await response.json()
        const parsed = parseArkoJSON(obj)
        const content = parsed?.content || obj.content || obj.text || JSON.stringify(obj)
        chatId = parsed?.chatId || ''
        if (content) {
          for (const chunk of [
            { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
          ]) {
            await writer.write(enc.encode('data: ' + JSON.stringify({
              id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
              model, choices: chunk.choices, ...(cid ? { _cid: cid } : {})
            }) + '\n\n'))
          }
        }
        await writer.write(enc.encode('data: [DONE]\n\n'))
        return
      }

      // NDJSON stream
      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')
      const decoder = new TextDecoder()
      let buffer = ''
      let chatId = ''
      let fullContent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer) {
            try {
              const json = JSON.parse(buffer)
              if (json.type === 'delta' && json.content) {
                fullContent += json.content
                await writer.write(enc.encode('data: ' + JSON.stringify({
                  id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                  model, choices: [{ index: 0, delta: { content: json.content }, finish_reason: null }],
                  _cid: cid || chatId
                }) + '\n\n'))
              } else if (json.type === 'error') {
                await writer.write(enc.encode('data: ' + JSON.stringify({
                  id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                  model, choices: [{ index: 0, delta: { content: '[Arko 錯誤: ' + (json.message || json.code || 'unknown') + ']' }, finish_reason: null }]
                }) + '\n\n'))
                if (!fullContent) fullContent = ''
              } else if (json.type === 'done') {
                const doneContent = extractDoneContent(json)
                if (doneContent) fullContent += doneContent
                if (!fullContent) fullContent = ''
              }
            } catch {}
          }
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines.filter(Boolean)) {
          try {
            const json = JSON.parse(line)
            if (json.type === 'chat' && json.id) {
              chatId = json.id
            } else if (json.type === 'delta' && json.content) {
              fullContent += json.content
              await writer.write(enc.encode('data: ' + JSON.stringify({
                id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                model, choices: [{ index: 0, delta: { content: json.content }, finish_reason: null }],
                _cid: cid || chatId
              }) + '\n\n'))
            } else if (json.type === 'error') {
              await writer.write(enc.encode('data: ' + JSON.stringify({
                id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                model, choices: [{ index: 0, delta: { content: '[Arko 錯誤: ' + (json.message || json.code || 'unknown') + ']' }, finish_reason: null }],
                ...(cid || chatId ? { _cid: cid || chatId } : {})
              }) + '\n\n'))
              if (!fullContent) fullContent = ''
            } else if (json.type === 'done') {
              // Extract content using robust multi-format handler
              const doneContent = extractDoneContent(json)
              if (doneContent) {
                if (doneContent !== fullContent) {
                  // Write assistant's actual response (avoids user prompt echo in deltas)
                  fullContent = doneContent
                  await writer.write(enc.encode('data: ' + JSON.stringify({
                    id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                    model, choices: [{ index: 0, delta: { content: doneContent }, finish_reason: null }],
                    _cid: cid || chatId
                  }) + '\n\n'))
                }
              }
              if (chatId && db && ctxHash) {
                try { await saveChatCid(db, ctxHash, chatId, currentAid) } catch {}
              }
              const finalCid = cid || chatId
              await writer.write(enc.encode('data: ' + JSON.stringify({
                id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                ...(finalCid ? { _cid: finalCid } : {})
              }) + '\n\n'))
              await writer.write(enc.encode('data: [DONE]\n\n'))
              return
            } else {
              // Fallback: try Arko JSON format (no type field)
              const fb = extractDoneContent(json)
              if (fb && !fullContent) {
                fullContent = fb
                await writer.write(enc.encode('data: ' + JSON.stringify({
                  id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
                  model, choices: [{ index: 0, delta: { content: fb }, finish_reason: null }],
                  ...(chatId ? { _cid: chatId } : {})
                }) + '\n\n'))
              }
            }
          } catch {}
        }
      }

      // Stream ended without done event — still close cleanly
      if (!fullContent) throw new Error('Empty stream')
      await writer.write(enc.encode('data: [DONE]\n\n'))
    } catch (e) {
      try {
        await writer.write(enc.encode('data: ' + JSON.stringify({
          id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        }) + '\n\n'))
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } catch {}
    } finally {
      try { await writer.close() } catch {}
    }
  })()

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  })
}

// ── OpenAI response formatters ────────────────────────────────────
function makeCompletionId() { return 'chatcmpl-' + (crypto.randomUUID()?.slice(0, 8) || Math.random().toString(36).slice(2, 10)) }

function openAIStreamResponse(model, text, cid) {
  const enc = new TextEncoder(); const { readable, writable } = new TransformStream()
  const w = writable.getWriter(); const sid = makeCompletionId()
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]
  ;(async () => {
    for (const c of chunks) {
      await w.write(enc.encode('data: ' + JSON.stringify({
        id: sid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model, choices: c.choices, ...(cid ? { _cid: cid } : {})
      }) + '\n\n'))
    }
    await w.write(enc.encode('data: [DONE]\n\n')); await w.close()
  })()
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  })
}

function openAICompletion(model, text, cid) {
  return {
    id: makeCompletionId(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    ...(cid ? { _cid: cid } : {})
  }
}

// ── Core proxy ────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const lastArkoCall = new Map()
let aidRotateCounter = 0

export async function proxyArko(provider, payload, stream, db, wsTimeoutMs) {
  const messages = payload.messages || []
  const model = payload.model || 'arko'
  const aid = provider.upstream_model
  if (!aid) throw new Error('Arko provider has no upstream_model configured')
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const systemMsg = messages.find(m => m.role === 'system')

  // Normalize content: array → extract text parts (handle vision/image payloads)
  const normalizeContent = (c) => {
    if (!c) return ''
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.filter(p => p.type === 'text').map(p => p.text || '').join(' ')
    return String(c)
  }

  const baseContent = normalizeContent(lastUser?.content)
  const sysContent = normalizeContent(systemMsg?.content)

  // Build [System Instructions] context from system message
  const ctxParts = []
  if (sysContent) ctxParts.push(sysContent)

  // Collect assistant messages under [Assistant Instructions] block
  const asstMsgs = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const c = normalizeContent(msg.content)
      if (c) asstMsgs.push(c)
    }
  }
  if (asstMsgs.length) {
    ctxParts.push('[Assistant Instructions]\n' + asstMsgs.join('\n\n'))
  }

  // Build conversation history from previous user messages (exclude last)
  const prevUserMsgs = []
  for (const msg of messages) {
    if (msg.role === 'user' && msg !== lastUser) {
      const c = normalizeContent(msg.content)
      if (c) prevUserMsgs.push(c)
    }
  }

  const ctxBlock = ctxParts.length ? ctxParts.join('\n\n') : 'You are a helpful AI assistant.'
  const histBlock = prevUserMsgs.length ? `\n\nConversation history:\nUser: ${prevUserMsgs.join('\nUser: ')}` : ''
  const contentWithSystem = `[System Instructions]\n${ctxBlock}${histBlock}\n\n${baseContent}`

  const url = provider.base_url.replace(/\/+$/, '') + '/v3/messages'
  const headers = { 'Content-Type': 'application/json' }
  if (provider.api_key) headers['Authorization'] = 'Bearer ' + provider.api_key

  const callArko = async (body, timeoutMs = wsTimeoutMs || 8000) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
      if (!r.ok) throw new Error('Arko HTTP ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 500))
      return r
    } finally { clearTimeout(timer) }
  }

  if (!contentWithSystem?.trim()) {
    throw new Error('Message content is empty')
  }

  // Non-tool path: plain text to arko
  const aids = healthyAids(aid.split(',').map(s => s.trim()).filter(Boolean))
  // If all AIDs are unhealthy, reset and try all
  if (!aids.length) {
    aidFailureCount.clear()
    aids.push(...aid.split(',').map(s => s.trim()).filter(Boolean))
  }
  const allUserMsgs = messages.filter(m => m.role === 'user').map(m => normalizeContent(m.content))

  // Compute saveHash from ALL user messages (for saving CID at end of this turn)
  // Compute lookupHash from PREVIOUS user messages (for finding existing CID)
  let aidOrder, ctxHash
  const prevMsgs = allUserMsgs.slice(0, allUserMsgs.length - (messages[messages.length - 1]?.role === 'user' ? 1 : 0))
  if (db && allUserMsgs.length) {
    const hashStr = JSON.stringify(allUserMsgs)
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashStr))
    ctxHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 64)
  }
  if (db && prevMsgs.length) {
    const hashStr2 = JSON.stringify(prevMsgs)
    const buf2 = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashStr2))
    const lookupHash = Array.from(new Uint8Array(buf2)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 64)
    const existing = await db.prepare(
      'SELECT aid FROM chat_cids WHERE ctx_hash = ? AND aid IN (' + aids.map(() => '?').join(',') + ') LIMIT 1'
    ).bind(lookupHash, ...aids).first()
    if (existing?.aid) {
      aidOrder = [existing.aid, ...aids.filter(a => a !== existing.aid)]
    }
  }
  if (!aidOrder) {
    // New conversation: rotate start AID for load balancing
    const offset = (aidRotateCounter++) % aids.length
    if (aidRotateCounter > 1000000) aidRotateCounter = aids.length
    aidOrder = [...aids.slice(offset), ...aids.slice(0, offset)]
  }

  let lastErr = null
  const isImageGen = likelyImageGen(contentWithSystem)
  const MAX_DURATION_MS = 29500
  const startTime = Date.now()
  const callTimeout = Math.min(wsTimeoutMs || 8000, isImageGen ? 15000 : 8000)

  while (Date.now() - startTime < MAX_DURATION_MS) {
    for (const currentAid of aidOrder) {
      if (Date.now() - startTime >= MAX_DURATION_MS) break

      const now = Date.now()
      const lastTime = lastArkoCall.get(currentAid) || 0
      if (now - lastTime < 500) await sleep(500 - (now - lastTime))
      lastArkoCall.set(currentAid, Date.now())

      let resolvedCid = payload.cid || null
      if (!resolvedCid && db && prevMsgs.length && ctxHash) {
        const row = await db.prepare('SELECT cid FROM chat_cids WHERE ctx_hash = ? AND aid = ?').bind(ctxHash, currentAid).first()
        if (row?.cid) resolvedCid = row.cid
      }

      const body = { content: contentWithSystem, stream: true, aid: currentAid, ...(resolvedCid ? { cid: resolvedCid } : {}) }
      try {
        const resp = await callArko(body, callTimeout)
        const parsed = await readArkoStream(resp)
        if (parsed.content) {
          if (db && parsed.chatId && ctxHash) {
            try { await saveChatCid(db, ctxHash, parsed.chatId, currentAid) } catch {}
          }
          markAidSuccess(currentAid)
          if (stream) return openAIStreamResponse(model, parsed.content, parsed.chatId || payload.cid)
          return openAICompletion(model, parsed.content, parsed.chatId || payload.cid)
        }
      } catch (e) {
        lastErr = e
        const status = e.message?.match(/Arko HTTP (\d+)/)?.[1] || 'unknown'
        markAidFailure(currentAid)
        console.error(`Arko attempt failed (aid=${currentAid.slice(0,8)} status=${status}):`, e.message?.slice(0, 200))
      }

      await sleep(500)
    }
  }
  throw new Error('Arko returned empty content after retries' + (lastErr ? ': ' + lastErr.message : ''))
}

// ── Arko admin helpers ────────────────────────────────────────────
async function arkoFetch(provider, body, timeoutMs = 10000) {
  const url = provider.base_url.replace(/\/+$/, '') + '/v3/messages'
  const h = { 'Content-Type': 'application/json' }
  if (provider.api_key) h['Authorization'] = 'Bearer ' + provider.api_key
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctrl.signal })
    return r
  } finally { clearTimeout(timer) }
}

export async function getAgentInfo(provider, aid) {
  const resp = await arkoFetch(provider, { content: 'ping', stream: true, aid })
  if (!resp.ok) return null
  const parsed = await readArkoStream(resp)
  const name = parsed.content ? parsed.content.slice(0, 200) : ''
  return { name, chatId: parsed.chatId }
}

export async function listAgents(provider, maxLimit = 200) {
  if (!provider?.api_key) return []
  const root = provider.base_url.replace(/\/+$/, '').replace(/\/v3(\/.*)?$/, '')
  const headers = { 'Authorization': 'Bearer ' + provider.api_key, 'Content-Type': 'application/json' }
  try {
    const allRows = []
    const pageSize = Math.min(maxLimit, 100)
    const maxPages = Math.min(Math.ceil(maxLimit / pageSize), 3) // cap at 3 pages for subrequest budget
    let offset = 0
    for (let page = 0; page < maxPages; page++) {
      const resp = await fetch(`${root}/v3/agents?limit=${pageSize}&offset=${offset}&order=DESC`, { headers })
      if (!resp.ok) break
      const body = await resp.json()
      const rows = body?.data?.rows || []
      const total = body?.data?.count || 0
      allRows.push(...rows)
      offset += pageSize
      if (allRows.length >= total || rows.length < pageSize) break
    }
    return allRows
  } catch { return [] }
}

export async function cleanupOldChats(provider, aid, knownAgents, db) {
  if (!provider?.api_key) return { cleaned: false, error: 'No API key configured', deleted: 0, agents: 0 }

  const root = provider.base_url.replace(/\/+$/, '').replace(/\/v3(\/.*)?$/, '')
  const headers = {
    'Authorization': 'Bearer ' + provider.api_key,
  }

  const retentionDays = 1
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const cutoffStr = cutoff.toISOString()

  let totalDeleted = 0
  let totalChecked = 0
  let offset = 0
  let pages = 0
  const MAX_PAGES = 5       // max chat list pages per invocation
  const MAX_DELETIONS = 30  // cap deletions to fit within Worker subrequest limit
  const PAGE_LIMIT = 50

  while (pages < MAX_PAGES && totalDeleted < MAX_DELETIONS) {
    pages++
    const resp = await fetch(`${root}/v3/chats?limit=${PAGE_LIMIT}&offset=${offset}&order=ASC`, { headers })
    if (!resp.ok) {
      return { cleaned: false, error: `List chats HTTP ${resp.status}`, checked: totalChecked, deleted: totalDeleted }
    }
    const body = await resp.json()
    if (!body?.success) {
      return { cleaned: false, error: body?.message || 'Arko list failed', checked: totalChecked, deleted: totalDeleted }
    }

    const rows = body.data?.rows || []
    if (!rows.length) break

    const toDelete = []
    for (const chat of rows) {
      totalChecked++
      if (totalDeleted >= MAX_DELETIONS) break
      if (!chat.created_at) continue
      if (chat.created_at >= cutoffStr) continue
      toDelete.push(chat.id)
    }

    // Delete matches concurrently in batches
    if (toDelete.length) {
      const batchSize = 4
      for (let i = 0; i < toDelete.length && totalDeleted < MAX_DELETIONS; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize)
        const results = await Promise.allSettled(batch.map(async (id) => {
          const r = await fetch(`${root}/v3/chats/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
          if (r.ok) {
            if (db) {
              await db.prepare('DELETE FROM chat_cids WHERE cid = ?').bind(id).run().catch(e => console.error('Failed to delete cid from D1:', e))
            }
            return true
          }
          if (r.status === 404) return true
          if (r.status === 403) console.error(`Cleanup DELETE 403 for chat ${id.slice(0,8)} — API key lacks chats:write scope`)
          else console.error(`Cleanup DELETE ${r.status} for chat ${id.slice(0,8)}`)
          return false
        }))
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) totalDeleted++
        }
      }
    }

    offset += PAGE_LIMIT
  }

  return { cleaned: true, checked: totalChecked, deleted: totalDeleted }
}

export async function testProviderConnection(provider) {
  try {
    // Only arko provider type is supported; config table has no type column, skip check
    const aid = provider.upstream_model || ''
    const resp = await arkoFetch(provider, { content: 'test', stream: true, aid })
    if (!resp.ok) return { ok: false, status: resp.status, error: (await resp.text()).slice(0, 200) }
    const parsed = await readArkoStream(resp)
    if (parsed.content || parsed.chatId) return { ok: true, status: resp.status }
    return { ok: false, error: 'No content from arko' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ── SSE Streaming with keepalive (replaces WebSocket) ──────────────
export async function proxyArkoSSE(provider, payload, db, wsTimeoutMs) {
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  const model = payload.model || 'arko'

  // Keepalive fires during await proxyArko() — CF Workers event loop
  // processes timers between async await points; network wait doesn't
  // count toward CPU time.
  const keepalive = setInterval(() => {
    try { writer.write(enc.encode(': keepalive\n\n')) } catch {}
  }, 5000)

  ;(async () => {
    try {
      const result = await proxyArko(provider, payload, true, db, wsTimeoutMs)
      clearInterval(keepalive)

      if (!(result instanceof Response)) throw new Error('Unexpected non-streaming result')

      const reader = result.body?.getReader()
      if (!reader) throw new Error('No response body')
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(enc.encode(decoder.decode(value, { stream: true })))
      }
    } catch (e) {
      try {
        await writer.write(enc.encode('data: ' + JSON.stringify({
          id: 'chatcmpl-err', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model, choices: [{ index: 0, delta: { content: '[錯誤: ' + e.message + ']' }, finish_reason: 'stop' }]
        }) + '\n\n'))
        await writer.write(enc.encode('data: [DONE]\n\n'))
      } catch {}
    } finally {
      clearInterval(keepalive)
      try { await writer.close() } catch {}
    }
  })()

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  })
}
