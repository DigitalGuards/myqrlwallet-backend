export type BoundedJsonFailure =
  'too-large' | 'empty' | 'non-binary' | 'invalid-utf8' | 'invalid-json' | 'stream-error';

export class BoundedJsonError extends Error {
  constructor(
    readonly failure: BoundedJsonFailure,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'BoundedJsonError';
  }
}

function declaredBodyIsOversize(value: string | null, maxBytes: number): boolean {
  if (value === null || !/^\d+$/.test(value)) return false;
  return BigInt(value) > BigInt(maxBytes);
}

/**
 * Incrementally read and decode an untrusted fetch response under a hard byte
 * cap. Any failure before EOF aborts and cancels the body so an upstream cannot
 * continue streaming after the caller has already rejected its response.
 */
export async function readBoundedJsonResponse(
  response: Response,
  controller: AbortController,
  maxBytes: number
): Promise<unknown> {
  if (declaredBodyIsOversize(response.headers.get('content-length'), maxBytes)) {
    controller.abort();
    throw new BoundedJsonError('too-large', 'response body too large');
  }
  if (!response.body) {
    throw new BoundedJsonError('empty', 'response body is empty');
  }

  const stream: ReadableStream<unknown> = response.body;
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  let body = '';
  let reachedEof = false;

  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new BoundedJsonError('stream-error', 'response stream failed', { cause: error });
      }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new BoundedJsonError('non-binary', 'response stream yielded a non-binary chunk');
      }
      if (received + chunk.value.byteLength > maxBytes) {
        throw new BoundedJsonError('too-large', 'response body too large');
      }
      received += chunk.value.byteLength;
      try {
        body += decoder.decode(chunk.value, { stream: true });
      } catch (error) {
        throw new BoundedJsonError('invalid-utf8', 'response body is not valid UTF-8', {
          cause: error,
        });
      }
    }

    try {
      body += decoder.decode();
    } catch (error) {
      throw new BoundedJsonError('invalid-utf8', 'response body is not valid UTF-8', {
        cause: error,
      });
    }
    reachedEof = true;
  } finally {
    if (!reachedEof) {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    }
  }

  if (received === 0) {
    throw new BoundedJsonError('empty', 'response body is empty');
  }

  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch (error) {
    throw new BoundedJsonError('invalid-json', 'response body is not valid JSON', { cause: error });
  }
}
