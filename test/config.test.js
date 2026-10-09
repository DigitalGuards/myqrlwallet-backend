import * as chai from 'chai';
import { spawnSync } from 'node:child_process';
import {
  parseHistoryOrigin,
  parseIpfsGateways,
  parseRpcIdentity,
  resolveListenHost,
} from '../src/config/index.js';
import { normalizeClientIpForLimits } from '../src/utils/client-ip.js';

const { expect } = chai;

describe('IPFS gateway configuration', () => {
  it('defaults to the ordered public gateway list', () => {
    expect(parseIpfsGateways(undefined, undefined)).to.deep.equal([
      'https://ipfs.io/ipfs/',
      'https://gateway.pinata.cloud/ipfs/',
      'https://dweb.link/ipfs/',
    ]);
  });

  it('trims, normalizes, and deduplicates an ordered list ahead of the legacy value', () => {
    expect(
      parseIpfsGateways(
        ' https://first.example/ipfs, https://second.example/ipfs///, https://first.example/ipfs/ ',
        'invalid legacy value'
      )
    ).to.deep.equal(['https://first.example/ipfs/', 'https://second.example/ipfs/']);
  });

  it('preserves a single legacy HTTPS gateway when the list is absent', () => {
    expect(parseIpfsGateways(undefined, ' https://legacy.example/ipfs ')).to.deep.equal([
      'https://legacy.example/ipfs/',
    ]);
  });

  it('accepts a DNS hostname with a normalized IPFS base path and valid port', () => {
    expect(parseIpfsGateways('HTTPS://GATEWAY.EXAMPLE:443/a/../ipfs///', undefined)).to.deep.equal([
      'https://gateway.example/ipfs/',
    ]);
    expect(parseIpfsGateways('https://gateway.example:8443/ipfs', undefined)).to.deep.equal([
      'https://gateway.example:8443/ipfs/',
    ]);
  });

  const loopbackV4 = [127, 0, 0, 1].join('.');
  const invalidGateways = [
    ...[
      { label: 'IPv4 loopback', host: loopbackV4 },
      { label: 'IPv4 link-local', host: [169, 254, 169, 254].join('.') },
      { label: 'IPv4 documentation address', host: [192, 0, 2, 1].join('.') },
      { label: 'short IPv4', host: [127, 1].join('.') },
      { label: 'decimal IPv4', host: String(0x7f000001) },
      { label: 'hexadecimal IPv4', host: `0x${(0x7f000001).toString(16)}` },
      { label: 'octal IPv4', host: [127, 0, 0, 1].map((part) => `0${part.toString(8)}`).join('.') },
      { label: 'encoded IPv4', host: loopbackV4.replaceAll('.', '%2e') },
      { label: 'IPv4 with a trailing dot', host: `${loopbackV4}.` },
      { label: 'IPv6 loopback', host: `[${['', '', '1'].join(':')}]` },
      { label: 'IPv6 link-local', host: `[${['fe80', '', '1'].join(':')}]` },
      { label: 'IPv6 documentation address', host: `[${['2001', 'db8', '', '1'].join(':')}]` },
      { label: 'IPv6 mapped IPv4', host: `[${['', '', 'ffff', loopbackV4].join(':')}]` },
    ].map(({ label, host }) => ({ label, value: `https://${host}/ipfs/` })),
    { label: 'port zero', value: 'https://gateway.example:0/ipfs/' },
    { label: 'zero-padded port zero', value: 'https://gateway.example:000/ipfs/' },
    { label: 'empty userinfo', value: 'https://@gateway.example/ipfs/' },
    ...[
      '',
      '/',
      '/a/../../',
      '/%2e%2e/',
      '/ipfs/../',
      '/ipfs/%2e%2e/',
      '/x',
      '/api/ipfs/',
      '/ipfs/child/',
      '/IPFS/',
      '/%69pfs/',
      '/ipfs%2f',
    ].map((path) => ({
      label: `base path ${JSON.stringify(path)}`,
      value: `https://gateway.example${path}`,
    })),
  ];

  for (const { label, value } of invalidGateways) {
    it(`rejects ${label} through both configuration variables`, () => {
      expect(() => parseIpfsGateways(value, undefined)).to.throw('IPFS_GATEWAYS entry 1');
      expect(() => parseIpfsGateways(undefined, value)).to.throw('IPFS_GATEWAY entry 1');
    });

    it(`fails startup for ${label} with a sanitized configuration error`, () => {
      const child = importConfig({ IPFS_GATEWAYS: value });
      expect(child.status, child.stderr).to.equal(1);
      expect(child.stderr).to.include('Invalid IPFS gateway configuration: IPFS_GATEWAYS');
      expect(child.stderr).not.to.include(value);
    });
  }

  it('rejects malformed, blank, unsafe, and non-string entries without disclosing their values', () => {
    for (const value of [
      '',
      ' ',
      'https://valid.example/ipfs,',
      ',https://valid.example/ipfs',
      'https://valid.example/ipfs,,https://other.example/ipfs',
      'http://gateway.example/ipfs',
      '//gateway.example/ipfs',
      '/ipfs/',
      'gateway.example/ipfs',
      'https:gateway.example/ipfs',
      'https:///gateway.example/ipfs',
      'https://gateway.example/white space',
      'https://gateway.example/line\nbreak',
      'https://gateway.example\\ipfs',
      'https://gateway.example:invalid/ipfs',
      'https://secret-user:secret-password@gateway.example/ipfs',
      'https://gateway.example/ipfs?token=secret-token',
      'https://gateway.example/ipfs#secret-fragment',
      'https://gateway.example/ipfs?',
      null,
      42,
      ['https://gateway.example/ipfs'],
    ]) {
      expect(() => parseIpfsGateways(value, 'https://legacy.example/ipfs')).to.throw(
        'IPFS_GATEWAYS'
      );
    }
    expect(() => parseIpfsGateways(undefined, 'http://legacy.example/ipfs')).to.throw(
      'IPFS_GATEWAY entry 1'
    );
    expect(() =>
      parseIpfsGateways(undefined, 'https://first.example,https://second.example')
    ).to.throw('IPFS_GATEWAY entry 1');
  });

  function importConfig(env, expression = 'CONFIG.IPFS_GATEWAYS') {
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { CONFIG } from './src/config/index.ts'; console.log(JSON.stringify(${expression}));`,
      ],
      { encoding: 'utf8', timeout: 5000, env: { ...process.env, ...env } }
    );
  }

  for (const { label, reserve, cooldown, expected } of [
    { label: 'defaults', reserve: undefined, cooldown: undefined, expected: [1000, 900_000] },
    {
      label: 'configured values',
      reserve: '2000',
      cooldown: '1800000',
      expected: [2000, 1_800_000],
    },
    { label: 'minimum values', reserve: '1', cooldown: '1', expected: [250, 900_000] },
    ...['0', '-1', 'invalid'].map((value) => ({
      label: `invalid value ${value}`,
      reserve: value,
      cooldown: value,
      expected: [1000, 900_000],
    })),
  ]) {
    it(`loads bounded fallback and cooldown settings with ${label}`, () => {
      const child = importConfig(
        {
          IPFS_FALLBACK_RESERVE_MS: reserve,
          IPFS_MAX_COOLDOWN_MS: cooldown,
        },
        '[CONFIG.IPFS_FALLBACK_RESERVE_MS, CONFIG.IPFS_MAX_COOLDOWN_MS]'
      );
      expect(child.status, child.stderr).to.equal(0);
      expect(JSON.parse(child.stdout.trim())).to.deep.equal(expected);
    });
  }

  it('loads the list from the environment ahead of the legacy single gateway', () => {
    const child = importConfig({
      IPFS_GATEWAYS: ' https://first.example/ipfs, https://second.example/ipfs ',
      IPFS_GATEWAY: 'https://legacy.example/ipfs',
    });
    expect(child.status, child.stderr).to.equal(0);
    expect(JSON.parse(child.stdout.trim())).to.deep.equal([
      'https://first.example/ipfs/',
      'https://second.example/ipfs/',
    ]);
  });

  it('loads the legacy single gateway from the environment', () => {
    const child = importConfig({
      IPFS_GATEWAYS: undefined,
      IPFS_GATEWAY: 'https://legacy.example/ipfs',
    });
    expect(child.status, child.stderr).to.equal(0);
    expect(JSON.parse(child.stdout.trim())).to.deep.equal(['https://legacy.example/ipfs/']);
  });

  it('fails startup with a clear sanitized log for an invalid list or legacy value', () => {
    for (const env of [
      { IPFS_GATEWAYS: 'https://valid.example/ipfs,http://invalid.example/private-token' },
      { IPFS_GATEWAYS: undefined, IPFS_GATEWAY: 'http://invalid.example/private-token' },
    ]) {
      const child = importConfig(env);
      expect(child.status).to.equal(1);
      expect(child.stderr).to.include('Invalid IPFS gateway configuration: IPFS_GATEWAY');
      expect(child.stderr).to.include('must be an absolute HTTPS URL');
      expect(child.stderr).not.to.include('private-token');
    }
  });
});

describe('server configuration', () => {
  it('leaves RPC identity binding optional only when both pins are absent', () => {
    expect(parseRpcIdentity(undefined, undefined)).to.equal(null);
  });

  it('normalizes complete RPC identity pins without losing chain ID precision', () => {
    const genesis = `0x${'AB'.repeat(32)}`;
    expect(parseRpcIdentity('17', genesis)).to.deep.equal({
      chainId: '0x11',
      genesisHash: genesis.toLowerCase(),
    });
    expect(parseRpcIdentity(((1n << 256n) - 1n).toString(), genesis).chainId).to.equal(
      `0x${'f'.repeat(64)}`
    );
  });

  it('fails closed on partial, blank, malformed or overflowing RPC identity pins', () => {
    const genesis = `0x${'ab'.repeat(32)}`;
    const invalidPairs = [
      [undefined, genesis],
      ['17', undefined],
      ['', ''],
      ['', genesis],
      ['17', ''],
      ['0', genesis],
      ['-1', genesis],
      ['1.5', genesis],
      ['1e3', genesis],
      ['017', genesis],
      ['0x11', genesis],
      ['17junk', genesis],
      [' 17 ', genesis],
      [(1n << 256n).toString(), genesis],
      ['1'.repeat(79), genesis],
      ['17', `0x${'a'.repeat(63)}`],
      ['17', `0x${'a'.repeat(65)}`],
      ['17', `0x${'g'.repeat(64)}`],
      ['17', `${'a'.repeat(64)}`],
    ];
    for (const [chainId, genesisHash] of invalidPairs) {
      expect(() => parseRpcIdentity(chainId, genesisHash)).to.throw(
        'RPC expected identity requires both'
      );
    }
  });

  it('loads each deployment identity from its own canonical network environment pair', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "import { CONFIG } from './src/config/index.ts'; console.log(JSON.stringify(CONFIG.RPC_EXPECTED_IDENTITIES));",
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          RPC_EXPECTED_CHAIN_ID_DEV: '17',
          RPC_EXPECTED_GENESIS_HASH_DEV: `0x${'ab'.repeat(32)}`,
          RPC_EXPECTED_CHAIN_ID_TESTNET: '19',
          RPC_EXPECTED_GENESIS_HASH_TESTNET: `0x${'cd'.repeat(32)}`,
          RPC_EXPECTED_CHAIN_ID_MAINNET: '23',
          RPC_EXPECTED_GENESIS_HASH_MAINNET: `0x${'ef'.repeat(32)}`,
        },
      }
    );
    expect(child.status).to.equal(0);
    expect(JSON.parse(child.stdout.trim())).to.deep.equal({
      dev: { chainId: '0x11', genesisHash: `0x${'ab'.repeat(32)}` },
      testnet: { chainId: '0x13', genesisHash: `0x${'cd'.repeat(32)}` },
      mainnet: { chainId: '0x17', genesisHash: `0x${'ef'.repeat(32)}` },
    });
  });

  it('refuses to initialize the application with a partial deployment identity', () => {
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', "await import('./src/app.ts');"],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          RPC_EXPECTED_CHAIN_ID_TESTNET: '17',
          RPC_EXPECTED_GENESIS_HASH_TESTNET: '',
        },
      }
    );
    expect(child.status).to.equal(1);
    expect(child.stderr).to.include('RPC expected identity requires both');
  });

  it('validates history origins and permits explicit disabling', () => {
    expect(parseHistoryOrigin(undefined, 'https://explorer.example')).to.equal(
      'https://explorer.example'
    );
    expect(parseHistoryOrigin('', 'https://explorer.example')).to.equal(null);
    expect(parseHistoryOrigin('https://explorer.example/', null)).to.equal(
      'https://explorer.example'
    );
    expect(parseHistoryOrigin('http://127.0.0.1:8080', null)).to.equal('http://127.0.0.1:8080');
    for (const value of [
      'file:///tmp/history',
      'http://explorer.example',
      'https://user:pass@explorer.example',
      'https://explorer.example/api',
      'https://explorer.example/?network=testnet',
    ]) {
      expect(() => parseHistoryOrigin(value, null)).to.throw();
    }
  });

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
