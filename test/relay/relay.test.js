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
import { ChannelManager } from '../../src/relay/channelManager.js';

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
  const { io, channelManager, destroy } = createRelayServer(httpServer);

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const port = httpServer.address().port;
      resolve({
        io,
        channelManager,
        httpServer,
        port,
        cleanup: () => {
          destroy();
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
    if (!socket.connected) {
      resolve();
      return;
    }
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

    before(async () => {
      relay = await startRelay();
    });
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

    it('should pin a joined socket to its original clientType', async () => {
      const socket = await connect(relay.port);
      expect((await joinChannel(socket, 'ch-role-pin', 'dapp')).success).to.equal(true);

      const switched = await joinChannel(socket, 'ch-role-pin', 'wallet');

      expect(switched.success).to.equal(false);
      expect(switched.error).to.include('cannot change clientType');
      await disconnect(socket);
    });

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
      const resp = await joinChannel(dapp2, 'ch-pk-conflict', 'dapp', 'c29tZS1vdGhlci1rZXk=');
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

  describe('trusted proxy attribution', () => {
    it('ignores spoofed vendor IP headers from a direct peer', async () => {
      const relay = await startRelay({
        RELAY_MAX_SOCKETS_PER_IP: 2,
        TRUSTED_PROXY_CIDRS: [],
      });
      const sockets = [];
      try {
        for (let i = 0; i < 2; i++) {
          sockets.push(
            await connect(relay.port, {
              extraHeaders: { 'CF-Connecting-IP': `198.51.100.${i + 1}` },
            })
          );
        }

        let extra = null;
        try {
          extra = await connect(relay.port, {
            extraHeaders: { 'CF-Connecting-IP': '198.51.100.200' },
          });
        } catch {
          // A connection-level rejection is also a successful cap outcome.
        }
        if (extra) {
          await new Promise((resolve) => {
            extra.on('disconnect', resolve);
            setTimeout(resolve, 500);
          });
          expect(extra.connected).to.be.false;
          extra.close();
        }
      } finally {
        for (const socket of sockets) await disconnect(socket);
        relay.cleanup();
      }
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

    before(async () => {
      relay = await startRelay();
    });
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

  describe('atomic channel switching', () => {
    let relay;

    before(async () => {
      relay = await startRelay();
    });
    after(() => relay.cleanup());

    it('preserves the old channel when the new channel has a role conflict', async () => {
      const switchingDapp = await connect(relay.port);
      const oldWallet = await connect(relay.port);
      const conflictingDapp = await connect(relay.port);
      await joinChannel(switchingDapp, 'switch-old-conflict', 'dapp');
      await joinChannel(oldWallet, 'switch-old-conflict', 'wallet');
      await joinChannel(conflictingDapp, 'switch-new-conflict', 'dapp');

      const notices = [];
      oldWallet.on('participants_changed', (notice) => notices.push(notice));
      const conflict = await joinChannel(switchingDapp, 'switch-new-conflict', 'dapp');
      expect(conflict.success).to.equal(false);
      expect(conflict.error).to.include('already connected');

      const received = waitForEvent(oldWallet, 'message');
      const routed = await sendMessage(
        switchingDapp,
        'switch-old-conflict',
        'old-channel-still-live'
      );
      expect(routed.success).to.equal(true);
      expect((await received).message).to.equal('old-channel-still-live');
      expect(notices).to.deep.equal([]);

      const disconnected = waitForEvent(oldWallet, 'participants_changed');
      await disconnect(switchingDapp);
      expect((await disconnected).event).to.equal('disconnect');
      await disconnect(oldWallet);
      await disconnect(conflictingDapp);
    });

    it('preserves the old channel when the requested channel is tombstoned', async () => {
      const switchingDapp = await connect(relay.port);
      const oldWallet = await connect(relay.port);
      const closer = await connect(relay.port);
      await joinChannel(switchingDapp, 'switch-old-tombstone', 'dapp');
      await joinChannel(oldWallet, 'switch-old-tombstone', 'wallet');
      await joinChannel(closer, 'switch-dead', 'dapp');
      await new Promise((resolve) => {
        closer.emit('close_channel', { channelId: 'switch-dead' }, resolve);
      });

      const tombstone = await joinChannel(switchingDapp, 'switch-dead', 'dapp');
      expect(tombstone.success).to.equal(true);
      expect(tombstone.terminated).to.equal(true);

      const received = waitForEvent(oldWallet, 'message');
      const routed = await sendMessage(
        switchingDapp,
        'switch-old-tombstone',
        'old-channel-survived'
      );
      expect(routed.success).to.equal(true);
      expect((await received).message).to.equal('old-channel-survived');

      await disconnect(switchingDapp);
      await disconnect(oldWallet);
      await disconnect(closer);
    });

    it('emits one leave event after a successful channel switch', async () => {
      const dapp = await connect(relay.port);
      const oldWallet = await connect(relay.port);
      await joinChannel(dapp, 'switch-old-success', 'dapp');
      await joinChannel(oldWallet, 'switch-old-success', 'wallet');

      const notice = waitForEvent(oldWallet, 'participants_changed');
      const switched = await joinChannel(dapp, 'switch-new-success', 'dapp');

      expect(switched.success).to.equal(true);
      expect(await notice).to.deep.equal({ event: 'leave', clientType: 'dapp' });
      expect((await sendMessage(dapp, 'switch-old-success', 'must-not-route')).error).to.equal(
        'Sender not in channel'
      );

      await disconnect(dapp);
      await disconnect(oldWallet);
    });
  });

  // ── Leave channel ────────────────────────────────────────────────────

  describe('leave channel', () => {
    let relay;

    before(async () => {
      relay = await startRelay();
    });
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

    before(async () => {
      relay = await startRelay();
    });
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

    it('rate limits custom control events', async () => {
      const socket = await connect(relay.port);
      let response;
      for (let i = 0; i < 301; i++) {
        response = await new Promise((resolve) => socket.emit('ping', resolve));
      }
      expect(response.success).to.equal(false);
      expect(response.error).to.include('Control rate limit');
      await disconnect(socket);
    });
  });

  // ── Channel ID validation ────────────────────────────────────────────

  describe('channel ID validation', () => {
    let relay;

    before(async () => {
      relay = await startRelay();
    });
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

    before(async () => {
      relay = await startRelay();
    });
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

  // ── Malformed ack arguments ──────────────────────────────────────────
  // A client can emit with arbitrary data in the position where Socket.IO
  // would synthesize an ack callback. Calling that value blindly used to
  // throw a TypeError inside the handler and crash the process (remote DoS).

  describe('malformed ack arguments', () => {
    let relay;

    before(async () => {
      relay = await startRelay();
    });
    after(() => relay.cleanup());

    it('survives non-function ack slots on every wire event', async () => {
      const s = await connect(relay.port);

      // None of these request an ack; the junk value lands in the callback
      // parameter position server-side. Pre-fix, each one crashed the relay.
      s.emit('ping', 'junk');
      s.emit('join_channel', { channelId: 'ack-junk', clientType: 'dapp' }, 'junk');
      s.emit('message', { id: 'ack-junk', message: 'x' }, 42);
      s.emit('leave_channel', { channelId: 'ack-junk' }, { not: 'a function' });
      s.emit('close_channel', { channelId: 'ack-junk' }, null);

      // The relay must still be alive and serving acks afterwards.
      const resp = await new Promise((resolve) => {
        s.emit('ping', (data) => resolve(data));
      });
      expect(resp.type).to.equal('pong');
      await disconnect(s);
    });
  });

  describe('message canonicalization', () => {
    it('drops unrecognized payload fields before forwarding', async () => {
      const relay = await startRelay();
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      try {
        await joinChannel(dapp, 'canonical-msg', 'dapp');
        await joinChannel(wallet, 'canonical-msg', 'wallet');

        const receivedPromise = waitForEvent(wallet, 'message');
        const ackPromise = new Promise((resolve) => {
          dapp.emit(
            'message',
            {
              id: 'canonical-msg',
              clientType: 'dapp',
              message: 'ciphertext',
              seq: 7,
              attackerPadding: 'x'.repeat(100_000),
            },
            resolve
          );
        });

        expect((await ackPromise).success).to.be.true;
        expect(await receivedPromise).to.deep.equal({
          id: 'canonical-msg',
          clientType: 'dapp',
          message: 'ciphertext',
          seq: 7,
        });
      } finally {
        await disconnect(dapp);
        await disconnect(wallet);
        relay.cleanup();
      }
    });
  });

  describe('live egress budgets', () => {
    it('delivers back-to-back ACK and ORIGINATOR_INFO without disconnecting', async () => {
      const relay = await startRelay();
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      try {
        await joinChannel(dapp, 'handshake-burst', 'dapp');
        await joinChannel(wallet, 'handshake-burst', 'wallet');

        const received = [];
        const bothMessages = new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Timeout waiting for handshake burst')),
            2000
          );
          wallet.on('message', (message) => {
            received.push(message);
            if (received.length === 2) {
              clearTimeout(timer);
              resolve(received);
            }
          });
        });

        const [ackResult, originatorInfoResult] = await Promise.all([
          sendMessage(dapp, 'handshake-burst', { type: 'ACK' }),
          sendMessage(dapp, 'handshake-burst', { type: 'ORIGINATOR_INFO' }),
        ]);

        expect(ackResult.success).to.equal(true);
        expect(originatorInfoResult.success).to.equal(true);
        expect((await bothMessages).map((payload) => payload.message.type)).to.deep.equal([
          'ACK',
          'ORIGINATOR_INFO',
        ]);
        expect(wallet.connected).to.equal(true);
      } finally {
        await disconnect(dapp);
        await disconnect(wallet);
        relay.cleanup();
      }
    });

    it('bounds a stalled target and resumes buffered work on drain', async () => {
      const relay = await startRelay({
        RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL: 1800,
        RELAY_MAX_BUFFERED_BYTES_PER_IP: 1800,
        RELAY_MAX_BUFFERED_BYTES_GLOBAL: 1800,
      });
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      try {
        await joinChannel(dapp, 'live-egress-budget', 'dapp');
        await joinChannel(wallet, 'live-egress-budget', 'wallet');
        await new Promise((resolve) => setImmediate(resolve));

        const target = relay.io.sockets.sockets.get(wallet.id);
        const transport = target.conn.transport;
        const originalSend = transport.send;
        transport.send = function () {
          this.writable = false;
        };
        transport.writable = true;

        const payload = 'x'.repeat(700);
        const first = await sendMessage(dapp, 'live-egress-budget', payload);
        expect(first).to.deep.include({ success: true, buffered: false });

        const second = await sendMessage(dapp, 'live-egress-budget', `${payload}2`);
        expect(second).to.deep.include({ success: true, buffered: true });

        const rejected = await sendMessage(dapp, 'live-egress-budget', `${payload}3`);
        expect(rejected.success).to.equal(false);
        expect(rejected.error).to.include('capacity exceeded');

        const stats = relay.channelManager.getStats();
        expect(stats.totalDirectInflightBytes).to.be.greaterThan(0);
        expect(stats.totalBufferedMessages).to.equal(1);
        expect(stats.totalDirectInflightBytes + stats.totalBufferedBytes).to.be.at.most(1800);
        expect(target.conn.writeBuffer.length).to.equal(0);

        const resumed = waitForEvent(wallet, 'message');
        transport.send = originalSend;
        transport.emit('drain');
        transport.emit('ready');
        expect(relay.channelManager.getStats().totalBufferedMessages).to.equal(1);
        transport.writable = true;
        transport.emit('ready');

        expect((await resumed).message).to.equal(`${payload}2`);
        expect(wallet.connected).to.equal(true);
        expect(relay.channelManager.getStats().totalBufferedMessages).to.equal(0);
      } finally {
        await disconnect(dapp);
        await disconnect(wallet);
        relay.cleanup();
      }
    });

    it('disconnects an idle unwritable target so reconnect drains its buffer', async () => {
      const relay = await startRelay();
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      let replacement;
      try {
        await joinChannel(dapp, 'idle-backpressure', 'dapp');
        await joinChannel(wallet, 'idle-backpressure', 'wallet');
        await new Promise((resolve) => setImmediate(resolve));

        const target = relay.io.sockets.sockets.get(wallet.id);
        target.conn.transport.writable = false;
        const disconnected = waitForEvent(target, 'disconnect');

        const result = await sendMessage(dapp, 'idle-backpressure', 'queued-ciphertext');
        expect(result).to.deep.include({ success: true, buffered: true });
        await disconnected;

        replacement = await connect(relay.port);
        const rejoined = await joinChannel(replacement, 'idle-backpressure', 'wallet');
        expect(rejoined.success).to.equal(true);
        expect(rejoined.bufferedMessages).to.have.length(1);
        expect(rejoined.bufferedMessages[0].message).to.equal('queued-ciphertext');
      } finally {
        await disconnect(dapp);
        await disconnect(wallet);
        if (replacement) await disconnect(replacement);
        relay.cleanup();
      }
    });

    it('does not traverse every channel after each routed message', async () => {
      const relay = await startRelay();
      const dapp = await connect(relay.port);
      const wallet = await connect(relay.port);
      try {
        await joinChannel(dapp, 'metrics-cost', 'dapp');
        await joinChannel(wallet, 'metrics-cost', 'wallet');

        const originalGetStats = relay.channelManager.getStats.bind(relay.channelManager);
        const originalGetActive = relay.channelManager.getActiveChannelCount.bind(
          relay.channelManager
        );
        let traversals = 0;
        relay.channelManager.getStats = () => {
          traversals += 1;
          return originalGetStats();
        };
        relay.channelManager.getActiveChannelCount = () => {
          traversals += 1;
          return originalGetActive();
        };

        const received = waitForEvent(wallet, 'message');
        expect((await sendMessage(dapp, 'metrics-cost', 'ciphertext')).success).to.equal(true);
        await received;
        expect(traversals).to.equal(0);
      } finally {
        await disconnect(dapp);
        await disconnect(wallet);
        relay.cleanup();
      }
    });
  });

  // ── Participant roster + terminated tombstone ────────────────────────

  describe('roster and tombstone', () => {
    let relay;

    before(async () => {
      relay = await startRelay();
    });
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

    it('does not park a socket or emit a phantom join when re-joining a tombstone', async () => {
      const dapp = await connect(relay.port);
      await joinChannel(dapp, 'tombstone-quiet', 'dapp');
      await new Promise((resolve) => {
        dapp.emit('close_channel', { channelId: 'tombstone-quiet' }, () => resolve());
      });
      await disconnect(dapp);

      // First re-joiner lands on the tombstone. It must NOT be placed in the
      // Socket.IO room, so it cannot hear a later re-joiner "arrive".
      const a = await connect(relay.port);
      const respA = await joinChannel(a, 'tombstone-quiet', 'dapp');
      expect(respA.terminated).to.be.true;

      let phantom = null;
      a.on('participants_changed', (data) => {
        phantom = data;
      });

      // Second re-joiner. Pre-fix, both sockets sat in the dead room and `a`
      // would receive a spurious { event: 'join' }.
      const b = await connect(relay.port);
      const respB = await joinChannel(b, 'tombstone-quiet', 'wallet');
      expect(respB.terminated).to.be.true;

      // Give any (incorrect) emit a chance to land before asserting silence.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(phantom, 'tombstone re-join must not emit a presence event').to.equal(null);

      await disconnect(a);
      await disconnect(b);
    });
  });

  // ── ChannelManager unit: tombstone memory hygiene ────────────────────

  describe('ChannelManager tombstones', () => {
    it('does not allocate a channel for an invalid public key', () => {
      const cm = new ChannelManager();
      try {
        const result = cm.join('invalid-key-no-allocation', 'sock-a', 'dapp', 'not base64!');
        expect(result.success).to.equal(false);
        expect(cm.getChannelInfo('invalid-key-no-allocation')).to.equal(null);
      } finally {
        cm.destroy();
      }
    });

    it('close() clears heavy channel state but keeps the tombstone flag', () => {
      const cm = new ChannelManager();
      try {
        // dApp joins (binding a PK) with no counterparty yet, so a routed
        // message has nowhere to go and is buffered.
        cm.join('unit-close', 'sock-d', 'dapp', 'YQ==');
        const routed = cm.routeMessage('unit-close', 'sock-d', {
          id: 'unit-close',
          clientType: 'dapp',
          message: 'x',
          seq: 0,
        });
        expect(routed.buffered).to.be.true;
        const before = cm.channels.get('unit-close');
        expect(before.messageBuffer.length).to.equal(1);
        expect(before.participants.size).to.equal(1);
        expect(before.seqNumbers.size).to.equal(1);
        expect(before.publicKey).to.equal('YQ==');

        cm.close('unit-close');

        const after = cm.channels.get('unit-close');
        expect(after.terminated).to.be.true;
        expect(after.participants.size).to.equal(0);
        expect(after.seqNumbers.size).to.equal(0);
        expect(after.messageBuffer.length).to.equal(0);
        expect(after.publicKey).to.equal(null);
        // Tombstone is excluded from the active-channel admission count.
        expect(cm.getActiveChannelCount()).to.equal(0);
        // ... and routing through it is refused.
        expect(
          cm.routeMessage('unit-close', 'sock-d', {
            id: 'unit-close',
            clientType: 'dapp',
            message: 'y',
            seq: 1,
          }).error
        ).to.equal('Channel terminated');
      } finally {
        clearInterval(cm.cleanupTimer);
      }
    });

    it('close() is idempotent and a tombstone re-join parks no participant', () => {
      const cm = new ChannelManager();
      try {
        cm.join('dup-ch', 'sock-a', 'dapp');
        cm.close('dup-ch');
        expect(cm.terminatedOrder.length).to.equal(1);
        // Idempotent: a second close (or a join->close loop on the same id)
        // must not push a duplicate FIFO entry that would flush real tombstones.
        cm.close('dup-ch');
        expect(cm.terminatedOrder.length).to.equal(1);
        // A re-join to the tombstone reports terminated and adds no participant.
        const rejoin = cm.join('dup-ch', 'sock-b', 'dapp');
        expect(rejoin.success).to.be.true;
        expect(rejoin.terminated).to.be.true;
        expect(cm.channels.get('dup-ch').participants.size).to.equal(0);
      } finally {
        clearInterval(cm.cleanupTimer);
      }
    });
  });

  describe('ChannelManager buffered-byte budgets', () => {
    const budgetKeys = [
      'RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL',
      'RELAY_MAX_BUFFERED_BYTES_PER_IP',
      'RELAY_MAX_BUFFERED_BYTES_GLOBAL',
    ];

    function withBudgets(overrides, fn) {
      const originals = {};
      for (const key of budgetKeys) originals[key] = CONFIG[key];
      Object.assign(CONFIG, overrides);
      try {
        fn();
      } finally {
        Object.assign(CONFIG, originals);
      }
    }

    it('enforces the per-channel byte cap and releases accounting on delivery', () => {
      const payload = {
        id: 'bytes-ch',
        clientType: 'dapp',
        message: 'x'.repeat(64),
      };
      const bytes = Buffer.byteLength(JSON.stringify(payload));

      withBudgets(
        {
          RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL: bytes,
          RELAY_MAX_BUFFERED_BYTES_PER_IP: bytes * 10,
          RELAY_MAX_BUFFERED_BYTES_GLOBAL: bytes * 10,
        },
        () => {
          const cm = new ChannelManager();
          try {
            cm.join('bytes-ch', 'dapp-socket', 'dapp');
            expect(cm.routeMessage('bytes-ch', 'dapp-socket', payload, '192.0.2.1').buffered).to.be
              .true;
            expect(cm.getStats().totalBufferedBytes).to.equal(bytes);

            const rejected = cm.routeMessage('bytes-ch', 'dapp-socket', payload, '192.0.2.1');
            expect(rejected.error).to.include('Channel buffered-byte');

            const walletJoin = cm.join('bytes-ch', 'wallet-socket', 'wallet');
            expect(walletJoin.success).to.be.true;
            expect(walletJoin.bufferedMessages).to.have.length(1);
            expect(cm.getStats().totalBufferedBytes).to.equal(0);
          } finally {
            cm.destroy();
          }
        }
      );
    });

    it('retains live-egress accounting until transport drain after a leave', () => {
      const cm = new ChannelManager({ canSocketReceive: () => true });
      try {
        cm.join('leave-inflight', 'dapp-socket', 'dapp');
        cm.join('leave-inflight', 'wallet-socket', 'wallet');
        const routed = cm.routeMessage(
          'leave-inflight',
          'dapp-socket',
          { id: 'leave-inflight', clientType: 'dapp', message: 'ciphertext' },
          '192.0.2.1'
        );
        expect(routed.targetSocketId).to.equal('wallet-socket');
        const reserved = cm.getStats().totalDirectInflightBytes;
        expect(reserved).to.be.greaterThan(0);

        cm.leave('wallet-socket', 'leave-inflight');
        expect(cm.getStats().totalDirectInflightBytes).to.equal(reserved);

        cm.releaseDirectDelivery('wallet-socket');
        expect(cm.getStats().totalDirectInflightBytes).to.equal(0);
      } finally {
        cm.destroy();
      }
    });

    it('moves one buffered message into the live reservation after each drain', () => {
      const cm = new ChannelManager({ canSocketReceive: () => true });
      try {
        cm.join('burst-accounting', 'dapp-socket', 'dapp');
        cm.join('burst-accounting', 'wallet-socket', 'wallet');
        const first = {
          id: 'burst-accounting',
          clientType: 'dapp',
          message: { type: 'ACK' },
        };
        const second = {
          id: 'burst-accounting',
          clientType: 'dapp',
          message: { type: 'ORIGINATOR_INFO' },
        };

        expect(cm.routeMessage('burst-accounting', 'dapp-socket', first).buffered).to.equal(false);
        expect(cm.routeMessage('burst-accounting', 'dapp-socket', second).buffered).to.equal(true);

        const retainedBefore = cm.getStats();
        expect(retainedBefore.totalDirectInflightBytes).to.be.greaterThan(0);
        expect(retainedBefore.totalBufferedBytes).to.be.greaterThan(0);

        expect(cm.advanceDirectDelivery('wallet-socket')).to.deep.equal(second);
        const retainedAfter = cm.getStats();
        expect(retainedAfter.totalBufferedMessages).to.equal(0);
        expect(retainedAfter.totalBufferedBytes).to.equal(0);
        expect(retainedAfter.totalDirectInflightBytes).to.equal(
          Buffer.byteLength(JSON.stringify(second))
        );

        cm.releaseDirectDelivery('wallet-socket');
        expect(cm.getStats().totalDirectInflightBytes).to.equal(0);
      } finally {
        cm.destroy();
      }
    });

    it('enforces per-IP and global buffered-byte caps across channels', () => {
      const first = { id: 'budget-a', clientType: 'dapp', message: 'x'.repeat(32) };
      const second = { id: 'budget-b', clientType: 'dapp', message: 'x'.repeat(32) };
      const bytes = Buffer.byteLength(JSON.stringify(first));

      withBudgets(
        {
          RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL: bytes * 10,
          RELAY_MAX_BUFFERED_BYTES_PER_IP: bytes,
          RELAY_MAX_BUFFERED_BYTES_GLOBAL: bytes * 10,
        },
        () => {
          const cm = new ChannelManager();
          try {
            cm.join('budget-a', 'socket-a', 'dapp');
            cm.join('budget-b', 'socket-b', 'dapp');
            expect(cm.routeMessage('budget-a', 'socket-a', first, '192.0.2.1').buffered).to.be.true;
            expect(cm.routeMessage('budget-b', 'socket-b', second, '192.0.2.1').error).to.include(
              'Per-IP buffered-byte'
            );
          } finally {
            cm.destroy();
          }
        }
      );

      withBudgets(
        {
          RELAY_MAX_BUFFERED_BYTES_PER_CHANNEL: bytes * 10,
          RELAY_MAX_BUFFERED_BYTES_PER_IP: bytes * 10,
          RELAY_MAX_BUFFERED_BYTES_GLOBAL: bytes,
        },
        () => {
          const cm = new ChannelManager();
          try {
            cm.join('budget-a', 'socket-a', 'dapp');
            cm.join('budget-b', 'socket-b', 'dapp');
            expect(cm.routeMessage('budget-a', 'socket-a', first, '192.0.2.1').buffered).to.be.true;
            expect(cm.routeMessage('budget-b', 'socket-b', second, '192.0.2.2').error).to.include(
              'Global buffered-byte'
            );
          } finally {
            cm.destroy();
          }
        }
      );
    });
  });
});
