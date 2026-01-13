import * as chai from 'chai';
import { rpcService } from '../../src/services/rpc.service.js';
import { CONFIG } from '../../src/config/index.js';

const { expect } = chai;

describe('RPC Service', () => {
  it('should validate network parameter', async () => {
    try {
      await rpcService.executeRPC('invalid-network', 'zond_blockNumber', []);
      expect.fail('Should have thrown an error');
    } catch (error) {
      expect(error.message).to.equal('Invalid network');
    }
  });

  it('should have valid RPC endpoints configured', () => {
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('dev');
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('testnet');
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('mainnet');
    expect(CONFIG.RPC_ENDPOINTS).to.have.property('custom');
  });
});
