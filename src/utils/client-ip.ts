import type { IncomingMessage } from 'node:http';
import { ipKeyGenerator } from 'express-rate-limit';
import proxyaddr from 'proxy-addr';
import { CONFIG } from '../config/index.js';

type TrustProxy = (address: string, index: number) => boolean;

let cachedCidrs = '';
let cachedTrust: TrustProxy = () => false;

function getTrustProxy(): TrustProxy {
  const cidrs = CONFIG.TRUSTED_PROXY_CIDRS.join(',');
  if (cidrs === cachedCidrs) return cachedTrust;

  cachedCidrs = cidrs;
  cachedTrust = CONFIG.TRUSTED_PROXY_CIDRS.length
    ? proxyaddr.compile(CONFIG.TRUSTED_PROXY_CIDRS)
    : () => false;
  return cachedTrust;
}

/** Express trust-proxy callback. Forwarded hops are trusted only by CIDR. */
export function isTrustedProxy(address: string, index: number): boolean {
  return getTrustProxy()(address, index);
}

/**
 * Resolve a request's closest untrusted address, walking X-Forwarded-For from
 * right to left. Vendor headers are intentionally ignored: an origin request
 * can forge them unless the edge strips and rewrites them first.
 */
export function getTrustedClientIp(request: IncomingMessage): string {
  try {
    return proxyaddr(request, getTrustProxy());
  } catch {
    return request.socket.remoteAddress ?? 'unknown';
  }
}

/**
 * Collapse IPv6 privacy addresses to a stable prefix before applying any
 * per-client admission or memory budget. Exact IPv6 addresses are cheap to
 * rotate within one delegated prefix and would make those controls trivial
 * to bypass. IPv4 addresses and malformed fallback values pass through.
 */
export function normalizeClientIpForLimits(ip: string): string {
  return ipKeyGenerator(ip);
}
