/**
 * Relay Server tests - admission controls, capacity limits, and reconnect paths.
 *
 * These tests spin up a real Socket.IO relay on an ephemeral port and use
 * socket.io-client to exercise the admission and capacity logic.
 */

import * as chai from 'chai';
import { createServer } from 'http';
import { io as ioc } from 'socket.io-client';
import { CONFIG } from '../../src/config/index.js';
import { createRelayServer } from '../../src/relay/relayServer.js';

const { expect } = chai;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start relay with optional CONFIG overrides. Returns { io, httpServer, port, cleanup }. */
function startRelay(configOverrides = {}) {
  // Apply overrides directly to the CONFIG singleton (restored in cleanup).
  const originals = {};
  for (const [key, value] of Object.entries(configOverrides)) {
    originals[key] = CONFIG[key];
    CONFIG[key] = value;
  }

  const httpServer = createServer();
  const io = createRelayServer(httpServer);

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const port = httpServer.address().port;
      resolve({
        io,
        httpServer,
        port,
        cleanup: () => {
          io.destroy();
          httpServer.close();
          // Restore CONFIG
          for (const [key, value] of Object.entries(originals)) {
            CONFIG[key] = value;
          }
        },
      });
    });
  });
}

/** Create a connected client. Returns the socket.io-client socket. */
function connect(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://127.0.0.1:${port}`, {
      path: '/relay',
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      timeout: 2000,
      ...opts,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

// Arbitrary base64 blob standing in for a KEM public key. The relay
// is opaque about the key's contents — it just binds it to the channel
// and hands it back to the wallet for fingerprint verification.
const TEST_DAPP_PK = 'dGVzdC1kYXBwLXB1YmxpYy1rZXk=';

/** Join a channel and return the ack response. */
function joinChannel(socket, channelId, clientType, publicKey) {
  return new Promise((resolve) => {
    const payload = { channelId, clientType };
    // v2: dApp joins must carry a publicKey so the relay can bind it.
    // Tests that don't pass one explicitly get the shared test PK by default.
    if (publicKey !== undefined) {
      payload.publicKey = publicKey;
    } else if (clientType === 'dapp') {
      payload.publicKey = TEST_DAPP_PK;
    }
    socket.emit('join_channel', payload, (resp) => resolve(resp));
  });
}

/** Send a message and return the ack response. */
function sendMessage(socket, channelId, message, clientType = 'dapp') {
  return new Promise((resolve) => {
    socket.emit('message', { id: channelId, clientType, message }, (resp) => resolve(resp));
  });
}

/** Wait for a specific event with a timeout. */
function waitForEvent(socket, event, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Disconnect a socket and wait for it to fully close. */
function disconnect(socket) {
  return new Promise((resolve) => {
    if (!socket.connected) { resolve(); return; }
    socket.on('disconnect', () => resolve());
    socket.disconnect();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Relay Server', function () {
  this.timeout(10000);

  // ── Core channel operations ──────────────────────────────────────────

  describe('core operations', () => {
    let relay;

    before(async () => { relay = await startRelay(); });
    after(() => relay.cleanup());

    it('should allow dapp and wallet to join the same channel', async () => {
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);

      const r1 = await joinChannel(dapp, 'ch-1', 'dapp');
      expect(r1.success).to.be.true;

      const r2 = await joinChannel(wallet, 'ch-1', 'wallet');
      expect(r2.success).to.be.true;

      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('should route messages between dapp and wallet', async () => {
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);

      await joinChannel(dapp, 'ch-msg', 'dapp');
      await joinChannel(wallet, 'ch-msg', 'wallet');

      const msgPromise = waitForEvent(wallet, 'message');
      const ack = await sendMessage(dapp, 'ch-msg', 'hello-encrypted', 'dapp');
      expect(ack.success).to.be.true;
      expect(ack.buffered).to.be.false;

      const received = await msgPromise;
      expect(received.message).to.equal('hello-encrypted');

      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('should buffer messages when counterparty is disconnected', async () => {
      const dapp = await connect(relay.port);
      await joinChannel(dapp, 'ch-buf', 'dapp');

      // No wallet connected — message should be buffered
      const ack = await sendMessage(dapp, 'ch-buf', 'buffered-msg', 'dapp');
      expect(ack.success).to.be.true;
      expect(ack.buffered).to.be.true;

      // Wallet joins and gets the buffered message
      const wallet = await connect(relay.port);
      const joinResp = await joinChannel(wallet, 'ch-buf', 'wallet');
      expect(joinResp.success).to.be.true;
      expect(joinResp.bufferedMessages).to.have.length(1);
      expect(joinResp.bufferedMessages[0].message).to.equal('buffered-msg');

      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('should notify participants when counterparty joins', async () => {
      const dapp = await connect(relay.port);
      await joinChannel(dapp, 'ch-notify', 'dapp');

      const notifyPromise = waitForEvent(dapp, 'participants_changed');

      const wallet = await connect(relay.port);
      await joinChannel(wallet, 'ch-notify', 'wallet');

      const notification = await notifyPromise;
      expect(notification.event).to.equal('join');
      expect(notification.clientType).to.equal('wallet');

      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('should notify participants when counterparty disconnects', async () => {
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      await joinChannel(dapp, 'ch-dc', 'dapp');
      await joinChannel(wallet, 'ch-dc', 'wallet');

      const notifyPromise = waitForEvent(dapp, 'participants_changed');
      await disconnect(wallet);

      const notification = await notifyPromise;
      expect(notification.event).to.equal('disconnect');
      expect(notification.clientType).to.equal('wallet');

      await disconnect(dapp);
    });

    it('should reject invalid channelId', async () => {
      const socket = await connect(relay.port);

      const r1 = await joinChannel(socket, '', 'dapp');
      expect(r1.success).to.be.false;

      const r2 = await joinChannel(socket, 'bad channel!', 'dapp');
      expect(r2.success).to.be.false;

      await disconnect(socket);
    });

    it('should reject invalid clientType', async () => {
      const socket = await connect(relay.port);
      const resp = await joinChannel(socket, 'ch-type', 'hacker');
      expect(resp.success).to.be.false;
      expect(resp.error).to.include('clientType');
      await disconnect(socket);
    });

    // ── v2 PK-binding semantics ─────────────────────────────────────────

    it('should bind a dapp public key to the channel on first join', async () => {
      const dapp = await connect(relay.port);
      const resp = await joinChannel(dapp, 'ch-pk-bind', 'dapp', TEST_DAPP_PK);
      expect(resp.success).to.be.true;
      expect(resp.channelPublicKey).to.equal(TEST_DAPP_PK);
      await disconnect(dapp);
    });

    it('should echo the dapp public key to the wallet on join', async () => {
      const dapp = await connect(relay.port);
      await joinChannel(dapp, 'ch-pk-echo', 'dapp', TEST_DAPP_PK);

      const wallet = await connect(relay.port);
      const resp = await joinChannel(wallet, 'ch-pk-echo', 'wallet');
      expect(resp.success).to.be.true;
      expect(resp.channelPublicKey).to.equal(TEST_DAPP_PK);

      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('should reject a second dapp join that supplies a different PK', async () => {
      const dapp1 = await connect(relay.port);
      await joinChannel(dapp1, 'ch-pk-conflict', 'dapp', TEST_DAPP_PK);

      // First dApp stays connected; second dApp attempts to hijack with a
      // different PK. Relay must reject rather than silently rebinding —
      // otherwise a wallet scanning the original QR would be routed to
      // the attacker's key without the fp check ever firing.
      const dapp2 = await connect(relay.port);
      const resp = await joinChannel(
        dapp2,
        'ch-pk-conflict',
        'dapp',
        'c29tZS1vdGhlci1rZXk='
      );
      expect(resp.success).to.be.false;
      expect(resp.error).to.match(/bound|already/i);

      await disconnect(dapp1);
      await disconnect(dapp2);
    });

    it('should allow a wallet to join without a bound PK (returns null)', async () => {
      // Wallet reconnects (persisted session) or wins the race against
      // the dApp — either way, let it in and signal "no PK yet" via null.
      // The wallet decides whether that's a problem based on its own
      // session state.
      const wallet = await connect(relay.port);
      const resp = await joinChannel(wallet, 'ch-pk-early', 'wallet');
      expect(resp.success).to.be.true;
      expect(resp.channelPublicKey).to.be.null;
      await disconnect(wallet);
    });

    it('should reject a dapp PK exceeding size limit', async () => {
      const dapp = await connect(relay.port);
      const tooBig = 'A'.repeat(3000); // ~2250 bytes when decoded — over 2048B cap
      const resp = await joinChannel(dapp, 'ch-pk-big', 'dapp', tooBig);
      expect(resp.success).to.be.false;
      expect(resp.error).to.match(/size|limit/i);
      await disconnect(dapp);
    });
  });

  // ── Per-IP socket cap ────────────────────────────────────────────────

  describe('per-IP socket cap', () => {
    let relay;
    const MAX_PER_IP = 3;

    before(async () => {
      relay = await startRelay({ RELAY_MAX_SOCKETS_PER_IP: MAX_PER_IP });
    });
    after(() => relay.cleanup());

    it('should allow up to RELAY_MAX_SOCKETS_PER_IP connections', async () => {
      const sockets = [];
      for (let i = 0; i < MAX_PER_IP; i++) {
        sockets.push(await connect(relay.port));
      }
      expect(sockets).to.have.length(MAX_PER_IP);
      for (const s of sockets) await disconnect(s);
    });

    it('should reject connections beyond RELAY_MAX_SOCKETS_PER_IP', async () => {
      const sockets = [];
      for (let i = 0; i < MAX_PER_IP; i++) {
        sockets.push(await connect(relay.port));
      }

      // The next connection should be immediately disconnected by the server
      try {
        const extra = await connect(relay.port);
        // If we somehow connect, wait a moment to see if server disconnects us
        await new Promise((resolve) => {
          extra.on('disconnect', () => resolve());
          setTimeout(resolve, 500);
        });
        expect(extra.connected).to.be.false;
      } catch {
        // connect_error is also acceptable — server rejected us
      }

      for (const s of sockets) await disconnect(s);
    });

    it('should recover slot when a socket disconnects', async () => {
      const sockets = [];
      for (let i = 0; i < MAX_PER_IP; i++) {
        sockets.push(await connect(relay.port));
      }

      // Release one slot
      await disconnect(sockets.pop());

      // Should now be able to connect again
      const replacement = await connect(relay.port);
      expect(replacement.connected).to.be.true;

      await disconnect(replacement);
      for (const s of sockets) await disconnect(s);
    });
  });

  // ── Global socket cap ────────────────────────────────────────────────

  describe('global socket cap', () => {
    let relay;
    const GLOBAL_MAX = 3;

    before(async () => {
      relay = await startRelay({
        RELAY_MAX_ACTIVE_SOCKETS: GLOBAL_MAX,
        RELAY_MAX_SOCKETS_PER_IP: 100, // don't hit per-IP cap
      });
    });
    after(() => relay.cleanup());

    it('should reject connections beyond RELAY_MAX_ACTIVE_SOCKETS', async () => {
      const sockets = [];
      for (let i = 0; i < GLOBAL_MAX; i++) {
        sockets.push(await connect(relay.port));
      }

      try {
        const extra = await connect(relay.port);
        await new Promise((resolve) => {
          extra.on('disconnect', () => resolve());
          setTimeout(resolve, 500);
        });
        expect(extra.connected).to.be.false;
      } catch {
        // connect_error is acceptable
      }

      for (const s of sockets) await disconnect(s);
    });
  });

  // ── Channel capacity cap ─────────────────────────────────────────────

  describe('channel capacity cap', () => {
    const MAX_CHANNELS = 2;

    it('should reject new channel creation beyond RELAY_MAX_ACTIVE_CHANNELS', async () => {
      const relay = await startRelay({
        RELAY_MAX_ACTIVE_CHANNELS: MAX_CHANNELS,
        RELAY_MAX_SOCKETS_PER_IP: 100,
      });
      const sockets = [];

      try {
        // Fill up channels
        for (let i = 0; i < MAX_CHANNELS; i++) {
          const s = await connect(relay.port);
          const resp = await joinChannel(s, `cap-ch-${i}`, 'dapp');
          expect(resp.success).to.be.true;
          sockets.push(s);
        }

        // Next NEW channel should fail
        const extra = await connect(relay.port);
        const resp = await joinChannel(extra, 'cap-ch-overflow', 'dapp');
        expect(resp.success).to.be.false;
        expect(resp.error).to.include('capacity');

        await disconnect(extra);
      } finally {
        for (const s of sockets) await disconnect(s);
        relay.cleanup();
      }
    });

    it('should allow joining an existing channel even at capacity', async () => {
      const relay = await startRelay({
        RELAY_MAX_ACTIVE_CHANNELS: MAX_CHANNELS,
        RELAY_MAX_SOCKETS_PER_IP: 100,
      });
      const sockets = [];

      try {
        for (let i = 0; i < MAX_CHANNELS; i++) {
          const s = await connect(relay.port);
          await joinChannel(s, `exist-ch-${i}`, 'dapp');
          sockets.push(s);
        }

        // Join an EXISTING channel as wallet — should succeed
        const wallet = await connect(relay.port);
        const resp = await joinChannel(wallet, 'exist-ch-0', 'wallet');
        expect(resp.success).to.be.true;

        await disconnect(wallet);
      } finally {
        for (const s of sockets) await disconnect(s);
        relay.cleanup();
      }
    });
  });

  // ── Reconnect / rejoin path ──────────────────────────────────────────

  describe('reconnect and rejoin', () => {
    let relay;

    before(async () => { relay = await startRelay(); });
    after(() => relay.cleanup());

    it('should deliver buffered messages after wallet reconnects', async () => {
      const dapp = await connect(relay.port);
      const wallet1 = await connect(relay.port);

      await joinChannel(dapp, 'ch-recon', 'dapp');
      await joinChannel(wallet1, 'ch-recon', 'wallet');

      // Wallet disconnects
      await disconnect(wallet1);

      // dApp sends messages while wallet is offline
      await sendMessage(dapp, 'ch-recon', 'msg-while-offline-1', 'dapp');
      await sendMessage(dapp, 'ch-recon', 'msg-while-offline-2', 'dapp');

      // Wallet reconnects and joins the same channel
      const wallet2 = await connect(relay.port);
      const joinResp = await joinChannel(wallet2, 'ch-recon', 'wallet');
      expect(joinResp.success).to.be.true;
      expect(joinResp.bufferedMessages).to.have.length(2);
      expect(joinResp.bufferedMessages[0].message).to.equal('msg-while-offline-1');
      expect(joinResp.bufferedMessages[1].message).to.equal('msg-while-offline-2');

      await disconnect(dapp);
      await disconnect(wallet2);
    });

    it('should allow stale socket replacement on rejoin', async () => {
      const dapp = await connect(relay.port);
      await joinChannel(dapp, 'ch-stale', 'dapp');

      // Simulate stale socket: disconnect without server knowing immediately
      // Then reconnect with a new socket and rejoin same channel as dapp
      await disconnect(dapp);

      const dapp2 = await connect(relay.port);
      const resp = await joinChannel(dapp2, 'ch-stale', 'dapp');
      expect(resp.success).to.be.true;

      await disconnect(dapp2);
    });

    it('should prevent active socket hijacking', async () => {
      const dapp1 = await connect(relay.port);
      await joinChannel(dapp1, 'ch-hijack', 'dapp');

      // Second dapp tries to join same channel while first is still connected
      const dapp2 = await connect(relay.port);
      const resp = await joinChannel(dapp2, 'ch-hijack', 'dapp');
      expect(resp.success).to.be.false;
      expect(resp.error).to.include('already connected');

      await disconnect(dapp1);
      await disconnect(dapp2);
    });
  });

  // ── Leave channel ────────────────────────────────────────────────────

  describe('leave channel', () => {
    let relay;

    before(async () => { relay = await startRelay(); });
    after(() => relay.cleanup());

    it('should notify counterparty on explicit leave', async () => {
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);

      await joinChannel(dapp, 'ch-leave', 'dapp');
      await joinChannel(wallet, 'ch-leave', 'wallet');

      const notifyPromise = waitForEvent(dapp, 'participants_changed');

      await new Promise((resolve) => {
        wallet.emit('leave_channel', { channelId: 'ch-leave' }, resolve);
      });

      const notification = await notifyPromise;
      expect(notification.event).to.equal('leave');
      expect(notification.clientType).to.equal('wallet');

      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('should allow rejoining after explicit leave', async () => {
      const socket = await connect(relay.port);

      await joinChannel(socket, 'ch-rejoin', 'dapp');

      await new Promise((resolve) => {
        socket.emit('leave_channel', { channelId: 'ch-rejoin' }, resolve);
      });

      const resp = await joinChannel(socket, 'ch-rejoin', 'dapp');
      expect(resp.success).to.be.true;

      await disconnect(socket);
    });
  });

  // ── Rate limiting ────────────────────────────────────────────────────

  describe('rate limiting', () => {
    let relay;

    before(async () => { relay = await startRelay(); });
    after(() => relay.cleanup());

    it('should reject messages after rate limit is exceeded', async () => {
      const dapp = await connect(relay.port);
      await joinChannel(dapp, 'ch-rate', 'dapp');

      // Send 100 messages (the limit), all should succeed
      let lastAck;
      for (let i = 0; i < 100; i++) {
        lastAck = await sendMessage(dapp, 'ch-rate', `msg-${i}`, 'dapp');
      }
      expect(lastAck.success).to.be.true;

      // The 101st should be rate limited
      const overLimit = await sendMessage(dapp, 'ch-rate', 'one-too-many', 'dapp');
      expect(overLimit.success).to.be.false;
      expect(overLimit.error).to.include('Rate limit');

      await disconnect(dapp);
    });
  });

  // ── Channel ID validation ────────────────────────────────────────────

  describe('channel ID validation', () => {
    let relay;

    before(async () => { relay = await startRelay(); });
    after(() => relay.cleanup());

    it('should reject empty channelId', async () => {
      const s = await connect(relay.port);
      const resp = await joinChannel(s, '', 'dapp');
      expect(resp.success).to.be.false;
      await disconnect(s);
    });

    it('should reject channelId with special characters', async () => {
      const s = await connect(relay.port);
      const resp = await joinChannel(s, 'bad channel!@#', 'dapp');
      expect(resp.success).to.be.false;
      await disconnect(s);
    });

    it('should accept valid UUID-style channelId', async () => {
      const s = await connect(relay.port);
      const resp = await joinChannel(s, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'dapp');
      expect(resp.success).to.be.true;
      await disconnect(s);
    });

    it('should reject channelId exceeding max length', async () => {
      const s = await connect(relay.port);
      const longId = 'a'.repeat(129);
      const resp = await joinChannel(s, longId, 'dapp');
      expect(resp.success).to.be.false;
      await disconnect(s);
    });
  });

  // ── Ping ─────────────────────────────────────────────────────────────

  describe('ping', () => {
    let relay;

    before(async () => { relay = await startRelay(); });
    after(() => relay.cleanup());

    it('should respond with pong', async () => {
      const s = await connect(relay.port);
      const resp = await new Promise((resolve) => {
        s.emit('ping', (data) => resolve(data));
      });
      expect(resp.type).to.equal('pong');
      expect(resp.timestamp).to.be.a('number');
      await disconnect(s);
    });
  });

  // ── Participant roster + terminated tombstone ────────────────────────

  describe('roster and tombstone', () => {
    let relay;

    before(async () => { relay = await startRelay(); });
    after(() => relay.cleanup());

    it('join ack reports an empty roster when the peer joins alone', async () => {
      const dapp = await connect(relay.port);
      const resp = await joinChannel(dapp, 'roster-alone', 'dapp');
      expect(resp.success).to.be.true;
      expect(resp.participants).to.deep.equal([]);
      expect(resp.terminated).to.be.false;
      await disconnect(dapp);
    });

    it('join ack reports the counterparty client type when present', async () => {
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      await joinChannel(dapp, 'roster-pair', 'dapp');
      const walletAck = await joinChannel(wallet, 'roster-pair', 'wallet');
      expect(walletAck.success).to.be.true;
      // The wallet joined second, so it sees the dApp already in the channel.
      expect(walletAck.participants).to.deep.equal(['dapp']);
      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('close_channel marks a tombstone surfaced on a later re-join', async () => {
      const dapp = await connect(relay.port);
      await joinChannel(dapp, 'tombstone-ch', 'dapp');
      await new Promise((resolve) => {
        dapp.emit('close_channel', { channelId: 'tombstone-ch' }, () => resolve());
      });
      await disconnect(dapp);

      // A fresh dApp socket re-joining the same channel learns it was closed.
      const dapp2 = await connect(relay.port);
      const resp = await joinChannel(dapp2, 'tombstone-ch', 'dapp');
      expect(resp.success).to.be.true;
      expect(resp.terminated).to.be.true;
      await disconnect(dapp2);
    });

    it('notifies a connected counterparty of an explicit close', async () => {
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      await joinChannel(dapp, 'close-notify', 'dapp');
      await joinChannel(wallet, 'close-notify', 'wallet');
      const evt = waitForEvent(dapp, 'participants_changed');
      wallet.emit('close_channel', { channelId: 'close-notify' });
      const data = await evt;
      expect(data.event).to.equal('close');
      expect(data.clientType).to.equal('wallet');
      await disconnect(dapp);
      await disconnect(wallet);
    });

    it('refuses to route messages on a terminated channel', async () => {
      const wallet = await connect(relay.port);
      const dapp = await connect(relay.port);
      await joinChannel(wallet, 'closed-route', 'wallet');
      await joinChannel(dapp, 'closed-route', 'dapp');
      // The wallet explicitly closes (tombstones) the channel.
      await new Promise((resolve) => {
        wallet.emit('close_channel', { channelId: 'closed-route' }, () => resolve());
      });
      // A peer that never received or ignored the 'close' event must not be
      // able to keep routing through the dead channel.
      const ack = await sendMessage(dapp, 'closed-route', 'after-close', 'dapp');
      expect(ack.success).to.be.false;
      expect(ack.error).to.equal('Channel terminated');
      await disconnect(dapp);
      await disconnect(wallet);
    });
  });
});
