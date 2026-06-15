// ── Token ──────────────────────────────────────────────────────────
export function generateToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return 'sk-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
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
  return { ...p, api_key_set: !!(p.api_key && p.api_key.length) }
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
  if (finalApiKey === undefined) {
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

// Find enabled providers matching model (keeps compatibility with proxyWithArkoFallback)
export function findProvidersForModel(providers, model) {
  const sorted = [...providers].filter(p => p.enabled).sort((a, b) => b.priority - a.priority)
  if (model === 'openai') return sorted
  const exact = sorted.filter(p => {
    try { return JSON.parse(p.models).includes(model) } catch { return false }
  })
  if (exact.length) return exact
  const wildcard = sorted.filter(p => {
    try {
      const m = JSON.parse(p.models)
      return m.includes('*') || m.includes('all')
    } catch { return false }
  })
  return wildcard
}

// ── Arko helpers ──────────────────────────────────────────────────
function extractToolDef(t) {
  let name, description, parameters
  if (t.type === 'function' && t.function) {
    name = t.function.name; description = t.function.description
    parameters = t.function.parameters || t.function.inputSchema
  } else if (t.name) {
    name = t.name; description = t.description || ''; parameters = t.parameters || t.inputSchema
  } else {
    return null
  }
  return { name, description: description || '', parameters: parameters || {} }
}

function buildArkoToolPrompt(tools) {
  if (!tools?.length) return ''
  const defs = tools.map(extractToolDef).filter(Boolean).map(({ name, description, parameters }) => {
    const entries = parameters?.properties ? Object.entries(parameters.properties) : []
    const req = parameters?.required || []
    const pt = entries.map(([k, v]) => {
      const r = req.includes(k) ? ' (required)' : ' (optional)'
      const d = v.description ? ' - ' + v.description : ''
      return '  ' + k + ': ' + (v.type || 'any') + d + r
    }).join('\n')
    return '* ' + name + (description ? ': ' + description : '') + '\n' + (pt || '  (no parameters)')
  }).join('\n\n')
  if (!defs) return ''
  return 'IMPORTANT: You MUST use these tools when asked. Output ONLY this JSON format:\n' +
    '{"name":"<tool_name>","arguments":{...}}\n\nAvailable tools:\n' + defs + '\n\n' +
    'Respond with ONLY the JSON above, no other text.'
}

function tryExtractToolCall(text, tools) {
  if (!text) return null
  const tryParse = (str) => {
    try {
      const o = JSON.parse(str)
      // Match extracted tool name against actual tool names (support short names from LLM)
      const resolveToolName = (extracted) => {
        if (!tools?.length || !extracted) return extracted
        const toolNames = tools.map(t => { const d = extractToolDef(t); return d?.name }).filter(Boolean)
        const e = String(extracted)
        if (toolNames.includes(e)) return e
        // Suffix match: arko might return "web_search_exa" without "PluggedinMCP_exa-search__"
        const suffix = toolNames.find(tn => tn.endsWith(e) || tn.endsWith('__' + e) || tn.toLowerCase().endsWith(e.toLowerCase()))
        if (suffix) return suffix
        // Normalized fuzzy match
        const norm = e.toLowerCase().replace(/[^a-z0-9]/g, '')
        const fuzzy = toolNames.find(tn => tn.toLowerCase().replace(/[^a-z0-9]/g, '') === norm)
        if (fuzzy) return fuzzy
        return e // keep original as fallback
      }

      if (o.name && o.arguments) {
        const id = 'call_' + (crypto.randomUUID()?.slice(0, 8) || Math.random().toString(36).slice(2, 10))
        const name = resolveToolName(o.name)
        return { id, type: 'function', function: { name, arguments: JSON.stringify(o.arguments) } }
      }
      if (o.call && typeof o.call === 'string') {
        const { call, ...args } = o
        const id = 'call_' + (crypto.randomUUID()?.slice(0, 8) || Math.random().toString(36).slice(2, 10))
        const name = resolveToolName(call)
        return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
      }
    } catch {}
    return null
  }
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim()
  let r = tryParse(cleaned)
  if (r) return r
  // Scan for top-level JSON objects
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{') {
      let depth = 1, j = i + 1
      while (j < cleaned.length && depth > 0) {
        if (cleaned[j] === '{') depth++
        else if (cleaned[j] === '}') depth--
        j++
      }
      if (depth === 0) {
        r = tryParse(cleaned.slice(i, j))
        if (r) return r
      }
    }
  }
  return null
}

// ── Tool intent scoring (metadata-only, no hardcoded mappings) ────
const INTENT_SYNONYMS = [
  ['look up', 'search'], ['lookup', 'search'],
  ['find out', 'search'], ['find', 'search'],
  ['fetch', 'search'], ['retrieve', 'search'],
  ['query', 'search'], ['check', 'search'],
  ['get', 'search'], ['tell me about', 'search'],
  ['run', 'execute'], ['launch', 'execute'],
  ['start', 'execute'],
  // Chinese synonyms
  ['搜尋', 'search'], ['搜索', 'search'], ['查詢', 'search'],
  ['查', 'search'], ['找', 'search'],
  ['獲取', 'fetch'], ['取得', 'fetch'], ['下載', 'fetch'],
  ['打開', 'open'], ['開啟', 'open'],
  ['分析', 'analyze'], ['總結', 'summarize'],
  ['天氣', 'weather'], ['新聞', 'news'],
]

function scoreToolRelevance(def, msg) {
  let score = 0
  const name = def.name.toLowerCase().replace(/_/g, ' ')
  const desc = (def.description || '').toLowerCase()
  const allMeta = name + ' ' + desc +
    (def.parameters?.properties ? ' ' + Object.keys(def.parameters.properties).join(' ') : '')
  const nameWords = [...new Set(name.split(/[_\s-]+/).filter(w => w.length > 2))]
  for (const w of nameWords) { if (msg.includes(w)) score += 15 }
  if (def.parameters?.properties) {
    const seen = new Set()
    for (const p of Object.keys(def.parameters.properties)) {
      const pk = p.toLowerCase()
      if (pk.length > 2 && !seen.has(pk) && msg.includes(pk)) { score += 10; seen.add(pk) }
    }
  }
  const descWords = [...new Set(desc.split(/\s+/).filter(w => w.length > 3))]
  for (const w of descWords) { if (msg.includes(w)) score += 3 }
  for (const [phrase, keyword] of INTENT_SYNONYMS) {
    if (msg.includes(phrase)) {
      const kw = keyword.toLowerCase()
      if (nameWords.some(w => w.includes(kw) || kw.includes(w)) ||
          descWords.some(w => w.includes(kw) || kw.includes(w)) ||
          allMeta.includes(kw)) score += 8
    }
  }
  // URL-aware adjustment: detect if the message contains actual URLs
  if (def.parameters?.properties) {
    const paramKeys = Object.keys(def.parameters.properties).map(k => k.toLowerCase())
    const hasUrlParam = paramKeys.some(k => ['url','urls','link','links','uri'].includes(k))
    const hasQueryParam = paramKeys.some(k => ['query','q','search','keyword'].includes(k))
    const hasUrlsInMsg = /https?:\/\/[^\s,;)]+/i.test(msg)
    if (hasUrlsInMsg && hasUrlParam) {
      score += 3  // message has URLs and tool accepts URLs → prefer it
    } else if (!hasUrlsInMsg) {
      if (hasUrlParam && !hasQueryParam) score -= 5  // pure fetch tool without URLs → penalize
      if (hasQueryParam) score += 3  // search-like tool when no URLs → prefer
    }
  }
  return score
}

function userIntendsTool(userMsg, tools) {
  if (!userMsg || !tools?.length) return false
  const msg = userMsg.trim().toLowerCase()
  if (/^(hi|hello|hey|嗨|你好|您好|哈囉|yo|sup)[\s!\.]*$/i.test(msg)) return false
  if (/^(good morning|good afternoon|good evening|how are you|how do you do|what's up|nice to meet you)[\s!\.]*$/i.test(msg)) return false
  if (msg.length < 3) return false
  for (const t of tools) {
    const d = extractToolDef(t)
    if (!d) continue
    if (scoreToolRelevance(d, msg) >= 8) return true
  }
  return false
}

const _STOP = new Set(['the','and','for','with','from','that','this','what','when','where','which','have','has','not','but','are','was','were','been','does','did','get','got','its','our','their','your','all','can','just','very','also','more','some','any','each','every','both','few','many','much','than','then','into','over','after','before','between','through','during','against','without','within','along','about','around','down','off','above','below','out','up','how','why','who','whom','whose'])

function generateMockToolCall(tools, userMsg) {
  if (!tools?.length) return null
  const msg = (userMsg || '').toLowerCase().trim()
  const rawMsg = (userMsg || '').trim()
  let best = null, bestScore = -1
  for (const t of tools) {
    const d = extractToolDef(t)
    if (!d) continue
    const s = scoreToolRelevance(d, msg)
    if (s > bestScore) { bestScore = s; best = d }
  }
  if (bestScore < 8) return null
  if (!best) { best = extractToolDef(tools[0]); if (!best) return null }

  const required = new Set(best.parameters?.required || [])
  const argsObj = {}
  if (best.parameters?.properties) {
    const msgWords = msg.split(/\s+/).filter(Boolean)
    const contentWords = msgWords.filter(w => w.length > 2 && !_STOP.has(w))
    const urlsFound = rawMsg.match(/https?:\/\/[^\s,;)]+/g) || []

    for (const [k, v] of Object.entries(best.parameters.properties)) {
      const type = v.type || 'string'
      const pk = k.toLowerCase()
      const isReq = required.has(k)
      let value = null

      if (type === 'string') {
        // Enum: use first allowed value
        if (v.enum?.length) {
          value = v.enum[0]
        } else if (v.format === 'uuid' || pk.includes('uuid') || pk === 'session_id' || pk.endsWith('_uuid')) {
          value = crypto.randomUUID?.() || '00000000-0000-0000-0000-000000000000'
        } else if (v.format === 'email' || pk.includes('email')) {
          value = 'user@example.com'
        } else if (v.format === 'uri' || v.format === 'url' || pk === 'url' || pk === 'uri') {
          value = urlsFound[0] || 'https://example.com'
        } else if (v.format === 'date-time' || v.format === 'date') {
          value = new Date().toISOString()
        } else if (v.format === 'ipv4') {
          value = '127.0.0.1'
        } else if (v.format === 'ipv6') {
          value = '::1'
        } else if (v.pattern) {
          value = rawMsg.slice(0, 100) || 'test'
        } else if (['query','q','search','keyword'].includes(pk)) {
          const ai = msgWords.findIndex(w => ['search','find','look','query','fetch','get','for','about','on'].includes(w))
          if (ai >= 0 && ai + 1 < msgWords.length) value = msgWords.slice(ai + 1).join(' ')
          else if (contentWords.length) value = contentWords.join(' ')
        } else if (['url','link','path','file','filename','name','id','title'].includes(pk)) {
          if (urlsFound.length) value = urlsFound[0]
          else {
            const pm = msg.match(/[\/\w\-.]+\.[a-z]{2,}(?:\/[^\s]*)?/)
            if (pm) value = pm[0]
            else if (contentWords.length) value = contentWords.slice(0, 3).join(' ')
          }
        } else if (['command','cmd'].includes(pk)) {
          const cm = msg.match(/(?:run|execute|command)\s+(.+)/i)
          if (cm) value = cm[1].trim()
        }
        if (!value && contentWords.length) value = contentWords.join(' ').slice(0, 500)
        else if (!value) value = rawMsg.slice(0, 500)
        if (value && !v.enum) value = value.replace(/^(?:for |about |on |command |run |execute |search |find |look up |fetch |check |get )/i, '').trim()
        // Min/Max length clamp
        if (value) {
          if (v.maxLength && value.length > v.maxLength) value = value.slice(0, v.maxLength)
          if (v.minLength && value.length < v.minLength) value = value.padEnd(v.minLength, 'x').slice(0, v.minLength)
        }
        if (!value) value = isReq ? 'test' : ''
      } else if (type === 'array') {
        if (['urls','links','ids'].includes(pk) && urlsFound.length) {
          value = urlsFound
        } else {
          const itemType = v.items?.type || 'string'
          let items = []
          if (itemType === 'object') {
            // Generate stub object with required sub-properties
            const stub = {}
            if (v.items?.properties) {
              for (const [sk, sv] of Object.entries(v.items.properties)) {
                const sReq = v.items.required?.includes(sk)
                const sr = sv.type || 'string'
                if (sr === 'string') stub[sk] = sv.enum?.[0] || (sReq ? sk : '')
                else if (sr === 'number' || sr === 'integer') stub[sk] = sv.minimum || 1
                else if (sr === 'boolean') stub[sk] = true
                else stub[sk] = null
              }
            }
            items = [stub]
          } else {
            items = contentWords.length ? contentWords.slice(0, 5) : []
            if (!items.length && isReq) items.push(rawMsg.slice(0, 100) || 'test')
          }
          value = items
        }
        // MinItems clamp
        if (v.minItems && value.length < v.minItems) {
          const fill = value.length ? value[0] : 'item'
          while (value.length < v.minItems) value.push(typeof fill === 'object' ? {...fill} : fill)
        }
      } else if (type === 'number' || type === 'integer') {
        const nm = msg.match(/\d+/)
        const min = v.minimum !== undefined ? v.minimum : -Infinity
        const max = v.maximum !== undefined ? v.maximum : Infinity
        const defVal = v.default !== undefined ? v.default : null
        if (nm) {
          value = parseInt(nm[0], 10)
          if (value < min) value = min
          if (value > max) value = max
        } else if (defVal !== null) {
          value = defVal
        } else {
          value = isReq ? (min > -Infinity ? min : 1) : (min > -Infinity ? min : null)
        }
      } else if (type === 'boolean') {
        value = pk.includes('dis') || pk.includes('hide') || pk.includes('disable') ? false : true
      } else if (type === 'object') {
        // Generate stub with sub-properties
        const stub = {}
        if (v.properties) {
          for (const [sk, sv] of Object.entries(v.properties)) {
            const sReq = v.required?.includes(sk)
            const sr = sv.type || 'string'
            if (sr === 'string') stub[sk] = sv.enum?.[0] || (sReq ? sk : '')
            else if (sr === 'number' || sr === 'integer') stub[sk] = sv.minimum || 1
            else if (sr === 'boolean') stub[sk] = true
            else if (sr === 'array') stub[sk] = []
            else if (sr === 'object') stub[sk] = {}
          }
        }
        value = Object.keys(stub).length ? stub : {}
      }

      if (value === null) {
        if (isReq) value = '' // will be caught by final check
        else continue // skip optional params with no value
      }
      argsObj[k] = value
    }
  }
  // ── Random UUID guard ──
  // If a required param was filled with a randomly-generated UUID (not from user msg),
  // skip mock — the referenced resource won't exist server-side.
  if (required.size > 0) {
    const msgHasUuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(msg)
    if (!msgHasUuid) {
      for (const k of required) {
        const val = argsObj[k]
        if (typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)) {
          return null // skip mock — UUID can't match a real resource
        }
      }
    }
  }
  const a = Object.keys(argsObj).length ? JSON.stringify(argsObj) : '{}'
  return {
    id: 'call_' + (crypto.randomUUID?.()?.slice(0, 8) || Math.random().toString(36).slice(2, 10)),
    type: 'function', function: { name: best.name, arguments: a }
  }
}

// ── Arko stream parsing ──────────────────────────────────────────
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
        else if (json.type === 'done') {
          if (json.content) full += json.content
          // Drain remaining buffer then stop
          if (json.messages?.length) {
            const msgs = json.messages
            const asst = [...msgs].reverse().find(m => m.role === 'assistant' && m.content)
            if (asst?.content) full = asst.content
          }
          // Consume remaining stream data quickly
          const drainReader = response.body?.getReader()
          if (drainReader) {
            try { while (!(await drainReader.read()).done) {} } catch {}
          }
          return { content: full.trim(), chatId }
        }
      } catch {}
    }
  }
  return { content: full.trim(), chatId }
}

// ── OpenAI response formatters ────────────────────────────────────
function makeCompletionId() { return 'chatcmpl-' + (crypto.randomUUID()?.slice(0, 8) || Math.random().toString(36).slice(2, 10)) }

function openAIStreamResponse(model, text, toolCall, cid) {
  const enc = new TextEncoder(); const { readable, writable } = new TransformStream()
  const w = writable.getWriter(); const sid = makeCompletionId()
  const chunks = toolCall ? [
    { choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.function.name, arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.function.arguments } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ] : [
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

function openAICompletion(model, text, toolCall, cid) {
  const msg = toolCall
    ? { role: 'assistant', content: null, tool_calls: [toolCall] }
    : { role: 'assistant', content: text }
  return {
    id: makeCompletionId(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    choices: [{ index: 0, message: msg, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
    ...(cid ? { _cid: cid } : {})
  }
}

// ── Core proxy ────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const lastArkoCall = new Map()
let aidRotateCounter = 0

export async function proxyArko(provider, payload, stream, db) {
  const messages = payload.messages || []
  const tools = payload.tools || payload.functions || []
  const hasTools = !!(tools.length)
  const lastMsg = messages[messages.length - 1] || {}
  const model = payload.model || 'arko'
  const aid = provider.upstream_model
  if (!aid) throw new Error('Arko provider has no upstream_model configured')
  const toolChoice = payload.tool_choice
  const toolsActive = hasTools && toolChoice !== 'none'

  // Tool result passthrough
  if (toolsActive && lastMsg.role === 'tool') {
    const r = lastMsg.content || ''
    return stream ? openAIStreamResponse(model, r, null, payload.cid) : openAICompletion(model, r, null, payload.cid)
  }

  // Tool intent detection
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const systemMsg = messages.find(m => m.role === 'system')
  const baseContent = lastUser?.content || ''
  const contentWithSystem = systemMsg ? `[System Instructions]\n${systemMsg.content}\n\n${baseContent}` : baseContent

  // Build tool descriptions (shared between tool and non-tool paths)
  let toolDesc = ''
  if (toolsActive && tools.length) {
    toolDesc = tools.map(t => {
      const d = extractToolDef(t)
      if (!d) return ''
      const params = d.parameters?.properties
        ? Object.entries(d.parameters.properties).map(([k, v]) => `    ${k} (${v.type || 'any'})${v.description ? ': ' + v.description : ''}`).join('\n')
        : ''
      return `- ${d.name}${d.description ? ': ' + d.description : ''}\n${params}`
    }).filter(Boolean).join('\n')
  }

  // Shared arko helpers
  const url = provider.base_url.replace(/\/+$/, '') + '/v3/messages'
  const headers = { 'Content-Type': 'application/json' }
  if (provider.api_key) headers['Authorization'] = 'Bearer ' + provider.api_key

  const callArko = async (body, timeoutMs = 8000) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
      if (!r.ok) throw new Error('Arko HTTP ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 500))
      return r
    } finally { clearTimeout(timer) }
  }

  const cleanParam = (v) => typeof v === 'string' ? v.replace(/^(?:for |about |on |command |run |execute |search |find |look up |fetch |check |get )/i, '').trim() : v
  const returnToolCall = (tc, cid) => {
    const args = JSON.parse(tc.function.arguments)
    // Sanitize args against tool schema constraints
    const tcDef = tools.find(t => { const d = extractToolDef(t); return d && d.name === tc.function.name })
    if (tcDef) {
      const def = extractToolDef(tcDef)
      if (def?.parameters?.properties) {
        for (const [k, v] of Object.entries(def.parameters.properties)) {
          if (!(k in args)) continue
          const val = args[k]
          const st = v.type || 'string'
          if ((st === 'number' || st === 'integer') && typeof val === 'number') {
            const min = v.minimum !== undefined ? v.minimum : -Infinity
            const max = v.maximum !== undefined ? v.maximum : Infinity
            let adj = val
            if (adj < min) adj = min
            if (adj > max) adj = max
            if (adj !== val) args[k] = adj
          } else if (st === 'string' && typeof val === 'string') {
            // Enum clamp
            if (v.enum?.length && !v.enum.includes(val)) {
              args[k] = v.enum[0]
            }
            // Min/Max length
            if (v.minLength && val.length < v.minLength) args[k] = val.padEnd(v.minLength, 'x').slice(0, v.minLength)
            if (v.maxLength && val.length > v.maxLength) args[k] = val.slice(0, v.maxLength)
          } else if (st === 'array' && Array.isArray(val)) {
            // Clamp array minItems/maxItems
            if (v.minItems && val.length < v.minItems) {
              const fill = val.length ? val[0] : 'item'
              while (val.length < v.minItems) val.push(fill)
            }
            if (v.maxItems) val.splice(v.maxItems)
            // Ensure items match item schema
            if (v.items?.type && val.length) {
              for (let i = 0; i < val.length; i++) {
                if (v.items.type === 'object' && typeof val[i] === 'string') {
                  try { val[i] = JSON.parse(val[i]) } catch { val[i] = {} }
                }
              }
            }
          }
        }
      }
    }
    for (const k of Object.keys(args)) args[k] = cleanParam(args[k])
    tc.function.arguments = JSON.stringify(args)
    const mt = JSON.stringify({ name: tc.function.name, arguments: args })
    return stream ? openAIStreamResponse(model, mt, tc, cid || payload.cid) : openAICompletion(model, mt, tc, cid || payload.cid)
  }
  const returnText = (text, cid) =>
    stream ? openAIStreamResponse(model, text, null, cid || payload.cid) : openAICompletion(model, text, null, cid || payload.cid)

  // Tool path: arko-aware extraction + metadata fallback
  if (toolsActive && userIntendsTool(baseContent, tools)) {
    // Phase 1: Ask arko (aware + extract combined)
    if (toolDesc) {
      const recentHistory = messages.slice(-5).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')
      const ep = `You are a parameter extraction assistant. Extract the tool call parameters from the user's request.\n\n` +
        `Available tools:\n${toolDesc}\n\n` +
        `Rules:\n` +
        `- Respond with ONLY valid JSON, no other text\n` +
        `- Format: {"name":"<exact_tool_name>","arguments":{<param>:<value>,...}}\n` +
        `- Extract actual values from the user request (e.g. if user says "search for cats", query should be "cats")\n` +
        `- If user provided a URL, include it exactly as given\n` +
        `- If a parameter is not mentioned in the request, guess a reasonable value\n` +
        `- If the user's intent does NOT match any tool, respond normally as a helpful assistant\n\n` +
        `Conversation History:\n${recentHistory}\n\nExtract parameters for the final User request.`
      try {
        const resp = await callArko({ content: ep, stream: true, aid }, 8000)
        const parsed = await readArkoStream(resp)
        const tc = tryExtractToolCall(parsed.content || '', tools)
          if (tc) {
            // Merge Phase 1 result with mock-generated fallback for missing/empty params
            const mockTc = generateMockToolCall(tools, baseContent)
            if (mockTc) {
              const p1 = JSON.parse(tc.function.arguments)
              const mockArgs = JSON.parse(mockTc.function.arguments)
              // Build schema constraint map for this tool
              const tcDef = tools.find(t => { const d = extractToolDef(t); return d && d.name === tc.function.name })
              const schemaProps = tcDef ? (extractToolDef(tcDef)?.parameters?.properties || {}) : {}
              for (const [k, val] of Object.entries(p1)) {
                // Keep Phase 1 value if non-empty; fall back to mock's value
                const isEmpty = val === '' || val === null || val === undefined || (Array.isArray(val) && val.length === 0)
                // Also replace if number violates minimum constraint
                const prop = schemaProps[k]
                const isNumViolation = !isEmpty && typeof val === 'number' && prop && (prop.type === 'number' || prop.type === 'integer') &&
                  prop.minimum !== undefined && val < prop.minimum
                if (isEmpty || isNumViolation) {
                  if (mockArgs[k] !== undefined) p1[k] = mockArgs[k]
                }
              }
              // Copy any params from mock that Phase 1 missed
              for (const [k, val] of Object.entries(mockArgs)) {
                if (!(k in p1) && val !== undefined && val !== null && val !== '') {
                  p1[k] = val
                }
              }
              tc.function.arguments = JSON.stringify(p1)
            }
          return returnToolCall(tc, parsed.chatId)
        }
      } catch {}
    }
    // Phase 2: Metadata extraction fallback
    const tc = generateMockToolCall(tools, baseContent)
    if (tc) return returnToolCall(tc, payload.cid)
  }

  // Tool awareness questions
  if (toolsActive && toolDesc && /what (tools?|can you)|capabilities|功能|工具有哪些/i.test(baseContent)) {
    return returnText('I have these tools available through my proxy:\n' + toolDesc, payload.cid)
  }

  // Non-tool path: plain text to arko
  const aids = aid.split(',').map(s => s.trim()).filter(Boolean)
  const allUserMsgs = messages.filter(m => m.role === 'user').map(m => m.content)

  // Determine AID order: if existing CID found, pin to that AID; otherwise rotate
  let aidOrder, ctxHash
  const prevMsgs = allUserMsgs.slice(0, allUserMsgs.length - (messages[messages.length - 1]?.role === 'user' ? 1 : 0))
  if (db && prevMsgs.length) {
    const hashStr = JSON.stringify(prevMsgs)
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashStr))
    ctxHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 64)
    // Find which AID has an existing CID for this conversation
    const existing = await db.prepare(
      'SELECT aid FROM chat_cids WHERE ctx_hash = ? AND aid IN (' + aids.map(() => '?').join(',') + ') LIMIT 1'
    ).bind(ctxHash, ...aids).first()
    if (existing?.aid) {
      // Pin to the AID that has context; remaining AIDs as fallback in original order
      aidOrder = [existing.aid, ...aids.filter(a => a !== existing.aid)]
    }
  }
  if (!aidOrder) {
    // New conversation: rotate start AID for load balancing
    const offset = (aidRotateCounter++) % aids.length
    aidOrder = [...aids.slice(offset), ...aids.slice(0, offset)]
  }

  let lastErr = null
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const currentAid of aidOrder) {
      // Per-agent throttle: at least 1s between calls to the same agent
      const now = Date.now()
      const lastTime = lastArkoCall.get(currentAid) || 0
      if (now - lastTime < 1000) await sleep(1000 - (now - lastTime))
      lastArkoCall.set(currentAid, Date.now())

      // Resolve cid for this specific AID
      let resolvedCid = payload.cid || null
      if (!resolvedCid && db && prevMsgs.length && ctxHash) {
        const row = await db.prepare('SELECT cid FROM chat_cids WHERE ctx_hash = ? AND aid = ?').bind(ctxHash, currentAid).first()
        if (row?.cid) resolvedCid = row.cid
      }

      const body = { content: contentWithSystem, stream: true, aid: currentAid, ...(resolvedCid ? { cid: resolvedCid } : {}) }
      try {
        const resp = await callArko(body, 8000)
        const parsed = await readArkoStream(resp)
        if (parsed.content) {
          // Save cid keyed by all user messages (stable for next turn)
          if (db && parsed.chatId && messages?.length) {
            if (allUserMsgs.length) {
              const hashStr = JSON.stringify(allUserMsgs)
              const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashStr))
              const newHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 64)
              await db.prepare(
                'INSERT OR REPLACE INTO chat_cids (ctx_hash, cid, aid, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
              ).bind(newHash, parsed.chatId, currentAid).run()
            }
          }
          return returnText(parsed.content, parsed.chatId)
        }
        // empty content → fall through
      } catch (e) {
        lastErr = e
      }

      await sleep(500) // delay before next attempt
    }
  }
  throw new Error('Arko returned empty content after retries' + (lastErr ? ': ' + lastErr.message : ''))
}

// ── Fallback: try arko providers in priority order ────────────────
export async function proxyWithArkoFallback(providers, model, payload, stream, db) {
  const candidates = findProvidersForModel(providers, model).filter(p => p.enabled)
  if (!candidates.length) throw new Error('No enabled arko provider available for model: ' + model)
  let lastErr = null
  for (const p of candidates) {
    try { return await proxyArko(p, payload, stream, db) } catch (e) { lastErr = e }
  }
  throw new Error('All arko providers failed: ' + (lastErr?.message || 'unknown'))
}

// ── Arko admin helpers ────────────────────────────────────────────
async function arkoFetch(provider, body) {
  const url = provider.base_url.replace(/\/+$/, '') + '/v3/messages'
  const h = { 'Content-Type': 'application/json' }
  if (provider.api_key) h['Authorization'] = 'Bearer ' + provider.api_key
  const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) })
  return r
}

export async function getAgentInfo(provider, aid) {
  const resp = await arkoFetch(provider, { content: 'ping', stream: true, aid })
  if (!resp.ok) return null
  const parsed = await readArkoStream(resp)
  const name = parsed.content ? parsed.content.slice(0, 200) : ''
  return { name, chatId: parsed.chatId }
}

export async function listAgents(provider) {
  if (!provider?.api_key) return []
  const root = provider.base_url.replace(/\/+$/, '').replace(/\/v3(\/.*)?$/, '')
  const headers = { 'Authorization': 'Bearer ' + provider.api_key, 'Content-Type': 'application/json' }
  try {
    const resp = await fetch(`${root}/v3/agents?limit=100&order=DESC`, { headers })
    if (!resp.ok) return []
    const body = await resp.json()
    return body?.data?.rows || []
  } catch { return [] }
}

export async function cleanupOldChats(provider, aid, knownAgents, db) {
  if (!provider?.api_key) return { cleaned: false, error: 'No API key configured', deleted: 0, agents: 0 }

  const root = provider.base_url.replace(/\/+$/, '').replace(/\/v3(\/.*)?$/, '')
  const headers = {
    'Authorization': 'Bearer ' + provider.api_key,
    'Content-Type': 'application/json'
  }

  // Determine target agents: use knownAgents if provided, otherwise discover
  let agentIds = []
  if (knownAgents?.length) {
    agentIds = knownAgents
  } else if (aid) {
    agentIds = [aid]
  } else {
    const resp = await fetch(`${root}/v3/agents?limit=100`, { headers })
    if (!resp.ok) return { cleaned: false, error: `List agents HTTP ${resp.status}`, deleted: 0, agents: 0 }
    const body = await resp.json()
    if (!body?.success) return { cleaned: false, error: body?.message || 'Arko list agents failed', deleted: 0, agents: 0 }
    agentIds = (body.data?.rows || []).map(a => a.id).filter(Boolean)
  }

  if (!agentIds.length) return { cleaned: true, checked: 0, deleted: 0, agents: 0 }
  const agentSet = new Set(agentIds)

  // Cutoff is 7 days ago, checking updated_at to protect active sessions
  const retentionDays = 7
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  const cutoffStr = cutoff.toISOString()

  let totalDeleted = 0
  let totalChecked = 0
  let offset = 0
  let pages = 0
  const MAX_PAGES = 3       // max chat list pages per invocation
  const MAX_DELETIONS = 15  // cap deletions to fit within Worker subrequest limit
  const PAGE_LIMIT = 20

  while (pages < MAX_PAGES && totalDeleted < MAX_DELETIONS) {
    pages++
    const resp = await fetch(`${root}/v3/chats?limit=${PAGE_LIMIT}&offset=${offset}&order=DESC&archived=false`, { headers })
    if (!resp.ok) {
      return { cleaned: false, error: `List chats HTTP ${resp.status}`, checked: totalChecked, deleted: totalDeleted, agents: agentIds.length }
    }
    const body = await resp.json()
    if (!body?.success) {
      return { cleaned: false, error: body?.message || 'Arko list failed', checked: totalChecked, deleted: totalDeleted, agents: agentIds.length }
    }

    const rows = body.data?.rows || []
    if (!rows.length) break

    const toDelete = []
    for (const chat of rows) {
      totalChecked++
      if (totalDeleted >= MAX_DELETIONS) break
      if (!agentSet.has(chat.agent?.id)) continue
      // Keep chats updated within the retention window
      if (chat.updated_at && chat.updated_at >= cutoffStr) continue
      toDelete.push(chat.id)
    }

    // Delete matches concurrently in batches
    if (toDelete.length) {
      const batchSize = 5
      for (let i = 0; i < toDelete.length && totalDeleted < MAX_DELETIONS; i += batchSize) {
        const batch = toDelete.slice(i, i + batchSize)
        const results = await Promise.allSettled(batch.map(async (id) => {
          const r = await fetch(`${root}/v3/chats/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
          if (r.ok || r.status === 204 || r.status === 404) {
            if (db) {
              await db.prepare('DELETE FROM chat_cids WHERE cid = ?').bind(id).run().catch(e => console.error('Failed to delete cid from D1:', e))
            }
            return true
          }
          return false
        }))
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value) totalDeleted++
        }
      }
    }

    offset += PAGE_LIMIT
  }

  return { cleaned: true, checked: totalChecked, deleted: totalDeleted, agents: agentIds.length }
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
