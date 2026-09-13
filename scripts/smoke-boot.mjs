/**
 * Boot smoke test: start the BUILT server exactly the way pm2 does
 * (`node server.js`) and prove it listens and routes resolve.
 *
 * The mocha suite imports `src/app.ts` under tsx, so a route that throws at
 * registration is usually caught there. This check closes the remaining gaps:
 *
 *   - routes registered in `src/server.ts` (`/relay/stats`, `/metrics`) are
 *     outside the unit tests' import graph;
 *   - only the compiled `dist/` output is what production runs;
 *   - a dependency bump can change runtime behaviour without touching a line
 *     the tests exercise (express 5 rejecting `/:cid/*` at boot on 2026-09-03
 *     shipped to prod because nothing in the pipeline booted the server).
 *
 * Success means the process answered HTTP on every probe. Status codes are
 * deliberately not asserted: `/health` legitimately returns 503 when no RPC
 * upstream is reachable, which is always the case in CI.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const BOOT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

// A syntactically valid CIDv0 so the wildcard probe reaches the route handler
// instead of being rejected as malformed before routing matters.
const PROBE_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

const PROBES = ['/health', `/api/ipfs/${PROBE_CID}/path/to/asset.png`];

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function probe(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.status;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      LISTEN_HOST: '127.0.0.1',
      // Point every upstream at a closed local port so the health monitor
      // fails fast instead of hanging on a real network in CI.
      RPC_ENDPOINTS_TESTNET: 'http://127.0.0.1:9',
      RPC_ENDPOINTS_DEV: 'http://127.0.0.1:9',
      RPC_ENDPOINTS_MAINNET: 'http://127.0.0.1:9',
      IPFS_GATEWAY: 'http://127.0.0.1:9/ipfs/',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const fail = (msg) => {
    console.error(`smoke-boot: FAIL: ${msg}`);
    if (output.trim()) {
      console.error('--- server output ---');
      console.error(output.trimEnd());
      console.error('---------------------');
    }
    if (!exited) child.kill('SIGKILL');
    process.exit(1);
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let listening = false;
  while (Date.now() < deadline) {
    if (exited) {
      fail(`server exited before listening (code=${exited.code} signal=${exited.signal})`);
    }
    try {
      await probe(`${base}/health`);
      listening = true;
      break;
    } catch {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  if (!listening) fail(`no HTTP response on ${base} within ${BOOT_TIMEOUT_MS}ms`);

  for (const path of PROBES) {
    try {
      const status = await probe(`${base}${path}`);
      console.log(`smoke-boot: ${path} -> ${status}`);
    } catch (err) {
      fail(`${path} did not answer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  child.kill('SIGTERM');
  const exitDeadline = Date.now() + 5_000;
  while (!exited && Date.now() < exitDeadline) await sleep(50);
  if (!exited) child.kill('SIGKILL');

  console.log('smoke-boot: OK');
}

main().catch((err) => {
  console.error('smoke-boot: FAIL:', err);
  process.exit(1);
});
