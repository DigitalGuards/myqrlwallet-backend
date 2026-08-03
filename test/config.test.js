import * as chai from 'chai';
import { resolveListenHost } from '../src/config/index.js';
import { normalizeClientIpForLimits } from '../src/utils/client-ip.js';

const { expect } = chai;

describe('server configuration', () => {
  it('binds to loopback by default', () => {
    expect(resolveListenHost(undefined)).to.equal('127.0.0.1');
    expect(resolveListenHost('  ')).to.equal('127.0.0.1');
  });

  it('allows an explicit container bind address', () => {
    expect(resolveListenHost('0.0.0.0')).to.equal('0.0.0.0');
  });

  it('groups IPv6 privacy addresses by delegated prefix for admission limits', () => {
    const first = normalizeClientIpForLimits('2001:db8:1234:5601::1');
    const rotated = normalizeClientIpForLimits('2001:db8:1234:56ff::2');
    const otherPrefix = normalizeClientIpForLimits('2001:db8:1234:5701::1');

    expect(first).to.equal(rotated);
    expect(first).not.to.equal(otherPrefix);
    expect(normalizeClientIpForLimits('198.51.100.7')).to.equal('198.51.100.7');
  });
});
