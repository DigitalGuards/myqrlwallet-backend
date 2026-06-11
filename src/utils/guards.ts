/**
 * Runtime type guards for untrusted input (HTTP bodies, Socket.IO payloads,
 * upstream RPC responses). The hardening mandate bans type assertions, so
 * every wire value enters the typed world through one of these.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Array.isArray narrows unknown to any[], which silently re-launders every
 * element; this predicate keeps the elements unknown.
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Coerce an unknown caught value into an Error without losing the message. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value) ?? 'Unknown error');
  } catch {
    return new Error('Unknown error');
  }
}

/**
 * HTTP-aware error: lets middleware signal a specific status code to the
 * central error handler instead of defaulting to 500.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
