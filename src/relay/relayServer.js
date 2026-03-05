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

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 100; // per window per IP
const RATE_LIMIT_MAX_JOINS = 30; // per window per IP
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

  const allowedOrigins = new Set(CONFIG.ALLOWED_ORIGINS);
  const allowAllOrigins = CONFIG.NODE_ENV !== 'production' && allowedOrigins.size === 0;

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin || allowAllOrigins || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed by relay CORS policy'));
      },
      methods: ['GET', 'POST'],
    },
    path: '/relay',
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
  });

  /**
   * Check a named rate limit bucket for an IP address.
   * @param {string} ip
   * @param {'message'|'join'} bucket
   * @param {number} limit
   * @returns {boolean} true if allowed
   */
  function checkRateLimit(ip, bucket, limit) {
    const now = Date.now();
    let entry = rateLimits.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { counts: { message: 0, join: 0 }, resetAt: now + RATE_LIMIT_WINDOW_MS };
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
    const ip = socket.handshake.address;

    let currentChannelId = null;

    /**
     * join_channel - Join or create a channel room.
     * Payload: { channelId: string, clientType: 'dapp' | 'wallet' }
     */
    socket.on('join_channel', (payload, callback) => {
      if (!checkRateLimit(ip, 'join', RATE_LIMIT_MAX_JOINS)) {
        return callback?.({ success: false, error: 'Join rate limit exceeded' });
      }

      const { channelId, clientType } = payload || {};

      if (!isValidChannelId(channelId)) {
        return callback?.({ success: false, error: 'Invalid channelId' });
      }

      if (clientType !== 'dapp' && clientType !== 'wallet') {
        return callback?.({
          success: false,
          error: 'clientType must be "dapp" or "wallet"',
        });
      }

      // Leave previous channel if any
      if (currentChannelId && currentChannelId !== channelId) {
        socket.leave(currentChannelId);
        channelManager.leave(socket.id, currentChannelId);
      }

      const result = channelManager.join(channelId, socket.id, clientType);

      if (!result.success) {
        return callback?.({ success: false, error: result.error });
      }

      socket.join(channelId);
      currentChannelId = channelId;

      // Notify other participant that counterparty joined
      socket.to(channelId).emit('participants_changed', {
        event: 'join',
        clientType,
      });

      callback?.({
        success: true,
        bufferedMessages: result.bufferedMessages || [],
      });
    });

    /**
     * message - Route an encrypted message to the counterparty.
     * Payload: { id: channelId, message: encryptedData, clientType: string }
     */
    socket.on('message', (payload, callback) => {
      if (!checkRateLimit(ip, 'message', RATE_LIMIT_MAX_MESSAGES)) {
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
      }

      callback?.({ success: true, buffered: result.buffered });
    });

    /**
     * leave_channel - Explicitly leave a channel.
     */
    socket.on('leave_channel', (payload, callback) => {
      const channelId = payload?.channelId || currentChannelId;

      if (channelId) {
        socket.leave(channelId);
        const participant = channelManager.leave(socket.id, channelId);

        // Notify other participant
        socket.to(channelId).emit('participants_changed', {
          event: 'leave',
          clientType: participant?.clientType || null,
        });

        if (currentChannelId === channelId) {
          currentChannelId = null;
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
      if (currentChannelId) {
        const participant = channelManager.leave(socket.id, currentChannelId);

        // Notify remaining participant
        socket.to(currentChannelId).emit('participants_changed', {
          event: 'disconnect',
          clientType: participant?.clientType || null,
        });
      }
    });
  });

  // Expose stats endpoint for health checks
  io.channelManager = channelManager;
  io.destroy = () => {
    if (rateLimitCleanupTimer) {
      clearInterval(rateLimitCleanupTimer);
    }
    channelManager.destroy();
    io.removeAllListeners();
  };

  return io;
}
