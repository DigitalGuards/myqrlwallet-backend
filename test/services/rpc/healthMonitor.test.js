import * as chai from 'chai';
import { healthMonitor, HEALTH_STATES } from '../../../src/services/rpc/healthMonitor.js';

const { expect } = chai;
const { STATE_UP, STATE_DOWN, STATE_STALLED, STATE_UNKNOWN } = HEALTH_STATES;

describe('healthMonitor', () => {
  afterEach(() => {
    healthMonitor.__resetForTesting();
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

    it('flips an unknown endpoint to up on a successful real request', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];
      expect(ep.state).to.equal(STATE_UNKNOWN);

      healthMonitor.applyRequestSuccess('testnet', ep);
      expect(ep.state).to.equal(STATE_UP);
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
    it('returns true for up/unknown/stalled (any non-down state)', () => {
      // Stalled endpoints still route requests (with stale data), so /health
      // should report 200 — operators rely on the per-endpoint state field
      // to spot the stall.
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.true;
      healthMonitor.__forceStateForTesting('testnet', 'http://x:8545', STATE_STALLED);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.true;
      healthMonitor.__forceStateForTesting('testnet', 'http://x:8545', STATE_UP);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.true;
    });

    it('returns false only when every endpoint is down', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      healthMonitor.__forceStateForTesting('testnet', 'http://x:8545', STATE_DOWN);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.false;
    });
  });
});
