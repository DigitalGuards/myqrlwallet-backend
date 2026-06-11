import * as chai from 'chai';
import sinon from 'sinon';
import { rpcService } from '../../src/services/rpc.service.js';
import { CONFIG } from '../../src/config/index.js';
import { cache } from '../../src/utils/cache.js';
import { healthMonitor, HEALTH_STATES } from '../../src/services/rpc/healthMonitor.js';

const { expect } = chai;

describe('RPC Service', () => {
  afterEach(() => {
    sinon.restore();
    cache.flushAll();
    healthMonitor.__resetForTesting();
  });

  it('should validate network parameter', async () => {
    try {
      await rpcService.executeRPC('invalid-network', 'qrl_blockNumber', []);
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).to.equal('Invalid network');
    }
  });

  it('should throw an error for a failed RPC call', async function () {
    this.timeout(5000);

    // Stub the makeRPCCall method directly to simulate a failed response
    const stub = sinon.stub(rpcService, 'makeRPCCall');
    stub.rejects(new Error('HTTP error! status: 404'));

    try {
      await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
      expect.fail('Expected an error to be thrown');
    } catch (error) {
      expect(error.message).to.equal('HTTP error! status: 404');
    }
  });

  it('should have valid RPC endpoints configured', () => {
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('dev');
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('testnet');
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('mainnet');
    expect(CONFIG.RPC_ENDPOINTS).to.not.have.property('custom');
  });

  describe('caching behavior', () => {
    it('should NOT cache state-dependent reads (qrl_call)', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.onFirstCall().resolves({ jsonrpc: '2.0', id: 1, result: '0xaaa' });
      stub.onSecondCall().resolves({ jsonrpc: '2.0', id: 2, result: '0xbbb' });

      const params = [{ to: 'Q' + 'a'.repeat(40), data: '0x' }, 'latest'];
      const first = await rpcService.executeRPC('testnet', 'qrl_call', params);
      const second = await rpcService.executeRPC('testnet', 'qrl_call', params);

      expect(stub.callCount).to.equal(2);
      expect(first.result).to.equal('0xaaa');
      expect(second.result).to.equal('0xbbb');
    });

    it('should NOT cache qrl_blockNumber', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.onFirstCall().resolves({ jsonrpc: '2.0', id: 1, result: '0x100' });
      stub.onSecondCall().resolves({ jsonrpc: '2.0', id: 2, result: '0x101' });

      const first = await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
      const second = await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);

      expect(stub.callCount).to.equal(2);
      expect(first.result).to.equal('0x100');
      expect(second.result).to.equal('0x101');
    });

    it('should NOT cache qrl_getTransactionReceipt', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.onFirstCall().resolves({ jsonrpc: '2.0', id: 1, result: null });
      stub.onSecondCall().resolves({
        jsonrpc: '2.0',
        id: 2,
        result: { status: '0x1', blockNumber: '0x10' },
      });

      const params = ['0x' + 'a'.repeat(64)];
      const first = await rpcService.executeRPC('testnet', 'qrl_getTransactionReceipt', params);
      const second = await rpcService.executeRPC('testnet', 'qrl_getTransactionReceipt', params);

      expect(stub.callCount).to.equal(2);
      expect(first.result).to.equal(null);
      expect(second.result).to.deep.equal({ status: '0x1', blockNumber: '0x10' });
    });

    it('should NOT cache qrl_sendRawTransaction', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.resolves({ jsonrpc: '2.0', id: 1, result: '0x' + '1'.repeat(64) });

      await rpcService.executeRPC('testnet', 'qrl_sendRawTransaction', ['0xdeadbeef']);
      await rpcService.executeRPC('testnet', 'qrl_sendRawTransaction', ['0xdeadbeef']);

      expect(stub.callCount).to.equal(2);
    });

    it('should cache qrl_chainId (network-invariant)', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.resolves({ jsonrpc: '2.0', id: 1, result: '0x1' });

      await rpcService.executeRPC('testnet', 'qrl_chainId', []);
      await rpcService.executeRPC('testnet', 'qrl_chainId', []);

      expect(stub.callCount).to.equal(1);
    });

    it('should cache net_version (network-invariant)', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.resolves({ jsonrpc: '2.0', id: 1, result: '1' });

      await rpcService.executeRPC('testnet', 'net_version', []);
      await rpcService.executeRPC('testnet', 'net_version', []);

      expect(stub.callCount).to.equal(1);
    });

    it('rebuilds cached responses with the caller own id (no id replay)', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.resolves({ jsonrpc: '2.0', id: 'first-caller', result: '0x1' });

      const first = await rpcService.executeRPC('testnet', 'qrl_chainId', [], 'first-caller');
      const second = await rpcService.executeRPC('testnet', 'qrl_chainId', [], 'second-caller');

      expect(stub.callCount).to.equal(1);
      expect(first.id).to.equal('first-caller');
      // The cache stores only the result value; the envelope (and id) is
      // rebuilt per request instead of replaying the first caller's id.
      expect(second).to.deep.equal({ jsonrpc: '2.0', id: 'second-caller', result: '0x1' });
    });

    it('does NOT cache upstream JSON-RPC error envelopes', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub
        .onFirstCall()
        .resolves({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'node hiccup' } });
      stub.onSecondCall().resolves({ jsonrpc: '2.0', id: 2, result: '0x1' });

      const first = await rpcService.executeRPC('testnet', 'qrl_chainId', []);
      const second = await rpcService.executeRPC('testnet', 'qrl_chainId', []);

      // A transient error envelope must not be pinned into the cache for
      // the TTL; the second call goes upstream again and succeeds.
      expect(stub.callCount).to.equal(2);
      expect(first.error.message).to.equal('node hiccup');
      expect(second.result).to.equal('0x1');
    });
  });

  describe('JSON-RPC id passthrough', () => {
    it('forwards the client id upstream', async () => {
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.resolves({ jsonrpc: '2.0', id: 'client-id-9', result: '0x100' });

      await rpcService.executeRPC('testnet', 'qrl_blockNumber', [], 'client-id-9');

      expect(stub.firstCall.args[3]).to.equal('client-id-9');
    });
  });

  describe('failover behavior', () => {
    it('falls back to a second endpoint when the first one fails', async () => {
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://primary.test:8545',
        'http://secondary.test:8545',
      ]);
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.withArgs('http://primary.test:8545').rejects(new Error('primary down'));
      stub
        .withArgs('http://secondary.test:8545')
        .resolves({ jsonrpc: '2.0', id: 1, result: '0xff' });

      const result = await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
      expect(result.result).to.equal('0xff');
      expect(stub.callCount).to.equal(2);
    });

    it('throws the last error when all endpoints fail within the retry budget', async () => {
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://primary.test:8545',
        'http://secondary.test:8545',
      ]);
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.rejects(new Error('all gone'));

      try {
        await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
        expect.fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.equal('all gone');
      }
      expect(stub.callCount).to.equal(2);
    });

    it('skips down endpoints in favour of healthy ones (orderEndpointsForAttempt)', async () => {
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://primary.test:8545',
        'http://secondary.test:8545',
      ]);
      healthMonitor.__forceStateForTesting(
        'testnet',
        'http://primary.test:8545',
        HEALTH_STATES.STATE_DOWN
      );
      healthMonitor.__forceStateForTesting(
        'testnet',
        'http://secondary.test:8545',
        HEALTH_STATES.STATE_UP
      );

      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.resolves({ jsonrpc: '2.0', id: 1, result: '0xee' });

      await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
      // First (and only) attempt should be the up endpoint, not the down one.
      expect(stub.firstCall.args[0]).to.equal('http://secondary.test:8545');
    });

    it('pins txpool_* methods to the primary endpoint only (no failover)', async () => {
      healthMonitor.__setEndpointsForTesting('testnet', [
        'http://primary.test:8545',
        'http://secondary.test:8545',
      ]);
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.rejects(new Error('primary down'));

      try {
        await rpcService.executeRPC('testnet', 'txpool_status', []);
        expect.fail('Expected an error to be thrown');
      } catch (err) {
        expect(err.message).to.equal('primary down');
      }
      // Only the primary should be tried — txpool_* must not fail over.
      expect(stub.callCount).to.equal(1);
      expect(stub.firstCall.args[0]).to.equal('http://primary.test:8545');
    });
  });
});
