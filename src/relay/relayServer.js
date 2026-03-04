/**
 * Relay Server - Socket.IO configuration and event handlers for
 * the QRL Connect dApp-to-wallet protocol.
 *
 * Stateless message routing between channel rooms.
 * All messages are E2E encrypted (ECIES) - relay sees only ciphertext.
 */

import { Server } from 'socket.io';
import { ChannelManager } from './channelManager.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 100; // per window per IP
const MAX_CHANNEL_ID_LENGTH = 128;
const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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
  const channelManager = new ChannelManager();

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const rateLimits = new Map();

  const io = new Server(httpServer, {
    cors: {
      origin: '*', // Messages are E2E encrypted
      methods: ['GET', 'POST'],
    },
    path: '/relay',
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  /**
   * Check rate limit for an IP address.
   * @param {string} ip
   * @returns {boolean} true if allowed
   */
  function checkRateLimit(ip) {
    const now = Date.now();
    let entry = rateLimits.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateLimits.set(ip, entry);
    }

    entry.count++;
    return entry.count <= RATE_LIMIT_MAX_MESSAGES;
  }

  // Cleanup rate limit entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
      if (now > entry.resetAt) {
        rateLimits.delete(ip);
      }
    }
  }, RATE_LIMIT_WINDOW_MS);

  io.on('connection', (socket) => {
    const ip =
      socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      socket.handshake.address;

    let currentChannelId = null;

    /**
     * join_channel - Join or create a channel room.
     * Payload: { channelId: string, clientType: 'dapp' | 'wallet' }
     */
    socket.on('join_channel', (payload, callback) => {
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
      if (!checkRateLimit(ip)) {
        return callback?.({ success: false, error: 'Rate limit exceeded' });
      }

      const { id: channelId, message, clientType } = payload || {};

      if (!isValidChannelId(channelId) || !message) {
        return callback?.({ success: false, error: 'Invalid channelId or missing message' });
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
        channelManager.leave(socket.id, channelId);

        // Notify other participant
        socket.to(channelId).emit('participants_changed', {
          event: 'leave',
          clientType: null,
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
        channelManager.leave(socket.id, currentChannelId);

        // Notify remaining participant
        socket.to(currentChannelId).emit('participants_changed', {
          event: 'disconnect',
        });
      }
    });
  });

  // Expose stats endpoint for health checks
  io.channelManager = channelManager;

  return io;
}
