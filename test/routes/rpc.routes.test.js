import * as chai from 'chai';
import { createServer, request as httpRequest } from 'node:http';
import { default as chaiHttp, request } from 'chai-http';
import sinon from 'sinon';
import { app } from '../../src/app.js';
import { CONFIG } from '../../src/config/index.js';
import { rpcService } from '../../src/services/rpc.service.js';
import { HttpError } from '../../src/utils/guards.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('RPC Routes', () => {
  let rpcServiceStub;
  let originalRateLimits;

  beforeEach(() => {
    originalRateLimits = {
      RPC_RATE_LIMIT_PER_MINUTE: CONFIG.RPC_RATE_LIMIT_PER_MINUTE,
      RPC_WRITE_RATE_LIMIT_PER_MINUTE: CONFIG.RPC_WRITE_RATE_LIMIT_PER_MINUTE,
    };
    rpcServiceStub = sinon.stub(rpcService, 'executeRPC');
  });

  afterEach(() => {
    Object.assign(CONFIG, originalRateLimits);
    rpcServiceStub.restore();
  });

  it('should return result for valid RPC call', async () => {
    const mockResult = { jsonrpc: '2.0', id: 1, result: '0x1234' };
    rpcServiceStub.resolves(mockResult);

    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({ method: 'qrl_blockNumber', params: [] });

    expect(res).to.have.status(200);
    expect(res.body).to.deep.equal(mockResult);
  });

  it('forwards the client JSON-RPC id to the service', async () => {
    rpcServiceStub.resolves({ jsonrpc: '2.0', id: 'abc-1', result: '0x1' });

    await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({ jsonrpc: '2.0', method: 'qrl_blockNumber', params: [], id: 'abc-1' });

    expect(rpcServiceStub.firstCall.args[3]).to.equal('abc-1');
  });

  it('degrades an invalid (non string/number) id to null', async () => {
    rpcServiceStub.resolves({ jsonrpc: '2.0', id: null, result: '0x1' });

    await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({ jsonrpc: '2.0', method: 'qrl_blockNumber', params: [], id: { weird: true } });

    expect(rpcServiceStub.firstCall.args[3]).to.equal(null);
  });

  it('should handle errors from RPC service', async () => {
    rpcServiceStub.rejects(new Error('RPC Error'));

    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({ method: 'qrl_blockNumber', params: [] });

    expect(res).to.have.status(500);
    expect(res.body.error.message).to.equal('Internal Server Error');
  });

  it('preserves deterministic upstream and admission error statuses', async () => {
    for (const status of [502, 503]) {
      rpcServiceStub.rejects(new HttpError(status, status === 502 ? 'upstream failed' : 'busy'));
      const res = await request
        .execute(app)
        .post(`/api/qrl-rpc/status-${status}`)
        .send({ method: 'qrl_blockNumber', params: [] });
      expect(res).to.have.status(status);
      rpcServiceStub.resetBehavior();
    }
  });

  it('should reject disallowed RPC methods', async () => {
    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({ method: 'debug_traceTransaction', params: [] });

    expect(res).to.have.status(403);
    expect(res.body.error.code).to.equal(-32601);
    expect(res.body.error.message).to.include('Method not allowed');
  });

  it('does not expose unsigned qrl_sendTransaction', async () => {
    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({ method: 'qrl_sendTransaction', params: [{ from: 'Q' + 'a'.repeat(40) }] });

    expect(res).to.have.status(403);
    expect(res.body.error.code).to.equal(-32601);
    expect(rpcServiceStub.called).to.equal(false);
  });

  it('rejects numeric-to-dynamic qrl_getLogs scans', async () => {
    for (const filter of [
      { fromBlock: '0x1', toBlock: 'latest' },
      { fromBlock: '0x1', toBlock: 'pending' },
      { fromBlock: '0x1' },
    ]) {
      const res = await request
        .execute(app)
        .post('/api/qrl-rpc/dev')
        .send({ method: 'qrl_getLogs', params: [filter] });
      expect(res).to.have.status(400);
      expect(res.body.error.message).to.include('numeric toBlock');
    }
    expect(rpcServiceStub.called).to.equal(false);
  });

  it('allows a bounded numeric qrl_getLogs range', async () => {
    rpcServiceStub.resolves({ jsonrpc: '2.0', id: 1, result: [] });
    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'qrl_getLogs',
        params: [{ fromBlock: '0x100', toBlock: '0x200' }],
      });

    expect(res).to.have.status(200);
    expect(rpcServiceStub.calledOnce).to.equal(true);
  });

  it('enforces the 50KB JSON limit for chunked bodies without Content-Length', async () => {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const body = JSON.stringify({
        method: 'qrl_call',
        params: [{ to: 'Q' + 'a'.repeat(40), data: 'x'.repeat(60 * 1024) }],
      });
      const status = await new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/qrl-rpc/dev',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Transfer-Encoding': 'chunked',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          }
        );
        req.on('error', reject);
        const midpoint = Math.floor(body.length / 2);
        req.write(body.slice(0, midpoint));
        req.end(body.slice(midpoint));
      });

      expect(status).to.equal(413);
      expect(rpcServiceStub.called).to.equal(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('does not let spoofed forwarding headers evade write rate limits', async () => {
    const originalTrustedProxies = [...CONFIG.TRUSTED_PROXY_CIDRS];
    CONFIG.TRUSTED_PROXY_CIDRS = [];
    rpcServiceStub.resolves({ jsonrpc: '2.0', id: 1, result: '0x1' });
    try {
      let lastResponse;
      for (let i = 0; i < 11; i++) {
        lastResponse = await request
          .execute(app)
          .post('/api/qrl-rpc/mainnet')
          .set('X-Forwarded-For', `198.51.100.${i + 1}`)
          .send({ id: i, method: 'qrl_sendRawTransaction', params: ['0x01'] });
      }
      expect(lastResponse).to.have.status(429);
      expect(rpcServiceStub.callCount).to.equal(10);
    } finally {
      CONFIG.TRUSTED_PROXY_CIDRS = originalTrustedProxies;
    }
  });

  it('charges invalid and batch requests to the general admission limit', async () => {
    CONFIG.RPC_RATE_LIMIT_PER_MINUTE = 3;
    const originalTrustedProxies = [...CONFIG.TRUSTED_PROXY_CIDRS];
    CONFIG.TRUSTED_PROXY_CIDRS = ['loopback'];
    const clientIp = '198.51.100.244';

    try {
      const malformed = await request
        .execute(app)
        .post('/api/qrl-rpc/invalid-a')
        .set('X-Forwarded-For', clientIp)
        .set('Content-Type', 'application/json')
        .send('{');
      expect(malformed).to.have.status(400);

      const invalid = await request
        .execute(app)
        .post('/api/qrl-rpc/invalid-b')
        .set('X-Forwarded-For', clientIp)
        .send({ method: 'not_allowed', params: [] });
      expect(invalid).to.have.status(403);

      const batch = await request
        .execute(app)
        .post('/api/qrl-rpc/invalid-c')
        .set('X-Forwarded-For', clientIp)
        .send([{ method: 'qrl_blockNumber', params: [] }]);
      expect(batch).to.have.status(400);

      const limited = await request
        .execute(app)
        .post('/api/qrl-rpc/invalid-d')
        .set('X-Forwarded-For', clientIp)
        .send({ method: 'still_not_allowed', params: [] });
      expect(limited).to.have.status(429);
      expect(limited.body.error.code).to.equal(-32005);
      expect(rpcServiceStub.called).to.equal(false);
    } finally {
      CONFIG.TRUSTED_PROXY_CIDRS = originalTrustedProxies;
    }
  });

  it('should reject batch requests', async () => {
    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send([
        { method: 'qrl_blockNumber', params: [] },
        { method: 'qrl_gasPrice', params: [] },
      ]);

    expect(res).to.have.status(400);
    expect(res.body.error.message).to.include('Batch requests are not supported');
  });

  it('should validate address format', async () => {
    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({ method: 'qrl_getBalance', params: ['invalid-address', 'latest'] });

    expect(res).to.have.status(400);
    expect(res.body.error.code).to.equal(-32602);
  });
});
