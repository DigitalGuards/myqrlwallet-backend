import fetch from 'node-fetch';
import { CONFIG } from '../config/index.js';
import { cache } from '../utils/cache.js';

/**
 * Validate a custom RPC URL to prevent SSRF attacks.
 * Blocks private IP ranges, localhost, cloud metadata endpoints, and non-HTTP protocols.
 */
function validateCustomRpcUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid custom RPC URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Custom RPC URL must use http or https protocol');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Block IPv6 localhost
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
    throw new Error('Custom RPC URL cannot target localhost');
  }

  // Block localhost hostnames
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Custom RPC URL cannot target localhost');
  }

  // Block cloud metadata hostnames
  if (hostname === 'metadata.google.internal') {
    throw new Error('Custom RPC URL cannot target internal services');
  }

  // Block private/reserved IPv4 ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 0) throw new Error('Custom RPC URL cannot target reserved addresses');
    if (a === 127) throw new Error('Custom RPC URL cannot target localhost');
    if (a === 10) throw new Error('Custom RPC URL cannot target private networks');
    if (a === 172 && b >= 16 && b <= 31) throw new Error('Custom RPC URL cannot target private networks');
    if (a === 192 && b === 168) throw new Error('Custom RPC URL cannot target private networks');
    if (a === 169 && b === 254) throw new Error('Custom RPC URL cannot target link-local addresses');
  }
}

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
      validateCustomRpcUrl(customRpcUrl);
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