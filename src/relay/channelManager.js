/**
 * Channel Manager - Manages relay channel lifecycle, participant tracking,
 * message buffering, and TTL cleanup for the QRL Connect protocol.
 */

const CHANNEL_TTL_MS = 30 * 60 * 1000; // 30 minutes inactivity
const MAX_PARTICIPANTS = 2;
const MAX_BUFFERED_MESSAGES = 50;
const BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute
// How long an explicit "terminated" tombstone is retained after the channel
// empties. A dApp that re-joins within this window learns the session was
// torn down on purpose (so it drops its stored session immediately) instead
// of sitting on a liveness timeout. Kept generous but bounded so tombstones
// cannot grow without limit; a dApp re-joining after this simply finds no
// wallet present and falls back to QR via the normal liveness path.
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
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
        /** @type {boolean} Set when a participant explicitly closed the channel. */
        terminated: false,
        /** @type {number} When the channel was terminated (for tombstone TTL). */
        terminatedAt: 0,
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
      // Strict base64 validation up front. `Buffer.from(s, 'base64')`
      // silently drops non-base64 characters instead of throwing, so we
      // reject anything that doesn't match the canonical alphabet first.
      // Re-encoding the decoded buffer and comparing to the input also
      // canonicalises it — a dApp re-joining with equivalent-but-not-
      // identical padding will still match the stored value byte-wise.
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyBase64)) {
        return { success: false, error: 'Public key is not valid base64' };
      }
      const decoded = Buffer.from(publicKeyBase64, 'base64');
      if (decoded.length === 0) {
        return { success: false, error: 'Public key is empty' };
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

    // Roster of the OTHER participants' client types, so a (re)joining peer
    // can immediately tell whether its counterparty is present rather than
    // waiting on a future participants_changed event that may never come
    // (e.g. the wallet left while the dApp tab was closed). Computed after
    // adding self, then filtered to exclude self.
    const counterpartyTypes = [];
    for (const [sid, p] of channel.participants) {
      if (sid !== socketId) counterpartyTypes.push(p.clientType);
    }

    return {
      success: true,
      bufferedMessages: buffered.map((msg) => msg.data),
      channelPublicKey: channel.publicKey,
      participants: counterpartyTypes,
      terminated: channel.terminated === true,
    };
  }

  /**
   * Explicitly terminate a channel (wallet- or dApp-initiated disconnect /
   * "forget"). Marks a durable tombstone so a peer re-joining later learns
   * the session was torn down on purpose and drops its stored session,
   * instead of sitting on a liveness timeout or re-pairing a dead channel.
   * The tombstone is retained for TOMBSTONE_TTL_MS and is excluded from the
   * active-channel admission count so it cannot block new channels.
   * @param {string} channelId
   */
  close(channelId) {
    const channel = this.channels.get(channelId);
    // Only mark an existing channel. Never fabricate a tombstone for an
    // unknown channelId: a non-existent channel is already dead (a re-joining
    // peer sees no participants anyway), and creating one would let an
    // attacker fill memory with tombstones that bypass the channel cap.
    if (!channel) return;
    channel.terminated = true;
    channel.terminatedAt = Date.now();
    channel.lastActivity = Date.now();
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

    // A terminated channel (explicit close / tombstone) is dead. Refuse to
    // route so a peer that never received or ignored the 'close' event cannot
    // keep using it until the 24h tombstone TTL expires.
    if (channel.terminated) {
      return { buffered: false, error: 'Channel terminated' };
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

      // Terminated tombstones live on their own (longer) TTL so a dApp that
      // re-joins within a day still learns the session was closed on purpose.
      // Delete strictly on age regardless of participant count: a lingering
      // participant (or a socket leak) must not pin a tombstone in memory
      // forever.
      if (channel.terminated) {
        if (now - channel.terminatedAt > TOMBSTONE_TTL_MS) {
          this.channels.delete(channelId);
        }
        continue;
      }

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
   * Get the number of live (non-terminated) channels, used for admission
   * control before creating new channels. Terminated tombstones are excluded
   * so a burst of closes cannot exhaust the active-channel budget. Bounded by
   * the channel cap, so the linear scan is cheap.
   */
  getActiveChannelCount() {
    let count = 0;
    for (const channel of this.channels.values()) {
      if (!channel.terminated) count += 1;
    }
    return count;
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
