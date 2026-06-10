export function dashboardHtml(origin) {
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
.table-providers th{background:var(--bs-tertiary-bg);font-size:.85rem;text-transform:uppercase;letter-spacing:.5px}
.model-badge{font-size:.75rem;margin:2px;display:inline-block}
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

<div id="loginOverlay">
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
    <li class="nav-item"><a class="nav-link" data-page="providers" onclick="switchPage('providers')">📡 API 提供者</a></li>
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
            <div class="h2 mb-1" id="statProviders">0</div>
            <div class="text-secondary small">提供者</div>
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

<div class="page" id="page-providers">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="mb-0">📡 API 提供者</h5>
    <button class="btn btn-info btn-sm" onclick="showProviderModal()">＋ 新增提供者</button>
  </div>
  <div class="table-responsive">
    <table class="table table-dark table-hover align-middle table-providers">
      <thead><tr>
        <th>名稱</th><th>API 網址</th><th>模型</th><th>狀態</th><th>操作</th>
      </tr></thead>
      <tbody id="providerTableBody"></tbody>
    </table>
  </div>
  <div id="noProviders" class="text-center text-secondary py-5" style="display:none">
    <p>尚未新增任何 API 提供者</p>
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
        <input type="text" class="form-control" id="userInput" placeholder="輸入訊息..." onkeydown="if(event.key==='Enter')sendPlayground()">
        <button class="btn btn-info" id="playgroundSend" onclick="sendPlayground()">發送</button>
      </div>
    </div>
  </div>
</div>

</div>

<div class="modal fade" id="providerModal" tabindex="-1">
  <div class="modal-dialog modal-lg">
    <div class="modal-content bg-dark border-secondary">
      <div class="modal-header border-secondary">
        <h5 class="modal-title" id="providerModalTitle">新增提供者</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="providerId">
        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label">名稱</label>
            <input type="text" class="form-control" id="providerName" placeholder="My OpenAI Proxy">
          </div>
          <div class="col-md-6">
            <label class="form-label">類型</label>
            <select class="form-select" id="providerType" onchange="onProviderTypeChange()">
              <option value="openai">openai</option>
              <option value="chatwithfiction">chatwithfiction</option>
              <option value="gemini">gemini</option>
            </select>
          </div>
          <div class="col-12">
            <label class="form-label">API 網址</label>
            <input type="text" class="form-control" id="providerBaseUrl" placeholder="https://api.example.com/v1">
            <div class="form-text text-secondary" id="providerBaseUrlHint">gemini 類型可留空使用預設端點</div>
          </div>
          <div class="col-12">
            <label class="form-label">API Key</label>
            <input type="password" class="form-control" id="providerApiKey" placeholder="選填" autocomplete="new-password">
            <div class="form-text text-secondary" id="providerApiKeyHint"></div>
          </div>
          <div class="col-12">
            <label class="form-label">模型（逗號分隔）</label>
            <input type="text" class="form-control" id="providerModels" placeholder="gpt-4o, gpt-4o-mini 或 * 代表全部">
          </div>
          <div class="col-md-6">
            <label class="form-label">優先順序</label>
            <input type="number" class="form-control" id="providerPriority" value="0">
          </div>
          <div class="col-md-6 d-flex align-items-end">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" id="providerEnabled" checked>
              <label class="form-check-label" for="providerEnabled">啟用</label>
            </div>
          </div>
        </div>
        <div id="providerFormError" class="text-danger small mt-2"></div>
      </div>
      <div class="modal-footer border-secondary">
        <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">取消</button>
        <button type="button" class="btn btn-info btn-sm" onclick="saveProvider()">儲存</button>
      </div>
    </div>
  </div>
</div>

<div class="toast-container" id="toastContainer"></div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
const API_BASE = window.location.origin

document.addEventListener('DOMContentLoaded', () => {
  checkAuth()
})

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
    if (d.authed) { onLogin(); return }
    if (!d.passwordRequired) {
      const lr = await fetch(API_BASE + '/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: '' })
      })
      const ld = await lr.json()
      if (ld.ok) { onLogin(); return }
    }
  } catch {}
  document.getElementById('loginOverlay').classList.remove('hidden')
}

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
  if (name === 'providers') loadProviders()
  if (name === 'settings') loadSettings()
  if (name === 'playground') loadPlayground()
  if (name === 'dashboard') loadDashboard()
}

async function loadDashboard() {
  try {
    const [pr, mr, tk] = await Promise.all([
      api('/api/providers'), api('/api/models'), api('/api/client-token')
    ])
    const providers = await pr.json()
    const models = await mr.json()
    const tok = await tk.json()
    document.getElementById('statProviders').textContent = providers.length
    document.getElementById('statModels').textContent = models.length
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

async function loadProviders() {
  const r = await api('/api/providers')
  const list = await r.json()
  const tbody = document.getElementById('providerTableBody')
  const noProv = document.getElementById('noProviders')
  tbody.innerHTML = ''
  if (!list.length) { noProv.style.display = ''; return }
  noProv.style.display = 'none'
  list.forEach(p => {
    let models = []
    try { models = JSON.parse(p.models) || [] } catch {}
    const modelsHtml = models.map(m => '<span class="badge bg-secondary model-badge">' + esc(m) + '</span>').join(' ')
    tbody.innerHTML += '<tr>' +
      '<td><strong>' + esc(p.name) + '</strong><br><span class="badge bg-dark border border-secondary">' + esc(p.type || 'openai') + '</span></td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(p.base_url) + '">' + esc(p.base_url || '—') + '</td>' +
      '<td>' + (modelsHtml || '<span class="text-secondary small">無</span>') + '</td>' +
      '<td>' + (p.enabled ? '<span class="badge bg-success">啟用</span>' : '<span class="badge bg-secondary">停用</span>') + '</td>' +
      '<td class="text-nowrap">' +
        '<button class="btn btn-outline-info btn-sm me-1" onclick="editProvider(' + p.id + ')">編輯</button>' +
        (p.enabled
          ? '<button class="btn btn-outline-warning btn-sm me-1" onclick="toggleProvider(' + p.id + ')">停用</button>'
          : '<button class="btn btn-outline-success btn-sm me-1" onclick="toggleProvider(' + p.id + ')">啟用</button>') +
        '<button class="btn btn-outline-secondary btn-sm me-1" onclick="testProvider(' + p.id + ')">測試</button>' +
        '<button class="btn btn-outline-danger btn-sm" onclick="deleteProvider(' + p.id + ')">刪除</button>' +
      '</td></tr>'
  })
}

async function toggleProvider(id) {
  const r = await api('/api/providers')
  const list = await r.json()
  const p = list.find(x => x.id === id)
  if (!p) return
  await api('/api/providers/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !p.enabled })
  })
  loadProviders()
  toast(p.enabled ? '已停用' : '已啟用', 'success')
}

async function deleteProvider(id) {
  if (!confirm('確定刪除此提供者？')) return
  await api('/api/providers/' + id, { method: 'DELETE' })
  loadProviders()
  toast('已刪除', 'success')
}

let providerModal
function getProviderModal() {
  if (!providerModal) providerModal = new bootstrap.Modal(document.getElementById('providerModal'))
  return providerModal
}

function onProviderTypeChange() {
  const type = document.getElementById('providerType').value
  const hint = document.getElementById('providerBaseUrlHint')
  hint.textContent = type === 'gemini' ? 'gemini 類型可留空使用預設端點' : '必填（例如 https://api.openai.com/v1）'
}

function parseModelsInput(value) {
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

function showProviderModal(provider) {
  document.getElementById('providerFormError').textContent = ''
  document.getElementById('providerId').value = provider ? provider.id : ''
  document.getElementById('providerModalTitle').textContent = provider ? '編輯提供者' : '新增提供者'
  document.getElementById('providerName').value = provider ? provider.name : ''
  document.getElementById('providerType').value = provider ? (provider.type || 'openai') : 'openai'
  document.getElementById('providerBaseUrl').value = provider ? (provider.base_url || '') : ''
  document.getElementById('providerApiKey').value = ''
  document.getElementById('providerModels').value = provider ? (() => { try { return JSON.parse(provider.models).join(', ') } catch { return '' } })() : ''
  document.getElementById('providerPriority').value = provider ? (provider.priority || 0) : 0
  document.getElementById('providerEnabled').checked = provider ? !!provider.enabled : true
  document.getElementById('providerApiKeyHint').textContent = provider && provider.api_key_set ? '已設定 API Key，留空則保留現有值' : ''
  onProviderTypeChange()
  getProviderModal().show()
}

async function editProvider(id) {
  const r = await api('/api/providers')
  const list = await r.json()
  const provider = list.find(x => x.id === id)
  if (!provider) return
  showProviderModal(provider)
}

async function saveProvider() {
  const id = document.getElementById('providerId').value
  const name = document.getElementById('providerName').value.trim()
  const type = document.getElementById('providerType').value
  const base_url = document.getElementById('providerBaseUrl').value.trim()
  const api_key = document.getElementById('providerApiKey').value
  const models = parseModelsInput(document.getElementById('providerModels').value)
  const priority = parseInt(document.getElementById('providerPriority').value, 10) || 0
  const enabled = document.getElementById('providerEnabled').checked
  const errEl = document.getElementById('providerFormError')

  if (!name) { errEl.textContent = '請輸入名稱'; return }
  if (!base_url && type !== 'gemini') { errEl.textContent = '請輸入 API 網址'; return }
  errEl.textContent = ''

  const body = { name, type, base_url, models, priority, enabled }
  if (api_key) body.api_key = api_key

  try {
    const r = await api(id ? '/api/providers/' + id : '/api/providers', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const d = await r.json()
    if (!r.ok) { errEl.textContent = d.error || '儲存失敗'; return }
    getProviderModal().hide()
    loadProviders()
    toast(id ? '已更新' : '已新增', 'success')
  } catch (e) {
    errEl.textContent = e.message || '儲存失敗'
  }
}

async function testProvider(id) {
  const r = await api('/api/providers/' + id + '/test', { method: 'POST' })
  const d = await r.json()
  if (d.ok) toast('連線成功 (' + d.status + ')', 'success')
  else toast('連線失敗: ' + (d.error || d.status), 'danger')
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    })
    const d = await r.json()
    if (d.ok) { document.getElementById('passwordMsg').innerHTML = '<span class="text-success">密碼已更新</span>' }
    else { document.getElementById('passwordMsg').innerHTML = '<span class="text-danger">' + (d.error || '失敗') + '</span>' }
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
    sel.innerHTML += '<option value="' + esc(m.id) + '">' + esc(m.id) + ' (' + esc(m.provider_name) + ')</option>'
  })
}

function clearChat() {
  document.getElementById('chatBox').innerHTML = ''
}

let abortController = null

async function sendPlayground() {
  const msg = document.getElementById('userInput').value.trim()
  if (!msg) return
  const model = document.getElementById('playgroundModel').value
  if (!model) { toast('請選擇模型', 'warning'); return }
  const stream = document.getElementById('streamToggle').checked
  const temp = parseFloat(document.getElementById('temperature').value) || 0.7
  const maxTokens = parseInt(document.getElementById('maxTokens').value) || 2048
  const systemPrompt = document.getElementById('systemPrompt').value.trim()
  const chatBox = document.getElementById('chatBox')

  const messages = []
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  messages.push({ role: 'user', content: msg })

  chatBox.innerHTML += '<div class="msg user">' + esc(msg) + '</div>'
  document.getElementById('userInput').value = ''
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
    if (stream) {
      const r = await fetch(API_BASE + '/api/playground/chat', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, temperature: temp, max_tokens: maxTokens }),
        signal: abortController.signal
      })
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || r.statusText) }
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
          } catch {}
        }
        chatBox.scrollTop = chatBox.scrollHeight
      }
    } else {
      const r = await api('/api/playground/chat', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, temperature: temp, max_tokens: maxTokens })
      })
      const d = await r.json()
      const text = d.choices?.[0]?.message?.content || d.choices?.[0]?.text || JSON.stringify(d)
      msgEl.textContent = text
    }
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

document.getElementById('temperature').addEventListener('input', function() {
  document.getElementById('tempVal').textContent = this.value
})
</script>
</body></html>`
}
