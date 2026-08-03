/**
 * Relay Server - Socket.IO configuration and event handlers for
 * the QRL Connect dApp-to-wallet protocol.
 *
 * Stateless message routing between channel rooms.
 * All messages are E2E encrypted (ML-KEM-768 + AES-256-GCM, QRL Connect v2);
 * the relay sees only ciphertext.
 */

import type { Server as HttpServer } from 'node:http';
import type { Transport } from 'engine.io';
import { Server } from 'socket.io';
import {
  ChannelManager,
  isClientType,
  type ClientType,
  type RelayPayload,
} from './channelManager.js';
import { CONFIG } from '../config/index.js';
import { getTrustedClientIp, normalizeClientIpForLimits } from '../utils/client-ip.js';
import { isRecord } from '../utils/guards.js';
import * as metrics from './metrics.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 100; // per window per IP
const RATE_LIMIT_MAX_JOINS = 30; // per window per IP
const RATE_LIMIT_MAX_CONNECTIONS = 60; // new connections per window per IP
const RATE_LIMIT_MAX_CONTROL_EVENTS = 300; // ping/leave/close per window per IP
const MAX_CHANNEL_ID_LENGTH = 128;
const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_MESSAGE_BYTES = 256 * 1024;

interface ParticipantsChange {
  event: 'join' | 'leave' | 'close' | 'disconnect';
  clientType: ClientType;
}

/**
 * Wire events. Payloads and ack callbacks arrive from untrusted clients, so
 * both are typed unknown and narrowed at runtime; emits are fully typed.
 */
interface ClientToServerEvents {
  join_channel: (payload: unknown, callback: unknown) => void;
  message: (payload: unknown, callback: unknown) => void;
  leave_channel: (payload: unknown, callback: unknown) => void;
  close_channel: (payload: unknown, callback: unknown) => void;
  ping: (callback: unknown) => void;
}

interface ServerToClientEvents {
  message: (payload: unknown) => void;
  participants_changed: (change: ParticipantsChange) => void;
}

export type RelayServer = Server<ClientToServerEvents, ServerToClientEvents>;

export interface RelayHandle {
  io: RelayServer;
  channelManager: ChannelManager;
  destroy: () => void;
}

type Ack = (response: Record<string, unknown>) => void;

/**
 * Narrow a client-supplied ack slot to a callable, or undefined. Socket.IO
 * only synthesizes a function here when the client actually requested an
 * ack; a malicious client can instead place an arbitrary value in the last
 * argument position. Calling that value blindly (the old `callback?.(...)`)
 * threw a TypeError inside the handler, which escapes Socket.IO's dispatch
 * and crashes the process: a one-line remote DoS.
 */
function toAck(value: unknown): Ack | undefined {
  if (typeof value !== 'function') return undefined;
  return (response) => {
    Reflect.apply(value, undefined, [response]);
  };
}

/**
 * Validate channel identifiers to avoid unbounded relay state growth.
 */
function isValidChannelId(channelId: unknown): channelId is string {
  return (
    typeof channelId === 'string' &&
    channelId.length > 0 &&
    channelId.length <= MAX_CHANNEL_ID_LENGTH &&
    CHANNEL_ID_PATTERN.test(channelId)
  );
}

/**
 * Attach Socket.IO relay to an HTTP server.
 */
export function createRelayServer(httpServer: HttpServer): RelayHandle {
  const io: RelayServer = new Server(httpServer, {
    cors: {
      // Relay allows all origins: it only routes E2E encrypted ciphertext
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
    pingInterval: CONFIG.RELAY_PING_INTERVAL_MS,
    pingTimeout: CONFIG.RELAY_PING_TIMEOUT_MS,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
  });

  const directTransportListeners = new Map<
    string,
    { transport: Transport; event: 'drain' | 'ready'; listener: () => void }
  >();

  const channelManager = new ChannelManager({
    isSocketActive: (socketId) => io.sockets.sockets.has(socketId),
    canSocketReceive: (socketId) => {
      const target = io.sockets.sockets.get(socketId);
      return (
        target?.connected === true &&
        target.conn.readyState === 'open' &&
        target.conn.transport.writable &&
        !directTransportListeners.has(socketId)
      );
    },
  });

  function releaseDirectDelivery(socketId: string): void {
    const armed = directTransportListeners.get(socketId);
    if (armed) {
      armed.transport.removeListener(armed.event, armed.listener);
      directTransportListeners.delete(socketId);
    }
    channelManager.releaseDirectDelivery(socketId);
  }

  function waitForDirectReady(socketId: string, transport: Transport): void {
    const onReady = (): void => {
      directTransportListeners.delete(socketId);
      const target = io.sockets.sockets.get(socketId);
      if (!target?.connected || target.conn.readyState !== 'open') {
        channelManager.releaseDirectDelivery(socketId);
        return;
      }

      // Engine.IO's own ready listener runs first and can consume the newly
      // writable transport for an existing control packet. Wait for its next
      // ready cycle while the relay's reservation remains fully accounted.
      if (!target.conn.transport.writable) {
        waitForDirectReady(socketId, target.conn.transport);
        return;
      }

      // Arm the next drain before moving an accepted buffered message into
      // the single direct reservation. All checks and the promotion happen in
      // one synchronous turn, so a failed arm leaves the message buffered for
      // reconnect.
      if (!armDirectDelivery(socketId)) {
        channelManager.releaseDirectDelivery(socketId);
        target.disconnect(true);
        return;
      }

      const nextPayload = channelManager.advanceDirectDelivery(socketId);
      if (!nextPayload) {
        releaseDirectDelivery(socketId);
        return;
      }

      target.volatile.emit('message', nextPayload);
    };
    directTransportListeners.set(socketId, { transport, event: 'ready', listener: onReady });
    transport.once('ready', onReady);
  }

  function armDirectDelivery(socketId: string): boolean {
    const target = io.sockets.sockets.get(socketId);
    if (!target?.connected || target.conn.readyState !== 'open') return false;
    const transport = target.conn.transport;
    if (!transport.writable || directTransportListeners.has(socketId)) return false;

    const onDrain = (): void => {
      directTransportListeners.delete(socketId);

      // Engine.IO emits drain before making websocket and WebTransport
      // writable again. Polling also waits for the next poll request. Keep the
      // completed reservation accounted until that transport emits ready.
      waitForDirectReady(socketId, transport);
    };
    directTransportListeners.set(socketId, { transport, event: 'drain', listener: onDrain });
    transport.once('drain', onDrain);
    return true;
  }

  interface RateLimitEntry {
    counts: { connect: number; message: number; join: number; control: number };
    resetAt: number;
  }
  const rateLimits = new Map<string, RateLimitEntry>();
  const activeSocketsByIp = new Map<string, number>();

  /**
   * Check a named rate limit bucket for an IP address. Returns true if allowed.
   */
  function checkRateLimit(
    ip: string,
    bucket: keyof RateLimitEntry['counts'],
    limit: number
  ): boolean {
    const now = Date.now();
    let entry = rateLimits.get(ip);

    if (!entry || now > entry.resetAt) {
      entry = {
        counts: { connect: 0, message: 0, join: 0, control: 0 },
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      };
      rateLimits.set(ip, entry);
    }

    entry.counts[bucket] += 1;
    return entry.counts[bucket] <= limit;
  }

  /**
   * Approximate message payload size for memory-DoS protection.
   */
  function getMessageSizeBytes(message: unknown): number {
    try {
      const serialized = JSON.stringify(message);
      return typeof serialized === 'string'
        ? Buffer.byteLength(serialized, 'utf8')
        : MAX_MESSAGE_BYTES + 1;
    } catch {
      return MAX_MESSAGE_BYTES + 1;
    }
  }

  function refreshBufferMetrics(): void {
    const stats = channelManager.getStats();
    metrics.activeChannels.set(channelManager.getActiveChannelCount());
    metrics.bufferedMessages.set(stats.totalBufferedMessages);
    metrics.bufferedBytes.set(stats.totalBufferedBytes);
    metrics.directInflightBytes.set(stats.totalDirectInflightBytes);
  }

  // Cleanup rate limit entries periodically
  const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
      if (now > entry.resetAt) {
        rateLimits.delete(ip);
      }
    }
    refreshBufferMetrics();
  }, RATE_LIMIT_WINDOW_MS);

  io.on('connection', (socket) => {
    const clientIp = normalizeClientIpForLimits(getTrustedClientIp(socket.request));

    if (!checkRateLimit(clientIp, 'connect', RATE_LIMIT_MAX_CONNECTIONS)) {
      metrics.rateLimitHits.inc({ bucket: 'connect' });
      socket.disconnect(true);
      return;
    }

    const activeForIp = (activeSocketsByIp.get(clientIp) ?? 0) + 1;
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
      const updatedCount = (activeSocketsByIp.get(clientIp) ?? 1) - 1;
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
    let currentChannelId: string | null = null;
    let releasedSocketCounter = false;
    let joinInProgress = false;

    const releaseSocketCounter = (): void => {
      if (releasedSocketCounter) {
        return;
      }
      releasedSocketCounter = true;
      const count = activeSocketsByIp.get(clientIp) ?? 0;
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
    socket.on('join_channel', async (payload, rawCallback) => {
      const callback = toAck(rawCallback);
      if (joinInProgress) {
        callback?.({ success: false, error: 'Another channel join is in progress' });
        return;
      }
      joinInProgress = true;
      let joinedRoom = false;
      let joinedManager = false;
      let requestedChannelId: string | null = null;
      try {
        if (!checkRateLimit(clientIp, 'join', RATE_LIMIT_MAX_JOINS)) {
          metrics.rateLimitHits.inc({ bucket: 'join' });
          callback?.({ success: false, error: 'Join rate limit exceeded' });
          return;
        }

        const data = isRecord(payload) ? payload : {};
        const channelId = data.channelId;
        const clientType = data.clientType;
        const publicKey = data.publicKey;

        if (!isValidChannelId(channelId)) {
          callback?.({ success: false, error: 'Invalid channelId' });
          return;
        }
        requestedChannelId = channelId;
        if (
          !channelManager.getChannelInfo(channelId) &&
          channelManager.getActiveChannelCount() >= CONFIG.RELAY_MAX_ACTIVE_CHANNELS
        ) {
          callback?.({ success: false, error: 'Relay channel capacity reached' });
          return;
        }

        if (!isClientType(clientType)) {
          callback?.({
            success: false,
            error: 'clientType must be "dapp" or "wallet"',
          });
          return;
        }

        if (publicKey !== undefined && typeof publicKey !== 'string') {
          callback?.({ success: false, error: 'publicKey must be a base64 string' });
          return;
        }

        const switchingChannels = currentChannelId !== null && currentChannelId !== channelId;
        if (currentChannelId !== channelId) {
          await socket.join(channelId);
          joinedRoom = true;
        }

        const result = channelManager.join(channelId, socket.id, clientType, publicKey);

        if (!result.success) {
          if (joinedRoom) await socket.leave(channelId);
          callback?.({ success: false, error: result.error });
          return;
        }

        // Re-join to an explicitly closed (tombstoned) channel: report the
        // tombstone so the peer drops its stored session, but do NOT park the
        // socket in the dead room, point currentChannelId at it, or emit a
        // phantom 'join'. channelManager.join() added no participant for a
        // terminated channel and routing is refused there, so joining the room
        // would only leak a spurious presence event to other re-joiners.
        if (result.terminated) {
          if (joinedRoom) await socket.leave(channelId);
          callback?.({
            success: true,
            terminated: true,
            participants: [],
            channelPublicKey: null,
            bufferedMessages: [],
          });
          return;
        }
        joinedManager = true;

        if (switchingChannels && currentChannelId) {
          const previousChannelId = currentChannelId;
          const previousParticipant = channelManager.leave(socket.id, previousChannelId);
          if (previousParticipant) {
            socket.to(previousChannelId).emit('participants_changed', {
              event: 'leave',
              clientType: previousParticipant.clientType,
            });
          }
          await socket.leave(previousChannelId);
        }

        metrics.channelJoins.inc({ status: 'success' });
        refreshBufferMetrics();
        currentChannelId = channelId;

        // Notify other participant that counterparty joined
        socket.to(channelId).emit('participants_changed', {
          event: 'join',
          clientType,
        });

        callback?.({
          success: true,
          bufferedMessages: result.bufferedMessages,
          channelPublicKey: result.channelPublicKey,
          // Counterparty roster so a (re)joining peer can detect an absent
          // wallet immediately; `terminated` flags a channel that was closed
          // on purpose so the peer drops its stored session instead of waiting.
          participants: result.participants,
          terminated: result.terminated,
        });
      } catch {
        if (joinedManager && requestedChannelId) {
          channelManager.leave(socket.id, requestedChannelId);
        }
        if (joinedRoom && requestedChannelId) {
          await Promise.resolve(socket.leave(requestedChannelId)).catch(() => undefined);
        }
        callback?.({ success: false, error: 'Unable to join channel' });
      } finally {
        joinInProgress = false;
      }
    });

    /**
     * message - Route an encrypted message to the counterparty.
     * Payload: { id: channelId, message: encryptedData, clientType: string }
     */
    socket.on('message', (payload, rawCallback) => {
      const callback = toAck(rawCallback);
      if (!checkRateLimit(clientIp, 'message', RATE_LIMIT_MAX_MESSAGES)) {
        metrics.rateLimitHits.inc({ bucket: 'message' });
        callback?.({ success: false, error: 'Rate limit exceeded' });
        return;
      }

      const data = isRecord(payload) ? payload : {};
      const channelId = data.id;
      const message = data.message;
      const clientType = data.clientType;
      const seq = data.seq;

      if (
        !isValidChannelId(channelId) ||
        message === undefined ||
        message === null ||
        !isClientType(clientType)
      ) {
        callback?.({ success: false, error: 'Invalid channelId, clientType, or missing message' });
        return;
      }
      if (seq !== undefined && (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)) {
        callback?.({ success: false, error: 'seq must be a non-negative safe integer' });
        return;
      }

      const payloadSize = getMessageSizeBytes(payload);
      if (payloadSize > MAX_MESSAGE_BYTES) {
        callback?.({ success: false, error: 'Message payload too large' });
        return;
      }

      const canonicalPayload: RelayPayload =
        seq === undefined
          ? { id: channelId, clientType, message }
          : { id: channelId, clientType, message, seq };
      const result = channelManager.routeMessage(channelId, socket.id, canonicalPayload, clientIp);

      if (result.backpressuredSocketId !== undefined) {
        const slowTarget = io.sockets.sockets.get(result.backpressuredSocketId);
        if (!channelManager.hasDirectDelivery(result.backpressuredSocketId)) {
          slowTarget?.disconnect(true);
        }
      }

      if (result.error !== undefined) {
        callback?.({ success: false, error: result.error });
        return;
      }

      if (result.targetSocketId !== undefined) {
        const target = io.sockets.sockets.get(result.targetSocketId);
        if (!target || !armDirectDelivery(result.targetSocketId)) {
          releaseDirectDelivery(result.targetSocketId);
          target?.disconnect(true);
          callback?.({ success: false, error: 'Counterparty transport unavailable' });
          return;
        }
        // The transport was writable at admission and the delivery is reserved
        // until its actual transport drain. Volatile is a final race guard: it
        // prevents Socket.IO from silently creating a second unaccounted queue.
        target.volatile.emit('message', canonicalPayload);
        metrics.messagesRouted.inc({ status: 'delivered' });
        metrics.messageSize.observe(payloadSize);
      }

      callback?.({ success: true, buffered: result.buffered });
      if (result.buffered) {
        metrics.messagesRouted.inc({ status: 'buffered' });
      }
    });

    /**
     * leave_channel - Explicitly leave a channel.
     */
    socket.on('leave_channel', (payload, rawCallback) => {
      const callback = toAck(rawCallback);
      if (!checkRateLimit(clientIp, 'control', RATE_LIMIT_MAX_CONTROL_EVENTS)) {
        metrics.rateLimitHits.inc({ bucket: 'control' });
        callback?.({ success: false, error: 'Control rate limit exceeded' });
        return;
      }
      const requested = isRecord(payload) ? payload.channelId : undefined;
      const channelId = typeof requested === 'string' && requested ? requested : currentChannelId;

      if (channelId) {
        void socket.leave(channelId);
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
    socket.on('close_channel', (payload, rawCallback) => {
      const callback = toAck(rawCallback);
      if (!checkRateLimit(clientIp, 'control', RATE_LIMIT_MAX_CONTROL_EVENTS)) {
        metrics.rateLimitHits.inc({ bucket: 'control' });
        callback?.({ success: false, error: 'Control rate limit exceeded' });
        return;
      }
      const requested = isRecord(payload) ? payload.channelId : undefined;
      const channelId = typeof requested === 'string' && requested ? requested : currentChannelId;

      if (!isValidChannelId(channelId)) {
        callback?.({
          success: false,
          terminated: false,
          error: 'Channel close was not confirmed',
        });
        return;
      }

      // Only an actual participant may terminate the channel. Return the same
      // failure for unknown channels and non-participants so the ack cannot be
      // mistaken for a durable tombstone or used as a channel-existence probe.
      const participant = channelManager.leave(socket.id, channelId);
      if (!participant || !channelManager.close(channelId)) {
        callback?.({
          success: false,
          terminated: false,
          error: 'Channel close was not confirmed',
        });
        return;
      }

      void socket.leave(channelId);
      refreshBufferMetrics();

      // Tell a currently-connected counterparty this was an explicit close,
      // distinct from a transient disconnect.
      socket.to(channelId).emit('participants_changed', {
        event: 'close',
        clientType: participant.clientType,
      });

      if (currentChannelId === channelId) {
        currentChannelId = null;
      }

      callback?.({ success: true, terminated: true });
    });

    /**
     * ping - Simple connectivity check.
     */
    socket.on('ping', (rawCallback) => {
      const callback = toAck(rawCallback);
      if (!checkRateLimit(clientIp, 'control', RATE_LIMIT_MAX_CONTROL_EVENTS)) {
        metrics.rateLimitHits.inc({ bucket: 'control' });
        callback?.({ success: false, error: 'Control rate limit exceeded' });
        return;
      }
      callback?.({ type: 'pong', timestamp: Date.now() });
    });

    /**
     * Handle disconnection - clean up channel membership.
     */
    socket.on('disconnect', () => {
      metrics.activeSockets.dec();
      releaseSocketCounter();
      releaseDirectDelivery(socket.id);
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

  const destroy = (): void => {
    clearInterval(rateLimitCleanupTimer);
    activeSocketsByIp.clear();
    rateLimits.clear();
    for (const socketId of directTransportListeners.keys()) releaseDirectDelivery(socketId);
    channelManager.destroy();
    metrics.activeChannels.set(0);
    metrics.bufferedMessages.set(0);
    metrics.bufferedBytes.set(0);
    metrics.directInflightBytes.set(0);
    io.removeAllListeners();
  };

  return { io, channelManager, destroy };
}
