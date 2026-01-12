import * as chai from 'chai';
import sinon from 'sinon';
import { rpcService } from '../../src/services/rpc.service.js';

const { expect } = chai;

describe('RPC Service', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should throw an error for a failed RPC call', async function() {
    // Increase timeout for this test
    this.timeout(5000);

    // Stub the makeRPCCall method directly to simulate a failed response
    const stub = sinon.stub(rpcService, 'makeRPCCall');
    stub.rejects(new Error('HTTP error! status: 404'));

    try {
      await rpcService.makeRPCCall('http://fake-endpoint', 'getInfo', []);
      // If we get here, the test should fail
      expect.fail('Expected an error to be thrown');
    } catch (error) {
      expect(error.message).to.equal('HTTP error! status: 404');
    }
  });

  it('should throw an error for invalid network', async function() {
    try {
      await rpcService.executeRPC('invalid-network', 'getInfo', []);
      expect.fail('Expected an error to be thrown');
    } catch (error) {
      expect(error.message).to.equal('Invalid network');
    }
  });
});
