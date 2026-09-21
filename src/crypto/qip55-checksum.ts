import { createHash } from 'node:crypto';

/**
 * QIP-55 checksum casing (mirrors zondscan backendAPI/qrladdress/address.go):
 * SHAKE-256 over the ASCII lowercase hex body, one nibble per character;
 * a hex letter is uppercase exactly when its nibble is >= 8.
 */
export function checksummedBody(lower: string): string {
  const hash = createHash('shake256', { outputLength: lower.length / 2 })
    .update(lower, 'ascii')
    .digest();
  let out = '';
  for (let i = 0; i < lower.length; i += 1) {
    const c = lower.charAt(i);
    if (c < 'a' || c > 'f') {
      out += c;
      continue;
    }
    const byte = hash[i >> 1] ?? 0;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** Uniform-case bodies are valid; mixed-case bodies must match the checksum. */
export function hasValidCase(body: string): boolean {
  const lower = body.toLowerCase();
  if (body === lower || body === body.toUpperCase()) return true;
  return body === checksummedBody(lower);
}
