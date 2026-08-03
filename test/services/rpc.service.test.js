import * as chai from 'chai';
import sinon from 'sinon';
import { rpcService } from '../../src/services/rpc.service.js';
import { CONFIG } from '../../src/config/index.js';
import { cache } from '../../src/utils/cache.js';
import { healthMonitor, HEALTH_STATES } from '../../src/services/rpc/healthMonitor.js';

const { expect } = chai;

function buildRpcResponse({ ok = true, status = 200, contentLength, chunks } = {}) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  const queue = [...(chunks ?? [body])];
  let index = 0;
  return {
    ok,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-length') {
          return String(
            contentLength ?? queue.reduce((total, chunk) => total + chunk.byteLength, 0)
          );
        }
        return null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= queue.length) return { done: true, value: undefined };
            return { done: false, value: queue[index++] };
          },
          async cancel() {
            index = queue.length;
          },
        };
      },
    },
  };
}

describe('RPC Service', () => {
  let originalRpcLimits;

  beforeEach(() => {
    originalRpcLimits = {
      RPC_MAX_RESPONSE_BYTES: CONFIG.RPC_MAX_RESPONSE_BYTES,
      RPC_MAX_CONCURRENT: CONFIG.RPC_MAX_CONCURRENT,
      RPC_MAX_INFLIGHT_BYTES: CONFIG.RPC_MAX_INFLIGHT_BYTES,
    };
  });

  afterEach(() => {
    Object.assign(CONFIG, originalRpcLimits);
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

  describe('upstream response admission', () => {
    it('parses a valid response from bounded chunks', async () => {
      const encoded = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, result: '0x77' }));
      sinon.stub(globalThis, 'fetch').resolves(
        buildRpcResponse({
          chunks: [encoded.subarray(0, 10), encoded.subarray(10)],
        })
      );

      const result = await rpcService.makeRPCCall(
        'http://upstream.test:8545',
        'qrl_blockNumber',
        [],
        7
      );

      expect(result).to.deep.equal({ jsonrpc: '2.0', id: 7, result: '0x77' });
      expect(globalThis.fetch.firstCall.args[1].redirect).to.equal('error');
    });

    it('returns 502 when declared or streamed response bytes exceed the cap', async () => {
      CONFIG.RPC_MAX_RESPONSE_BYTES = 32;
      CONFIG.RPC_MAX_INFLIGHT_BYTES = 64;
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(buildRpcResponse({ contentLength: 33 }));

      let declaredError;
      try {
        await rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      } catch (err) {
        declaredError = err;
      }
      expect(declaredError).to.include({ status: 502, message: 'RPC upstream response too large' });

      const encoded = Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(64) })
      );
      fetchStub.onSecondCall().resolves(
        buildRpcResponse({
          contentLength: 1,
          chunks: [encoded.subarray(0, 20), encoded.subarray(20)],
        })
      );

      let streamedError;
      try {
        await rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      } catch (err) {
        streamedError = err;
      }
      expect(streamedError).to.include({ status: 502, message: 'RPC upstream response too large' });
    });

    it('returns 502 for invalid upstream JSON', async () => {
      sinon
        .stub(globalThis, 'fetch')
        .resolves(buildRpcResponse({ chunks: [Buffer.from('{"jsonrpc":')] }));

      let rpcError;
      try {
        await rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      } catch (err) {
        rpcError = err;
      }
      expect(rpcError).to.include({ status: 502, message: 'RPC upstream returned invalid JSON' });
    });

    it('returns 502 and cancels an invalid UTF-8 response stream', async () => {
      let cancelled = false;
      let delivered = false;
      sinon.stub(globalThis, 'fetch').resolves({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader() {
            return {
              async read() {
                if (delivered) return { done: true, value: undefined };
                delivered = true;
                return { done: false, value: Uint8Array.from([0xff]) };
              },
              async cancel() {
                cancelled = true;
              },
            };
          },
        },
      });

      let rpcError;
      try {
        await rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      } catch (err) {
        rpcError = err;
      }

      await Promise.resolve();
      expect(rpcError).to.include({
        status: 502,
        message: 'RPC upstream returned an invalid response body',
      });
      expect(cancelled).to.equal(true);
    });

    it('returns 503 when the concurrency cap is occupied and releases the slot', async () => {
      CONFIG.RPC_MAX_RESPONSE_BYTES = 1024;
      CONFIG.RPC_MAX_CONCURRENT = 1;
      CONFIG.RPC_MAX_INFLIGHT_BYTES = 2048;
      let resolveFetch;
      let signalStarted;
      const started = new Promise((resolve) => {
        signalStarted = resolve;
      });
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().callsFake(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
            signalStarted();
          })
      );
      fetchStub.onSecondCall().resolves(buildRpcResponse());

      const first = rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      await started;

      let busyError;
      try {
        await rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      } catch (err) {
        busyError = err;
      }
      expect(busyError).to.include({ status: 503, message: 'RPC proxy busy' });
      expect(fetchStub.callCount).to.equal(1);

      resolveFetch(buildRpcResponse());
      await first;
      await rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      expect(fetchStub.callCount).to.equal(2);
    });

    it('returns 503 when the aggregate byte reservation is occupied', async () => {
      CONFIG.RPC_MAX_RESPONSE_BYTES = 1024;
      CONFIG.RPC_MAX_CONCURRENT = 4;
      CONFIG.RPC_MAX_INFLIGHT_BYTES = 1024;
      let resolveFetch;
      let signalStarted;
      const started = new Promise((resolve) => {
        signalStarted = resolve;
      });
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().callsFake(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
            signalStarted();
          })
      );

      const first = rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      await started;

      let busyError;
      try {
        await rpcService.makeRPCCall('http://upstream.test:8545', 'qrl_blockNumber', []);
      } catch (err) {
        busyError = err;
      }
      expect(busyError).to.include({ status: 503, message: 'RPC proxy busy' });
      expect(fetchStub.callCount).to.equal(1);

      resolveFetch(buildRpcResponse());
      await first;
    });
  });

  describe('failover behavior', () => {
    it('never lets client-selected success or failure mutate endpoint health', async () => {
      healthMonitor.__setEndpointsForTesting('testnet', ['http://primary.test:8545']);
      healthMonitor.__forceStateForTesting(
        'testnet',
        'http://primary.test:8545',
        HEALTH_STATES.STATE_STALLED
      );
      const stub = sinon.stub(rpcService, 'makeRPCCall');
      stub.onFirstCall().resolves({ jsonrpc: '2.0', id: 1, result: '0x100' });
      stub.onSecondCall().resolves({ jsonrpc: '2.0', id: 2, result: '0x101' });
      stub.onThirdCall().rejects(new Error('client request failed'));

      await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
      expect(healthMonitor.getSnapshot().testnet[0].state).to.equal(HEALTH_STATES.STATE_STALLED);

      healthMonitor.__forceStateForTesting(
        'testnet',
        'http://primary.test:8545',
        HEALTH_STATES.STATE_DOWN
      );
      await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
      expect(healthMonitor.getSnapshot().testnet[0].state).to.equal(HEALTH_STATES.STATE_DOWN);

      try {
        await rpcService.executeRPC('testnet', 'qrl_blockNumber', []);
      } catch {
        // The upstream failure is expected; only the poller may record it.
      }
      const endpoint = healthMonitor.getSnapshot().testnet[0];
      expect(endpoint.state).to.equal(HEALTH_STATES.STATE_DOWN);
      expect(endpoint.consecutiveFailures).to.equal(0);
      expect(stub.callCount).to.equal(3);
    });

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
