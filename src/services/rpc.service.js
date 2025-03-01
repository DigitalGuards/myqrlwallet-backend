import fetch from 'node-fetch';
import { CONFIG } from '../config/index.js';
import { cache } from '../utils/cache.js';

class RPCService {
  async makeRPCCall(endpoint, method, params) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  }

  async executeRPC(network, method, params, customRpcUrl = '') {
    if (!CONFIG.RPC_ENDPOINTS[network]) {
      throw new Error('Invalid network');
    }

    const cacheKey = `${network}-${method}-${JSON.stringify(params)}`;
    const cachedResult = cache.get(cacheKey);

    if (cachedResult) {
      return cachedResult;
    }

    if (network === 'custom' && customRpcUrl !== '') {
      const result = await this.makeRPCCall(customRpcUrl, method, params);
      cache.set(cacheKey, result);
      return result;
    } else {
      const result = await this.makeRPCCall(CONFIG.RPC_ENDPOINTS[network], method, params);
      cache.set(cacheKey, result);
      return result;
    }

  }
}

export const rpcService = new RPCService(); 