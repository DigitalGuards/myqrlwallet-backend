import * as chai from 'chai';
import { default as chaiHttp, request } from 'chai-http';
import sinon from 'sinon';
import { app } from '../../src/app.js';
import { CONFIG } from '../../src/config/index.js';
import { rpcService } from '../../src/services/rpc.service.js';
import {
  RPC_SEND_RAW_TX_BODY_LIMIT_BYTES,
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
    expect(body.length).to.be.lessThan(RPC_SEND_RAW_TX_BODY_LIMIT_BYTES);
    expect(RPC_SEND_RAW_TX_BODY_LIMIT_BYTES).to.be.greaterThan(RPC_DEFAULT_BODY_LIMIT_BYTES);
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
    const res = await post(sendRaw(RPC_SEND_RAW_TX_BODY_LIMIT_BYTES / 2 + 1000));
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
    expect(await post(sendRaw(RPC_SEND_RAW_TX_BODY_LIMIT_BYTES / 2 + 1000), ip)).to.have.status(
      413
    );
    const limited = await post(sendRaw(100), ip);
    expect(limited).to.have.status(429);
    expect(limited.body.error.code).to.equal(-32005);
    expect(stub.called).to.equal(false);
  });
});
