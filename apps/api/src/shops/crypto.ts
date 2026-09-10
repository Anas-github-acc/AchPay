import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

function key(): Buffer {
  const raw = process.env.MERCHANT_SECRETS_KEY ?? config.quoteSigningSecret;
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted merchant secret');
  const iv = Buffer.from(parts[0]!, 'base64url');
  const tag = Buffer.from(parts[1]!, 'base64url');
  const body = Buffer.from(parts[2]!, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
