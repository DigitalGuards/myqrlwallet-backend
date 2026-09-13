import * as chai from 'chai';
import axios from 'axios';
import { default as chaiHttp, request } from 'chai-http';
import sinon from 'sinon';
import { app } from '../../src/app.js';
import { CONFIG } from '../../src/config/index.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('application proxy routes', () => {
  const qip55Address = `Q${'a'.repeat(128)}`;
  const originalOrigins = { ...CONFIG.TX_HISTORY_ORIGINS };

  afterEach(() => {
    sinon.restore();
    CONFIG.TX_HISTORY_ORIGINS = { ...originalOrigins };
  });

  it('bounds transaction-history pagination, response bytes, and redirects', async () => {
    const getStub = sinon.stub(axios, 'get').resolves({ data: { transactions: [] } });

    const response = await request
      .execute(app)
      .post('/api/tx-history')
      .send({ network: 'testnet', address: qip55Address, page: 1_000_000, limit: 10_000 });

    expect(response).to.have.status(200);
    expect(getStub.calledOnce).to.equal(true);
    expect(getStub.firstCall.args[1]).to.deep.include({
      params: { page: 100_000, limit: 50 },
      timeout: 8000,
      maxContentLength: 2 * 1024 * 1024,
      maxRedirects: 0,
    });
    expect(getStub.firstCall.args[0]).to.include(qip55Address);
  });

  it('rejects legacy 20-byte transaction-history addresses', async () => {
    const getStub = sinon.stub(axios, 'get');

    const response = await request
      .execute(app)
      .post('/api/tx-history')
      .send({ network: 'testnet', address: `Q${'a'.repeat(40)}` });

    expect(response).to.have.status(400);
    expect(response.body.message).to.equal('Invalid address format');
    expect(getStub.called).to.equal(false);
  });

  it('uses only the selected network server-owned explorer origin', async () => {
    CONFIG.TX_HISTORY_ORIGINS.dev = 'http://127.0.0.1:8080';
    const getStub = sinon.stub(axios, 'get').resolves({ data: { transactions: [] } });
    const response = await request.execute(app).post('/api/tx-history').send({
      network: 'dev',
      address: qip55Address,
      explorerOrigin: 'https://client-selected.invalid',
    });
    expect(response).to.have.status(200);
    expect(getStub.firstCall.args[0]).to.equal(
      `http://127.0.0.1:8080/api/address/${qip55Address}/transactions`
    );
  });

  it('reports unsupported history without falling back to another network', async () => {
    CONFIG.TX_HISTORY_ORIGINS.mainnet = null;
    const getStub = sinon.stub(axios, 'get');
    const response = await request.execute(app).post('/api/tx-history').send({
      network: 'mainnet',
      address: qip55Address,
    });
    expect(response).to.have.status(501);
    expect(response.body.code).to.equal('HISTORY_UNAVAILABLE');
    expect(getStub.called).to.equal(false);
  });

  for (const network of [undefined, 'MAIN_NET', 'https://example.invalid', ['testnet']]) {
    it(`rejects an invalid or missing history network: ${JSON.stringify(network)}`, async () => {
      const getStub = sinon.stub(axios, 'get');
      const response = await request.execute(app).post('/api/tx-history').send({
        network,
        address: qip55Address,
      });
      expect(response).to.have.status(400);
      expect(response.body.code).to.equal('INVALID_NETWORK');
      expect(getStub.called).to.equal(false);
    });
  }
});
