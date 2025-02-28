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

  async executeRPC(network, method, params) {
    if (!CONFIG.RPC_ENDPOINTS[network]) {
      throw new Error('Invalid network');
    }

    const cacheKey = `${network}-${method}-${JSON.stringify(params)}`;
    const cachedResult = cache.get(cacheKey);

    if (cachedResult) {
      return cachedResult;
    }

    const result = await this.makeRPCCall(CONFIG.RPC_ENDPOINTS[network], method, params);
    cache.set(cacheKey, result);

    return result;
  }

  async executeCustomRPC(url, method, params) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
      });

      if (!response.ok) {
        throw new Error(`RPC call failed with status ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      throw new Error(`Failed to execute custom RPC: ${error.message}`);
    }
  }
}

export const rpcService = new RPCService(); 