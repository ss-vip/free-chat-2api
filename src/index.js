import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  initDB, getClientToken, rotateClientToken,
  getDashboardPasswordHash, setDashboardPasswordHash,
  getProvider, updateProvider, sanitizeProvider,
  proxyWithArkoFallback, testProviderConnection, cleanupOldChats, listAgents,
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
  try { return JSON.parse(provider.models || '["*"]') } catch { return ['*'] }
}

app.get('/api/models', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const provider = await getProvider(c.env.DB)
  const models = parseModels(provider)
  return c.json(models.map(m => ({ id: m, provider_name: 'arko' })))
})

// ---- Playground ----
app.post('/api/playground/chat', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const { model, messages, ...rest } = await c.req.json()
  const provider = await getProvider(c.env.DB)
  const providers = provider ? [{ ...provider, enabled: true, priority: 1, type: 'arko', name: 'default' }] : []
  const stream = rest.stream !== false
  const payload = { model, messages, stream, ...rest }
  try {
    const result = await proxyWithArkoFallback(providers, model, payload, stream, c.env.DB)
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
  const models = parseModels(provider)
  return c.json({
    object: 'list',
    data: models.map(m => ({
      id: m,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'free-chat-api'
    }))
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
  const providers = provider ? [{ ...provider, enabled: true, priority: 1, type: 'arko', name: 'default' }] : []
  const stream = rest.stream !== false
  const payload = { model, messages, stream, ...rest }
  try {
    const result = await proxyWithArkoFallback(providers, model, payload, stream, c.env.DB)
    if (result instanceof Response) return result
    return c.json(result)
  } catch (e) {
    return c.json({ error: e.message }, 502)
  }
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
      agent_id: a.id,
      agent_name: a.name || '(unknown)',
      status: 'active'
    }))

    // Cleanup old chats for all discovered agents (skip rediscovery)
    let cleanup = null
    try {
      cleanup = await cleanupOldChats(provider, '', agents.map(a => a.id))
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
function dashboardHtml(origin) {
  return `<!DOCTYPE html>
<html lang="zh-TW" data-bs-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Free Chat API Dashboard</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>
:root{--sidebar-width:220px}
body{background:var(--bs-dark);min-height:100vh}
#loadingOverlay{position:fixed;inset:0;z-index:99999;background:var(--bs-dark);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
#loadingOverlay.hidden{display:none}
#loginOverlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
#loginOverlay.hidden{display:none}
.sidebar{width:var(--sidebar-width);position:fixed;top:56px;left:0;bottom:0;background:var(--bs-dark);border-right:1px solid var(--bs-border-color);overflow-y:auto;z-index:100}
.sidebar .nav-link{color:var(--bs-secondary-color);border-radius:0;padding:.65rem 1rem;cursor:pointer;border-left:3px solid transparent}
.sidebar .nav-link:hover{color:var(--bs-light);background:var(--bs-tertiary-bg)}
.sidebar .nav-link.active{color:var(--bs-info);border-left-color:var(--bs-info);background:rgba(13,202,240,.08)}
.main{margin-left:var(--sidebar-width);padding:1.5rem;padding-top:76px;min-height:calc(100vh - 56px)}
.page{display:none}
.page.active{display:block}
#page-playground.active{display:flex!important;flex-direction:column;height:calc(100vh - 56px - 76px - 24px)}
#page-playground.active .row{flex:1;min-height:0;flex-wrap:nowrap!important}
#page-playground.active .col-md-9{display:flex;flex-direction:column}
#page-playground.active .chat-box{flex:1;min-height:0;overflow-y:auto;height:auto!important}
#page-playground.active .input-group{flex-shrink:0}
#page-playground.active .input-group textarea{border-bottom-right-radius:0}
#page-playground.active .input-group .btn{border-top-left-radius:0;border-bottom-left-radius:0;min-height:calc(1.5em + .75rem + 4px)}
.welcome-section{text-align:center;padding:3rem 1rem}
.welcome-section h1{font-size:2.5rem;margin-bottom:.5rem}
.chat-box{overflow-y:auto;border:1px solid var(--bs-border-color);border-radius:var(--bs-border-radius);padding:1rem;background:var(--bs-tertiary-bg)}
.chat-box .msg{margin-bottom:.75rem;padding:.5rem .75rem;border-radius:var(--bs-border-radius);max-width:85%}
.chat-box .msg.user{background:var(--bs-info);color:var(--bs-dark);margin-left:auto}
.chat-box .msg.assistant{background:var(--bs-secondary-bg);color:var(--bs-light)}
.chat-box .msg.system{background:rgba(255,193,7,.15);color:var(--bs-warning);text-align:center;max-width:100%;font-size:.85rem}
.chat-box .msg.error{background:rgba(220,53,69,.15);color:var(--bs-danger);text-align:center;max-width:100%}
.token-display{font-family:monospace;background:var(--bs-tertiary-bg);padding:.5rem 1rem;border-radius:var(--bs-border-radius);word-break:break-all}
.toast-container{position:fixed;top:70px;right:1rem;z-index:99999}
.form-label{font-size:.875rem;color:var(--bs-secondary-color)}
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
      <pre class="text-start bg-dark p-3 rounded border border-secondary" style="font-size:.85rem"><code id="usageCode">curl https://your-worker.workers.dev/v1/chat/completions \\
  -H "Authorization: Bearer sk-xxx" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"openai","messages":[{"role":"user","content":"Hello"}]}'</code></pre>
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
            <input type="password" class="form-control" id="providerApiKey" placeholder="必填" autocomplete="new-password" required>
            <div class="form-text text-secondary" id="providerApiKeyHint">請輸入 API Key</div>
          </div>
          <div class="col-md-6">
            <label class="form-label">上游 Agent ID (必填)</label>
            <input type="text" class="form-control" id="providerUpstreamModel" placeholder="arko agent UUID" required>
            <div class="form-text text-secondary">對應 Arko Studio 的 Agent ID</div>
          </div>
          <div class="col-md-6">
            <label class="form-label">模型（逗號分隔，預設 * = 全部）</label>
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
      <div class="mb-3">
        <label class="form-label">Temperature</label>
        <input type="range" class="form-range" id="temperature" min="0" max="2" step="0.1" value="0.7">
        <span class="small text-secondary" id="tempVal">0.7</span>
      </div>
      <div class="mb-3">
        <label class="form-label">Max Tokens</label>
        <input type="number" class="form-control" id="maxTokens" value="2048" min="1" max="128000">
      </div>
      <div class="form-check mb-3">
        <input class="form-check-input" type="checkbox" id="streamToggle" checked>
        <label class="form-check-label">串流輸出</label>
      </div>
    </div>
    <div class="col-md-9">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <span class="text-secondary small">對話</span>
        <button class="btn btn-outline-danger btn-sm" onclick="clearChat()">🗑 清空</button>
      </div>
      <div class="chat-box" id="chatBox"></div>
      <div class="input-group">
        <textarea class="form-control" id="userInput" placeholder="輸入訊息... (Ctrl+Enter 發送)" rows="2" style="resize:none" onkeydown="if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();sendPlayground()}"></textarea>
        <button class="btn btn-info" id="playgroundSend" onclick="sendPlayground()">發送</button>
      </div>
    </div>
  </div>
</div>

</div>

<div class="toast-container" id="toastContainer"></div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js" defer></script>
<script>
const API_BASE = window.location.origin

function hideLoading() {
  const el = document.getElementById('loadingOverlay')
  if (el) el.classList.add('hidden')
}

function toast(msg, type='info') {
  const c = document.getElementById('toastContainer')
  const t = document.createElement('div')
  t.className = 'toast align-items-center text-bg-' + type + ' border-0 show'
  t.role = 'alert'
  t.innerHTML = '<div class="d-flex"><div class="toast-body">' + esc(String(msg)) + '</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>'
  c.appendChild(t)
  setTimeout(() => { t.remove() }, 3000)
}

async function api(path, opts = {}) {
  const resp = await fetch(API_BASE + path, { credentials: 'include', ...opts })
  if (resp.status === 401) { window.location.reload(); throw new Error('Unauthorized') }
  return resp
}

async function checkAuth() {
  try {
    const r = await fetch(API_BASE + '/api/auth/status', { credentials: 'include' })
    const d = await r.json()
    if (d.authed) { hideLoading(); onLogin(); return }
    if (!d.passwordRequired) {
      const lr = await fetch(API_BASE + '/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' })
      })
      const ld = await lr.json()
      if (ld.ok) { hideLoading(); onLogin(); return }
    }
  } catch { /* fallback below */ }
  hideLoading()
  const loginEl = document.getElementById('loginOverlay')
  if (loginEl) loginEl.classList.remove('hidden')
}

// Safety net: hide loading after 3s no matter what
setTimeout(hideLoading, 3000)
// Start auth check when DOM is ready
document.addEventListener('DOMContentLoaded', () => { checkAuth() })

async function doLogin() {
  const pw = document.getElementById('loginPassword').value
  const r = await fetch(API_BASE + '/api/auth/login', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  })
  const d = await r.json()
  if (d.ok) { onLogin(); return }
  document.getElementById('loginError').textContent = d.error || '登入失敗'
}

async function doLogout() {
  await api('/api/auth/logout', { method: 'POST' })
  window.location.reload()
}

function onLogin() {
  document.getElementById('loginOverlay').classList.add('hidden')
  document.getElementById('navStatus').textContent = '已登入'
  document.getElementById('logoutBtn').style.display = ''
  loadDashboard()
}

function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.getElementById('page-' + name).classList.add('active')
  document.querySelectorAll('.sidebar .nav-link').forEach(l => l.classList.remove('active'))
  document.querySelector('.sidebar .nav-link[data-page="' + name + '"]')?.classList.add('active')
  if (name === 'provider') loadProvider()
  if (name === 'settings') loadSettings()
  if (name === 'playground') loadPlayground()
  if (name === 'dashboard') loadDashboard()
}

async function loadDashboard() {
  try {
    const [pr, tk] = await Promise.all([
      api('/api/provider'), api('/api/client-token')
    ])
    const provider = await pr.json()
    const tok = await tk.json()
    const models = provider?.models ? (() => { try { return JSON.parse(provider.models) } catch { return [] } })() : []
    document.getElementById('statProvider').textContent = provider?.base_url ? '已設定' : '未設定'
    document.getElementById('statModels').textContent = Array.isArray(models) ? models.length : 0
    document.getElementById('apiEndpoint').textContent = API_BASE + '/v1'
    var _t = (tok.token || 'sk-xxx')
    var _curl = [
      'curl ' + API_BASE + '/v1/chat/completions \\\\',
      '  -H "Authorization: Bearer ' + _t + '" \\\\',
      '  -H "Content-Type: application/json" \\\\',
      "  -d '" + JSON.stringify({model: "openai", messages: [{role: "user", content: "Hello"}]}) + "'"
    ].join('\\n')
    document.getElementById('usageCode').textContent = _curl
  } catch {}
}

async function loadProvider() {
  try {
    const r = await api('/api/provider')
    const p = await r.json()
    document.getElementById('providerBaseUrl').value = p?.base_url || 'https://arko.arcaelas.com'
    document.getElementById('providerUpstreamModel').value = p?.upstream_model || ''
    const models = p?.models ? (() => { try { return JSON.parse(p.models).join(', ') } catch { return '' } })() : ''
    document.getElementById('providerModels').value = models
    document.getElementById('providerApiKey').value = ''
    document.getElementById('providerApiKeyHint').textContent = p?.api_key_set ? '✅ 已設定 API Key，留空則保留' : '⚠️ API Key 尚未設定（必填）'
  } catch {}
}

async function saveProvider() {
  let base_url = document.getElementById('providerBaseUrl').value.trim()
  const api_key = document.getElementById('providerApiKey').value
  const upstream_model = document.getElementById('providerUpstreamModel').value.trim()
  const modelsRaw = document.getElementById('providerModels').value.trim()
  const errEl = document.getElementById('providerFormError')
  base_url = base_url.replace(/\\/+$/, '') || 'https://arko.arcaelas.com'
  document.getElementById('providerBaseUrl').value = base_url
  if (!base_url) { errEl.textContent = '請輸入 API 網址'; return }
  if (!upstream_model) { errEl.textContent = '請輸入 Agent ID (上游提供者)'; return }
  errEl.textContent = ''
  const body = { base_url, upstream_model, models: modelsRaw ? modelsRaw.split(',').map(s => s.trim()).filter(Boolean) : ['*'] }
  if (api_key) body.api_key = api_key
  try {
    const r = await api('/api/provider', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const d = await r.json()
    if (!r.ok) { errEl.textContent = d.error || '儲存失敗'; return }
    toast('已儲存', 'success')
  } catch (e) { errEl.textContent = e.message || '儲存失敗' }
}

async function testProvider() {
  try {
    const r = await api('/api/provider/test', { method: 'POST' })
    const d = await r.json()
    if (d.ok) toast('連線成功 (' + d.status + ')', 'success')
    else toast('連線失敗: ' + (d.error || d.status || '未知錯誤'), 'danger')
  } catch (e) { toast('測試失敗: ' + e.message, 'danger') }
}

async function loadSettings() {
  const r = await api('/api/client-token')
  const d = await r.json()
  document.getElementById('clientTokenDisplay').textContent = d.token || '（無）'
  document.getElementById('passwordMsg').textContent = ''
  document.getElementById('tokenMsg').textContent = ''
}

async function changePassword() {
  const pw = document.getElementById('newPassword').value
  document.getElementById('passwordMsg').textContent = '更新中...'
  try {
    const r = await api('/api/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw })
    })
    const d = await r.json()
    if (d.ok) document.getElementById('passwordMsg').innerHTML = '<span class="text-success">密碼已更新</span>'
    else document.getElementById('passwordMsg').innerHTML = '<span class="text-danger">' + (d.error || '失敗') + '</span>'
  } catch { document.getElementById('passwordMsg').innerHTML = '<span class="text-danger">更新失敗</span>' }
}

function copyText(id) {
  const el = document.getElementById(id)
  const text = el.textContent || el.innerText
  if (!text) return
  navigator.clipboard.writeText(text.trim()).then(() => toast('已複製', 'success'))
}

function copyToken() {
  const t = document.getElementById('clientTokenDisplay').textContent
  if (!t || t === '（無）') return
  navigator.clipboard.writeText(t).then(() => toast('已複製 Token', 'success'))
}

async function rotateToken() {
  if (!confirm('重新產生後，舊 Token 將立即失效，確定？')) return
  const r = await api('/api/client-token/rotate', { method: 'POST' })
  const d = await r.json()
  if (d.token) {
    document.getElementById('clientTokenDisplay').textContent = d.token
    document.getElementById('tokenMsg').innerHTML = '<span class="text-success">已重新產生</span>'
    toast('Token 已更新', 'success')
  }
}

async function loadPlayground() {
  const r = await api('/api/models')
  const models = await r.json()
  const sel = document.getElementById('playgroundModel')
  sel.innerHTML = '<option value="">-- 選擇模型 --</option>'
  const seen = new Set()
  models.forEach(m => {
    if (seen.has(m.id)) return
    seen.add(m.id)
    sel.innerHTML += '<option value="' + esc(m.id) + '">' + esc(m.id) + '</option>'
  })
  sel.value = 'openai'
}

function clearChat() {
  document.getElementById('chatBox').innerHTML = ''
  chatCid = ''
  if (abortController) { abortController.abort(); abortController = null }
}
let abortController = null
let chatCid = ''

function buildConversationHistory() {
  const msgs = []
  const systemPrompt = document.getElementById('systemPrompt').value.trim()
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt })
  const bubbles = document.querySelectorAll('#chatBox .msg')
  bubbles.forEach(el => {
    if (el.classList.contains('user')) msgs.push({ role: 'user', content: el.textContent })
    if (el.classList.contains('assistant') && el.textContent.trim()) msgs.push({ role: 'assistant', content: el.textContent })
  })
  return msgs
}

async function sendPlayground() {
  const input = document.getElementById('userInput')
  const msg = input.value.trim()
  if (!msg) return
  const model = document.getElementById('playgroundModel').value
  if (!model) { toast('請選擇模型', 'warning'); return }
  const temp = parseFloat(document.getElementById('temperature').value) || 0.7
  const maxTokens = parseInt(document.getElementById('maxTokens').value) || 2048
  const chatBox = document.getElementById('chatBox')
  const messages = buildConversationHistory()
  messages.push({ role: 'user', content: msg })
  chatBox.innerHTML += '<div class="msg user">' + esc(msg) + '</div>'
  input.value = ''
  input.style.height = 'auto'
  chatBox.scrollTop = chatBox.scrollHeight
  const sendBtn = document.getElementById('playgroundSend')
  sendBtn.disabled = true
  sendBtn.textContent = '⏳ 等待回應...'
  const msgEl = document.createElement('div')
  msgEl.className = 'msg assistant'
  msgEl.textContent = '...'
  chatBox.appendChild(msgEl)
  chatBox.scrollTop = chatBox.scrollHeight
  if (abortController) abortController.abort()
  abortController = new AbortController()
  try {
    const r = await fetch(API_BASE + '/api/playground/chat', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, temperature: temp, max_tokens: maxTokens, cid: chatCid || undefined }),
      signal: abortController.signal
    })
    if (!r.ok) { const e = await r.json(); throw new Error(e.error || r.statusText) }
    const contentType = r.headers.get('Content-Type') || ''
    if (!contentType.includes('text/event-stream') && !contentType.includes('text/plain')) {
      const json = await r.json()
      const text = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || JSON.stringify(json)
      msgEl.textContent = text
      if (json._cid) chatCid = json._cid
      sendBtn.disabled = false
      sendBtn.textContent = '➤ 發送'
      return
    }
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    msgEl.textContent = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const content = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text || ''
          if (content) { fullText += content; msgEl.textContent = fullText }
          if (parsed._cid) chatCid = parsed._cid
        } catch {}
      }
      chatBox.scrollTop = chatBox.scrollHeight
    }
    if (!fullText) msgEl.textContent = '（無回應內容—請檢查伺服器日誌）'
  } catch (e) {
    if (e.name !== 'AbortError') {
      msgEl.className = 'msg error'
      msgEl.textContent = '錯誤: ' + e.message
    }
  }
  sendBtn.disabled = false
  sendBtn.textContent = '➤ 發送'
  chatBox.scrollTop = chatBox.scrollHeight
}

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML }

document.getElementById('temperature').addEventListener('input', function() { document.getElementById('tempVal').textContent = this.value })
document.getElementById('userInput').addEventListener('input', function() { this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 160) + 'px' })
</script>
</body></html>`
}
