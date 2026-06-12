import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { dashboardHtml } from './html.js'
import {
  initDB, getClientToken, rotateClientToken,
  getDashboardPasswordHash, setDashboardPasswordHash,
  getProviders, getProvider, createProvider, updateProvider, deleteProvider,
  getModels, createSession, getValidSession, deleteSession, deleteExpiredSessions
} from './lib/db.js'
import { proxyWithFallback, testProviderConnection, sanitizeProvider } from './lib/providers.js'
import {
  hashPassword, verifyPassword, generateSessionToken,
  sessionCookie, clearSessionCookie, parseSessionCookie
} from './lib/auth.js'

const app = new Hono()

app.use('*', async (c, next) => {
  try {
    if (c.env.DB) await initDB(c.env.DB)
  } catch (e) {
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
    const token = parseSessionCookie(c.req.header('Cookie'))
    if (!token) return false
    const session = await getValidSession(c.env.DB, token)
    return !!session
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

app.get('/', async (c) => {
  return c.html(dashboardHtml(c.req.url))
})

app.get('/api/auth/status', async (c) => {
  const authed = await requireAuth(c)
  const passwordHash = await getDashboardPasswordHash(c.env.DB)
  return c.json({ authed, passwordRequired: !!passwordHash })
})

app.post('/api/auth/login', async (c) => {
  const { password } = await c.req.json()
  const stored = await getDashboardPasswordHash(c.env.DB)
  if (stored) {
    const result = await verifyPassword(password, stored)
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

app.get('/api/providers', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const list = await getProviders(c.env.DB)
  return c.json(list.map(sanitizeProvider))
})

app.post('/api/providers', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const data = await c.req.json()
  if (!data.name) return c.json({ error: 'name 為必填' }, 400)
  if (!data.base_url) {
    return c.json({ error: 'base_url 為必填' }, 400)
  }
  const provider = await createProvider(c.env.DB, data)
  return c.json(sanitizeProvider(provider))
})

app.put('/api/providers/:id', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const id = parseInt(c.req.param('id'))
  const data = await c.req.json()
  const provider = await updateProvider(c.env.DB, id, data)
  if (!provider) return c.json({ error: '提供者不存在' }, 404)
  return c.json(sanitizeProvider(provider))
})

app.delete('/api/providers/:id', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const id = parseInt(c.req.param('id'))
  await deleteProvider(c.env.DB, id)
  return c.json({ ok: true })
})

app.post('/api/providers/:id/test', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const id = parseInt(c.req.param('id'))
  const provider = await getProvider(c.env.DB, id)
  if (!provider) return c.json({ error: '提供者不存在' }, 404)
  const result = await testProviderConnection(provider)
  return c.json(result)
})

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

app.get('/api/models', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const models = await getModels(c.env.DB)
  return c.json(models)
})

app.post('/api/playground/chat', async (c) => {
  if (!(await requireAuth(c))) return c.json({ error: '未登入' }, 401)
  const { model, messages, stream, ...rest } = await c.req.json()
  const providers = await getProviders(c.env.DB)
  const payload = { model, messages, stream: stream !== false, ...rest }
  try {
    const result = await proxyWithFallback(providers, model, 'v1/chat/completions', payload, stream !== false)
    if (stream !== false) return result
    return c.json(result)
  } catch (e) {
    return c.json({ error: e.message }, 502)
  }
})

app.get('/v1/models', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const stored = await getClientToken(c.env.DB)
  if (!stored || token !== stored) return c.json({ error: 'Unauthorized' }, 401)
  const models = await getModels(c.env.DB)
  return c.json({
    object: 'list',
    data: models.map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: m.provider_name || 'free-chat-api'
    }))
  })
})

app.post('/v1/chat/completions', async (c) => {
  const auth = c.req.header('Authorization') || ''
  const token = auth.replace('Bearer ', '')
  const stored = await getClientToken(c.env.DB)
  if (!stored || token !== stored) return c.json({ error: 'Unauthorized' }, 401)
  const body = await c.req.json()
  const { model, messages, stream, ...rest } = body
  const providers = await getProviders(c.env.DB)
  const doStream = stream !== false
  const payload = { model, messages, stream: doStream, ...rest }
  try {
    const result = await proxyWithFallback(providers, model, 'v1/chat/completions', payload, doStream)
    if (doStream) return result
    return c.json(result)
  } catch (e) {
    return c.json({ error: e.message }, 502)
  }
})

app.post('/api/debug/chat', async (c) => {
  const body = await c.req.json()
  const tools = body.tools || body.functions || []
  const info = {
    model: body.model,
    toolsCount: tools.length,
    tools: tools.map((t, i) => {
      const def = (typeof t === 'object' && t !== null) ? {
        hasType: !!t.type,
        type: t.type,
        hasFunction: !!t.function,
        name: t.function?.name || t.name,
        hasDescription: !!(t.function?.description || t.description),
        hasParameters: !!(t.function?.parameters || t.parameters),
        paramCount: Object.keys(t.function?.parameters?.properties || t.parameters?.properties || {}).length
      } : { raw: String(t).slice(0, 100) }
      return def
    }),
    messagesCount: (body.messages || []).length,
    lastRole: (body.messages || []).slice(-1)[0]?.role
  }
  return c.json({ debug: info, body })
})

app.all('*', (c) => c.text('Not Found', 404))

export default app
