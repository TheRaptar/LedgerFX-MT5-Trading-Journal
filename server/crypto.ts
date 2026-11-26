import crypto from 'node:crypto';
import net from 'node:net';

const SCRYPT_KEYLEN = 64;
const AES_ALGO = 'aes-256-gcm';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexKey] = parts;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hexKey, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function deriveEncryptionKey(secretMaterial: string): Buffer {
  return crypto.scryptSync(secretMaterial, 'ledgerfx-mt5-cred-v1', 32);
}

export function encryptCredentialPayload(plaintext: string, secretMaterial: string): string {
  const key = deriveEncryptionKey(secretMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `aes256gcm$${iv.toString('hex')}$${authTag.toString('hex')}$${encrypted.toString('hex')}`;
}

export function decryptCredentialPayload(ciphertext: string, secretMaterial: string): string {
  const parts = ciphertext.split('$');
  if (parts.length !== 4 || parts[0] !== 'aes256gcm') {
    throw new Error('Invalid encrypted credential envelope.');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const key = deriveEncryptionKey(secretMaterial);
  const decipher = crypto.createDecipheriv(AES_ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function isPrivateOrLinkLocalIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('169.254.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] ?? '', 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.toLowerCase().startsWith('fe80:') || ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) {
    return true;
  }
  return false;
}

/**
 * Validates user-supplied HTTPS MT5 Bridge URLs to prevent SSRF against internal/metadata addresses.
 */
export function validateSafeBridgeUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Bridge URL is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'MT5 Bridge connections must use HTTPS (TLS) to protect credentials in transit.' };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    return { ok: false, error: 'Loopback or internal metadata hostnames are not permitted for remote MT5 bridges.' };
  }
  if (net.isIP(hostname) && isPrivateOrLinkLocalIp(hostname)) {
    return { ok: false, error: 'Private or link-local IP addresses are not permitted.' };
  }
  return { ok: true, url: parsed };
}
