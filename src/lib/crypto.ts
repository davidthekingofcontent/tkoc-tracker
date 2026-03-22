/**
 * Encryption/Decryption utility for storing sensitive tokens at rest.
 * Uses AES-256-GCM with a key derived from JWT_SECRET via PBKDF2.
 * No external dependencies — uses Node.js built-in crypto module.
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const SALT = 'tkoc-token-encryption-salt-v1' // Static salt for key derivation
const KEY_LENGTH = 32 // 256 bits
const ITERATIONS = 100_000

let _derivedKey: Buffer | null = null

/**
 * Derive an encryption key from JWT_SECRET using PBKDF2.
 * Cached in memory after first derivation.
 */
function getEncryptionKey(): Buffer {
  if (_derivedKey) return _derivedKey

  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!secret) {
    throw new Error('Missing TOKEN_ENCRYPTION_KEY or JWT_SECRET for token encryption')
  }

  _derivedKey = pbkdf2Sync(secret, SALT, ITERATIONS, KEY_LENGTH, 'sha512')
  return _derivedKey
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a string in the format: base64(iv):base64(authTag):base64(ciphertext)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')

  const authTag = cipher.getAuthTag()

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`
}

/**
 * Decrypt a ciphertext string encrypted with encrypt().
 * Expects format: base64(iv):base64(authTag):base64(ciphertext)
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey()
  const parts = ciphertext.split(':')

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format')
  }

  const iv = Buffer.from(parts[0], 'base64')
  const authTag = Buffer.from(parts[1], 'base64')
  const encryptedData = parts[2]

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encryptedData, 'base64', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}

/**
 * Check if a string looks like encrypted data (has the iv:tag:data format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':')
  if (parts.length !== 3) return false
  try {
    Buffer.from(parts[0], 'base64')
    Buffer.from(parts[1], 'base64')
    return true
  } catch {
    return false
  }
}
