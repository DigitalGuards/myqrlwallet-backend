/**
 * Relay Server - Socket.IO configuration and event handlers for
 * the QRL Connect dApp-to-wallet protocol.
 *
 * Stateless message routing between channel rooms.
 * All messages are E2E encrypted (ECIES) - relay sees only ciphertext.
 */

import { Server } from 'socket.io';
import { ChannelManager } from './channelManager.js';
import { CONFIG } from '../config/index.js';
import * as metrics from './metrics.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 100; // per window per IP
const RATE_LIMIT_MAX_JOINS = 30; // per window per IP
const RATE_LIMIT_MAX_CONNECTIONS = 60; // new connections per window per IP
const MAX_CHANNEL_ID_LENGTH = 128;
const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_MESSAGE_BYTES = 256 * 1024;

/**
 * Validate channel identifiers to avoid unbounded relay state growth.
 * @param {unknown} channelId
 * @returns {boolean}
 */
function isValidChannelId(channelId) {
  return (
    typeof channelId === 'string' &&
    channelId.length > 0 &&
    channelId.length <= MAX_CHANNEL_ID_LENGTH &&
    CHANNEL_ID_PATTERN.test(channelId)
  );
}

/**
 * Attach Socket.IO relay to an HTTP server.
 * @param {import('http').Server} httpServer
 * @returns {Server} Socket.IO server instance
 */
export function createRelayServer(httpServer) {
  /** @type {Server|undefined} */
  let io;
  const channelManager = new ChannelManager({
    isSocketActive: (socketId) => io?.sockets?.sockets?.has(socketId) ?? false,
  });

  /** @type {Map<string, { counts: Record<string, number>, resetAt: number }>} */
  const rateLimits = new Map();
  /** @type {Map<string, number>} */
  const activeSocketsByIp = new Map();

  io = new Server(httpServer, {
    cors: {
      // Relay allows all origins — it only routes E2E encrypted ciphertext
      // and any dApp in the world should be able to connect.
      origin: true,
      methods: ['GET', 'POST'],
    },
    path: '/relay',
    transports: ['websocket', 'polling'],
    // Tunable keepalive cadence. Some client network paths (observed:
    // mobile WebView traffic, likely via iCloud Private Relay or an
    // idle-reaping middlebox) kill websockets after ~5s without traffic;
    // device diagnostics showed connections dying at aliveMs ~5.2-5.4s
    // like clockwork. A pingInterval below the reap threshold keeps the
    // socket alive at the cost of a 2-byte frame per interval.
    pingInterval: parseInt(process.env.RELAY_PING_INTERVAL_MS || '25000', 10),
    pingTimeout: parseInt(process.env.RELAY_PING_TIMEOUT_MS || '20000', 10),
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
  });

  /**
   * Check a named rate limit bucket for an IP address.
   * @param {string} ip
   * @param {'connect'|'message'|'join'} bucket
   * @param {number} limit
   * @returns {boolean} true if allowed
   */
  function checkRateLimit(ip, bucket, limit) {
    const now = Date.now();
    let entry = rateLimits.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { counts: { connect: 0, message: 0, join: 0 }, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateLimits.set(ip, entry);
    }

    entry.counts[bucket] = (entry.counts[bucket] || 0) + 1;
    return entry.counts[bucket] <= limit;
  }

  /**
   * Approximate message payload size for memory-DoS protection.
   * @param {unknown} message
   * @returns {number}
   */
  function getMessageSizeBytes(message) {
    try {
      if (typeof message === 'string') {
        return Buffer.byteLength(message, 'utf8');
      }
      if (typeof message === 'object' && message !== null) {
        return Buffer.byteLength(JSON.stringify(message), 'utf8');
      }
      return 0;
    } catch {
      return MAX_MESSAGE_BYTES + 1;
    }
  }

  /**
   * Normalize a client IP string from proxy/socket metadata.
   * @param {unknown} rawIp
   * @returns {string}
   */
  function normalizeClientIp(rawIp) {
    if (typeof rawIp !== 'string') return '';
    const trimmed = rawIp.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('::ffff:')) {
      return trimmed.slice('::ffff:'.length);
    }
    return trimmed;
  }

  /**
   * Resolve client IP for rate limiting across direct and proxied setups.
   * @param {import('socket.io').Socket} socket
   * @returns {string}
   */
  function getClientIp(socket) {
    const headers = socket.handshake.headers || {};
    const xff = headers['x-forwarded-for'];
    const forwardedFor =
      typeof xff === 'string' ? xff.split(',')[0] : Array.isArray(xff) ? xff[0] : '';

    const candidates = [
      headers['cf-connecting-ip'],
      headers['true-client-ip'],
      headers['x-real-ip'],
      forwardedFor,
      socket.handshake.address,
      socket.conn?.remoteAddress,
    ];

    for (const candidate of candidates) {
      const normalized = normalizeClientIp(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return 'unknown';
  }

  // Cleanup rate limit entries periodically
  const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
      if (now > entry.resetAt) {
        rateLimits.delete(ip);
      }
    }
  }, RATE_LIMIT_WINDOW_MS);

  io.on('connection', (socket) => {
    const clientIp = getClientIp(socket);

    if (!checkRateLimit(clientIp, 'connect', RATE_LIMIT_MAX_CONNECTIONS)) {
      metrics.rateLimitHits.inc({ bucket: 'connect' });
      socket.disconnect(true);
      return;
    }

    const activeForIp = (activeSocketsByIp.get(clientIp) || 0) + 1;
    activeSocketsByIp.set(clientIp, activeForIp);
    if (activeForIp > CONFIG.RELAY_MAX_SOCKETS_PER_IP) {
      activeSocketsByIp.set(clientIp, activeForIp - 1);
      if (activeForIp - 1 <= 0) {
        activeSocketsByIp.delete(clientIp);
      }
      metrics.rateLimitHits.inc({ bucket: 'per_ip_cap' });
      socket.disconnect(true);
      return;
    }
    if (io.engine.clientsCount > CONFIG.RELAY_MAX_ACTIVE_SOCKETS) {
      const updatedCount = (activeSocketsByIp.get(clientIp) || 1) - 1;
      if (updatedCount > 0) {
        activeSocketsByIp.set(clientIp, updatedCount);
      } else {
        activeSocketsByIp.delete(clientIp);
      }
      metrics.rateLimitHits.inc({ bucket: 'global_cap' });
      socket.disconnect(true);
      return;
    }

    metrics.connectionsTotal.inc();
    metrics.activeSockets.inc();
    let currentChannelId = null;
    let releasedSocketCounter = false;

    const releaseSocketCounter = () => {
      if (releasedSocketCounter) {
        return;
      }
      releasedSocketCounter = true;
      const count = activeSocketsByIp.get(clientIp) || 0;
      if (count <= 1) {
        activeSocketsByIp.delete(clientIp);
      } else {
        activeSocketsByIp.set(clientIp, count - 1);
      }
    };

    /**
     * join_channel - Join or create a channel room.
     * Payload:
     *   { channelId: string, clientType: 'dapp' | 'wallet', publicKey?: string }
     * `publicKey` is only honoured for the first dApp join (v2 protocol).
     * The relay binds it to the channel and echoes it back to the wallet
     * on its join so the wallet can verify the fingerprint from the QR.
     */
    socket.on('join_channel', (payload, callback) => {
      if (!checkRateLimit(clientIp, 'join', RATE_LIMIT_MAX_JOINS)) {
        metrics.rateLimitHits.inc({ bucket: 'join' });
        return callback?.({ success: false, error: 'Join rate limit exceeded' });
      }

      const { channelId, clientType, publicKey } = payload || {};

      if (!isValidChannelId(channelId)) {
        return callback?.({ success: false, error: 'Invalid channelId' });
      }
      if (
        !channelManager.getChannelInfo(channelId) &&
        channelManager.getActiveChannelCount() >= CONFIG.RELAY_MAX_ACTIVE_CHANNELS
      ) {
        return callback?.({ success: false, error: 'Relay channel capacity reached' });
      }

      if (clientType !== 'dapp' && clientType !== 'wallet') {
        return callback?.({
          success: false,
          error: 'clientType must be "dapp" or "wallet"',
        });
      }

      if (publicKey !== undefined && typeof publicKey !== 'string') {
        return callback?.({ success: false, error: 'publicKey must be a base64 string' });
      }

      // Leave previous channel if any
      if (currentChannelId && currentChannelId !== channelId) {
        socket.leave(currentChannelId);
        channelManager.leave(socket.id, currentChannelId);
      }

      const result = channelManager.join(channelId, socket.id, clientType, publicKey);

      if (!result.success) {
        return callback?.({ success: false, error: result.error });
      }

      // Re-join to an explicitly closed (tombstoned) channel: report the
      // tombstone so the peer drops its stored session, but do NOT park the
      // socket in the dead room, point currentChannelId at it, or emit a
      // phantom 'join'. channelManager.join() added no participant for a
      // terminated channel and routing is refused there, so joining the room
      // would only leak a spurious presence event to other re-joiners.
      if (result.terminated) {
        return callback?.({
          success: true,
          terminated: true,
          participants: [],
          channelPublicKey: null,
          bufferedMessages: [],
        });
      }

      socket.join(channelId);
      metrics.channelJoins.inc({ status: 'success' });
      metrics.activeChannels.set(channelManager.getActiveChannelCount());
      currentChannelId = channelId;

      // Notify other participant that counterparty joined
      socket.to(channelId).emit('participants_changed', {
        event: 'join',
        clientType,
      });

      callback?.({
        success: true,
        bufferedMessages: result.bufferedMessages || [],
        channelPublicKey: result.channelPublicKey || null,
        // Counterparty roster so a (re)joining peer can detect an absent
        // wallet immediately; `terminated` flags a channel that was closed
        // on purpose so the peer drops its stored session instead of waiting.
        participants: result.participants || [],
        terminated: result.terminated || false,
      });
    });

    /**
     * message - Route an encrypted message to the counterparty.
     * Payload: { id: channelId, message: encryptedData, clientType: string }
     */
    socket.on('message', (payload, callback) => {
      if (!checkRateLimit(clientIp, 'message', RATE_LIMIT_MAX_MESSAGES)) {
        metrics.rateLimitHits.inc({ bucket: 'message' });
        return callback?.({ success: false, error: 'Rate limit exceeded' });
      }

      const { id: channelId, message } = payload || {};

      if (!isValidChannelId(channelId) || !message) {
        return callback?.({ success: false, error: 'Invalid channelId or missing message' });
      }
      if (getMessageSizeBytes(message) > MAX_MESSAGE_BYTES) {
        return callback?.({ success: false, error: 'Message payload too large' });
      }

      const result = channelManager.routeMessage(channelId, socket.id, payload);

      if (result.error) {
        return callback?.({ success: false, error: result.error });
      }

      if (result.targetSocketId) {
        // Deliver directly to counterparty
        io.to(result.targetSocketId).emit('message', payload);
        metrics.messagesRouted.inc({ status: 'delivered' });
        metrics.messageSize.observe(getMessageSizeBytes(message));
      }

      callback?.({ success: true, buffered: result.buffered });
      if (result.buffered) {
        metrics.messagesRouted.inc({ status: 'buffered' });
      }
    });

    /**
     * leave_channel - Explicitly leave a channel.
     */
    socket.on('leave_channel', (payload, callback) => {
      const channelId = payload?.channelId || currentChannelId;

      if (channelId) {
        socket.leave(channelId);
        const participant = channelManager.leave(socket.id, channelId);

        // Only notify when this socket was actually a participant; a leave for
        // a channel we never joined (or a tombstone) must not emit a phantom
        // presence event with clientType:null.
        if (participant) {
          socket.to(channelId).emit('participants_changed', {
            event: 'leave',
            clientType: participant.clientType,
          });
        }

        if (currentChannelId === channelId) {
          currentChannelId = null;
        }
      }

      callback?.({ success: true });
    });

    /**
     * close_channel - Explicitly terminate a channel (an intentional
     * disconnect / "forget", as opposed to a transient socket drop on
     * backgrounding). Marks a durable tombstone so the counterparty learns
     * the session is dead even if it is absent now and re-joins later.
     */
    socket.on('close_channel', (payload, callback) => {
      const channelId = payload?.channelId || currentChannelId;

      if (isValidChannelId(channelId)) {
        // Authorize: only an actual participant may terminate the channel.
        // leave() returns the participant record (and null if this socket is
        // not in the channel), so it doubles as the membership check. This
        // blocks an attacker from closing arbitrary channels by guessing a
        // channelId, and from creating tombstones for channels they were
        // never part of (the close() below only marks an existing channel).
        socket.leave(channelId);
        const participant = channelManager.leave(socket.id, channelId);

        if (participant) {
          channelManager.close(channelId);

          // Tell a currently-connected counterparty this was an explicit
          // close, distinct from a transient 'disconnect'.
          socket.to(channelId).emit('participants_changed', {
            event: 'close',
            clientType: participant.clientType,
          });

          if (currentChannelId === channelId) {
            currentChannelId = null;
          }
        }
      }

      callback?.({ success: true });
    });

    /**
     * ping - Simple connectivity check.
     */
    socket.on('ping', (callback) => {
      callback?.({ type: 'pong', timestamp: Date.now() });
    });

    /**
     * Handle disconnection - clean up channel membership.
     */
    socket.on('disconnect', () => {
      metrics.activeSockets.dec();
      releaseSocketCounter();
      if (currentChannelId) {
        const participant = channelManager.leave(socket.id, currentChannelId);

        // Only notify when this socket was actually a participant (a transient
        // socket that never fully joined, or one parked on a tombstone, has no
        // record); avoids a phantom disconnect event with clientType:null.
        if (participant) {
          socket.to(currentChannelId).emit('participants_changed', {
            event: 'disconnect',
            clientType: participant.clientType,
          });
        }
      }
    });
  });

  // Expose stats endpoint for health checks
  io.channelManager = channelManager;
  io.destroy = () => {
    if (rateLimitCleanupTimer) {
      clearInterval(rateLimitCleanupTimer);
    }
    activeSocketsByIp.clear();
    rateLimits.clear();
    channelManager.destroy();
    io.removeAllListeners();
  };

  return io;
}
