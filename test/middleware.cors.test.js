/**
 * corsMiddleware origin policy: allowlisted web origins and browser-extension
 * schemes pass; other web origins are rejected with a 403 HttpError; absent
 * Origin (curl, native clients) passes.
 */
import * as chai from 'chai';
import { CONFIG } from '../src/config/index.js';
import { corsMiddleware } from '../src/middleware/cors.js';

const { expect } = chai;

/** Drive the cors package's origin callback via a fake request. */
function decide(origin) {
  return new Promise((resolve) => {
    const req = { method: 'GET', headers: origin ? { origin } : {} };
    const res = {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      end() {},
    };
    corsMiddleware(req, res, (err) => resolve(err ?? null));
  });
}

describe('corsMiddleware origin policy', () => {
  it('allows an allowlisted web origin', async () => {
    // CONFIG reads env at import and may be empty in the test env; inject a
    // known entry so the allowlist branch is always exercised.
    const testOrigin = 'https://allowed.example';
    CONFIG.ALLOWED_ORIGINS.push(testOrigin);
    try {
      expect(await decide(testOrigin)).to.equal(null);
    } finally {
      CONFIG.ALLOWED_ORIGINS.splice(CONFIG.ALLOWED_ORIGINS.indexOf(testOrigin), 1);
    }
  });

  it('allows a chrome-extension origin without allowlisting', async () => {
    expect(await decide('chrome-extension://abcdefghijklmnop')).to.equal(null);
  });

  it('allows a moz-extension origin', async () => {
    expect(await decide('moz-extension://uuid-here')).to.equal(null);
  });

  it('allows extension origins with uppercase schemes (case-insensitive)', async () => {
    expect(await decide('CHROME-EXTENSION://abcdefghijklmnop')).to.equal(null);
  });

  it('allows an absent Origin header (curl, native clients)', async () => {
    expect(await decide(undefined)).to.equal(null);
  });

  it('rejects an unlisted web origin with 403', async () => {
    const err = await decide('https://evil.example');
    expect(err).to.not.equal(null);
    expect(err.status ?? err.statusCode).to.equal(403);
  });

  it('does not let a web page spoof the scheme mid-origin', async () => {
    const err = await decide('https://chrome-extension.example');
    expect(err).to.not.equal(null);
  });
});
