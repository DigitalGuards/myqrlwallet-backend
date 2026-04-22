/**
 * Channel Manager - Manages relay channel lifecycle, participant tracking,
 * message buffering, and TTL cleanup for the QRL Connect protocol.
 */

const CHANNEL_TTL_MS = 30 * 60 * 1000; // 30 minutes inactivity
const MAX_PARTICIPANTS = 2;
const MAX_BUFFERED_MESSAGES = 50;
const BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute
// ML-KEM-768 public key is 1184 bytes → ~1580 chars base64. Cap at 2048
// raw bytes (~2730 chars) so a future KEM doesn't require a protocol
// change on the relay, but tightly enough that a malicious client can't
// bloat channel state.
const MAX_PUBLIC_KEY_BYTES = 2048;

class ChannelManager {
  constructor(options = {}) {
    /** @type {Map<string, Channel>} */
    this.channels = new Map();
    this.isSocketActive = options.isSocketActive || (() => false);
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Join or create a channel. Returns buffered messages if any and, for
   * wallet joins, the dApp's public key bound to the channel.
   *
   * v2 protocol: the dApp uploads its KEM public key with its first
   * join_channel. The relay binds that PK to the channel and serves it
   * to the wallet on its join. The QR carries only `SHA-256(label||cid||pk)`
   * so the wallet can verify the served PK against that out-of-band
   * commitment. That means:
   *  - An attacker can't substitute the PK via the relay (fp mismatch).
   *  - The PK is no longer carried in the QR (24× smaller URI).
   *
   * @param {string} channelId
   * @param {string} socketId
   * @param {string} clientType - 'dapp' or 'wallet'
   * @param {string} [publicKeyBase64] - dApp-only; base64-encoded KEM PK.
   *   Ignored for wallet joins. First dApp sets it; later dApp joins must
   *   match the stored value (protects against impersonation attempts on
   *   stale channels).
   * @returns {{ success: boolean, error?: string, bufferedMessages?: Array, channelPublicKey?: string }}
   */
  join(channelId, socketId, clientType, publicKeyBase64) {
    let channel = this.channels.get(channelId);

    if (!channel) {
      channel = {
        participants: new Map(),
        lastActivity: Date.now(),
        messageBuffer: [],
        /** @type {Map<string, number>} Monotonic sequence numbers per sender socketId */
        seqNumbers: new Map(),
        /** @type {string|null} dApp's base64-encoded KEM public key. */
        publicKey: null,
      };
      this.channels.set(channelId, channel);
    }

    // Prevent active participant hijacking by requiring stale socket replacement only.
    for (const [existingSocketId, participant] of channel.participants) {
      if (participant.clientType === clientType && existingSocketId !== socketId) {
        if (this.isSocketActive(existingSocketId)) {
          return {
            success: false,
            error: `A ${clientType} participant is already connected`,
          };
        }
        // Allow replacing stale/disconnected participant socket.
        channel.participants.delete(existingSocketId);
        channel.seqNumbers.delete(existingSocketId);
        break;
      }
    }

    if (!channel.participants.has(socketId) && channel.participants.size >= MAX_PARTICIPANTS) {
      return { success: false, error: 'Channel is full (max 2 participants)' };
    }

    // Bind the dApp PK on first dApp join. Reject mismatches so a hijack
    // attempt (someone else trying to claim the same channelId with a
    // different PK) fails loudly instead of silently routing the wallet
    // to an attacker.
    if (
      clientType === 'dapp' &&
      typeof publicKeyBase64 === 'string' &&
      publicKeyBase64.length > 0
    ) {
      // Validate via a real base64 decode so non-base64 characters are
      // rejected and we can compare by decoded bytes. Encoding the
      // decoded buffer and comparing to the input also canonicalises it:
      // a dApp that later re-joins with extra `=` padding or different
      // (but equivalent) spacing still matches the stored value byte-wise.
      let decoded;
      try {
        decoded = Buffer.from(publicKeyBase64, 'base64');
      } catch {
        return { success: false, error: 'Public key is not valid base64' };
      }
      if (decoded.length === 0) {
        return { success: false, error: 'Public key is empty or invalid base64' };
      }
      if (decoded.length > MAX_PUBLIC_KEY_BYTES) {
        return { success: false, error: 'Public key exceeds size limit' };
      }
      const canonical = decoded.toString('base64');
      if (channel.publicKey === null) {
        channel.publicKey = canonical;
      } else if (channel.publicKey !== canonical) {
        return {
          success: false,
          error: 'Channel is already bound to a different dApp public key',
        };
      }
    }

    // Note: a wallet may legitimately join a channel with no PK bound —
    // either the dApp hasn't arrived yet (fresh scan race), or the relay
    // restarted and forgot the binding (wallet has a persisted session
    // and doesn't need to re-verify). The wallet's join ack carries
    // `channelPublicKey: null` in both cases; the wallet decides what to
    // do with that based on whether it's in a fresh-handshake flow.

    channel.participants.set(socketId, { clientType, joinedAt: Date.now() });
    channel.lastActivity = Date.now();

    // Deliver buffered messages for this client type
    const buffered = [];
    const newBuffer = [];
    for (const msg of channel.messageBuffer) {
      if (msg.targetClientType === clientType) {
        buffered.push(msg);
      } else {
        newBuffer.push(msg);
      }
    }
    channel.messageBuffer = newBuffer;

    return {
      success: true,
      bufferedMessages: buffered.map((msg) => msg.data),
      channelPublicKey: channel.publicKey,
    };
  }

  /**
   * Remove a participant from their channel.
   * @param {string} socketId
   * @param {string} channelId
   * @returns {{ clientType: string, joinedAt: number }|null}
   */
  leave(socketId, channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    const participant = channel.participants.get(socketId);
    if (!participant) return null;

    channel.participants.delete(socketId);
    channel.seqNumbers.delete(socketId);
    channel.lastActivity = Date.now();

    // Don't delete channel immediately - allow reconnection.
    // Cleanup timer will handle stale channels.
    return participant;
  }

  /**
   * Route a message to the counterparty in the channel.
   * If counterparty is disconnected, buffer the message.
   * @param {string} channelId
   * @param {string} senderSocketId
   * @param {object} data - The encrypted message data
   * @returns {{ targetSocketId?: string, buffered: boolean, error?: string }}
   */
  routeMessage(channelId, senderSocketId, data) {
    const channel = this.channels.get(channelId);
    if (!channel) {
      return { buffered: false, error: 'Channel not found' };
    }

    channel.lastActivity = Date.now();

    const sender = channel.participants.get(senderSocketId);
    if (!sender) {
      return { buffered: false, error: 'Sender not in channel' };
    }

    // Replay protection: enforce monotonic sequence numbers per sender.
    // If the message includes a seq number, reject duplicates and out-of-order.
    if (typeof data?.seq === 'number') {
      const lastSeq = channel.seqNumbers.get(senderSocketId) ?? -1;
      if (data.seq <= lastSeq) {
        return { buffered: false, error: 'Duplicate or out-of-order message (replay rejected)' };
      }
      channel.seqNumbers.set(senderSocketId, data.seq);
    }

    // Find counterparty (the other participant)
    let targetSocketId = null;

    for (const [sid] of channel.participants) {
      if (sid !== senderSocketId) {
        targetSocketId = sid;
        break;
      }
    }

    if (targetSocketId) {
      return { targetSocketId, buffered: false };
    }

    // Counterparty not connected - buffer the message
    const otherClientType = sender.clientType === 'dapp' ? 'wallet' : 'dapp';

    if (channel.messageBuffer.length >= MAX_BUFFERED_MESSAGES) {
      // Drop oldest message
      channel.messageBuffer.shift();
    }

    channel.messageBuffer.push({
      data,
      targetClientType: otherClientType,
      timestamp: Date.now(),
    });

    return { buffered: true };
  }

  /**
   * Get channel info for debugging/monitoring.
   * @param {string} channelId
   */
  getChannelInfo(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    return {
      participantCount: channel.participants.size,
      bufferedMessages: channel.messageBuffer.length,
      lastActivity: channel.lastActivity,
      age: Date.now() - channel.lastActivity,
    };
  }

  /**
   * Find which channel a socket belongs to.
   * @param {string} socketId
   * @returns {string|null} channelId
   */
  findChannelBySocket(socketId) {
    for (const [channelId, channel] of this.channels) {
      if (channel.participants.has(socketId)) {
        return channelId;
      }
    }
    return null;
  }

  /**
   * Cleanup stale channels and expired buffered messages.
   */
  cleanup() {
    const now = Date.now();

    for (const [channelId, channel] of this.channels) {
      // Remove expired buffered messages
      channel.messageBuffer = channel.messageBuffer.filter(
        (msg) => now - msg.timestamp < BUFFER_TTL_MS
      );

      // Remove channels inactive beyond TTL with no participants
      if (channel.participants.size === 0 && now - channel.lastActivity > CHANNEL_TTL_MS) {
        this.channels.delete(channelId);
      }
    }
  }

  /**
   * Get stats for health check / monitoring.
   */
  getStats() {
    let totalParticipants = 0;
    let totalBuffered = 0;

    for (const channel of this.channels.values()) {
      totalParticipants += channel.participants.size;
      totalBuffered += channel.messageBuffer.length;
    }

    return {
      activeChannels: this.channels.size,
      totalParticipants,
      totalBufferedMessages: totalBuffered,
    };
  }

  /**
   * Get current number of tracked channels in O(1).
   * Useful for admission control before creating new channels.
   */
  getActiveChannelCount() {
    return this.channels.size;
  }

  /**
   * Shutdown cleanup timer.
   */
  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export { ChannelManager };
