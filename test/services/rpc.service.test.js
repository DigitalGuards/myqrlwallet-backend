import * as chai from 'chai';
import sinon from 'sinon';
import { rpcService } from '../../src/services/rpc.service.js';
import { CONFIG } from '../../src/config/index.js';

const { expect } = chai;

describe('RPC Service', () => {
  afterEach(() => {
    sinon.restore();
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
});
