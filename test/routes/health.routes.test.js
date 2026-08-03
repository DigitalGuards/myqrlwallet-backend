import * as chai from 'chai';

import { default as chaiHttp, request } from 'chai-http';
chai.use(chaiHttp);

import { app } from '../../src/app.js';
import { CONFIG } from '../../src/config/index.js';
import { healthMonitor, HEALTH_STATES } from '../../src/services/rpc/healthMonitor.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('Health Routes', () => {
  const originalRequiredNetworks = [...CONFIG.RPC_REQUIRED_NETWORKS];

  afterEach(() => {
    healthMonitor.__resetForTesting();
    CONFIG.RPC_REQUIRED_NETWORKS = [...originalRequiredNetworks];
  });

  it('returns ok with a redacted snapshot when every required network is up', async () => {
    healthMonitor.__setEndpointsForTesting('testnet', ['http://example.test:8545']);
    healthMonitor.__forceStateForTesting(
      'testnet',
      'http://example.test:8545',
      HEALTH_STATES.STATE_UP
    );
    const res = await request.execute(app).get('/health');
    expect(res).to.have.status(200);
    expect(res.body.status).to.equal('ok');
    expect(res.body.endpoints).to.be.an('object');
    expect(res.body.endpoints.testnet).to.be.an('array').with.lengthOf(1);
    expect(res.body.endpoints.testnet[0]).to.include({
      index: 0,
      state: HEALTH_STATES.STATE_UP,
    });
    // Internal RPC URL is intentionally stripped from the public response
    // so anonymous callers can't enumerate backend infrastructure.
    expect(res.body.endpoints.testnet[0]).to.not.have.property('url');
  });

  it('returns 503 degraded when a required network is stalled', async () => {
    healthMonitor.__setEndpointsForTesting('testnet', ['http://down.test:8545']);
    healthMonitor.__forceStateForTesting(
      'testnet',
      'http://down.test:8545',
      HEALTH_STATES.STATE_STALLED
    );

    const res = await request.execute(app).get('/health');
    expect(res).to.have.status(503);
    expect(res.body.status).to.equal('degraded');
    expect(res.body.endpoints.testnet[0].state).to.equal(HEALTH_STATES.STATE_STALLED);
  });

  it('keeps process liveness healthy when RPC readiness is degraded', async () => {
    healthMonitor.__setEndpointsForTesting('testnet', ['http://down.test:8545']);
    healthMonitor.__forceStateForTesting(
      'testnet',
      'http://down.test:8545',
      HEALTH_STATES.STATE_DOWN
    );

    const readiness = await request.execute(app).get('/health');
    const liveness = await request.execute(app).get('/health/live');

    expect(readiness).to.have.status(503);
    expect(liveness).to.have.status(200);
    expect(liveness.body.status).to.equal('alive');
  });

  it('does not expose credential-bearing fetch failures', async () => {
    const secret = 'REVIEW_SECRET';
    healthMonitor.__setEndpointsForTesting('testnet', [
      `https://wallet:${secret}@example.invalid/rpc`,
    ]);
    const endpoint = healthMonitor.networks.get('testnet')[0];
    healthMonitor.applyFailure(
      'testnet',
      endpoint,
      new TypeError(`fetch failed for https://wallet:${secret}@example.invalid/rpc`)
    );

    const res = await request.execute(app).get('/health');
    expect(res).to.have.status(503);
    expect(JSON.stringify(res.body)).not.to.include(secret);
    expect(res.body.endpoints.testnet[0].lastError).to.equal('upstream health check failed');
  });

  it('requires every configured required network to be up', async () => {
    CONFIG.RPC_REQUIRED_NETWORKS = ['testnet', 'mainnet'];
    healthMonitor.__setEndpointsForTesting('testnet', ['http://testnet.test:8545']);
    healthMonitor.__setEndpointsForTesting('mainnet', ['http://mainnet.test:8545']);
    healthMonitor.__forceStateForTesting(
      'testnet',
      'http://testnet.test:8545',
      HEALTH_STATES.STATE_UP
    );
    healthMonitor.__forceStateForTesting(
      'mainnet',
      'http://mainnet.test:8545',
      HEALTH_STATES.STATE_DOWN
    );

    const res = await request.execute(app).get('/health');
    expect(res).to.have.status(503);
    expect(res.body.status).to.equal('degraded');
  });
});
