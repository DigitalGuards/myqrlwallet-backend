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
  const qip55Address = `Q${'a'.repeat(128)}`;
  const secondQip55Address = `Q${'B'.repeat(128)}`;

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

  describe('qrl_getTransactionByHash', () => {
    const method = 'qrl_getTransactionByHash';
    const hash = `0x${'ab'.repeat(32)}`;

    for (const [name, txHash, id] of [
      ['lowercase', hash, 'tx-lookup'],
      ['uppercase digits', `0x${'AB'.repeat(32)}`, 42],
      ['mixed-case digits', `0x${'aB'.repeat(32)}`, null],
    ]) {
      it(`forwards a ${name} hash and the caller id unchanged`, async () => {
        const result = { hash: txHash, value: '0x64', blockNumber: '0x10' };
        const envelope = { jsonrpc: '2.0', id, result };
        rpcServiceStub.resolves(envelope);

        const res = await request
          .execute(app)
          .post('/api/qrl-rpc/dev')
          .send({ jsonrpc: '2.0', id, method, params: [txHash] });

        expect(res).to.have.status(200);
        expect(res.body).to.deep.equal(envelope);
        expect(rpcServiceStub.calledOnceWithExactly('dev', method, [txHash], id)).to.equal(true);
      });
    }

    it('preserves a null result for an unknown transaction', async () => {
      const envelope = { jsonrpc: '2.0', id: 'unknown-tx', result: null };
      rpcServiceStub.resolves(envelope);

      const res = await request
        .execute(app)
        .post('/api/qrl-rpc/dev')
        .send({ jsonrpc: '2.0', id: envelope.id, method, params: [hash] });

      expect(res).to.have.status(200);
      expect(res.body).to.deep.equal(envelope);
      expect(rpcServiceStub.calledOnce).to.equal(true);
    });

    for (const [name, params] of [
      ['missing params', undefined],
      ['null params', null],
      ['empty params', []],
      ['extra params', [hash, true]],
      ['string params', hash],
      ['object params', { hash }],
      ['null hash', [null]],
      ['numeric hash', [1]],
      ['object hash', [{ hash }]],
      ['nested hash', [[hash]]],
      ['empty hash', ['']],
      ['missing prefix', ['ab'.repeat(32)]],
      ['uppercase prefix', [`0X${'ab'.repeat(32)}`]],
      ['short hash', [`0x${'a'.repeat(63)}`]],
      ['long hash', [`0x${'a'.repeat(65)}`]],
      ['non-hex hash', [`0x${'g'.repeat(64)}`]],
      ['QRL address', [qip55Address]],
      ['64-byte value', [`0x${'a'.repeat(128)}`]],
      ['padded hash', [` ${hash}`]],
      ['trailing newline', [`${hash}\n`]],
    ]) {
      it(`rejects ${name} before forwarding`, async () => {
        const res = await request
          .execute(app)
          .post('/api/qrl-rpc/dev')
          .send({ jsonrpc: '2.0', id: 'invalid-lookup', method, params });

        expect(res).to.have.status(400);
        expect(res.body.jsonrpc).to.equal('2.0');
        expect(res.body.id).to.equal('invalid-lookup');
        expect(res.body.error.code).to.equal(-32602);
        expect(rpcServiceStub.called).to.equal(false);
      });
    }

    it('rejects batched transaction lookups before forwarding', async () => {
      const res = await request
        .execute(app)
        .post('/api/qrl-rpc/dev')
        .send([{ jsonrpc: '2.0', id: 'batch-lookup', method, params: [hash] }]);

      expect(res).to.have.status(400);
      expect(res.body.error.code).to.equal(-32600);
      expect(rpcServiceStub.called).to.equal(false);
    });

    it('lists the lookup in public method documentation', async () => {
      const res = await request.execute(app).get('/api/qrl-rpc/dev');

      expect(res).to.have.status(200);
      expect(res.body.allowed_methods).to.include(method);
      expect(res.body.allowed_methods).not.to.include('qrl_getBlockReceipts');
    });

    it('charges valid and malformed lookups to the general admission limit', async () => {
      CONFIG.RPC_RATE_LIMIT_PER_MINUTE = 2;
      const originalTrustedProxies = [...CONFIG.TRUSTED_PROXY_CIDRS];
      CONFIG.TRUSTED_PROXY_CIDRS = ['loopback'];
      rpcServiceStub.resolves({ jsonrpc: '2.0', id: 1, result: null });

      try {
        const lookup = (params, id) =>
          request
            .execute(app)
            .post('/api/qrl-rpc/dev')
            .set('X-Forwarded-For', '198.51.100.243')
            .send({ jsonrpc: '2.0', id, method, params });

        expect(await lookup([hash], 1)).to.have.status(200);
        expect(await lookup([], 2)).to.have.status(400);
        const limited = await lookup([hash], 3);
        expect(limited).to.have.status(429);
        // Admission runs before JSON parsing, so the caller id is unavailable here.
        expect(limited.body.id).to.equal(null);
        expect(limited.body.error.code).to.equal(-32005);
        expect(rpcServiceStub.calledOnce).to.equal(true);
      } finally {
        CONFIG.TRUSTED_PROXY_CIDRS = originalTrustedProxies;
      }
    });
  });

  for (const method of [
    'qrl_getBlockReceipts',
    'qrl_getTransactionByBlockHashAndIndex',
    'debug_traceTransaction',
    'admin_peers',
    'txpool_content',
    'eth_getTransactionByHash',
  ]) {
    it(`keeps ${method} blocked`, async () => {
      const res = await request
        .execute(app)
        .post('/api/qrl-rpc/dev')
        .send({ jsonrpc: '2.0', id: 'blocked-method', method, params: [`0x${'a'.repeat(64)}`] });

      expect(res).to.have.status(403);
      expect(res.body.id).to.equal('blocked-method');
      expect(res.body.error.code).to.equal(-32601);
      expect(rpcServiceStub.called).to.equal(false);
    });
  }

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
      .send({ method: 'qrl_sendTransaction', params: [{ from: qip55Address }] });

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

  it('accepts QIP-55 addresses for account RPC methods', async () => {
    for (const method of ['qrl_getBalance', 'qrl_getTransactionCount', 'qrl_getCode']) {
      rpcServiceStub.resolves({ jsonrpc: '2.0', id: 1, result: '0x0' });
      const res = await request
        .execute(app)
        .post('/api/qrl-rpc/dev')
        .send({ id: 1, method, params: [qip55Address, 'latest'] });

      expect(res).to.have.status(200);
      rpcServiceStub.resetHistory();
    }
  });

  it('rejects legacy 20-byte addresses for account RPC methods', async () => {
    for (const method of ['qrl_getBalance', 'qrl_getTransactionCount', 'qrl_getCode']) {
      const res = await request
        .execute(app)
        .post('/api/qrl-rpc/dev')
        .send({ id: 1, method, params: [`Q${'a'.repeat(40)}`, 'latest'] });

      expect(res).to.have.status(400);
      expect(res.body.error.code).to.equal(-32602);
    }
    expect(rpcServiceStub.called).to.equal(false);
  });

  it('accepts scalar and array QIP-55 qrl_getLogs address filters', async () => {
    for (const address of [qip55Address, [qip55Address, secondQip55Address]]) {
      rpcServiceStub.resolves({ jsonrpc: '2.0', id: 1, result: [] });
      const res = await request
        .execute(app)
        .post('/api/qrl-rpc/dev')
        .send({
          id: 1,
          method: 'qrl_getLogs',
          params: [{ fromBlock: '0x100', toBlock: '0x200', address }],
        });

      expect(res).to.have.status(200);
      rpcServiceStub.resetHistory();
    }
  });

  it('rejects legacy 20-byte qrl_getLogs address filters', async () => {
    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({
        id: 1,
        method: 'qrl_getLogs',
        params: [{ fromBlock: '0x100', toBlock: '0x200', address: `Q${'a'.repeat(40)}` }],
      });

    expect(res).to.have.status(400);
    expect(res.body.error.message).to.include('Q + 128 hex chars');
    expect(rpcServiceStub.called).to.equal(false);
  });

  it('accepts a null qrl_getLogs topics filter like the node does', async () => {
    rpcServiceStub.resolves({ jsonrpc: '2.0', id: 1, result: [] });

    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({
        id: 1,
        method: 'qrl_getLogs',
        params: [{ fromBlock: '0x100', toBlock: '0x200', topics: null }],
      });

    expect(res).to.have.status(200);
    expect(rpcServiceStub.calledOnce).to.equal(true);
  });

  it('accepts exact-width QIP-55 qrl_getLogs topics', async () => {
    const topic = `0x${'a'.repeat(128)}`;
    rpcServiceStub.resolves({ jsonrpc: '2.0', id: 1, result: [] });

    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({
        id: 1,
        method: 'qrl_getLogs',
        params: [
          {
            fromBlock: '0x100',
            toBlock: '0x200',
            topics: [topic, null, [topic, null]],
          },
        ],
      });

    expect(res).to.have.status(200);
    expect(rpcServiceStub.calledOnce).to.equal(true);
  });

  it('rejects shortened event hashes in qrl_getLogs topics', async () => {
    const res = await request
      .execute(app)
      .post('/api/qrl-rpc/dev')
      .send({
        id: 1,
        method: 'qrl_getLogs',
        params: [
          {
            fromBlock: '0x100',
            toBlock: '0x200',
            topics: [`0x${'a'.repeat(64)}`],
          },
        ],
      });

    expect(res).to.have.status(400);
    expect(res.body.error.message).to.include('64-byte values');
    expect(rpcServiceStub.called).to.equal(false);
  });

  it('enforces the 50KB JSON limit for chunked bodies without Content-Length', async () => {
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const body = JSON.stringify({
        method: 'qrl_call',
        params: [{ to: qip55Address, data: 'x'.repeat(60 * 1024) }],
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
