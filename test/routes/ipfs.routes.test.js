import * as chai from 'chai';
import sinon from 'sinon';
import { default as chaiHttp, request } from 'chai-http';

chai.use(chaiHttp);
const { expect } = chai;

import { app } from '../../src/app.js';

/**
 * Build a stand-in for the Fetch API Response object that lets us drive
 * the streaming read loop in ipfs.routes.js. `chunks` is an array of
 * Uint8Array / Buffer pieces emitted in order.
 */
function buildFetchResponse({
  ok = true,
  status = 200,
  contentType = 'image/png',
  contentLength,
  chunks = [Buffer.from('PNGDATA')],
} = {}) {
  const queue = chunks.map((c) => (c instanceof Uint8Array ? c : Buffer.from(c)));
  const totalLen = queue.reduce((n, c) => n + c.byteLength, 0);
  let i = 0;
  const reader = {
    async read() {
      if (i >= queue.length) return { done: true, value: undefined };
      const value = queue[i++];
      return { done: false, value };
    },
    async cancel() {
      i = queue.length;
    },
  };
  return {
    ok,
    status,
    headers: {
      get(name) {
        const n = name.toLowerCase();
        if (n === 'content-type') return contentType;
        if (n === 'content-length') return String(contentLength ?? totalLen);
        return null;
      },
    },
    body: { getReader: () => reader },
  };
}

describe('IPFS Routes', () => {
  let fetchStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('rejects invalid CIDs', async () => {
    const res = await request.execute(app).get('/api/ipfs/notacid');
    expect(res).to.have.status(400);
    expect(res.body.error).to.equal('invalid CID');
    expect(fetchStub.called).to.equal(false);
  });

  it('rejects path segments containing ..', async () => {
    // `..` as its own URL segment gets collapsed by the HTTP-client URL
    // normalizer before the request hits us, so the only way `..` reaches
    // the route handler is inside a single segment (e.g. "foo..bar").
    // Belt-and-suspenders: validate that the handler still rejects this.
    const res = await request
      .execute(app)
      .get('/api/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/foo..bar');
    expect(res).to.have.status(400);
    expect(res.body.error).to.equal('invalid path');
    expect(fetchStub.called).to.equal(false);
  });

  it('proxies a valid CIDv0 image through the configured gateway', async () => {
    fetchStub.resolves(
      buildFetchResponse({ contentType: 'image/png', chunks: [Buffer.from('PNGDATA')] }),
    );

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(200);
    expect(res).to.have.header('content-type', 'image/png');
    expect(res).to.have.header('cache-control', /max-age=3600/);
    expect(res.body).to.be.instanceOf(Buffer);
    expect(res.body.toString()).to.equal('PNGDATA');
    expect(fetchStub.calledOnce).to.equal(true);
    expect(fetchStub.firstCall.args[0]).to.match(new RegExp(`/ipfs/${cid}$`));
  });

  it('proxies CIDv1 with a path suffix', async () => {
    fetchStub.resolves(
      buildFetchResponse({
        contentType: 'application/json',
        chunks: [Buffer.from('{"name":"x"}')],
      }),
    );

    const cid = 'bafybeib2gp4f5suijuyxbcfhi7lvjzvskyciye5n4ihfrn5pcwhrcq45ru';
    const res = await request.execute(app).get(`/api/ipfs/${cid}/metadata.json`);

    expect(res).to.have.status(200);
    expect(res).to.have.header('content-type', /^application\/json/);
    expect(fetchStub.firstCall.args[0]).to.match(
      new RegExp(`/ipfs/${cid}/metadata\\.json$`),
    );
  });

  it('rejects oversize responses up front via declared Content-Length', async () => {
    fetchStub.resolves(
      buildFetchResponse({ contentLength: 20 * 1024 * 1024, chunks: [Buffer.alloc(8)] }),
    );

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(413);
    expect(res.body.error).to.equal('too large');
  });

  it('rejects oversize responses mid-stream even when Content-Length lies', async () => {
    // Gateway lies in the header (says 10 bytes) but actually streams 12 MB
    // in 1 MB chunks. The handler must trip the incremental cap and 413
    // instead of buffering the whole thing into memory.
    const oneMb = Buffer.alloc(1024 * 1024);
    fetchStub.resolves(
      buildFetchResponse({
        contentLength: 10,
        chunks: Array(12).fill(oneMb),
      }),
    );

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(413);
    expect(res.body.error).to.equal('too large');
    expect(res.body.size).to.be.greaterThan(10 * 1024 * 1024);
  });

  it('returns 504 on gateway timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    fetchStub.rejects(abortErr);

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(504);
    expect(res.body.error).to.equal('gateway timeout');
  });

  it('returns 502 on generic gateway failure', async () => {
    fetchStub.rejects(new Error('ECONNRESET'));

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(502);
    expect(res.body.error).to.equal('gateway unreachable');
  });

  it('returns 502 when the gateway response has a null body', async () => {
    // Fetch API allows null body (e.g. 204 No Content). Handler must surface
    // this as a clean gateway error rather than letting .getReader() blow up.
    fetchStub.resolves({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const n = name.toLowerCase();
          if (n === 'content-type') return 'image/png';
          if (n === 'content-length') return '0';
          return null;
        },
      },
      body: null,
    });

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(502);
    expect(res.body.error).to.equal('gateway error');
  });

  it('returns 504 when an AbortError fires during stream read', async () => {
    // FETCH_TIMEOUT_MS controller can fire AFTER the response headers are
    // received — the inner stream-read catch must re-throw AbortError so
    // the outer catch maps it to 504, not the generic 502 stream error.
    const abortErr = new Error('aborted mid-stream');
    abortErr.name = 'AbortError';
    fetchStub.resolves({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const n = name.toLowerCase();
          if (n === 'content-type') return 'image/png';
          if (n === 'content-length') return '1000';
          return null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              throw abortErr;
            },
            async cancel() {},
          };
        },
      },
    });

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(504);
    expect(res.body.error).to.equal('gateway timeout');
  });

  it('returns 502 when the body stream throws mid-read', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const n = name.toLowerCase();
          if (n === 'content-type') return 'image/png';
          if (n === 'content-length') return '100';
          return null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              throw new Error('socket hang up');
            },
            async cancel() {},
          };
        },
      },
    });

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(502);
    expect(res.body.error).to.equal('gateway stream error');
  });

  it('returns 404 when the gateway returns 404', async () => {
    fetchStub.resolves({
      ok: false,
      status: 404,
      headers: { get: () => null },
    });

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(404);
    expect(res.body.error).to.equal('gateway error');
  });
});
