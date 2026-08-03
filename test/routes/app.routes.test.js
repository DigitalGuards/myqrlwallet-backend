import * as chai from 'chai';
import axios from 'axios';
import { default as chaiHttp, request } from 'chai-http';
import sinon from 'sinon';
import { app } from '../../src/app.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('application proxy routes', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('bounds transaction-history pagination, response bytes, and redirects', async () => {
    const getStub = sinon.stub(axios, 'get').resolves({ data: { transactions: [] } });

    const response = await request
      .execute(app)
      .post('/api/tx-history')
      .send({ address: `Q${'a'.repeat(40)}`, page: 1_000_000, limit: 10_000 });

    expect(response).to.have.status(200);
    expect(getStub.calledOnce).to.equal(true);
    expect(getStub.firstCall.args[1]).to.deep.include({
      params: { page: 100_000, limit: 50 },
      timeout: 8000,
      maxContentLength: 2 * 1024 * 1024,
      maxRedirects: 0,
    });
  });
});
