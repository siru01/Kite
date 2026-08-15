/**
 * cryptoUtils.js
 * Application-Layer Web Crypto API Helpers for E2EE AES-256-GCM & SHA-256 File Integrity Validation
 */

const EXECUTABLE_EXTENSIONS = new Set([
  'exe', 'sh', 'bat', 'scr', 'vbs', 'ps1', 'cmd',
  'msi', 'apk', 'jar', 'com', 'bin', 'dll', 'sys',
  'vb', 'js', 'vbe', 'wsf', 'wsh', 'pif', 'cpl'
])

/**
 * Generate a 256-bit AES-GCM key for file transfer E2EE session.
 */
export async function generateSessionKey() {
  return await window.crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

/**
 * Export CryptoKey to Base64 string for handshaking inside file-offer.
 */
export async function exportRawKey(key) {
  const raw = await window.crypto.subtle.exportKey('raw', key)
  return arrayBufferToBase64(raw)
}

/**
 * Import Base64 string into a CryptoKey object.
 */
export async function importRawKey(base64Key) {
  const raw = base64ToArrayBuffer(base64Key)
  return await window.crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  )
}

/**
 * Generate a random 12-byte Initialization Vector (IV) for AES-GCM.
 */
export function generateIV() {
  return window.crypto.getRandomValues(new Uint8Array(12))
}

/**
 * Encrypt an ArrayBuffer chunk using AES-256-GCM with a specified IV.
 */
export async function encryptChunk(chunkBuffer, key, iv) {
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    chunkBuffer
  )
  return encrypted
}

/**
 * Decrypt an encrypted ArrayBuffer chunk using AES-256-GCM and IV.
 */
export async function decryptChunk(encryptedBuffer, key, iv) {
  return await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    encryptedBuffer
  )
}

/**
 * Compute SHA-256 hex checksum over an ArrayBuffer.
 */
export async function computeSHA256(arrayBuffer) {
  const digestBuffer = await window.crypto.subtle.digest('SHA-256', arrayBuffer)
  const hashArray = Array.from(new Uint8Array(digestBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Compute SHA-256 from a Blob/File.
 */
export async function computeFileSHA256(file) {
  const arrayBuffer = await file.arrayBuffer()
  return await computeSHA256(arrayBuffer)
}

/**
 * Sanitize filename to prevent directory traversal and null byte injections.
 */
export function sanitizeFilename(name) {
  if (!name) return 'unnamed_file'
  let clean = name.replace(/[\x00-\x1F\x7F]/g, '') // strip control chars
  clean = clean.replace(/[\/\\]/g, '_') // replace slashes
  clean = clean.replace(/\.\.+/g, '.') // collapse multiple dots
  return clean.trim() || 'unnamed_file'
}

/**
 * Detect if a filename has a dangerous executable extension.
 */
export function isExecutableFilename(name) {
  if (!name) return false
  const ext = name.split('.').pop().toLowerCase()
  return EXECUTABLE_EXTENSIONS.has(ext)
}

// ── Helpers for Base64 conversion ──────────────────────────────────────────

function arrayBufferToBase64(buffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return window.btoa(binary)
}

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes.buffer
}
