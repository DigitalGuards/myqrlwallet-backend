import * as chai from 'chai';
import sinon from 'sinon';
import { healthMonitor, HEALTH_STATES } from '../../../src/services/rpc/healthMonitor.js';
import { CONFIG } from '../../../src/config/index.js';

const { expect } = chai;
const { STATE_UP, STATE_DOWN, STATE_STALLED, STATE_UNKNOWN } = HEALTH_STATES;

function installPollResponses(resolve = () => ({})) {
  return sinon.stub(globalThis, 'fetch').callsFake(async (url, options) => {
    const request = JSON.parse(options.body);
    const state = resolve(url);
    if (request.method === state.rejectMethod) throw new Error('fixture transport failure');
    const height = state.height ?? 42;
    let result;
    if (request.method === 'qrl_chainId') result = state.chainId ?? '0x11';
    if (request.method === 'qrl_blockNumber')
      result = state.heightResult ?? `0x${height.toString(16)}`;
    if (request.method === 'qrl_syncing') result = state.syncing ?? false;
    if (request.method === 'qrl_getBlockByNumber') {
      result =
        request.params[0] === '0x0' && state.genesis !== undefined
          ? state.genesis
          : {
              number: `0x${height.toString(16)}`,
              timestamp: `0x${Math.floor((state.timestamp ?? Date.now()) / 1000).toString(16)}`,
              ...state.block,
            };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
}
function markFresh(endpoint) {
  Object.assign(endpoint, {
    lastHeight: 100,
    syncing: false,
    headTimestamp: Date.now(),
    lastVerifiedPollAt: Date.now(),
  });
}

describe('healthMonitor', () => {
  const originalIdentities = { ...CONFIG.RPC_EXPECTED_IDENTITIES };
  afterEach(() => {
    sinon.restore();
    healthMonitor.__resetForTesting();
    CONFIG.RPC_EXPECTED_IDENTITIES = { ...originalIdentities };
  });

  describe('configured chain identity', () => {
    const identity = { chainId: '0x11', genesisHash: `0x${'ab'.repeat(32)}` };

    it('requires matching chain and genesis before making a fresh endpoint ready', async () => {
      CONFIG.RPC_EXPECTED_IDENTITIES.testnet = identity;
      const fetchStub = installPollResponses(() => ({
        genesis: { number: '0x0', hash: identity.genesisHash.toUpperCase().replace('0X', '0x') },
      }));
      healthMonitor.__setEndpointsForTesting('testnet', ['http://fixture.test:8545']);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);

      await healthMonitor.pollAll();

      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(true);
      expect(healthMonitor.networks.get('testnet')[0].verifiedIdentity).to.deep.equal(identity);
      expect(
        fetchStub.getCalls().map((call) => JSON.parse(call.args[1].body).method)
      ).to.deep.equal([
        'qrl_blockNumber',
        'qrl_chainId',
        'qrl_getBlockByNumber',
        'qrl_syncing',
        'qrl_getBlockByNumber',
      ]);
      expect(JSON.parse(fetchStub.getCall(2).args[1].body).params).to.deep.equal(['0x0', false]);
      expect(fetchStub.getCalls().every((call) => call.args[1].redirect === 'error')).to.equal(
        true
      );
      expect(new Set(fetchStub.getCalls().map((call) => call.args[1].signal)).size).to.equal(1);
    });

    for (const [reason, invalid] of [
      ['wrong chain', { chainId: '0x12' }],
      ['malformed chain', { chainId: '0x011' }],
      ['wrong genesis', { genesis: { number: '0x0', hash: `0x${'cd'.repeat(32)}` } }],
      ['non-genesis block', { genesis: { number: '0x1', hash: identity.genesisHash } }],
      ['missing genesis', { genesis: null }],
      ['failed identity query', { rejectMethod: 'qrl_chainId' }],
      ['failed head query', { rejectMethod: 'qrl_blockNumber' }],
    ]) {
      it(`immediately revokes prior readiness after ${reason} and recovers on verified evidence`, async () => {
        CONFIG.RPC_EXPECTED_IDENTITIES.testnet = identity;
        const state = { genesis: { number: '0x0', hash: identity.genesisHash } };
        installPollResponses(() => state);
        healthMonitor.__setEndpointsForTesting('testnet', ['http://fixture.test:8545']);
        await healthMonitor.pollAll();
        expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(true);

        Object.assign(state, invalid);
        await healthMonitor.pollAll();

        const endpoint = healthMonitor.networks.get('testnet')[0];
        expect(endpoint.consecutiveFailures).to.equal(1);
        expect(endpoint.state).to.equal(STATE_UP);
        expect(endpoint.verifiedIdentity).to.equal(null);
        expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);

        delete state.chainId;
        delete state.rejectMethod;
        state.genesis = { number: '0x0', hash: identity.genesisHash };
        await healthMonitor.pollAll();
        expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(true);
      });
    }

    it('excludes a wrong-chain peer without suppressing the correct network endpoint', async () => {
      CONFIG.RPC_EXPECTED_IDENTITIES.testnet = identity;
      installPollResponses((url) => ({
        chainId: url.includes('wrong') ? '0x12' : '0x11',
        height: url.includes('wrong') ? 100000 : 42,
        genesis: { number: '0x0', hash: identity.genesisHash },
      }));
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://wrong.test:8545',
        'http://correct.test:8545',
      ]);
      await healthMonitor.pollAll();
      expect(healthMonitor.readyEndpointsForAttempt('testnet')).to.deep.equal([
        'http://correct.test:8545',
      ]);
    });

    it('binds verified evidence to the configured network identity', async () => {
      CONFIG.RPC_EXPECTED_IDENTITIES.testnet = identity;
      installPollResponses(() => ({ genesis: { number: '0x0', hash: identity.genesisHash } }));
      healthMonitor.__setEndpointsForTesting('testnet', ['http://fixture.test:8545']);
      await healthMonitor.pollAll();
      CONFIG.RPC_EXPECTED_IDENTITIES.testnet = { ...identity, chainId: '0x12' };
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);
    });
  });

  describe('bounded polling', () => {
    it('accepts a small valid qrl_blockNumber response', async () => {
      const fetchStub = installPollResponses();
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      const ep = healthMonitor.networks.get('testnet')[0];

      await healthMonitor.pollOne('testnet', ep);

      expect(ep.state).to.equal(STATE_UP);
      expect(ep.lastHeight).to.equal(42);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(true);
      expect(fetchStub.callCount).to.equal(3);
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

  describe('verified head readiness', () => {
    it('excludes a fast historical resync while retaining a current slower endpoint', async () => {
      installPollResponses((url) =>
        url.includes('resync')
          ? { height: 10, timestamp: Date.now() - 60 * 60 * 1000 }
          : { height: 10000 }
      );
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://resync:8545',
        'http://current:8545',
      ]);
      await healthMonitor.pollAll();
      const endpoints = healthMonitor.networks.get('testnet');
      endpoints[0].lastLatencyMs = 1;
      endpoints[1].lastLatencyMs = 100;
      expect(healthMonitor.readyEndpointsForAttempt('testnet')).to.deep.equal([
        'http://current:8545',
      ]);
      expect(healthMonitor.getSnapshot().testnet[0].ready).to.equal(false);
    });

    it('rejects an explicitly syncing endpoint even when its timestamp is fresh', async () => {
      installPollResponses(() => ({
        syncing: { startingBlock: '0x0', currentBlock: '0x2a', highestBlock: '0x100' },
      }));
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      await healthMonitor.pollAll();
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);
      expect(healthMonitor.getSnapshot().testnet[0].syncing).to.equal(true);
    });

    it('fails readiness when every head is stale, including a genesis node reporting syncing=false', async () => {
      installPollResponses(() => ({ height: 0, timestamp: 0 }));
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      await healthMonitor.pollAll();
      expect(healthMonitor.readyEndpointsForAttempt('testnet')).to.deep.equal([]);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);
    });

    it('bounds lag while allowing a small reorg and polling skew', async () => {
      const state = { height: 1000 - CONFIG.RPC_HEALTH.MAX_LAG_BLOCKS };
      installPollResponses((url) => (url.includes('peer') ? state : { height: 1000 }));
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://current:8545',
        'http://peer:8545',
      ]);
      await healthMonitor.pollAll();
      expect(healthMonitor.readyEndpointsForAttempt('testnet')).to.have.length(2);
      state.height -= 1;
      await healthMonitor.pollAll();
      expect(healthMonitor.readyEndpointsForAttempt('testnet')).to.deep.equal([
        'http://current:8545',
      ]);
      state.height += 2;
      await healthMonitor.pollAll();
      expect(healthMonitor.readyEndpointsForAttempt('testnet')).to.have.length(2);
    });

    it('expires successful polls and rejects a head timestamp too far in the future', async () => {
      const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
      const state = {};
      installPollResponses(() => state);
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      await healthMonitor.pollAll();
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(true);
      clock.tick(
        Math.max(CONFIG.RPC_HEALTH.POLL_INTERVAL_MS * 3, CONFIG.RPC_HEALTH.POLL_TIMEOUT_MS * 2) + 1
      );
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);
      state.timestamp = Date.now() + CONFIG.RPC_HEALTH.MAX_HEAD_FUTURE_MS + 2000;
      await healthMonitor.pollAll();
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);
    });

    for (const invalid of [
      { heightResult: '0x2agarbage' },
      { syncing: true },
      { block: { timestamp: '0x123garbage' } },
      { block: { number: '0x29' } },
    ]) {
      it(`rejects malformed readiness evidence ${JSON.stringify(invalid)}`, async () => {
        installPollResponses(() => invalid);
        healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
        await healthMonitor.pollAll();
        expect(healthMonitor.hasHealthyForNetwork('testnet')).to.equal(false);
        expect(healthMonitor.networks.get('testnet')[0].consecutiveFailures).to.equal(1);
      });
    }
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
      markFresh(healthMonitor.networks.get('testnet')[0]);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.true;
    });

    it('returns false when every endpoint is down', () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://x:8545']);
      healthMonitor.__forceStateForTesting('testnet', 'http://x:8545', STATE_DOWN);
      expect(healthMonitor.hasHealthyForNetwork('testnet')).to.be.false;
    });
  });
});
