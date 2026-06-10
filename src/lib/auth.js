const PBKDF2_ITERATIONS = 100000

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return toHex(arr)
}

async function sha256(password) {
  const data = new TextEncoder().encode(password || '')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return toHex(hash)
}

async function pbkdf2Hash(password, salt, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations, hash: 'SHA-256' },
    key,
    256
  )
  return toHex(bits)
}

export async function hashPassword(password) {
  const salt = randomHex(16)
  const hash = await pbkdf2Hash(password, salt)
  return `pbkdf2:${PBKDF2_ITERATIONS}:${salt}:${hash}`
}

export async function verifyPassword(password, stored) {
  if (!stored) return { ok: true, needsUpgrade: false }
  if (stored.startsWith('pbkdf2:')) {
    const parts = stored.split(':')
    if (parts.length !== 4) return { ok: false, needsUpgrade: false }
    const iterations = parseInt(parts[1], 10)
    const salt = parts[2]
    const expected = parts[3]
    const computed = await pbkdf2Hash(password, salt, iterations)
    return { ok: computed === expected, needsUpgrade: false }
  }
  const legacy = await sha256(password)
  return { ok: legacy === stored, needsUpgrade: legacy === stored }
}

export function generateSessionToken() {
  return randomHex(32)
}

export function sessionCookie(token, secure = true) {
  const secureFlag = secure ? '; Secure' : ''
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureFlag}`
}

export function clearSessionCookie(secure = true) {
  const secureFlag = secure ? '; Secure' : ''
  return `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`
}

export function parseSessionCookie(cookieHeader) {
  const match = (cookieHeader || '').match(/session=([^;]+)/)
  return match ? match[1] : null
}
