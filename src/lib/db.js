export function generateToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return 'sk-' + hex
}

export async function initDB(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      client_token TEXT NOT NULL DEFAULT '',
      dashboard_password_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'openai',
      models TEXT NOT NULL DEFAULT '[]',
      priority INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  ]
  for (const sql of tables) {
    await db.prepare(sql).run()
  }
  const row = await db.prepare('SELECT version FROM schema_meta WHERE id = 1').first()
  if (!row) {
    await db.prepare('INSERT INTO schema_meta (id, version) VALUES (1, 0)').run()
  }
  const currentVersion = row ? row.version : 0
  if (currentVersion < 1) {
    await db.prepare(`
      INSERT INTO config (id, client_token, dashboard_password_hash)
      VALUES (1, ?, '')
    `).bind(generateToken()).run()
    await db.prepare('UPDATE schema_meta SET version = 1 WHERE id = 1').run()
  }
  if (currentVersion < 2) {
    try { await db.prepare("ALTER TABLE providers ADD COLUMN type TEXT NOT NULL DEFAULT 'openai'").run() } catch {}
    const count = await db.prepare('SELECT COUNT(*) as cnt FROM providers').first()
    if (count && count.cnt === 0) {
      await db.prepare(
        "INSERT INTO providers (name, base_url, type, models, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind('Chat With Fiction', 'https://www.chatwithfiction.com/api/gpt', 'chatwithfiction', '["chatwithfiction-gpt"]', 0, 1).run()
    }
    await db.prepare('UPDATE schema_meta SET version = 2 WHERE id = 1').run()
  }
  if (currentVersion < 3) {
    const existing = await db.prepare("SELECT id FROM providers WHERE type = 'chatwithfiction'").first()
    if (!existing) {
      await db.prepare(
        "INSERT INTO providers (name, base_url, type, models, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind('Chat With Fiction', 'https://www.chatwithfiction.com/api/gpt', 'chatwithfiction', '["chatwithfiction-gpt"]', 0, 1).run()
    }
    await db.prepare('UPDATE schema_meta SET version = 3 WHERE id = 1').run()
  }
  if (currentVersion < 7) {
    /* Remove deprecated providers */
    await db.prepare("DELETE FROM providers WHERE type IN ('perfectassistant', 'chat2api')").run()
    await db.prepare("DELETE FROM providers WHERE name = 'Chat2API Free'").run()
    const existing = await db.prepare("SELECT id FROM providers WHERE type = 'gemini'").first()
    if (!existing) {
      await db.prepare(
        "INSERT INTO providers (name, base_url, type, models, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind('Gemini Free', '', 'gemini', JSON.stringify(['gemini-3.5-flash', 'gemini-3.5-flash-thinking', 'gemini-flash-lite', 'gemini-auto']), 0, 1).run()
    }
    await db.prepare('UPDATE schema_meta SET version = 7 WHERE id = 1').run()
  }
  if (currentVersion < 8) {
    await db.prepare('DELETE FROM sessions WHERE expires_at < datetime(\'now\')').run()
    await db.prepare('UPDATE schema_meta SET version = 8 WHERE id = 1').run()
  }
}

export async function createSession(db, token) {
  const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  await db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').bind(token, expiresAt).run()
  return token
}

export async function getValidSession(db, token) {
  if (!token) return null
  return await db.prepare(
    'SELECT token FROM sessions WHERE token = ? AND expires_at > datetime(\'now\')'
  ).bind(token).first()
}

export async function deleteSession(db, token) {
  if (!token) return
  await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
}

export async function deleteExpiredSessions(db) {
  await db.prepare('DELETE FROM sessions WHERE expires_at <= datetime(\'now\')').run()
}

export async function getConfig(db) {
  return await db.prepare('SELECT * FROM config WHERE id = 1').first()
}

export async function getClientToken(db) {
  const row = await db.prepare('SELECT client_token FROM config WHERE id = 1').first()
  return row ? row.client_token : ''
}

export async function rotateClientToken(db) {
  const token = generateToken()
  await db.prepare('UPDATE config SET client_token = ?, updated_at = datetime(\'now\') WHERE id = 1').bind(token).run()
  return token
}

export async function getDashboardPasswordHash(db) {
  const row = await db.prepare('SELECT dashboard_password_hash FROM config WHERE id = 1').first()
  return row ? row.dashboard_password_hash : ''
}

export async function setDashboardPasswordHash(db, hash) {
  await db.prepare('UPDATE config SET dashboard_password_hash = ?, updated_at = datetime(\'now\') WHERE id = 1').bind(hash).run()
}

export async function getProviders(db) {
  const { results } = await db.prepare('SELECT * FROM providers ORDER BY priority DESC, id ASC').all()
  return results || []
}

export async function getProvider(db, id) {
  return await db.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first()
}

export async function createProvider(db, data) {
  const { name, base_url, api_key, type, models, priority, enabled } = data
  const modelsJson = JSON.stringify(models || [])
  const { results } = await db.prepare(
    'INSERT INTO providers (name, base_url, api_key, type, models, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *'
  ).bind(name, base_url || '', api_key || '', type || 'openai', modelsJson, priority || 0, enabled !== undefined ? (enabled ? 1 : 0) : 1).all()
  return results?.[0] || null
}

export async function updateProvider(db, id, data) {
  const { name, base_url, api_key, type, models, priority, enabled } = data
  const existing = await db.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first()
  if (!existing) return null
  const modelsJson = models ? JSON.stringify(models) : existing.models
  await db.prepare(
    'UPDATE providers SET name=?, base_url=?, api_key=?, type=?, models=?, priority=?, enabled=?, updated_at=datetime(\'now\') WHERE id=?'
  ).bind(
    name ?? existing.name,
    base_url ?? existing.base_url,
    api_key !== undefined ? api_key : existing.api_key,
    type ?? existing.type,
    modelsJson,
    priority !== undefined ? priority : existing.priority,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    id
  ).run()
  return await db.prepare('SELECT * FROM providers WHERE id = ?').bind(id).first()
}

export async function deleteProvider(db, id) {
  await db.prepare('DELETE FROM providers WHERE id = ?').bind(id).run()
}

export async function getModels(db) {
  const providers = await getProviders(db)
  const models = [{ id: 'openai', provider_id: 0, provider_name: 'All' }]
  for (const p of providers) {
    if (!p.enabled) continue
    try {
      const list = JSON.parse(p.models)
      for (const m of list) {
        models.push({ id: m, provider_id: p.id, provider_name: p.name })
      }
    } catch {}
  }
  return models
}
