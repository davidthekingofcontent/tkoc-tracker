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

const _derivedKeys = new Map<string, Buffer>()

function derive(secret: string): Buffer {
  let k = _derivedKeys.get(secret)
  if (!k) {
    k = pbkdf2Sync(secret, SALT, ITERATIONS, KEY_LENGTH, 'sha512')
    _derivedKeys.set(secret, k)
  }
  return k
}

/**
 * Clave con la que se cifra: siempre la actual.
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!secret) {
    throw new Error('Missing TOKEN_ENCRYPTION_KEY or JWT_SECRET for token encryption')
  }
  return derive(secret)
}

/**
 * Claves con las que se intenta descifrar, en orden.
 *
 * Esto es lo que permite rotar TOKEN_ENCRYPTION_KEY sin romper nada: se pone
 * la clave nueva en TOKEN_ENCRYPTION_KEY, la vieja en TOKEN_ENCRYPTION_KEY_OLD,
 * y los tokens ya guardados se siguen descifrando mientras se vuelven a cifrar
 * solos al refrescarse. Antes no habia vuelta atras: cambiar la clave dejaba
 * ilegibles los tokens de Meta, Instagram y YouTube de todas las cuentas
 * conectadas, y habia que pedirle a cada creador y cada marca que volviera a
 * autorizar. Cuando ya no quede nada cifrado con la vieja, se borra la
 * variable _OLD y listo.
 *
 * Sin TOKEN_ENCRYPTION_KEY_OLD definida se comporta exactamente igual que antes.
 */
function getDecryptionKeys(): Buffer[] {
  const secretos = [
    process.env.TOKEN_ENCRYPTION_KEY,
    process.env.TOKEN_ENCRYPTION_KEY_OLD,
    process.env.JWT_SECRET,
  ].filter((s): s is string => !!s)

  if (secretos.length === 0) {
    throw new Error('Missing TOKEN_ENCRYPTION_KEY or JWT_SECRET for token encryption')
  }
  return [...new Set(secretos)].map(derive)
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
  const parts = ciphertext.split(':')

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format')
  }

  const iv = Buffer.from(parts[0], 'base64')
  const authTag = Buffer.from(parts[1], 'base64')
  const encryptedData = parts[2]

  // AES-GCM verifica la etiqueta de autenticacion, asi que una clave
  // equivocada falla siempre: probar en orden es seguro, no adivina.
  let ultimo: unknown
  for (const key of getDecryptionKeys()) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(authTag)
      let decrypted = decipher.update(encryptedData, 'base64', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    } catch (e) {
      ultimo = e
    }
  }
  throw ultimo instanceof Error ? ultimo : new Error('Unable to decrypt with any configured key')
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
