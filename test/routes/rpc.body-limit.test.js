import * as chai from 'chai';
import { createServer, request as httpRequest } from 'node:http';
import { default as chaiHttp, request } from 'chai-http';
import sinon from 'sinon';
import { app } from '../../src/app.js';
import { CONFIG } from '../../src/config/index.js';
import { rpcService } from '../../src/services/rpc.service.js';
import {
  RPC_LARGE_BODY_LIMIT_BYTES,
  RPC_DEFAULT_BODY_LIMIT_BYTES,
} from '../../src/middleware/rpc-body.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('RPC body limits', () => {
  const qip55Address = `Q${'a'.repeat(128)}`;
  const MAX_POOL_TX_BYTES = 128 * 1024;
  let stub;
  let saved;
  let ipCounter = 0;

  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;
  const post = (body, ip = nextIp()) =>
    request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .set('X-Forwarded-For', ip)
      .set('Content-Type', 'application/json')
      .send(typeof body === 'string' ? body : JSON.stringify(body));
  const rawTx = (bytes) => `0x${'ab'.repeat(bytes)}`;
  const sendRaw = (bytes) => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'qrl_sendRawTransaction',
    params: [rawTx(bytes)],
  });

  beforeEach(() => {
    saved = {
      proxies: [...CONFIG.TRUSTED_PROXY_CIDRS],
      general: CONFIG.RPC_RATE_LIMIT_PER_MINUTE,
      write: CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE,
    };
    CONFIG.TRUSTED_PROXY_CIDRS = ['loopback'];
    CONFIG.RPC_RATE_LIMIT_PER_MINUTE = 1000;
    CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE = 1000;
    stub = sinon.stub(rpcService, 'executeRPC').resolves({ jsonrpc: '2.0', id: 7, result: '0x1' });
  });

  afterEach(() => {
    CONFIG.TRUSTED_PROXY_CIDRS = saved.proxies;
    CONFIG.RPC_RATE_LIMIT_PER_MINUTE = saved.general;
    CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE = saved.write;
    stub.restore();
  });

  it('covers a full 128 KiB transaction with the raw-transaction limit', () => {
    const body = JSON.stringify(sendRaw(MAX_POOL_TX_BYTES));
    expect(body.length).to.be.lessThan(RPC_LARGE_BODY_LIMIT_BYTES);
    expect(RPC_LARGE_BODY_LIMIT_BYTES).to.be.greaterThan(RPC_DEFAULT_BODY_LIMIT_BYTES);
  });

  for (const bytes of [60_000, MAX_POOL_TX_BYTES]) {
    it(`forwards a ${bytes} byte qrl_sendRawTransaction unchanged`, async () => {
      const res = await post(sendRaw(bytes));
      expect(res).to.have.status(200);
      expect(stub.calledOnce).to.equal(true);
      const [network, method, params, id] = stub.firstCall.args;
      expect(network).to.equal('dev');
      expect(method).to.equal('qrl_sendRawTransaction');
      expect(params).to.deep.equal([rawTx(bytes)]);
      expect(id).to.equal(7);
    });
  }

  it('refuses a qrl_sendRawTransaction body above the raw-transaction limit', async () => {
    const res = await post(sendRaw(RPC_LARGE_BODY_LIMIT_BYTES / 2 + 1000));
    expect(res).to.have.status(413);
    expect(res.body).to.deep.equal({ error: { message: 'Request body too large' } });
    expect(stub.called).to.equal(false);
  });

  it('keeps the default limit and error shape for another method', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'qrl_call',
      params: [{ to: qip55Address, data: 'x'.repeat(60 * 1024) }],
    });
    expect(res).to.have.status(413);
    expect(res.body).to.deep.equal({ error: { message: 'Request body too large' } });
    expect(stub.called).to.equal(false);
  });

  it('refuses a large body that only mentions the raw-transaction method', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'qrl_call',
      params: [{ to: qip55Address, data: 'qrl_sendRawTransaction'.repeat(3000) }],
    });
    expect(res).to.have.status(413);
    expect(stub.called).to.equal(false);
  });

  it('keeps the default limit for a batch carrying a large raw transaction', async () => {
    const res = await post([sendRaw(60_000)]);
    expect(res).to.have.status(413);
    expect(stub.called).to.equal(false);
  });

  it('still serves small requests of each kind', async () => {
    const small = await post(sendRaw(200));
    expect(small).to.have.status(200);
    const call = await post({
      jsonrpc: '2.0',
      id: 7,
      method: 'qrl_call',
      params: [{ to: qip55Address, data: '0x' }],
    });
    expect(call).to.have.status(200);
    expect(stub.calledTwice).to.equal(true);
  });

  it('charges oversized bodies to the admission limit', async () => {
    CONFIG.RPC_RATE_LIMIT_PER_MINUTE = 2;
    const ip = nextIp();
    const oversized = {
      jsonrpc: '2.0',
      id: 1,
      method: 'qrl_call',
      params: [{ to: qip55Address, data: 'x'.repeat(60 * 1024) }],
    };
    expect(await post(oversized, ip)).to.have.status(413);
    expect(await post(sendRaw(RPC_LARGE_BODY_LIMIT_BYTES / 2 + 1000), ip)).to.have.status(413);
    const limited = await post(sendRaw(100), ip);
    expect(limited).to.have.status(429);
    expect(limited.body.error.code).to.equal(-32005);
    expect(stub.called).to.equal(false);
  });

  describe('large-body methods', () => {
    const callBody = (method, dataBytes, extra = {}) => ({
      jsonrpc: '2.0',
      id: 7,
      method,
      params: [{ from: qip55Address, to: qip55Address, data: rawTx(dataBytes) }, 'latest'],
      ...extra,
    });

    for (const method of ['qrl_call', 'qrl_estimateGas']) {
      it(`forwards a large ${method} unchanged`, async () => {
        const body = callBody(method, 100_000);
        const res = await post(body);
        expect(res).to.have.status(200);
        const [, forwardedMethod, params] = stub.firstCall.args;
        expect(forwardedMethod).to.equal(method);
        expect(params).to.deep.equal(body.params);
      });
    }

    it('refuses a large body with a method outside the three', async () => {
      const res = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'qrl_getBalance',
        params: [qip55Address, rawTx(100_000)],
      });
      expect(res).to.have.status(413);
      expect(stub.called).to.equal(false);
    });

    it('refuses a large qrl_call that carries an unknown envelope field', async () => {
      const res = await post(callBody('qrl_call', 100_000, { padding: 'ab'.repeat(1000) }));
      expect(res).to.have.status(413);
      expect(stub.called).to.equal(false);
    });

    it('refuses a large qrl_call with a third param', async () => {
      const body = callBody('qrl_call', 100_000);
      body.params.push('latest');
      expect((await post(body)).status).to.equal(413);
      expect(stub.called).to.equal(false);
    });

    it('refuses a large qrl_call with a nested or non-hex call field', async () => {
      const nested = callBody('qrl_call', 100_000);
      nested.params[0].accessList = [];
      expect((await post(nested)).status).to.equal(413);
      const text = callBody('qrl_call', 100_000);
      text.params[0].data = 'ab'.repeat(100_000);
      expect((await post(text)).status).to.equal(413);
      expect(stub.called).to.equal(false);
    });

    it('refuses extra params on a large qrl_sendRawTransaction', async () => {
      const body = sendRaw(60_000);
      body.params.push(rawTx(1000));
      expect((await post(body)).status).to.equal(413);
      expect(stub.called).to.equal(false);
    });

    it('refuses a large padded or nested body that names a large method', async () => {
      const nested = `{"method":"qrl_call","params":${'['.repeat(30_000)}${']'.repeat(30_000)}}`;
      expect((await post(nested)).status).to.equal(413);
      const padded = JSON.stringify({ ...sendRaw(100), id: 'z'.repeat(200) }) + ' '.repeat(60_000);
      expect((await post(padded)).status).to.equal(413);
      const longId = { ...sendRaw(60_000), id: 'a'.repeat(5000) };
      expect((await post(longId)).status).to.equal(413);
      expect(stub.called).to.equal(false);
    });

    it('answers a malformed large body that names no method with 413', async () => {
      expect((await post(`{${'x'.repeat(60_000)}`)).status).to.equal(413);
    });

    it('refuses a near-miss method name above the default limit', async () => {
      const res = await post({ ...sendRaw(60_000), method: 'QRL_sendRawTransaction' });
      expect(res).to.have.status(413);
    });
  });

  describe('exact boundaries', () => {
    // Body of exactly `total` bytes: an id of 'a' characters (hex) absorbs parity.
    const exactSendRaw = (total) => {
      const base = JSON.stringify({ ...sendRaw(0), id: '' }).length;
      const rest = total - base;
      const idLen = rest % 2;
      const body = JSON.stringify({ ...sendRaw((rest - idLen) / 2), id: 'a'.repeat(idLen) });
      expect(body.length).to.equal(total);
      return body;
    };
    const exactCall = (total) => {
      const base = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'qrl_getLogs', params: [''] });
      return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'qrl_getLogs',
        params: ['x'.repeat(total - base.length)],
      });
    };

    it('accepts another method at exactly 51200 bytes and refuses 51201', async () => {
      const ok = exactCall(RPC_DEFAULT_BODY_LIMIT_BYTES);
      expect(ok.length).to.equal(RPC_DEFAULT_BODY_LIMIT_BYTES);
      const res = await post(ok);
      expect(res.status).to.not.equal(413);
      const over = await post(exactCall(RPC_DEFAULT_BODY_LIMIT_BYTES + 1));
      expect(over).to.have.status(413);
      expect(over.body).to.deep.equal({ error: { message: 'Request body too large' } });
    });

    it('accepts qrl_sendRawTransaction at exactly 270000 bytes and refuses 270001', async () => {
      expect(RPC_LARGE_BODY_LIMIT_BYTES).to.equal(270_000);
      const ok = await post(exactSendRaw(270_000));
      expect(ok).to.have.status(200);
      const over = await post(exactSendRaw(270_001));
      expect(over).to.have.status(413);
      expect(over.body).to.deep.equal({ error: { message: 'Request body too large' } });
      expect(stub.calledOnce).to.equal(true);
    });

    it('refuses a post-parse rejection with the standard error body', async () => {
      const res = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'qrl_getBalance',
        params: ['qrl_call', 'ab'.repeat(30_000)],
      });
      expect(res).to.have.status(413);
      expect(res.body).to.deep.equal({ error: { message: 'Request body too large' } });
    });
  });

  describe('scope of the larger limit', () => {
    const big = JSON.stringify(sendRaw(60_000));

    for (const verb of ['get', 'put', 'patch', 'delete', 'options']) {
      it(`keeps the default limit for ${verb.toUpperCase()} on the route`, async () => {
        const res = await request
          .execute(app)
          [verb]('/api/qrl-rpc/dev')
          .set('X-Forwarded-For', nextIp())
          .set('Content-Type', 'application/json')
          .send(big);
        expect(res).to.have.status(413);
        expect(stub.called).to.equal(false);
      });
    }

    for (const path of ['/api/qrl-rpc/dev/extra', '/api/tx-history', '/api/ipfs/x', '/other']) {
      it(`keeps the default limit for POST ${path}`, async () => {
        const res = await request
          .execute(app)
          .post(path)
          .set('X-Forwarded-For', nextIp())
          .set('Content-Type', 'application/json')
          .send(big);
        expect(res).to.have.status(413);
        expect(stub.called).to.equal(false);
      });
    }
  });

  describe('large-body limiter', () => {
    it('refuses the request after the write limit and counts refused large bodies', async () => {
      CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE = 3;
      const ip = nextIp();
      expect(await post(sendRaw(30_000), ip)).to.have.status(200);
      expect(await post(callBodyOversized(), ip)).to.have.status(413);
      expect(await post(sendRaw(30_000), ip)).to.have.status(200);
      const limited = await post(sendRaw(30_000), ip);
      expect(limited).to.have.status(429);
      expect(limited.body.error.code).to.equal(-32005);
      expect(stub.calledTwice).to.equal(true);
    });

    it('does not count small requests', async () => {
      CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE = 1000;
      const ip = nextIp();
      for (let i = 0; i < 5; i += 1) {
        expect(
          await post({ jsonrpc: '2.0', id: 1, method: 'qrl_blockNumber', params: [] }, ip)
        ).to.have.status(200);
      }
      CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE = 1;
      expect(await post(sendRaw(30_000), ip)).to.have.status(200);
    });

    function callBodyOversized() {
      return { jsonrpc: '2.0', id: 1, method: 'qrl_getBalance', params: ['ab'.repeat(30_000)] };
    }
  });

  describe('chunked requests', () => {
    const postChunked = async (payload, ip) => {
      const server = createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const body = JSON.stringify(payload);
        return await new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port: server.address().port,
              path: '/api/qrl-rpc/dev',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Transfer-Encoding': 'chunked',
                'X-Forwarded-For': ip,
              },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode));
            }
          );
          req.on('error', reject);
          const mid = Math.floor(body.length / 2);
          req.write(body.slice(0, mid));
          req.end(body.slice(mid));
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };

    it('does not count small chunked requests against the large-body limiter', async () => {
      CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE = 2;
      const ip = nextIp();
      for (let i = 0; i < 5; i += 1) {
        expect(
          await postChunked({ jsonrpc: '2.0', id: 1, method: 'qrl_blockNumber', params: [] }, ip)
        ).to.equal(200);
      }
      expect(stub.callCount).to.equal(5);
    });

    it('refuses a large chunked body that has no declared length', async () => {
      expect(await postChunked(sendRaw(60_000), nextIp())).to.equal(413);
      expect(stub.called).to.equal(false);
    });

    it('still serves a large body with a Content-Length', async () => {
      expect(await post(sendRaw(60_000))).to.have.status(200);
      expect(stub.calledOnce).to.equal(true);
    });
  });
});
