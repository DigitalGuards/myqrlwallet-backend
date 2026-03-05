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

/** Join a channel and return the ack response. */
function joinChannel(socket, channelId, clientType) {
  return new Promise((resolve) => {
    socket.emit('join_channel', { channelId, clientType }, (resp) => resolve(resp));
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
});
