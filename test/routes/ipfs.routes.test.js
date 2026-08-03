import * as chai from 'chai';
import { createServer, request as httpRequest, ServerResponse } from 'node:http';
import sinon from 'sinon';
import { default as chaiHttp, request } from 'chai-http';

chai.use(chaiHttp);
const { expect } = chai;

import { app } from '../../src/app.js';
import { CONFIG } from '../../src/config/index.js';

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

function getFromServer(port, path) {
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Connection: 'close' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    client.on('error', reject);
    client.end();
  });
}

function getFromServerExpectDisconnect(port, path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const client = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Connection: 'close' },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('aborted', () => {
          finish({ disconnected: true, status: response.statusCode, body: Buffer.concat(chunks) });
        });
        response.on('error', () => {
          finish({ disconnected: true, status: response.statusCode, body: Buffer.concat(chunks) });
        });
        response.on('end', () => {
          finish({ disconnected: false, status: response.statusCode, body: Buffer.concat(chunks) });
        });
      }
    );
    client.on('error', (error) => {
      if (settled) return;
      if (error.code === 'ECONNRESET') {
        finish({ disconnected: true, status: undefined, body: Buffer.alloc(0) });
        return;
      }
      reject(error);
    });
    client.end();
  });
}

describe('IPFS Routes', () => {
  let fetchStub;
  let originalLimits;

  beforeEach(() => {
    originalLimits = {
      IPFS_FETCH_TIMEOUT_MS: CONFIG.IPFS_FETCH_TIMEOUT_MS,
      IPFS_MAX_CONCURRENT: CONFIG.IPFS_MAX_CONCURRENT,
      IPFS_MAX_INFLIGHT_BYTES: CONFIG.IPFS_MAX_INFLIGHT_BYTES,
      IPFS_MAX_SIZE_BYTES: CONFIG.IPFS_MAX_SIZE_BYTES,
    };
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    Object.assign(CONFIG, originalLimits);
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
      buildFetchResponse({ contentType: 'image/png', chunks: [Buffer.from('PNGDATA')] })
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
    expect(fetchStub.firstCall.args[1]?.redirect).to.equal('error');
  });

  it('proxies CIDv1 with a path suffix', async () => {
    fetchStub.resolves(
      buildFetchResponse({
        contentType: 'application/json',
        chunks: [Buffer.from('{"name":"x"}')],
      })
    );

    const cid = 'bafybeib2gp4f5suijuyxbcfhi7lvjzvskyciye5n4ihfrn5pcwhrcq45ru';
    const res = await request.execute(app).get(`/api/ipfs/${cid}/metadata.json`);

    expect(res).to.have.status(200);
    expect(res).to.have.header('content-type', /^application\/json/);
    expect(fetchStub.firstCall.args[0]).to.match(new RegExp(`/ipfs/${cid}/metadata\\.json$`));
  });

  it('rejects oversize responses up front via declared Content-Length', async () => {
    fetchStub.resolves(
      buildFetchResponse({ contentLength: 20 * 1024 * 1024, chunks: [Buffer.alloc(8)] })
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
      })
    );

    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    try {
      const result = await getFromServerExpectDisconnect(address.port, `/api/ipfs/${cid}`);

      // Bytes already streamed cannot be replaced with a 413 envelope. The
      // proxy enforces the cap by terminating the partial HTTP response.
      expect(result.disconnected).to.equal(true);
      expect(result.body.byteLength).to.equal(10 * 1024 * 1024);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
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

  it('terminates a partial response when a later stream chunk is non-binary', async () => {
    let index = 0;
    const chunks = [Buffer.from('partial'), 'not-binary'];
    fetchStub.resolves({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const normalized = name.toLowerCase();
          if (normalized === 'content-type') return 'image/png';
          if (normalized === 'content-length') return '100';
          return null;
        },
      },
      body: {
        getReader() {
          return {
            async read() {
              if (index >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[index++] };
            },
            async cancel() {
              index = chunks.length;
            },
          };
        },
      },
    });

    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    try {
      const result = await getFromServerExpectDisconnect(address.port, `/api/ipfs/${cid}`);

      expect(result.disconnected).to.equal(true);
      expect(result.body.toString('utf8')).to.equal('partial');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
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

  it('rejects a second fetch while the concurrency budget is occupied', async () => {
    CONFIG.IPFS_MAX_CONCURRENT = 1;
    CONFIG.IPFS_MAX_INFLIGHT_BYTES = CONFIG.IPFS_MAX_SIZE_BYTES * 2;

    let releaseFetch;
    let signalFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      signalFetchStarted = resolve;
    });
    fetchStub.callsFake(
      () =>
        new Promise((resolve) => {
          releaseFetch = resolve;
          signalFetchStarted();
        })
    );

    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const path = `/api/ipfs/${cid}`;
    try {
      const firstRequest = getFromServer(address.port, path);
      await fetchStarted;

      const busy = await getFromServer(address.port, path);
      expect(busy.status).to.equal(503);
      expect(JSON.parse(busy.body).error).to.equal('IPFS proxy busy');
      expect(fetchStub.callCount).to.equal(1);

      releaseFetch(buildFetchResponse());
      expect((await firstRequest).status).to.equal(200);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('releases its fetch slot when a slow downstream client hits the deadline', async () => {
    CONFIG.IPFS_FETCH_TIMEOUT_MS = 100;
    CONFIG.IPFS_MAX_CONCURRENT = 1;
    CONFIG.IPFS_MAX_INFLIGHT_BYTES = CONFIG.IPFS_MAX_SIZE_BYTES;
    fetchStub.resolves(buildFetchResponse({ chunks: [Buffer.alloc(1024)] }));

    const originalWrite = ServerResponse.prototype.write;
    let blockOneWrite = true;
    sinon.stub(ServerResponse.prototype, 'write').callsFake(function (...args) {
      if (blockOneWrite) {
        blockOneWrite = false;
        return false;
      }
      return Reflect.apply(originalWrite, this, args);
    });

    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const path = `/api/ipfs/${cid}`;
    try {
      const timedOut = await getFromServer(address.port, path);
      expect(timedOut.status).to.equal(504);

      const next = await getFromServer(address.port, path);
      expect(next.status).to.equal(200);
      expect(fetchStub.callCount).to.equal(2);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('aborts the gateway request when the client disconnects', async () => {
    let signalFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      signalFetchStarted = resolve;
    });
    let signalAborted;
    const aborted = new Promise((resolve) => {
      signalAborted = resolve;
    });
    fetchStub.callsFake((_url, options) => {
      signalFetchStarted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            signalAborted();
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true }
        );
      });
    });

    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const client = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: `/api/ipfs/${cid}`,
      method: 'GET',
    });
    client.on('error', () => {});
    client.end();

    await fetchStarted;
    client.destroy();
    await aborted;
    await new Promise((resolve) => server.close(resolve));
  });
});
