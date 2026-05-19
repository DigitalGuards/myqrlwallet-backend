import * as chai from 'chai';
import sinon from 'sinon';
import { default as chaiHttp, request } from 'chai-http';

chai.use(chaiHttp);
const { expect } = chai;

import { app } from '../../src/app.js';

function buildFetchResponse({
  ok = true,
  status = 200,
  contentType = 'image/png',
  body = Buffer.from('PNGDATA'),
  contentLength,
} = {}) {
  const bufBody = body instanceof Buffer ? body : Buffer.from(body);
  return {
    ok,
    status,
    headers: {
      get(name) {
        const n = name.toLowerCase();
        if (n === 'content-type') return contentType;
        if (n === 'content-length') return String(contentLength ?? bufBody.length);
        return null;
      },
    },
    arrayBuffer: async () =>
      bufBody.buffer.slice(bufBody.byteOffset, bufBody.byteOffset + bufBody.byteLength),
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
      buildFetchResponse({ contentType: 'image/png', body: Buffer.from('PNGDATA') }),
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
        body: Buffer.from('{"name":"x"}'),
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

  it('rejects responses larger than MAX_SIZE', async () => {
    fetchStub.resolves(
      buildFetchResponse({ contentLength: 20 * 1024 * 1024, body: Buffer.alloc(8) }),
    );

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(413);
    expect(res.body.error).to.equal('too large');
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

  it('returns 404 when the gateway returns 404', async () => {
    fetchStub.resolves({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.alloc(0).buffer,
    });

    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const res = await request.execute(app).get(`/api/ipfs/${cid}`);

    expect(res).to.have.status(404);
    expect(res.body.error).to.equal('gateway error');
  });
});
