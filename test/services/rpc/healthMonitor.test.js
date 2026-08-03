import * as chai from 'chai';
import sinon from 'sinon';
import { healthMonitor, HEALTH_STATES } from '../../../src/services/rpc/healthMonitor.js';

const { expect } = chai;
const { STATE_UP, STATE_DOWN, STATE_STALLED, STATE_UNKNOWN } = HEALTH_STATES;

describe('healthMonitor', () => {
  afterEach(() => {
    sinon.restore();
    healthMonitor.__resetForTesting();
  });

  describe('bounded polling', () => {
    it('accepts a small valid qrl_blockNumber response', async () => {
      const fetchStub = sinon
        .stub(globalThis, 'fetch')
        .resolves(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2a' })));
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];

      await healthMonitor.pollOne('testnet', ep);

      expect(ep.state).to.equal(STATE_UP);
      expect(ep.lastHeight).to.equal(42);
      expect(fetchStub.firstCall.args[1].redirect).to.equal('error');
    });

    it('stores a credential-free category for fetch failures', async () => {
      const secret = 'HEALTH_SECRET';
      sinon
        .stub(globalThis, 'fetch')
        .rejects(new TypeError(`fetch failed for https://user:${secret}@rpc.invalid/testnet`));
      healthMonitor.__setEndpointsForTesting('testnet', [
        `https://user:${secret}@rpc.invalid/testnet`,
      ]);
      const ep = healthMonitor.networks.get('testnet')[0];

      await healthMonitor.pollOne('testnet', ep);

      expect(ep.lastError?.message).to.equal('upstream health check failed');
      expect(healthMonitor.getSnapshot().testnet[0].lastError).not.to.include(secret);
    });

    it('rejects an oversized health response before parsing it', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        new Response('{}', {
          headers: { 'Content-Length': String(16 * 1024 + 1) },
        })
      );
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];

      await healthMonitor.pollOne('testnet', ep);

      expect(ep.consecutiveFailures).to.equal(1);
      expect(ep.lastError?.message).to.equal('response body too large');
      expect(ep.state).to.equal(STATE_UNKNOWN);
    });
  });

  describe('orderEndpointsForAttempt', () => {
    it('orders up > unknown > stalled > down', () => {
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://a:8545',
        'http://b:8545',
        'http://c:8545',
        'http://d:8545',
      ]);
      healthMonitor.__forceStateForTesting('testnet', 'http://a:8545', STATE_DOWN);
      healthMonitor.__forceStateForTesting('testnet', 'http://b:8545', STATE_STALLED);
      healthMonitor.__forceStateForTesting('testnet', 'http://c:8545', STATE_UP);
      healthMonitor.__forceStateForTesting('testnet', 'http://d:8545', STATE_UNKNOWN);

      expect(healthMonitor.orderEndpointsForAttempt('testnet')).to.deep.equal([
        'http://c:8545',
        'http://d:8545',
        'http://b:8545',
        'http://a:8545',
      ]);
    });

    it('returns empty list for unknown network', () => {
      expect(healthMonitor.orderEndpointsForAttempt('nope')).to.deep.equal([]);
    });
  });

  describe('state transitions', () => {
    it('flips to down after DOWN_AFTER_FAILURES consecutive failures', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];

      healthMonitor.applyFailure('testnet', ep, new Error('boom'));
      healthMonitor.applyFailure('testnet', ep, new Error('boom'));
      expect(ep.state).to.equal(STATE_UNKNOWN);

      healthMonitor.applyFailure('testnet', ep, new Error('boom'));
      expect(ep.state).to.equal(STATE_DOWN);
    });

    it('marks stalled when block height stays put past STALL_AFTER_MS', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];
      ep.state = STATE_UP;
      ep.lastHeight = 100;
      ep.lastHeightChangeAt = Date.now() - 10 * 60 * 1000; // 10 min ago

      healthMonitor.applyPollSuccess('testnet', ep, 100);
      expect(ep.state).to.equal(STATE_STALLED);
    });

    it('exits stalled when a higher block is observed', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];
      ep.state = STATE_STALLED;
      ep.lastHeight = 100;

      healthMonitor.applyPollSuccess('testnet', ep, 101);
      expect(ep.state).to.equal(STATE_UP);
    });

    it('does not reset the stall timer on a height regression', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];
      ep.state = STATE_UP;
      ep.lastHeight = 100;
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      ep.lastHeightChangeAt = tenMinAgo;

      // Observed height regresses (chain reorg or bad node serving old head).
      // The stall timer must NOT reset, so the next equal-height poll should
      // still flip the endpoint to STALLED.
      healthMonitor.applyPollSuccess('testnet', ep, 99);
      expect(ep.lastHeight).to.equal(99);
      expect(ep.lastHeightChangeAt).to.equal(tenMinAgo);

      healthMonitor.applyPollSuccess('testnet', ep, 99);
      expect(ep.state).to.equal(STATE_STALLED);
    });

    it('moves unknown → up on first successful poll even without height advance', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];
      ep.lastHeight = 100; // pre-set so advance == false

      healthMonitor.applyPollSuccess('testnet', ep, 100);
      expect(ep.state).to.equal(STATE_UP);
    });
  });

  describe('hasHealthyForNetwork', () => {
    it('returns true only for a confirmed-up endpoint', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.false;
      healthMonitor.__forceStateForTesting('testnet', 'http://x:8545', STATE_STALLED);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.false;
      healthMonitor.__forceStateForTesting('testnet', 'http://x:8545', STATE_UP);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.true;
    });

    it('returns false when every endpoint is down', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      healthMonitor.__forceStateForTesting('testnet', 'http://x:8545', STATE_DOWN);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.false;
    });
  });
});
