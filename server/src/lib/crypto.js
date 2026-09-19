/**
 * Crypto helpers: password hashing, random ids/tokens, and AES-256-GCM
 * encryption for secrets at rest (Telegram sessions and API hashes).
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import config from '../config.js';

const BCRYPT_ROUNDS = 10;

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash || '');

export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
export const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

export const md5File = () => crypto.createHash('md5');
export const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex');

/** Deterministic key (32 bytes) derived from the configured secret. */
function key() {
  return crypto.createHash('sha256').update(String(config.encryptionKey)).digest();
}

/** AES-256-GCM encrypt → "v1.<iv>.<tag>.<ciphertext>" (all base64url). */
export function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(payload) {
  if (!payload) return '';
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    // tolerate values stored before encryption was introduced
    return payload;
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Constant-time compare for share-link passwords / admin tokens.
 */
export function safeEqual(a = '', b = '') {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default { hashPassword, verifyPassword, randomId, randomToken, encrypt, decrypt, sha1 };
