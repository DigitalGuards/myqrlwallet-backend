/**
 * Crypto primitive boundary.
 *
 * This is the only file in the backend allowed to import node:crypto (or any
 * crypto library); the fence is enforced by ESLint no-restricted-imports.
 *
 * The backend deliberately does almost no cryptography: the dApp Connect
 * relay routes E2E-encrypted ciphertext (ML-KEM-768 + AES-256-GCM, performed
 * by the SDK and the wallet) and never sees plaintext or key material. The
 * sole primitive needed server-side is a timing-safe comparison for the
 * /metrics and /relay/stats bearer token. Any future primitive must be added
 * here, not inlined at a call site.
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison for secret tokens. Length mismatches
 * return false without a byte comparison; the early exit leaks only the
 * length, which for our random fixed-length ops tokens is not secret.
 */
export function timingSafeEqualStrings(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
