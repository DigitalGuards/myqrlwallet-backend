import * as chai from 'chai';
import {default as chaiHttp, request} from "chai-http";
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
    const mockResult = { data: 'mockData' };
    rpcServiceStub.resolves(mockResult);

    const res = await request.execute(app)
      .post('/api/zond-rpc/dev')
      .send({ method: 'getInfo', params: [] });

    expect(res).to.have.status(200);
    expect(res.body).to.deep.equal(mockResult);
  });

  it('should handle errors from RPC service', async () => {
    rpcServiceStub.rejects(new Error('RPC Error'));

    const res = await request.execute(app)
      .post('/api/zond-rpc/dev')
      .send({ method: 'getInfo', params: [] });

    expect(res).to.have.status(500);
    expect(res.body.error.message).to.equal('RPC Error');
  });
}); 