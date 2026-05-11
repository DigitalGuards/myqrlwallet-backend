import * as chai from "chai";

import {default as chaiHttp, request} from "chai-http";
chai.use(chaiHttp);

import { app } from '../../src/app.js';
import { healthMonitor, HEALTH_STATES } from '../../src/services/rpc/healthMonitor.js';

chai.use(chaiHttp);
const { expect } = chai;

describe('Health Routes', () => {
  afterEach(() => {
    healthMonitor.__resetForTesting();
  });

  it('should return status ok with per-endpoint snapshot (url redacted) when at least one endpoint is selectable', async () => {
    healthMonitor.__setEndpointsForTesting('testnet', ['http://example.test:8545']);
    const res = await request.execute(app).get('/health');
    expect(res).to.have.status(200);
    expect(res.body.status).to.equal('ok');
    expect(res.body.endpoints).to.be.an('object');
    expect(res.body.endpoints.testnet).to.be.an('array').with.lengthOf(1);
    expect(res.body.endpoints.testnet[0]).to.include({
      index: 0,
      state: HEALTH_STATES.STATE_UNKNOWN,
    });
    // Internal RPC URL is intentionally stripped from the public response
    // so anonymous callers can't enumerate backend infrastructure.
    expect(res.body.endpoints.testnet[0]).to.not.have.property('url');
  });

  it('should return 503 degraded when every configured endpoint is down or stalled', async () => {
    healthMonitor.__setEndpointsForTesting('testnet', ['http://down.test:8545']);
    healthMonitor.__forceStateForTesting('testnet', 'http://down.test:8545', HEALTH_STATES.STATE_DOWN);

    const res = await request.execute(app).get('/health');
    expect(res).to.have.status(503);
    expect(res.body.status).to.equal('degraded');
    expect(res.body.endpoints.testnet[0].state).to.equal(HEALTH_STATES.STATE_DOWN);
  });
});
