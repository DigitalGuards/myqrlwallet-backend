import * as chai from 'chai';
import { default as chaiHttp, request } from 'chai-http';
import sinon from 'sinon';
import { app } from '../../src/app.js';
import { rpcService } from '../../src/services/rpc.service.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('RPC Routes', () => {
  let rpcServiceStub;

  beforeEach(() => {
    rpcServiceStub = sinon.stub(rpcService, 'executeRPC');
  });

  afterEach(() => {
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
    expect(res.body.error.message).to.equal('RPC Error');
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
