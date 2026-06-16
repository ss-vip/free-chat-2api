import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  initDB, getClientToken, rotateClientToken,
  getDashboardPasswordHash, setDashboardPasswordHash,
  getProvider, updateProvider, sanitizeProvider,
  proxyArko, testProviderConnection, cleanupOldChats, listAgents,
  proxyArkoViaWS,
  createSession, getValidSession, deleteSession, deleteExpiredSessions
} from './lib/db.js'
import {
  hashPassword, verifyPassword, verifyPasswordWithMeta, generateSessionToken,
  sessionCookie, clearSessionCookie, parseSessionCookie
} from './lib/auth.js'

const app = new Hono()
let dbInitialized = false

app.use('*', async (c, next) => {
  try {
    if (c.env.DB && !dbInitialized) {
      await initDB(c.env.DB)
      dbInitialized = true
    }
  } catch (e) {
    dbInitialized = false
    console.error('initDB failed:', e)
    return c.json({ error: 'Database initialization failed' }, 503)
  }
  await next()
})

app.use('/v1/*', cors({
  origin: '*',
  allowHeaders: ['*'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  exposeHeaders: ['*']
}))

async function requireAuth(c) {
  try {
    const passwordHash = await getDashboardPasswordHash(c.env.DB)
    if (!passwordHash) return true
    // Session cookie check
    const token = parseSessionCookie(c.req.header('Cookie'))
    if (token) {
      const session = await getValidSession(c.env.DB, token)
      if (session) return true
    }
    // X-Admin-Password header fallback
    const pw = c.req.header('X-Admin-Password')
    if (pw && passwordHash) return await verifyPassword(pw, passwordHash)
    return false
  } catch {
    return false
  }
}

function isSecureRequest(c) {
  const proto = c.req.header('X-Forwarded-Proto') || new URL(c.req.url).protocol.replace(':', '')
  return proto === 'https'
}

async function createAuthSession(c) {
  await deleteExpiredSessions(c.env.DB)
  const token = generateSessionToken()
  await createSession(c.env.DB, token)
  return token
}

// ---- Auth routes ----
app.get('/', async (c) => c.html(dashboardHtml(c.req.url)))

app.get('/api/auth/status', async (c) => {
  const authed = await requireAuth(c)
  const passwordHash = await getDashboardPasswordHash(c.env.DB)
  return c.json({ authed, passwordRequired: !!passwordHash })
})

app.post('/api/auth/login', async (c) => {
  const { password } = await c.req.json()
  const stored = await getDashboardPasswordHash(c.env.DB)
  if (stored) {
    const result = await verifyPasswordWithMeta(password, stored)
    if (!result.ok) return c.json({ error: '密碼錯誤' }, 401)
    if (result.needsUpgrade) {
      await setDashboardPasswordHash(c.env.DB, await hashPassword(password))
    }
  }
  const token = await createAuthSession(c)
  return c.json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, isSecureRequest(c)) })
})

app.post('/api/auth/logout', async (c) => {
  const token = parseSessionCookie(c.req.header('Cookie'))
  if (token) await deleteSession(c.env.DB, token)
  return c.json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(isSecureRequest(c)) })
})

app.post('/api/auth/password', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const { password } = await c.req.json()
  const oldToken = parseSessionCookie(c.req.header('Cookie'))
  if (oldToken) await deleteSession(c.env.DB, oldToken)
  if (password) {
    const hash = await hashPassword(password)
    await setDashboardPasswordHash(c.env.DB, hash)
    const token = await createAuthSession(c)
    return c.json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, isSecureRequest(c)) })
  }
  await setDashboardPasswordHash(c.env.DB, '')
  return c.json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(isSecureRequest(c)) })
})

// ---- Single provider config ----
app.get('/api/provider', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const p = await getProvider(c.env.DB)
  return c.json(sanitizeProvider(p))
})

app.put('/api/provider', async (c) => {
  try {
    if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
    const data = await c.req.json()
    const provider = await updateProvider(c.env.DB, data)
    return c.json(sanitizeProvider(provider))
  } catch (e) {
    console.error('PUT /api/provider error:', e)
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/provider/test', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const provider = await getProvider(c.env.DB)
  if (!provider) return c.json({ error: '尚未設定提供者' }, 404)
  const result = await testProviderConnection(provider)
  return c.json(result)
})

// ---- Client token ----
app.get('/api/client-token', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const token = await getClientToken(c.env.DB)
  return c.json({ token })
})

app.post('/api/client-token/rotate', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const token = await rotateClientToken(c.env.DB)
  return c.json({ token })
})

// ---- Models ----
function parseModels(provider) {
  if (!provider) return []
  try { return JSON.parse(provider.models || '["openai"]') } catch { return ['openai'] }
}

app.get('/api/models', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const provider = await getProvider(c.env.DB)
  return c.json([{ id: 'openai', name: 'openai', provider_name: 'arko' }])
})

// ---- Playground ----
app.post('/api/playground/chat', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const { model, messages, ...rest } = await c.req.json()
  const provider = await getProvider(c.env.DB)
  if (!provider) return c.json({ error: '尚未設定提供者' }, 404)
  const stream = rest.stream !== false
  const payload = { model, messages, stream, ...rest }
  try {
    const result = await proxyArko(provider, payload, stream, c.env.DB)
    if (result instanceof Response) return result
    return c.json(result)
  } catch (e) {
    return c.json({ error: e.message }, 502)
  }
})

app.get('/v1/models', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const stored = await getClientToken(c.env.DB)
  if (!stored || token !== stored) return c.json({ error: 'Unauthorized' }, 401)
  const provider = await getProvider(c.env.DB)
  if (!provider) return c.json({ object: 'list', data: [] })
  return c.json({
    object: 'list',
    data: [{
      id: 'openai',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'free-chat-api'
    }]
  })
})

app.post('/v1/chat/completions', async (c) => {
  const auth = c.req.header('Authorization') || ''
  const token = auth.replace('Bearer ', '')
  const stored = await getClientToken(c.env.DB)
  if (!stored || token !== stored) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json()
  const { model, messages, ...rest } = body
  const provider = await getProvider(c.env.DB)
  if (!provider) return c.json({ error: 'No provider configured' }, 503)
  const stream = rest.stream !== false
  const payload = { model, messages, stream, ...rest }
  try {
    const result = await proxyArko(provider, payload, stream, c.env.DB)
    if (result instanceof Response) return result
    return c.json(result)
  } catch (e) {
    return c.json({ error: e.message }, 502)
  }
})

// ---- WebSocket for long-running operations ----
app.get('/ws', async (c) => {
  const upgrade = c.req.header('Upgrade')
  if (upgrade?.toLowerCase() !== 'websocket') return c.text('Expected WebSocket upgrade', 426)

  const [client, server] = Object.values(new WebSocketPair())
  server.accept()

  // Auth via query param
  const queryToken = c.req.query('token')

  server.addEventListener('message', async (event) => {
    let payload
    try { payload = JSON.parse(event.data) } catch {
      server.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
      server.close(); return
    }

    const stored = await getClientToken(c.env.DB)
    const token = queryToken || payload.token || c.req.header('Authorization')?.replace('Bearer ', '')
    if (stored && token !== stored) {
      server.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }))
      server.close(); return
    }

    try {
      const provider = await getProvider(c.env.DB)
      if (!provider) throw new Error('No provider configured')
      await proxyArkoViaWS(provider, payload, server, c.env.DB)
    } catch (e) {
      server.send(JSON.stringify({ type: 'error', message: e.message }))
    } finally {
      server.close(1000, 'complete')
    }
  })

  return new Response(null, { status: 101, webSocket: client })
})

// ---- Debug ----
app.post('/api/debug/chat', async (c) => {
  const body = await c.req.json()
  const tools = body.tools || body.functions || []
  const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user')
  const baseContent = lastUser?.content || ''
  const info = {
    model: body.model,
    toolsCount: tools.length,
    toolsRaw: tools.map((t) => {
      if (typeof t !== 'object' || t === null) return { raw: String(t).slice(0, 100) }
      const f = t.function || {}
      const params = f.parameters || f.inputSchema || t.parameters || t.inputSchema
      return {
        type: t.type,
        name: f.name || t.name,
        hasDescription: !!(f.description || t.description),
        paramsType: params ? (params.type || 'none') : 'missing',
        paramsKeys: params?.properties ? Object.keys(params.properties) : [],
        paramsRequired: params?.required || []
      }
    }),
    message: {
      lastRole: (body.messages || []).slice(-1)[0]?.role,
      userContent: baseContent.slice(0, 200),
      messagesCount: (body.messages || []).length
    }
  }
  return c.json({ debug: info })
})

// ---- Health ----
app.get('/health', async (c) => {
  try {
    const provider = await getProvider(c.env.DB)
    if (!provider) return c.json({ ok: true, channels: { total: 0, active: 0, list: [] } })

    // List all agents
    const agents = await listAgents(provider)
    const channels = agents.map(a => ({
      agent_name: a.name || '(unknown)',
      status: 'active'
    }))

    // Cleanup old chats for all discovered agents (skip rediscovery)
    let cleanup = null
    try {
      cleanup = await cleanupOldChats(provider, '', agents.map(a => a.id), c.env.DB)
    } catch (e) {
      cleanup = { error: e.message }
    }

    return c.json({
      ok: true,
      timestamp: new Date().toISOString(),
      channels: {
        total: channels.length,
        active: channels.filter(c => c.status === 'active').length,
        list: channels
      },
      cleanup
    })
  } catch (e) {
    console.error('/health error:', e)
    return c.json({ ok: false, error: e.message }, 500)
  }
})

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: err.message || 'Internal Server Error' }, 500)
})

app.all('*', (c) => c.text('Not Found', 404))

export default app

// ── HTML template ─────────────────────────────────────────────────
// NOTE: The client-side script is extracted as a plain string to avoid
// nested backtick conflicts inside the outer HTML template literal.
// This also restores correct VS Code syntax highlighting.
const DASHBOARD_SCRIPT = [
  'const API_BASE = window.location.origin',
  '',
  'function hideLoading() {',
  '  const el = document.getElementById("loadingOverlay")',
  '  if (el) el.classList.add("hidden")',
  '}',
  '',
  'function toast(msg, type) {',
  '  type = type || "info"',
  '  const c = document.getElementById("toastContainer")',
  '  const t = document.createElement("div")',
  '  t.className = "toast align-items-center border-0 show"',
  '  if (type === "danger") t.style.borderColor = "rgba(220,53,69,0.5)"',
  '  else if (type === "warning") t.style.borderColor = "rgba(255,193,7,0.5)"',
  '  else t.style.borderColor = "rgba(13,202,240,0.5)"',
  '  t.role = "alert"',
  '  t.innerHTML = \'<div class="d-flex"><div class="toast-body">\' + esc(String(msg)) + \'</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>\'',
  '  c.appendChild(t)',
  '  setTimeout(function() { t.remove() }, 3000)',
  '}',
  '',
  'async function api(path, opts) {',
  '  opts = opts || {}',
  '  const resp = await fetch(API_BASE + path, Object.assign({ credentials: "include" }, opts))',
  '  if (resp.status === 401) { window.location.reload(); throw new Error("Unauthorized") }',
  '  return resp',
  '}',
  '',
  'async function checkAuth() {',
  '  try {',
  '    const r = await fetch(API_BASE + "/api/auth/status", { credentials: "include" })',
  '    const d = await r.json()',
  '    if (d.authed) { hideLoading(); onLogin(); return }',
  '    if (!d.passwordRequired) {',
  '      const lr = await fetch(API_BASE + "/api/auth/login", {',
  '        method: "POST", credentials: "include",',
  '        headers: { "Content-Type": "application/json" },',
  '        body: JSON.stringify({ password: "" })',
  '      })',
  '      const ld = await lr.json()',
  '      if (ld.ok) { hideLoading(); onLogin(); return }',
  '    }',
  '  } catch(e) { /* fallback below */ }',
  '  hideLoading()',
  '  const loginEl = document.getElementById("loginOverlay")',
  '  if (loginEl) loginEl.classList.remove("hidden")',
  '}',
  '',
  '// Safety net: hide loading after 3s no matter what',
  'setTimeout(hideLoading, 3000)',
  '// Start auth check when DOM is ready',
  'document.addEventListener("DOMContentLoaded", function() { checkAuth() })',
  '',
  'const loginPw = document.getElementById("loginPassword")',
  'loginPw.addEventListener("keydown", function(e) { if (e.key === "Enter") { e.preventDefault(); doLogin() } })',
  '',
  'async function doLogin() {',
  '  const pw = loginPw.value',
  '  const r = await fetch(API_BASE + "/api/auth/login", {',
  '    method: "POST", credentials: "include",',
  '    headers: { "Content-Type": "application/json" },',
  '    body: JSON.stringify({ password: pw })',
  '  })',
  '  const d = await r.json()',
  '  if (d.ok) { onLogin(); return }',
  '  document.getElementById("loginError").textContent = d.error || "登入失敗"',
  '}',
  '',
  'async function doLogout() {',
  '  await api("/api/auth/logout", { method: "POST" })',
  '  window.location.reload()',
  '}',
  '',
  'function onLogin() {',
  '  document.getElementById("loginOverlay").classList.add("hidden")',
  '  document.getElementById("navStatus").textContent = "已登入"',
  '  document.getElementById("logoutBtn").style.display = ""',
  '  loadDashboard()',
  '}',
  '',
  'function switchPage(name) {',
  '  document.querySelectorAll(".page").forEach(function(p) { p.classList.remove("active") })',
  '  document.getElementById("page-" + name).classList.add("active")',
  '  document.querySelectorAll(".sidebar .nav-link").forEach(function(l) { l.classList.remove("active") })',
  '  const lnk = document.querySelector(".sidebar .nav-link[data-page=\\"" + name + "\\"]")',
  '  if (lnk) lnk.classList.add("active")',
  '  if (name === "provider") loadProvider()',
  '  if (name === "settings") loadSettings()',
  '  if (name === "playground") loadPlayground()',
  '  if (name === "dashboard") loadDashboard()',
  '}',
  '',
  'async function loadDashboard() {',
  '  try {',
  '    const results = await Promise.all([api("/api/provider"), api("/api/client-token")])',
  '    const provider = await results[0].json()',
  '    const tok = await results[1].json()',
  '    var models = []',
  '    try { models = provider && provider.models ? JSON.parse(provider.models) : [] } catch(e) {}',
  '    document.getElementById("statProvider").textContent = provider && provider.base_url ? "已設定" : "未設定"',
  '    document.getElementById("statModels").textContent = Array.isArray(models) ? models.length : 0',
  '    document.getElementById("apiEndpoint").textContent = API_BASE + "/v1"',
  '    var _t = tok.token || "sk-xxx"',
  '    var _bs = String.fromCharCode(92)',
  '    var _q = String.fromCharCode(39)',
  '    var _curl = [',
  '      "curl " + API_BASE + "/v1/chat/completions " + _bs,',
  '      "  -H \\"Authorization: Bearer " + _t + "\\" " + _bs,',
  '      "  -H \\"Content-Type: application/json\\" " + _bs,',
  '      "  -d " + _q + JSON.stringify({model:"openai",messages:[{role:"user",content:"Hello"}]}) + _q',
  '    ].join("\\n")',
  '    document.getElementById("usageCode").textContent = _curl',
  '  } catch(e) {}',
  '}',
  '',
  'async function loadProvider() {',
  '  try {',
  '    const r = await api("/api/provider")',
  '    const p = await r.json()',
  '    document.getElementById("providerBaseUrl").value = (p && p.base_url) || "https://arko.arcaelas.com"',
  '    document.getElementById("providerUpstreamModel").value = (p && p.upstream_model) || ""',
  '    var models = ""',
  '    try { models = p && p.models ? JSON.parse(p.models).join(", ") : "" } catch(e) {}',
  '    document.getElementById("providerModels").value = models',
'    document.getElementById("providerApiKey").value = ""',
'    var keySet = p && p.api_key_set',
'    document.getElementById("providerApiKeyHint").textContent = keySet ? "✅ 已設定" : "⚠️ 尚未設定（必填）"',
'    document.getElementById("clearKeyBtn").style.display = keySet ? "inline-block" : "none"',
  '  } catch(e) {}',
  '}',
  '',
  'async function saveProvider() {',
  '  var base_url = document.getElementById("providerBaseUrl").value.trim()',
  '  var api_key = document.getElementById("providerApiKey").value',
  '  var upstream_model = document.getElementById("providerUpstreamModel").value.trim()',
  '  var modelsRaw = document.getElementById("providerModels").value.trim()',
  '  var errEl = document.getElementById("providerFormError")',
  '  base_url = base_url.replace(/\\/+$/, "") || "https://arko.arcaelas.com"',
  '  document.getElementById("providerBaseUrl").value = base_url',
  '  if (!base_url) { errEl.textContent = "請輸入 API 網址"; return }',
  '  if (!upstream_model) { errEl.textContent = "請輸入 Agent ID (上游提供者，多個以逗號分隔)"; return }',
  '  errEl.textContent = ""',
  '  var models = modelsRaw ? modelsRaw.split(",").map(function(s) { return s.trim() }).filter(Boolean) : ["*"]',
  '  var body = { base_url: base_url, upstream_model: upstream_model, models: models }',
  '  if (api_key) body.api_key = api_key',
  '  try {',
  '    const r = await api("/api/provider", {',
  '      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)',
  '    })',
  '    const d = await r.json()',
  '    if (!r.ok) { errEl.textContent = d.error || "儲存失敗"; return }',
  '    toast("已儲存", "success")',
  '  } catch(e) { errEl.textContent = e.message || "儲存失敗" }',
  '}',
  '',
  'async function testProvider() {',
  '  try {',
  '    const r = await api("/api/provider/test", { method: "POST" })',
  '    const d = await r.json()',
  '    if (d.ok) toast("連線成功 (" + d.status + ")", "success")',
  '    else toast("連線失敗: " + (d.error || d.status || "未知錯誤"), "danger")',
'  } catch(e) { toast("測試失敗: " + e.message, "danger") }',
'}',
'',
'async function clearApiKey() {',
'  if (!confirm("確定清除 API Key？")) return',
'  document.getElementById("providerFormError").textContent = ""',
'  try {',
'    const r = await api("/api/provider", {',
'      method: "PUT", headers: { "Content-Type": "application/json" },',
'      body: JSON.stringify({ clear_api_key: true })',
'    })',
'    const d = await r.json()',
'    if (!r.ok) { document.getElementById("providerFormError").textContent = d.error || "清除失敗"; return }',
'    toast("API Key 已清除", "success")',
'    loadProvider()',
'  } catch(e) { document.getElementById("providerFormError").textContent = e.message || "清除失敗" }',
'}',
'',
'async function loadSettings() {',
  '  const r = await api("/api/client-token")',
  '  const d = await r.json()',
  '  document.getElementById("clientTokenDisplay").textContent = d.token || "（無）"',
  '  document.getElementById("passwordMsg").textContent = ""',
  '  document.getElementById("tokenMsg").textContent = ""',
  '}',
  '',
  'async function changePassword() {',
  '  var pw = document.getElementById("newPassword").value',
  '  document.getElementById("passwordMsg").textContent = "更新中..."',
  '  try {',
  '    const r = await api("/api/auth/password", {',
  '      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw })',
  '    })',
  '    const d = await r.json()',
  '    if (d.ok) document.getElementById("passwordMsg").innerHTML = \'<span class="text-success">密碼已更新</span>\'',
  '    else document.getElementById("passwordMsg").innerHTML = \'<span class="text-danger">\' + (d.error || "失敗") + \'</span>\'',
  '  } catch(e) { document.getElementById("passwordMsg").innerHTML = \'<span class="text-danger">更新失敗</span>\' }',
  '}',
  '',
  'function copyText(id) {',
  '  var el = document.getElementById(id)',
  '  var text = el.textContent || el.innerText',
  '  if (!text) return',
  '  navigator.clipboard.writeText(text.trim()).then(function() { toast("已複製", "success") })',
  '}',
  '',
  'function copyToken() {',
  '  var t = document.getElementById("clientTokenDisplay").textContent',
  '  if (!t || t === "（無）") return',
  '  navigator.clipboard.writeText(t).then(function() { toast("已複製 Token", "success") })',
  '}',
  '',
  'async function rotateToken() {',
  '  if (!confirm("重新產生後，舊 Token 將立即失效，確定？")) return',
  '  const r = await api("/api/client-token/rotate", { method: "POST" })',
  '  const d = await r.json()',
  '  if (d.token) {',
  '    document.getElementById("clientTokenDisplay").textContent = d.token',
  '    document.getElementById("tokenMsg").innerHTML = \'<span class="text-success">已重新產生</span>\'',
  '    toast("Token 已更新", "success")',
  '  }',
  '}',
  '',
  'async function loadPlayground() {',
  '  const r = await api("/api/models")',
  '  const models = await r.json()',
  '  const sel = document.getElementById("playgroundModel")',
  '  sel.innerHTML = \'<option value="">-- 選擇模型 --</option>\'',
  '  var seen = new Set()',
  '  models.forEach(function(m) {',
  '    if (seen.has(m.id)) return',
  '    seen.add(m.id)',
  '    sel.innerHTML += \'<option value="\' + esc(m.id) + \'">\' + esc(m.name || m.id) + \'</option>\'',
  '  })',
  '  if (models.length > 0) {',
  '    sel.value = seen.has("openai") ? "openai" : models[0].id',
  '  }',
  '  renderHistory()',
  '}',
  '',
'function clearChat() {',
'  saveCurrentHistory()',
'  document.getElementById("chatBox").innerHTML = ""',
'  document.getElementById("systemPrompt").value = ""',
'  chatCid = ""',
'  if (abortController) { abortController.abort(); abortController = null }',
'}',
  '',
'function saveCurrentHistory() {',
'  var bubbles = document.querySelectorAll("#chatBox .msg")',
'  if (!bubbles.length) return',
'  var msgs = []',
'  var systemPrompt = document.getElementById("systemPrompt").value.trim()',
'  if (systemPrompt && bubbles.length) msgs.push({ role: "system", content: systemPrompt })',
'  bubbles.forEach(function(el) {',
'    var text = el.dataset.raw || el.textContent',
'    if (el.classList.contains("user")) msgs.push({ role: "user", content: text })',
'    if (el.classList.contains("assistant") && text.trim()) msgs.push({ role: "assistant", content: text })',
'  })',
'  if (!msgs.length) return',
'  var title = msgs[0]?.content?.slice(0,50) || "對話"',
'  var history = JSON.parse(localStorage.getItem("chatHistory") || "[]")',
'  var firstUser = ""',
'  for (var i = 0; i < msgs.length; i++) { if (msgs[i].role === "user") { firstUser = msgs[i].content.slice(0,50); break } }',
'  var convId = chatCid || document.getElementById("chatBox").dataset.convId || Date.now().toString()',
'  document.getElementById("chatBox").dataset.convId = convId',
'  var key = (firstUser || title) + "_" + convId',
'  var existing = -1',
'  for (var i = 0; i < history.length; i++) { if (history[i].key === key) { existing = i; break } }',
'  var entry = { key: key, title: title, msgs: msgs, cid: chatCid, ts: Date.now() }',
'  if (existing >= 0) { history[existing] = entry } else { history.unshift(entry) }',
'  localStorage.setItem("chatHistory", JSON.stringify(history))',
'  renderHistory()',
'}',
  '',
  'function renderHistory() {',
  '  var el = document.getElementById("convList")',
  '  if (!el) return',
'  var history = JSON.parse(localStorage.getItem("chatHistory") || "[]")',
'  var sorted = history.slice().sort(function(a,b) { return b.ts - a.ts })',
'  var html = ""',
'  html += "<button class=\'list-group-item list-group-item-action\' onclick=\'startNewChat()\'><strong>＋ 發起新對話</strong></button>"',
'  sorted.forEach(function(h, idx) {',
'    html += "<div class=\'list-group-item list-group-item-action d-flex justify-content-between align-items-center\' data-index=\'" + idx + "\' onclick=\'loadHistory(this)\'>"',
'    html += "<span class=\'text-truncate\' style=\'max-width:160px\'>" + esc(h.title) + "</span>"',
'    html += "<button class=\'btn btn-sm btn-outline-danger\' data-index=\'" + idx + "\' onclick=\'event.stopPropagation();deleteHistory(this)\'>✕</button>"',
'    html += "</div>"',
'  })',
  '  el.innerHTML = html',
  '}',
  '',
'function startNewChat() {',
'  saveCurrentHistory()',
'  document.getElementById("chatBox").innerHTML = ""',
'  document.getElementById("systemPrompt").value = ""',
'  document.getElementById("chatBox").dataset.convId = Date.now().toString()',
'  chatCid = ""',
'  if (abortController) { abortController.abort(); abortController = null }',
'}',
  '',
'function loadHistory(el) {',
'  var idx = parseInt(el.dataset.index)',
'  var history = JSON.parse(localStorage.getItem("chatHistory") || "[]")',
'  var sorted = history.slice().sort(function(a,b) { return b.ts - a.ts })',
'  if (idx < 0 || idx >= sorted.length) return',
'  var entry = sorted[idx]',
   '  document.getElementById("chatBox").innerHTML = ""',
   '  chatCid = entry.cid || ""',
   '  document.getElementById("chatBox").dataset.convId = chatCid || entry.key || ""',
  '  if (abortController) { abortController.abort(); abortController = null }',
  '  for (var j = 0; j < entry.msgs.length; j++) {',
  '    var m = entry.msgs[j]',
  '    if (m.role === "system") { document.getElementById("systemPrompt").value = m.content; continue }',
  '    var d = document.createElement("div")',
  '    d.className = "msg " + m.role',
  '    d.dataset.raw = m.content',
  '    if (m.role === "user") { d.textContent = m.content }',
  '    else { d.innerHTML = window.marked ? marked.parse(m.content) : esc(m.content) }',
  '    document.getElementById("chatBox").appendChild(d)',
  '  }',
  '  if (window.hljs) enhanceCode(document.getElementById("chatBox"))',
  '}',
  '',
'function deleteHistory(el) {',
'  var idx = parseInt(el.dataset.index)',
'  var history = JSON.parse(localStorage.getItem("chatHistory") || "[]")',
'  var sorted = history.slice().sort(function(a,b) { return b.ts - a.ts })',
'  if (idx < 0 || idx >= sorted.length) return',
'  var entry = sorted[idx]',
'  var realIdx = history.indexOf(entry)',
'  if (realIdx >= 0) history.splice(realIdx, 1)',
'  localStorage.setItem("chatHistory", JSON.stringify(history))',
'  renderHistory()',
'}',
  '',
  'function clearAllHistory() {',
  '  if (!confirm("確定刪除所有歷史對話？")) return',
  '  localStorage.removeItem("chatHistory")',
  '  renderHistory()',
  '}',
'var abortController = null',
'var chatCid = ""',
'var lastSendTime = 0',
'',
'function buildConversationHistory() {',
  '  var msgs = []',
  '  var systemPrompt = document.getElementById("systemPrompt").value.trim()',
  '  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt })',
  '  var bubbles = document.querySelectorAll("#chatBox .msg")',
  '  bubbles.forEach(function(el) {',
  '    var text = el.dataset.raw || el.textContent',
  '    if (el.classList.contains("user")) msgs.push({ role: "user", content: text })',
  '    if (el.classList.contains("assistant") && text.trim()) msgs.push({ role: "assistant", content: text })',
  '  })',
  '  return msgs',
  '}',
  '',
'async function sendPlayground() {',
'  var now = Date.now()',
'  if (now - lastSendTime < 2000) { await new Promise(function(r) { setTimeout(r, 2000 - (now - lastSendTime)) }) }',
'  var input = document.getElementById("userInput")',
'  var msg = input.value.trim()',
'  if (!msg) return',
'  var model = document.getElementById("playgroundModel").value',
'  if (!model) { toast("請選擇模型", "warning"); return }',
  '  saveCurrentHistory()',
  '  var chatBox = document.getElementById("chatBox")',
  '  var messages = buildConversationHistory()',
  '  messages.push({ role: "user", content: msg })',
  '  var umsg = document.createElement("div")',
  '  umsg.className = "msg user"',
  '  umsg.dataset.raw = msg',
  '  umsg.textContent = msg',
  '  chatBox.appendChild(umsg)',
  '  input.value = ""',
  '  input.style.height = "auto"',
  '  chatBox.scrollTop = chatBox.scrollHeight',
  '  var sendBtn = document.getElementById("playgroundSend")',
  '  sendBtn.disabled = true',
  '  sendBtn.textContent = "⏳ 思考中..."',
  '  var msgEl = document.createElement("div")',
  '  msgEl.className = "msg assistant"',
  '  msgEl.innerHTML = \'<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>\'',
  '  chatBox.appendChild(msgEl)',
  '  chatBox.scrollTop = chatBox.scrollHeight',
  '  if (abortController) abortController.abort()',
  '  abortController = new AbortController()',
  '  try {',
  '    var r = await fetch(API_BASE + "/api/playground/chat", {',
  '      method: "POST", credentials: "include",',
  '      headers: { "Content-Type": "application/json" },',
  '      body: JSON.stringify({ model: model, messages: messages, stream: true, cid: chatCid || undefined }),',
  '      signal: abortController.signal',
  '    })',
  '    if (!r.ok) { var ej = await r.json(); throw new Error(ej.error || r.statusText) }',
  '    var contentType = r.headers.get("Content-Type") || ""',
  '    if (!contentType.includes("text/event-stream") && !contentType.includes("text/plain")) {',
  '      var json = await r.json()',
  '      var text = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? JSON.stringify(json)',
'      msgEl.dataset.raw = text',
'      msgEl.innerHTML = window.marked ? marked.parse(text) : esc(text)',
'      if (window.hljs) enhanceCode(msgEl)',
 '      if (json._cid) chatCid = json._cid',
 '      saveCurrentHistory()',
 '      sendBtn.disabled = false',
 '      sendBtn.textContent = "➤ 發送"',
 '      return',
  '    }',
  '    var reader = r.body.getReader()',
  '    var decoder = new TextDecoder()',
  '    var buffer = ""',
  '    var fullText = ""',
  '    var hasStarted = false',
  '    while (true) {',
  '      var chunk = await reader.read()',
  '      if (chunk.done) break',
  '      buffer += decoder.decode(chunk.value, { stream: true })',
  '      var lines = buffer.split("\\n")',
  '      buffer = lines.pop() || ""',
  '      for (var i = 0; i < lines.length; i++) {',
  '        var line = lines[i]',
  '        if (!line.startsWith("data: ")) continue',
  '        var data = line.slice(6)',
  '        if (data === "[DONE]") continue',
  '        try {',
  '          var parsed = JSON.parse(data)',
  '          var content = parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.text ?? ""',
  '          if (content) {',
  '            if (!hasStarted) { hasStarted = true; msgEl.innerHTML = "" }',
  '            fullText += content',
  '            msgEl.dataset.raw = fullText',
  '            msgEl.innerHTML = window.marked ? marked.parse(fullText) : esc(fullText)',
  '          }',
  '          if (parsed._cid) chatCid = parsed._cid',
  '        } catch(e) {}',
  '      }',
  '      chatBox.scrollTop = chatBox.scrollHeight',
  '    }',
'  if (!fullText && !hasStarted) {',
'    // SSE empty — retry without CID (start fresh) via streaming',
'    try {',
'      var r2 = await fetch(API_BASE + "/api/playground/chat", {',
'        method: "POST", credentials: "include",',
'        headers: { "Content-Type": "application/json" },',
'        body: JSON.stringify({ model: model, messages: messages, stream: true }),',
'        signal: abortController.signal',
'      })',
'      if (r2.ok) {',
'        var reader2 = r2.body.getReader()',
'        var buf2 = ""',
'        while (true) {',
'          var c2 = await reader2.read()',
'          if (c2.done) break',
'          buf2 += new TextDecoder().decode(c2.value, { stream: true })',
'          var ls2 = buf2.split("\\n")',
'          buf2 = ls2.pop() || ""',
'          for (var j = 0; j < ls2.length; j++) {',
'            var ln = ls2[j]',
'            if (!ln.startsWith("data: ")) continue',
'            var d2 = ln.slice(6)',
'            if (d2 === "[DONE]") continue',
'            try {',
'              var p2 = JSON.parse(d2)',
'              var ct2 = p2?.choices?.[0]?.delta?.content ?? ""',
'              if (ct2) {',
'                if (!hasStarted) { hasStarted = true; msgEl.innerHTML = "" }',
'                fullText += ct2',
'                msgEl.dataset.raw = fullText',
'                msgEl.innerHTML = window.marked ? marked.parse(fullText) : esc(fullText)',
'              }',
'              if (p2._cid) chatCid = p2._cid',
'            } catch(e) {}',
'          }',
'          chatBox.scrollTop = chatBox.scrollHeight',
'        }',
'      }',
'    } catch(e) {}',
'    if (!fullText) msgEl.textContent = "\uff08\u7121\u56de\u61c9\u5167\u5bb9\uff09"',
'  }',
 '  if (fullText) saveCurrentHistory()',
 '  if (fullText && window.hljs) enhanceCode(msgEl)',
   '  } catch(e) {',
  '    if (e.name !== "AbortError") {',
  '      msgEl.className = "msg error"',
  '      msgEl.textContent = "錯誤: " + e.message',
  '    }',
  '  }',
'  sendBtn.disabled = false',
'  sendBtn.textContent = "➤ 發送"',
'  lastSendTime = Date.now()',
'  chatBox.scrollTop = chatBox.scrollHeight',
'}',
  '',
  'function esc(s) { if (!s) return ""; var d = document.createElement("div"); d.textContent = s; return d.innerHTML }',
'',
'function enhanceCode(container) {',
'  container.querySelectorAll("pre code").forEach(function(el) {',
'    var pre = el.parentElement',
'    if (pre.parentElement.classList.contains("code-wrapper")) return',
'    hljs.highlightElement(el)',
'    var lang = (el.className.match(/language-(\w+)/) || [])[1] || ""',
'    var wrapper = document.createElement("div")',
'    wrapper.className = "code-wrapper"',
'    var header = document.createElement("div")',
'    header.className = "code-header"',
'    if (lang) {',
'      var langSpan = document.createElement("span")',
'      langSpan.className = "code-lang"',
'      langSpan.textContent = lang',
'      header.appendChild(langSpan)',
'    }',
'    var btn = document.createElement("button")',
'    btn.className = "copy-btn"',
'    btn.textContent = "複製"',
'    btn.onclick = function() {',
'      var code = pre.textContent',
'      navigator.clipboard.writeText(code).then(function() {',
'        btn.textContent = "已複製!"',
'        setTimeout(function() { btn.textContent = "複製" }, 2000)',
'      })',
'    }',
'    header.appendChild(btn)',
'    pre.parentElement.insertBefore(wrapper, pre)',
'    wrapper.appendChild(header)',
'    wrapper.appendChild(pre)',
'  })',
'}',
'',
'document.getElementById("userInput").addEventListener("input", function() { this.style.height = "auto"; this.style.height = Math.min(this.scrollHeight, 160) + "px" })',
';document.getElementById("userInput").addEventListener("keydown", function(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPlayground() } })',
].join('\n')

function dashboardHtml(origin) {
  return `<!DOCTYPE html>
<html lang="zh-TW" data-bs-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Free Chat API Dashboard</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
:root{
  --sidebar-width:240px;
  --glass-bg: rgba(20, 20, 25, 0.7);
  --glass-border: rgba(255, 255, 255, 0.08);
  --accent: #0dcaf0;
  --bg-gradient: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
}
body{font-family:'Inter',sans-serif;background:var(--bg-gradient);background-attachment:fixed;color:#f8f9fa;min-height:100vh}
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
#loadingOverlay{position:fixed;inset:0;z-index:99999;background:var(--bg-gradient);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;backdrop-filter:blur(10px)}
#loadingOverlay.hidden{display:none}
#loginOverlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(12px)}
#loginOverlay.hidden{display:none}
.card, .sidebar, .navbar { background: var(--glass-bg) !important; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--glass-border) !important; }
.sidebar{width:var(--sidebar-width);position:fixed;top:56px;left:0;bottom:0;overflow-y:auto;z-index:100;transition:transform 0.3s ease}
.sidebar .nav-link{color:#adb5bd;border-radius:8px;margin:0.25rem 0.75rem;padding:.65rem 1rem;transition:all 0.2s ease}
.sidebar .nav-link:hover{color:#fff;background:rgba(255,255,255,0.05);transform:translateX(4px)}
.sidebar .nav-link.active{color:var(--accent);background:rgba(13,202,240,0.1);font-weight:500}
.main{margin-left:var(--sidebar-width);padding:2rem;padding-top:80px;min-height:calc(100vh - 56px)}
.card{border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);transition:transform 0.2s ease, box-shadow 0.2s ease}
.card:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(0,0,0,0.3)}
.form-control, .form-select { background: rgba(0,0,0,0.2) !important; border: 1px solid var(--glass-border) !important; color: #fff !important; border-radius: 8px; }
.form-control:focus, .form-select:focus { box-shadow: 0 0 0 0.25rem rgba(13,202,240,0.25); border-color: var(--accent) !important; }
.page{display:none}
.page.active{display:block;animation:fadeIn 0.4s ease}
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
#page-playground.active{display:flex!important;flex-direction:column;height:calc(100vh - 56px - 80px - 24px)}
#page-playground.active .row{flex:1;min-height:0;flex-wrap:nowrap!important}
#page-playground.active .col-md-9{display:flex;flex-direction:column}
#page-playground.active .chat-box{flex:1;min-height:0;overflow-y:auto;height:auto!important}
#page-playground.active .input-group{flex-shrink:0}
#page-playground.active .input-group textarea{border-bottom-right-radius:0}
#page-playground.active .input-group .btn{border-top-left-radius:0;border-bottom-left-radius:0;min-height:calc(1.5em + .75rem + 4px)}
.welcome-section{text-align:center;padding:3rem 1rem}
.welcome-section h1{font-size:2.5rem;margin-bottom:.5rem;font-weight:600;background:linear-gradient(to right,#fff,#0dcaf0);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.chat-box{overflow-y:auto;border:1px solid var(--glass-border);border-radius:12px;padding:1.5rem;background:rgba(0,0,0,0.15);box-shadow:inset 0 2px 10px rgba(0,0,0,0.1)}
.chat-box .msg{margin-bottom:1rem;padding:0.85rem 1.2rem;border-radius:12px;max-width:85%;animation:slideIn 0.3s cubic-bezier(0.16,1,0.3,1);line-height:1.6;word-wrap:break-word}
@keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.chat-box .msg.user{background:linear-gradient(135deg,#6c757d 0%,#495057 100%);color:#e2e8f0;margin-left:auto;border-bottom-right-radius:4px;box-shadow:0 4px 15px rgba(108,117,125,0.2)}
.chat-box .msg.assistant{background:var(--glass-bg);color:#e2e8f0;border-bottom-left-radius:4px;border:1px solid var(--glass-border);box-shadow:0 4px 15px rgba(0,0,0,0.1)}
.chat-box .msg.assistant p:last-child{margin-bottom:0}
.chat-box .msg.assistant pre { background: rgba(0,0,0,0.3); border-radius: 8px; padding: 1rem; border: 1px solid var(--glass-border); overflow-x: auto; margin: 0; border-top-left-radius: 0; border-top-right-radius: 0; }
.chat-box .msg.assistant .code-wrapper { margin-bottom: 1rem; border-radius: 8px; overflow: hidden; }
.chat-box .msg.assistant .code-header { display: flex; justify-content: space-between; align-items: center; padding: 0.35rem 0.75rem; background: rgba(0,0,0,0.4); border: 1px solid var(--glass-border); border-bottom: none; border-radius: 8px 8px 0 0; }
.chat-box .msg.assistant .code-lang { font-size: 0.75rem; color: #8b949e; text-transform: lowercase; }
.chat-box .msg.assistant .copy-btn { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 4px; border: 1px solid var(--glass-border); background: transparent; color: #8b949e; cursor: pointer; transition: all 0.2s; }
.chat-box .msg.assistant .copy-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
.chat-box .msg.system{background:rgba(255,193,7,.1);color:var(--bs-warning);text-align:center;max-width:100%;font-size:.85rem;border:1px solid rgba(255,193,7,.2)}
.chat-box .msg.error{background:rgba(220,53,69,.1);color:#ff6b6b;text-align:center;max-width:100%;border:1px solid rgba(220,53,69,.2)}
.token-display{font-family:monospace;background:rgba(0,0,0,0.2);padding:0.75rem 1rem;border-radius:8px;border:1px solid var(--glass-border);word-break:break-all}
.toast-container{position:fixed;top:70px;right:1rem;z-index:99999}
.toast{background:var(--glass-bg)!important;backdrop-filter:blur(12px);border:1px solid var(--glass-border)!important;color:#fff!important}
.form-label{font-size:.875rem;color:#adb5bd;font-weight:500}
.typing-indicator{display:inline-flex;gap:4px;padding:4px 8px}
.typing-dot{width:6px;height:6px;background:#adb5bd;border-radius:50%;animation:typing 1.4s infinite ease-in-out both}
.typing-dot:nth-child(1){animation-delay:-0.32s}
.typing-dot:nth-child(2){animation-delay:-0.16s}
@keyframes typing{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
</style>
</head>
<body>

<div id="loadingOverlay">
  <div class="spinner-border text-info" style="width:2.5rem;height:2.5rem" role="status"></div>
  <div class="text-secondary small">載入中...</div>
</div>

<div id="loginOverlay" class="hidden">
  <div class="card border-0" style="min-width:320px;background:var(--bs-tertiary-bg)">
    <div class="card-body p-4 text-center">
      <h4 class="mb-1">🔐 Dashboard</h4>
      <p class="text-secondary small mb-3">請輸入管理密碼</p>
      <div class="mb-3">
        <input type="password" id="loginPassword" class="form-control" placeholder="管理密碼" autocomplete="current-password">
      </div>
      <button class="btn btn-info w-100" onclick="doLogin()">登入</button>
      <div id="loginError" class="text-danger small mt-2"></div>
    </div>
  </div>
</div>

<nav class="navbar navbar-dark bg-dark border-bottom border-secondary fixed-top" style="z-index:200">
  <div class="container-fluid">
    <span class="navbar-brand mb-0 h6">⚡ Free Chat API</span>
    <div class="d-flex align-items-center gap-2">
      <span class="text-secondary small" id="navStatus">未登入</span>
      <button class="btn btn-outline-secondary btn-sm" onclick="doLogout()" id="logoutBtn" style="display:none">登出</button>
    </div>
  </div>
</nav>

<div class="sidebar" id="sidebar">
  <ul class="nav flex-column mt-2">
    <li class="nav-item"><a class="nav-link active" data-page="dashboard" onclick="switchPage('dashboard')">📊 概覽</a></li>
    <li class="nav-item"><a class="nav-link" data-page="provider" onclick="switchPage('provider')">📡 API 提供者</a></li>
    <li class="nav-item"><a class="nav-link" data-page="settings" onclick="switchPage('settings')">🔧 設定</a></li>
    <li class="nav-item"><a class="nav-link" data-page="playground" onclick="switchPage('playground')">🎮 Playground</a></li>
  </ul>
</div>

<div class="main">

<div class="page active" id="page-dashboard">
  <div class="welcome-section">
    <h1>⚡ Free Chat API</h1>
    <div class="row mt-4 justify-content-center">
      <div class="col-md-3 col-6 mb-3">
        <div class="card bg-tertiary-bg border-secondary h-100">
          <div class="card-body text-center">
            <div class="h2 mb-1" id="statProvider">—</div>
            <div class="text-secondary small">提供者狀態</div>
          </div>
        </div>
      </div>
      <div class="col-md-3 col-6 mb-3">
        <div class="card bg-tertiary-bg border-secondary h-100">
          <div class="card-body text-center">
            <div class="h2 mb-1" id="statModels">0</div>
            <div class="text-secondary small">可用模型</div>
          </div>
        </div>
      </div>
    </div>
    <div class="mt-4">
      <div class="d-flex align-items-center gap-2 mb-2">
        <span class="text-secondary small">API 端點</span>
        <button class="btn btn-sm btn-outline-secondary py-0" onclick="copyText('apiEndpoint')">📋</button>
      </div>
      <div class="token-display" id="apiEndpoint"></div>
    </div>
    <div class="mt-3">
      <div class="d-flex align-items-center gap-2 mb-2">
        <span class="text-secondary small">使用方式</span>
        <button class="btn btn-sm btn-outline-secondary py-0" onclick="copyText('usageCode')">📋</button>
      </div>
      <pre class="text-start bg-dark p-3 rounded border border-secondary" style="font-size:.85rem"><code id="usageCode"></code></pre>
    </div>
  </div>
</div>

<div class="page" id="page-provider">
  <h5 class="mb-3">📡 API 提供者</h5>
  <div class="card bg-tertiary-bg border-secondary">
    <div class="card-body">
      <form id="providerForm" onsubmit="saveProvider();return false">
        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label">API 網址</label>
            <input type="text" class="form-control" id="providerBaseUrl" placeholder="https://arko.arcaelas.com" required>
            <div class="form-text text-secondary">預設為 Arko API</div>
          </div>
          <div class="col-md-6">
            <label class="form-label">API Key</label>
            <input type="text" class="form-control" id="providerApiKey" placeholder="必填">
            <div class="d-flex align-items-center gap-2 mt-1">
              <div class="form-text text-secondary mb-0" id="providerApiKeyHint">請輸入 API Key</div>
              <button type="button" class="btn btn-outline-danger btn-sm py-0" id="clearKeyBtn" style="display:none" onclick="clearApiKey()">清除 Key</button>
            </div>
          </div>
          <div class="col-md-6">
            <label class="form-label">上游 Agent ID (必填)</label>
            <input type="text" class="form-control" id="providerUpstreamModel" placeholder="uuid1, uuid2, ..." required>
            <div class="form-text text-secondary">對應 Arko Studio 的 Agent ID，多個以逗號分隔自動輪詢</div>
          </div>
          <div class="col-md-6">
            <label class="form-label">模型</label>
            <input type="text" class="form-control" id="providerModels" placeholder="*">
          </div>
        </div>
        <div id="providerFormError" class="text-danger small mt-2"></div>
        <div class="mt-3 d-flex gap-2">
          <button type="submit" class="btn btn-info btn-sm">儲存</button>
          <button type="button" class="btn btn-outline-secondary btn-sm" onclick="testProvider()">測試連線</button>
        </div>
      </form>
    </div>
  </div>
</div>

<div class="page" id="page-settings">
  <h5 class="mb-3">🔧 設定</h5>
  <div class="row g-4">
    <div class="col-md-6">
      <div class="card bg-tertiary-bg border-secondary h-100">
        <div class="card-body">
          <h6 class="card-title">管理密碼</h6>
          <div class="mb-3">
            <label class="form-label">新密碼（留空 = 不須密碼）</label>
            <input type="password" id="newPassword" class="form-control" placeholder="新密碼" autocomplete="new-password">
          </div>
          <button class="btn btn-info btn-sm" onclick="changePassword()">更新密碼</button>
          <div id="passwordMsg" class="small mt-2"></div>
        </div>
      </div>
    </div>
    <div class="col-md-6">
      <div class="card bg-tertiary-bg border-secondary h-100">
        <div class="card-body">
          <h6 class="card-title">Client API Token</h6>
          <p class="text-secondary small">用於呼叫 /v1/* API 的 Bearer Token</p>
          <div class="token-display mb-2" id="clientTokenDisplay"></div>
          <div class="d-flex gap-2">
            <button class="btn btn-outline-info btn-sm" onclick="copyToken()">📋 複製</button>
            <button class="btn btn-warning btn-sm" onclick="rotateToken()">🔄 重新產生</button>
          </div>
          <div id="tokenMsg" class="small mt-2"></div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="page" id="page-playground">
  <h5 class="mb-3">🎮 Playground</h5>
  <div class="row g-3">
    <div class="col-md-3">
      <div class="mb-3">
        <label class="form-label">模型</label>
        <select class="form-select" id="playgroundModel"><option value="">-- 選擇模型 --</option></select>
      </div>
      <div class="mb-3">
        <label class="form-label">System Prompt</label>
        <textarea class="form-control" id="systemPrompt" rows="3" placeholder="可選的系統提示"></textarea>
      </div>
      <div id="convHistory">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <label class="form-label mb-0">歷史對話</label>
          <button class="btn btn-outline-danger btn-sm" onclick="clearAllHistory()">全部刪除</button>
        </div>
        <div id="convList" class="list-group list-group-flush" style="max-height:300px;overflow-y:auto"></div>
      </div>
    </div>
    <div class="col-md-9">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="text-secondary small">對話</span>
        <button class="btn btn-outline-danger btn-sm" onclick="clearChat()">🗑 清空</button>
      </div>
      <div class="chat-box" id="chatBox"></div>
      <div class="input-group">
        <textarea class="form-control" id="userInput" placeholder="輸入訊息... (Enter 發送, Shift+Enter 換行)" rows="3" style="resize:none"></textarea>
        <button class="btn btn-info" id="playgroundSend" onclick="sendPlayground()">發送</button>
      </div>
    </div>
  </div>
</div>

</div>

<div class="toast-container" id="toastContainer"></div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" defer><\/script>
<script>${DASHBOARD_SCRIPT}<\/script>
</body></html>`
}
