import * as chai from 'chai';
import sinon from 'sinon';
import fetch, { Response } from 'node-fetch';
import { rpcService } from '../../src/services/rpc.service.js';
import { CONFIG } from '../../src/config/index.js';

const { expect } = chai;

describe('RPC Service', () => {
  beforeEach(() => {
    global.fetch = sinon.stub();
  });

  afterEach(() => {
    sinon.restore();
  });

  // it('should make a successful RPC call', async () => {
  //   const mockResponse = new Response(JSON.stringify({
  //     jsonrpc: '2.0',
  //     id: 1740743910769,
  //     result: 'success'
  //   }), { status: 200 });
  //   global.fetch.returns(Promise.resolve(mockResponse));

  //   const result = await rpcService.makeRPCCall(CONFIG.RPC_ENDPOINTS.testnet, 'getInfo', []);
  //   expect(result).to.deep.equal({
  //     jsonrpc: '2.0',
  //     id: 1740743910769,
  //     result: 'success'
  //   });
  // });

  it('should throw an error for a failed RPC call', async () => {
    const mockResponse = new Response('Not Found', { status: 404 });
    global.fetch.returns(Promise.resolve(mockResponse));

    try {
      await rpcService.makeRPCCall(CONFIG.RPC_ENDPOINTS.testnet, 'getInfo', []);
    } catch (error) {
      expect(error.message).to.equal('HTTP error! status: 404');
    }
  });
}); 