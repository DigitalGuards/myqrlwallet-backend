import * as chai from 'chai';
import sinon from 'sinon';
import { rpcService } from '../../src/services/rpc.service.js';
import { CONFIG } from '../../src/config/index.js';
import { cache } from '../../src/utils/cache.js';

const { expect } = chai;

describe('RPC Service', () => {
  afterEach(() => {
    sinon.restore();
    cache.flushAll();
  });

  it('should validate network parameter', async () => {
    try {
      await rpcService.executeRPC('invalid-network', 'qrl_blockNumber', []);
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).to.equal('Invalid network');
    }
  });

  it('should throw an error for a failed RPC call', async function() {
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
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('custom');
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
  });
});
