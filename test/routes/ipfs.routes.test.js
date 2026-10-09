import * as chai from 'chai';
import { createServer, request as httpRequest, ServerResponse } from 'node:http';
import sinon from 'sinon';
import express from 'express';
import { default as chaiHttp, request } from 'chai-http';

chai.use(chaiHttp);
const { expect } = chai;

import { CONFIG } from '../../src/config/index.js';
import { createIpfsRouter } from '../../src/routes/ipfs.routes.js';

const gateways = [
  'https://first.example/ipfs/',
  'https://second.example/ipfs/',
  'https://third.example/ipfs/',
];
const testCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function delayUntilResponse(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      { once: true }
    );
  });
}

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
  retryAfter = null,
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
        if (n === 'retry-after') return retryAfter;
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
  let app;
  let fetchStub;
  let originalLimits;

  beforeEach(() => {
    originalLimits = {
      IPFS_GATEWAYS: CONFIG.IPFS_GATEWAYS,
      IPFS_FETCH_TIMEOUT_MS: CONFIG.IPFS_FETCH_TIMEOUT_MS,
      IPFS_FALLBACK_RESERVE_MS: CONFIG.IPFS_FALLBACK_RESERVE_MS,
      IPFS_MAX_COOLDOWN_MS: CONFIG.IPFS_MAX_COOLDOWN_MS,
      IPFS_MAX_CONCURRENT: CONFIG.IPFS_MAX_CONCURRENT,
      IPFS_MAX_INFLIGHT_BYTES: CONFIG.IPFS_MAX_INFLIGHT_BYTES,
      IPFS_MAX_SIZE_BYTES: CONFIG.IPFS_MAX_SIZE_BYTES,
    };
    CONFIG.IPFS_GATEWAYS = gateways;
    app = express();
    app.use('/api/ipfs', createIpfsRouter());
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

  it('re-joins a multi-segment path suffix into one gateway path', async () => {
    // Express 5 (path-to-regexp v8) returns the `*splat` wildcard as an array
    // of decoded segments; the handler must hand the gateway the original
    // `/`-joined path, exactly as Express 4's `params[0]` string did.
    fetchStub.resolves(
      buildFetchResponse({ contentType: 'image/png', chunks: [Buffer.from('PNGDATA')] })
    );

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}/images/1/asset.png`);

    expect(res).to.have.status(200);
    expect(fetchStub.calledOnce).to.equal(true);
    expect(fetchStub.firstCall.args[0]).to.match(new RegExp(`/ipfs/${cid}/images/1/asset\\.png$`));
  });

  it('rejects traversal that reaches the router inside the wildcard', async () => {
    // superagent and the WHATWG URL parser both collapse `..` and `%2e%2e`
    // dot-segments client-side, so chai-http can never deliver them. A raw
    // node:http request sends the path verbatim. Express 5 decodes each
    // wildcard segment, so `%2e%2e` arrives at the handler as `..` and the
    // re-joined path must still trip the traversal check before any fetch.
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const rawGet = (path) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: address.port, path, method: 'GET' },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
            );
          }
        );
        req.on('error', reject);
        req.end();
      });
    try {
      for (const suffix of ['a/%2e%2e/b', 'a/../b', '%2e%2e']) {
        const res = await rawGet(`/api/ipfs/${cid}/${suffix}`);
        expect(res.status, suffix).to.equal(400);
        expect(JSON.parse(res.body).error, suffix).to.equal('invalid path');
      }
      expect(fetchStub.called).to.equal(false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
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
    // Gateway declares 10 bytes and then streams 12 MB in 1 MB chunks.
    // The incremental cap must terminate the response at the size limit.
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
    // this as a clean gateway error before trying to read its body.
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
    // The deadline can fire after upstream headers arrive. Exhausted attempts
    // still map an AbortError from the body reader to a 504 response.
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
    expect(fetchStub.callCount).to.equal(1);
  });

  describe('gateway fallback', () => {
    for (const delay of [4000, 4500, 5000]) {
      it(`serves the first request after a fast 429 and a ${delay} ms success`, async () => {
        CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
        const clock = sinon.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
        let started;
        const fetchStarted = new Promise((resolve) => {
          started = resolve;
        });
        fetchStub.callsFake(async (url, { signal }) => {
          started();
          const limited = url.startsWith(gateways[0]) || url.startsWith(gateways[2]);
          await delayUntilResponse(limited ? 50 : delay, signal);
          return limited
            ? new globalThis.Response('rate limited', {
                status: 429,
                headers: { 'retry-after': '900' },
              })
            : new globalThis.Response(new Uint8Array([1, 2, 3]), {
                headers: { 'content-type': 'image/png' },
              });
        });
        const pending = request
          .execute(app)
          .get(`/api/ipfs/${testCid}`)
          .then((res) => res);
        await fetchStarted;
        await clock.tickAsync(8000);
        const res = await pending;
        expect(res).to.have.status(200);
        expect([...res.body]).to.deep.equal([1, 2, 3]);
        expect(fetchStub.getCalls().map((call) => call.args[0])).to.deep.equal([
          `${gateways[0]}${testCid}`,
          `${gateways[1]}${testCid}`,
        ]);
      });
    }

    it('serves a 4 second healthy head gateway within an 8 second budget', async () => {
      CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let started;
      const fetchStarted = new Promise((resolve) => {
        started = resolve;
      });
      fetchStub.callsFake(async (_url, { signal }) => {
        started();
        await delayUntilResponse(4000, signal);
        return new globalThis.Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' },
        });
      });
      const pending = request
        .execute(app)
        .get(`/api/ipfs/${testCid}`)
        .then((res) => res);
      await fetchStarted;
      await clock.tickAsync(8000);
      expect(await pending).to.have.status(200);
      expect(fetchStub.callCount).to.equal(1);
    });

    for (const admitted of [4, 6]) {
      it(`serves all ${admitted} admitted requests in a six request burst after fast 429s`, async () => {
        CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
        CONFIG.IPFS_MAX_CONCURRENT = 6;
        CONFIG.IPFS_MAX_INFLIGHT_BYTES = CONFIG.IPFS_MAX_SIZE_BYTES * admitted;
        const clock = sinon.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
        let started;
        const allStarted = new Promise((resolve) => {
          started = resolve;
        });
        fetchStub.callsFake(async (url, { signal }) => {
          if (fetchStub.callCount === admitted) started();
          const limited = url.startsWith(gateways[0]) || url.startsWith(gateways[2]);
          await delayUntilResponse(limited ? 50 : 4500, signal);
          return limited
            ? new globalThis.Response('rate limited', {
                status: 429,
                headers: { 'retry-after': '900' },
              })
            : new globalThis.Response(new Uint8Array([1, 2, 3]), {
                headers: { 'content-type': 'image/png' },
              });
        });
        const pending = Promise.all(
          Array.from({ length: 6 }, () =>
            request
              .execute(app)
              .get(`/api/ipfs/${testCid}`)
              .then((res) => res)
          )
        );
        await allStarted;
        await clock.tickAsync(8000);
        const responses = await pending;
        expect(responses.filter((res) => res.status === 200)).to.have.length(admitted);
        const busy = responses.filter((res) => res.status === 503);
        expect(busy).to.have.length(6 - admitted);
        for (const res of busy) expect(res.body.error).to.equal('IPFS proxy busy');
        expect(fetchStub.callCount).to.equal(admitted * 2);
      });
    }

    for (const status of [429, 500, 502, 503, 504, 599]) {
      it(`advances in order after ${status} and aborts the failed attempt`, async () => {
        fetchStub.callsFake(() => buildFetchResponse());
        fetchStub.onFirstCall().resolves(buildFetchResponse({ ok: false, status }));

        const res = await request.execute(app).get(`/api/ipfs/${testCid}/images/asset.png`);

        expect(res).to.have.status(200);
        expect(res.body.toString()).to.equal('PNGDATA');
        expect(fetchStub.getCalls().map((call) => call.args[0])).to.deep.equal([
          `${gateways[0]}${testCid}/images/asset.png`,
          `${gateways[1]}${testCid}/images/asset.png`,
        ]);
        expect(fetchStub.firstCall.args[1].signal.aborted).to.equal(true);
        expect(fetchStub.firstCall.args[1].signal).not.to.equal(
          fetchStub.secondCall.args[1].signal
        );
      });
    }

    it('falls back on a network error', async () => {
      fetchStub.callsFake(() => buildFetchResponse());
      fetchStub.onFirstCall().rejects(new TypeError('fetch failed'));
      const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
      expect(res).to.have.status(200);
      expect(fetchStub.callCount).to.equal(2);
    });

    it('falls back after reserving one second for each eligible later gateway', async () => {
      CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let started;
      const fetchStarted = new Promise((resolve) => {
        started = resolve;
      });
      fetchStub.callsFake(() => buildFetchResponse());
      fetchStub.onFirstCall().callsFake((_url, { signal }) => {
        started();
        return waitForAbort(signal);
      });
      const pending = request
        .execute(app)
        .get(`/api/ipfs/${testCid}`)
        .then((res) => res);
      await fetchStarted;
      await clock.tickAsync(5999);
      expect(fetchStub.callCount).to.equal(1);
      expect(fetchStub.firstCall.args[1].signal.aborted).to.equal(false);
      await clock.tickAsync(1);
      const res = await pending;
      expect(res).to.have.status(200);
      expect(fetchStub.callCount).to.equal(2);
      expect(fetchStub.firstCall.args[1].signal.aborted).to.equal(true);
    });

    it('falls back when response headers arrive but the first body chunk times out', async () => {
      CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let started;
      const bodyWaiting = new Promise((resolve) => {
        started = resolve;
      });
      const cancel = sinon.stub().resolves();
      fetchStub.callsFake(() => buildFetchResponse());
      fetchStub.onFirstCall().callsFake((_url, { signal }) => ({
        ...buildFetchResponse(),
        body: {
          getReader: () => ({
            read: () => {
              started();
              return waitForAbort(signal);
            },
            cancel,
          }),
        },
      }));
      const pending = request
        .execute(app)
        .get(`/api/ipfs/${testCid}`)
        .then((res) => res);
      await bodyWaiting;
      await clock.tickAsync(6000);
      const res = await pending;
      expect(res).to.have.status(200);
      expect(fetchStub.callCount).to.equal(2);
      expect(cancel.calledOnce).to.equal(true);
    });

    it('falls back on a body network error before response bytes are written', async () => {
      fetchStub.callsFake(() => buildFetchResponse());
      fetchStub.onFirstCall().resolves({
        ...buildFetchResponse(),
        body: {
          getReader: () => ({
            read: sinon.stub().rejects(new Error('socket closed')),
            cancel: sinon.stub().resolves(),
          }),
        },
      });
      const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
      expect(res).to.have.status(200);
      expect(fetchStub.callCount).to.equal(2);
    });

    for (const status of [400, 401, 403, 404, 410]) {
      it(`stops after a terminal ${status} response`, async () => {
        fetchStub.resolves(buildFetchResponse({ ok: false, status }));
        const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
        expect(res).to.have.status(status === 404 ? 404 : 502);
        expect(res.body.status).to.equal(status);
        expect(fetchStub.callCount).to.equal(1);
      });
    }

    it('returns an upstream failure when every gateway fails', async () => {
      fetchStub.resolves(buildFetchResponse({ ok: false, status: 503 }));
      const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
      expect(res).to.have.status(502);
      expect(res.body).to.deep.equal({ error: 'gateway error', status: 503 });
      expect(fetchStub.callCount).to.equal(3);
      expect(fetchStub.getCalls().every((call) => call.args[1].signal.aborted)).to.equal(true);
    });

    for (const upstreamStatus of [500, 502, 503, 504, 599]) {
      for (const index of [0, 1]) {
        it(`preserves upstream ${upstreamStatus} at position ${index + 1} across later 429s`, async () => {
          fetchStub.resolves(buildFetchResponse({ ok: false, status: 429 }));
          fetchStub
            .onCall(index)
            .resolves(buildFetchResponse({ ok: false, status: upstreamStatus }));
          const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
          expect(res).to.have.status(502);
          expect(res.body).to.deep.equal({ error: 'gateway error', status: upstreamStatus });
          expect(fetchStub.callCount).to.equal(3);
        });
      }
    }

    for (const timedOut of [false, true]) {
      it(`preserves an earlier ${timedOut ? 'timeout' : 'network failure'} across later 429s`, async () => {
        const error = new Error('fetch failed');
        if (timedOut) error.name = 'AbortError';
        fetchStub.resolves(buildFetchResponse({ ok: false, status: 429 }));
        fetchStub.onFirstCall().rejects(error);
        const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
        expect(res).to.have.status(timedOut ? 504 : 502);
        expect(res.body).to.deep.equal({
          error: timedOut ? 'gateway timeout' : 'gateway unreachable',
        });
        expect(fetchStub.callCount).to.equal(3);
      });
    }

    it('returns 504 when a final 429 arrives after the overall deadline', async () => {
      const now = sinon.stub(performance, 'now').returns(0);
      fetchStub.resolves(buildFetchResponse({ ok: false, status: 503 }));
      fetchStub.onThirdCall().callsFake(() => {
        now.returns(CONFIG.IPFS_FETCH_TIMEOUT_MS);
        return buildFetchResponse({ ok: false, status: 429 });
      });
      const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
      expect(res).to.have.status(504);
      expect(res.body).to.deep.equal({ error: 'gateway timeout' });
      expect(fetchStub.callCount).to.equal(3);
    });

    it('returns a terminal 404 after an earlier retryable failure', async () => {
      fetchStub.onFirstCall().resolves(buildFetchResponse({ ok: false, status: 503 }));
      fetchStub.onSecondCall().resolves(buildFetchResponse({ ok: false, status: 404 }));
      const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
      expect(res).to.have.status(404);
      expect(res.body.status).to.equal(404);
      expect(fetchStub.callCount).to.equal(2);
    });

    for (const cooledLater of [1, 2]) {
      it(`reserves no time for ${cooledLater} cooling later gateways`, async () => {
        CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
        const clock = sinon.useFakeTimers({
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'],
        });
        fetchStub.onFirstCall().resolves(buildFetchResponse({ ok: false, status: 503 }));
        fetchStub
          .onSecondCall()
          .resolves(buildFetchResponse({ ok: false, status: cooledLater === 1 ? 503 : 429 }));
        fetchStub.onThirdCall().resolves(buildFetchResponse({ ok: false, status: 429 }));
        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(502);
        await clock.tickAsync(30_000);
        fetchStub.reset();
        let started;
        const fetchStarted = new Promise((resolve) => {
          started = resolve;
        });
        fetchStub.callsFake(async (_url, { signal }) => {
          started();
          await delayUntilResponse(cooledLater === 1 ? 6500 : 7500, signal);
          return buildFetchResponse();
        });
        const pending = request
          .execute(app)
          .get(`/api/ipfs/${testCid}`)
          .then((res) => res);
        await fetchStarted;
        await clock.tickAsync(8000);
        expect(await pending).to.have.status(200);
        expect(fetchStub.callCount).to.equal(1);
      });
    }

    for (const { reserve, attemptMs } of [
      { reserve: 2000, attemptMs: 4000 },
      { reserve: 5000, attemptMs: 1000 },
    ]) {
      it(`honors a ${reserve} ms reserve with a bounded minimum attempt window`, async () => {
        CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
        CONFIG.IPFS_FALLBACK_RESERVE_MS = reserve;
        const clock = sinon.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
        let started;
        const fetchStarted = new Promise((resolve) => {
          started = resolve;
        });
        fetchStub.callsFake(() => buildFetchResponse());
        fetchStub.onFirstCall().callsFake((_url, { signal }) => {
          started();
          return waitForAbort(signal);
        });
        const pending = request
          .execute(app)
          .get(`/api/ipfs/${testCid}`)
          .then((res) => res);
        await fetchStarted;
        await clock.tickAsync(attemptMs - 1);
        expect(fetchStub.firstCall.args[1].signal.aborted).to.equal(false);
        await clock.tickAsync(1);
        expect(await pending).to.have.status(200);
        expect(fetchStub.callCount).to.equal(2);
      });
    }

    it('bounds the minimum attempt window by a shorter overall deadline', async () => {
      CONFIG.IPFS_FETCH_TIMEOUT_MS = 250;
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let started;
      const fetchStarted = new Promise((resolve) => {
        started = resolve;
      });
      fetchStub.callsFake((_url, { signal }) => {
        started();
        return waitForAbort(signal);
      });
      const pending = request
        .execute(app)
        .get(`/api/ipfs/${testCid}`)
        .then((res) => res);
      await fetchStarted;
      await clock.tickAsync(250);
      expect(await pending).to.have.status(504);
      expect(fetchStub.callCount).to.equal(1);
      expect(fetchStub.firstCall.args[1].signal.aborted).to.equal(true);
    });

    it('refuses redirect following at each gateway while trying the next configured origin', async () => {
      fetchStub.callsFake(() => buildFetchResponse());
      fetchStub.onFirstCall().rejects(new TypeError('unexpected redirect'));
      fetchStub.onSecondCall().rejects(new TypeError('unexpected redirect'));
      const res = await request.execute(app).get(`/api/ipfs/${testCid}/asset.png`);
      expect(res).to.have.status(200);
      expect(fetchStub.getCalls().map((call) => call.args[0])).to.deep.equal(
        gateways.map((gateway) => `${gateway}${testCid}/asset.png`)
      );
      for (const call of fetchStub.getCalls()) expect(call.args[1].redirect).to.equal('error');
    });

    for (const status of [301, 302, 307, 308]) {
      it(`rejects an exposed ${status} response without using its location`, async () => {
        fetchStub.resolves(
          new globalThis.Response(null, {
            status,
            headers: { location: 'https://offsite.invalid/private' },
          })
        );
        const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
        expect(res).to.have.status(502);
        expect(fetchStub.callCount).to.equal(1);
        expect(fetchStub.firstCall.args[1].redirect).to.equal('error');
      });
    }

    it('keeps all timed-out attempts within one overall budget and releases admission', async () => {
      CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
      CONFIG.IPFS_MAX_CONCURRENT = 1;
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let started;
      const fetchStarted = new Promise((resolve) => {
        started = resolve;
      });
      fetchStub.callsFake((_url, { signal }) => {
        started();
        return waitForAbort(signal);
      });
      let settled = false;
      const pending = request
        .execute(app)
        .get(`/api/ipfs/${testCid}`)
        .then((res) => {
          settled = true;
          return res;
        });
      await fetchStarted;
      await clock.tickAsync(7999);
      expect(settled).to.equal(false);
      expect(fetchStub.callCount).to.equal(3);
      await clock.tickAsync(1);
      const res = await pending;
      expect(res).to.have.status(504);
      expect(performance.now()).to.equal(8000);
      expect(fetchStub.getCalls().every((call) => call.args[1].signal.aborted)).to.equal(true);
      clock.restore();
      fetchStub.callsFake(() => buildFetchResponse());
      expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
    });

    it('keeps a partial fallback stream within the original deadline and then releases admission', async () => {
      CONFIG.IPFS_FETCH_TIMEOUT_MS = 8000;
      CONFIG.IPFS_MAX_CONCURRENT = 1;
      const server = createServer(app);
      await new Promise((resolve) => server.listen(0, CONFIG.LISTEN_HOST, resolve));
      const address = server.address();
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      let started;
      const fetchStarted = new Promise((resolve) => {
        started = resolve;
      });
      let reading;
      const bodyWaiting = new Promise((resolve) => {
        reading = resolve;
      });
      fetchStub.onFirstCall().callsFake((_url, { signal }) => {
        started();
        return waitForAbort(signal);
      });
      fetchStub.onSecondCall().callsFake((_url, { signal }) => {
        let first = true;
        return {
          ...buildFetchResponse(),
          body: {
            getReader: () => ({
              read() {
                if (first) {
                  first = false;
                  return Promise.resolve({ done: false, value: Buffer.from('partial') });
                }
                reading();
                return waitForAbort(signal);
              },
              cancel: sinon.stub().resolves(),
            }),
          },
        };
      });
      try {
        const pending = getFromServerExpectDisconnect(address.port, `/api/ipfs/${testCid}`);
        await fetchStarted;
        await clock.tickAsync(6000);
        await bodyWaiting;
        await clock.tickAsync(1999);
        expect(fetchStub.secondCall.args[1].signal.aborted).to.equal(false);
        await clock.tickAsync(1);
        const result = await pending;
        expect(performance.now()).to.equal(8000);
        expect(result.disconnected).to.equal(true);
        expect(result.body.toString()).to.equal('partial');
        expect(fetchStub.callCount).to.equal(2);
        expect(fetchStub.secondCall.args[1].signal.aborted).to.equal(true);
        clock.restore();
        fetchStub.callsFake(() => buildFetchResponse());
        expect((await getFromServer(address.port, `/api/ipfs/${testCid}`)).status).to.equal(200);
      } finally {
        clock.restore();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('fallback response safety', () => {
    beforeEach(() => {
      fetchStub.onFirstCall().resolves(buildFetchResponse({ ok: false, status: 503 }));
    });

    for (const contentLength of [0, 10]) {
      it(`enforces the size limit after fallback with declared size ${contentLength}`, async () => {
        CONFIG.IPFS_MAX_SIZE_BYTES = 4;
        fetchStub.callsFake(() =>
          buildFetchResponse({ contentLength, chunks: [Buffer.alloc(10)] })
        );
        const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
        expect(res).to.have.status(413);
        expect(fetchStub.callCount).to.equal(2);
        expect(fetchStub.secondCall.args[1].signal.aborted).to.equal(true);
      });
    }

    it('returns an error for a null fallback body', async () => {
      fetchStub.resolves(new globalThis.Response(null, { status: 204 }));
      const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
      expect(res).to.have.status(502);
      expect(res.body.error).to.equal('gateway error');
      expect(fetchStub.callCount).to.equal(2);
    });

    for (const contentType of ['text/html', null]) {
      it(`retains download and security headers for fallback content type ${contentType}`, async () => {
        fetchStub.callsFake(() => buildFetchResponse({ contentType }));
        const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
        expect(res).to.have.status(200);
        expect(res).to.have.header('content-type', 'application/octet-stream');
        expect(res).to.have.header('content-disposition', 'attachment');
        expect(res).to.have.header('x-content-type-options', 'nosniff');
        expect(res).to.have.header(
          'content-security-policy',
          "default-src 'none'; img-src 'self' data: blob:; sandbox"
        );
        expect(fetchStub.callCount).to.equal(2);
      });
    }

    for (const failure of ['oversize chunk', 'non-binary chunk', 'stream read error']) {
      it(`terminates a partial fallback response on ${failure}`, async () => {
        CONFIG.IPFS_MAX_SIZE_BYTES = 4;
        let first = true;
        const cancel = sinon.stub().callsFake(() => new Promise(() => {}));
        fetchStub.resolves({
          ...buildFetchResponse({ contentLength: 0 }),
          body: {
            getReader: () => ({
              async read() {
                if (first) {
                  first = false;
                  return { done: false, value: Buffer.from('part') };
                }
                if (failure === 'stream read error') throw new Error('socket hang up');
                return {
                  done: false,
                  value: failure === 'oversize chunk' ? Buffer.alloc(1) : 'non-binary',
                };
              },
              cancel,
            }),
          },
        });
        const server = createServer(app);
        await new Promise((resolve) => server.listen(0, CONFIG.LISTEN_HOST, resolve));
        try {
          const result = await getFromServerExpectDisconnect(
            server.address().port,
            `/api/ipfs/${testCid}`
          );
          expect(result.disconnected).to.equal(true);
          expect(result.body.toString()).to.equal('part');
          expect(fetchStub.callCount).to.equal(2);
          expect(fetchStub.secondCall.args[1].signal.aborted).to.equal(true);
          expect(cancel.calledOnce).to.equal(true);
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
      });
    }
  });

  describe('gateway cooldown', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    for (const { label, retryAfter, duration } of [
      { label: 'missing Retry-After', retryAfter: null, duration: 60_000 },
      { label: 'delta-seconds Retry-After', retryAfter: '120', duration: 120_000 },
      { label: 'fifteen minute Retry-After', retryAfter: '900', duration: 900_000 },
      {
        label: 'HTTP-date Retry-After',
        retryAfter: new Date(now + 90_000).toUTCString(),
        duration: 90_000,
      },
      { label: 'capped delta-seconds', retryAfter: '999999999999999999999', duration: 900_000 },
      {
        label: 'capped HTTP date',
        retryAfter: new Date(now + 1_800_000).toUTCString(),
        duration: 900_000,
      },
      { label: 'malformed Retry-After', retryAfter: 'later', duration: 60_000 },
      { label: 'negative Retry-After', retryAfter: '-1', duration: 60_000 },
    ]) {
      it(`skips and then retries the gateway with ${label}`, async () => {
        let current = now;
        sinon.stub(Date, 'now').callsFake(() => current);
        fetchStub.callsFake(() => buildFetchResponse());
        fetchStub
          .onFirstCall()
          .resolves(buildFetchResponse({ ok: false, status: 429, retryAfter }));

        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
        current += duration - 1;
        expect(await request.execute(app).get(`/api/ipfs/${testCid}/other.png`)).to.have.status(
          200
        );
        expect(fetchStub.thirdCall.args[0]).to.equal(`${gateways[1]}${testCid}/other.png`);
        current += 1;
        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
        expect(fetchStub.getCall(3).args[0]).to.equal(`${gateways[0]}${testCid}`);
        expect(fetchStub.callCount).to.equal(4);
      });
    }

    for (const status of [500, 502, 503, 504, 599]) {
      it(`skips a ${status} gateway for thirty seconds and retries it on expiry`, async () => {
        let current = now;
        sinon.stub(Date, 'now').callsFake(() => current);
        fetchStub.callsFake(() => buildFetchResponse());
        fetchStub
          .onFirstCall()
          .resolves(buildFetchResponse({ ok: false, status, retryAfter: '900' }));
        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
        current += 29_999;
        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
        expect(fetchStub.thirdCall.args[0]).to.equal(`${gateways[1]}${testCid}`);
        current += 1;
        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
        expect(fetchStub.getCall(3).args[0]).to.equal(`${gateways[0]}${testCid}`);
      });
    }

    it('honors a configured cooldown cap above fifteen minutes', async () => {
      CONFIG.IPFS_MAX_COOLDOWN_MS = 1_800_000;
      let current = now;
      sinon.stub(Date, 'now').callsFake(() => current);
      fetchStub.callsFake(() => buildFetchResponse());
      fetchStub
        .onFirstCall()
        .resolves(buildFetchResponse({ ok: false, status: 429, retryAfter: '3600' }));
      expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
      current += 1_799_999;
      expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
      expect(fetchStub.thirdCall.args[0]).to.equal(`${gateways[1]}${testCid}`);
      current += 1;
      expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
      expect(fetchStub.getCall(3).args[0]).to.equal(`${gateways[0]}${testCid}`);
    });

    for (const retryAfter of ['0', new Date(now - 60_000).toUTCString()]) {
      it(`permits the next request immediately for expired Retry-After ${retryAfter}`, async () => {
        sinon.stub(Date, 'now').returns(now);
        fetchStub.callsFake(() => buildFetchResponse());
        fetchStub
          .onFirstCall()
          .resolves(buildFetchResponse({ ok: false, status: 429, retryAfter }));
        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
        expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(200);
        expect(fetchStub.thirdCall.args[0]).to.equal(`${gateways[0]}${testCid}`);
      });
    }

    it('returns a bounded Retry-After without fetching when every gateway is cooling down', async () => {
      sinon.stub(Date, 'now').returns(now);
      fetchStub.resolves(buildFetchResponse({ ok: false, status: 429 }));
      expect(await request.execute(app).get(`/api/ipfs/${testCid}`)).to.have.status(502);
      const res = await request.execute(app).get(`/api/ipfs/${testCid}`);
      expect(res).to.have.status(503);
      expect(res).to.have.header('retry-after', '60');
      expect(fetchStub.callCount).to.equal(3);
    });
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
    expect(fetchStub.callCount).to.equal(1);
  });

  describe('inline media allowlist', () => {
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

    it('serves HTML as a download with a generic content type', async () => {
      fetchStub.resolves(
        buildFetchResponse({
          contentType: 'text/html; charset=utf-8',
          chunks: [Buffer.from('<h1>hi</h1>')],
        })
      );
      const res = await request.execute(app).get(`/api/ipfs/${cid}`);
      expect(res).to.have.status(200);
      expect(res).to.have.header('content-type', 'application/octet-stream');
      expect(res).to.have.header('content-disposition', 'attachment');
    });

    it('serves a missing content type as a download', async () => {
      fetchStub.resolves(buildFetchResponse({ contentType: null }));
      const res = await request.execute(app).get(`/api/ipfs/${cid}`);
      expect(res).to.have.header('content-type', 'application/octet-stream');
      expect(res).to.have.header('content-disposition', 'attachment');
    });

    for (const type of [
      'image/png',
      'image/svg+xml',
      'video/mp4',
      'audio/mpeg',
      'application/json',
    ]) {
      it(`keeps ${type} inline`, async () => {
        fetchStub.resolves(
          buildFetchResponse({ contentType: type, chunks: [Buffer.from('{"a":1}')] })
        );
        const res = await request.execute(app).get(`/api/ipfs/${cid}`);
        expect(res).to.have.header('content-type', new RegExp(`^${type.replace('+', '\\+')}`));
        expect(res).to.not.have.header('content-disposition');
      });
    }
  });
});
