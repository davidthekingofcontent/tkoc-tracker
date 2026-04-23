/**
 * Token Encryption — AES-256-GCM
 *
 * Used for encrypting OAuth access/refresh tokens at rest.
 * Format: `iv:authTag:ciphertext` (all hex).
 *
 * Requires TOKEN_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * If missing or invalid, throws at import time.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // 12 bytes = GCM standard
const KEY_LENGTH_BYTES = 32 // 256 bits
const KEY_LENGTH_HEX = KEY_LENGTH_BYTES * 2 // 64 hex chars

function loadKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is required. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length !== KEY_LENGTH_HEX) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be exactly ${KEY_LENGTH_HEX} hex chars (32 bytes). Got ${raw.length} chars.`
    )
  }
  return Buffer.from(raw, 'hex')
}

// Validate at import time — fail fast if key is missing or malformed.
const KEY = loadKey()

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns `iv:authTag:ciphertext` with each segment hex-encoded.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypt a string produced by `encrypt()`.
 * Expects `iv:authTag:ciphertext` (all hex).
 */
export function decrypt(payload: string): string {
  const parts = payload.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload: expected `iv:authTag:ciphertext`')
  }
  const [ivHex, tagHex, dataHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(tagHex, 'hex')
  const data = Buffer.from(dataHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, KEY, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return decrypted.toString('utf8')
}
