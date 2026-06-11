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
// Hard cap on retained tombstones. Terminated channels are excluded from the
// active-channel admission count, so without this an attacker could create +
// immediately close channels in a loop and accumulate unbounded tombstones
// (each held for TOMBSTONE_TTL_MS) until the relay exhausts memory. When the
// cap is exceeded the oldest tombstone is evicted; a dApp re-joining an evicted
// channel simply finds no wallet and falls back to QR via the liveness path.
const MAX_TOMBSTONES = 20000;
// ML-KEM-768 public key is 1184 bytes → ~1580 chars base64. Cap at 2048
// raw bytes (~2730 chars) so a future KEM doesn't require a protocol
// change on the relay, but tightly enough that a malicious client can't
// bloat channel state.
const MAX_PUBLIC_KEY_BYTES = 2048;

export type ClientType = 'dapp' | 'wallet';

export function isClientType(value: unknown): value is ClientType {
  return value === 'dapp' || value === 'wallet';
}

export interface Participant {
  clientType: ClientType;
  joinedAt: number;
}

interface BufferedMessage {
  data: unknown;
  targetClientType: ClientType;
  timestamp: number;
}

interface Channel {
  participants: Map<string, Participant>;
  lastActivity: number;
  messageBuffer: BufferedMessage[];
  /** Monotonic sequence numbers per sender socketId */
  seqNumbers: Map<string, number>;
  /** dApp's base64-encoded KEM public key. */
  publicKey: string | null;
  /** Set when a participant explicitly closed the channel. */
  terminated: boolean;
  /** When the channel was terminated (for tombstone TTL). */
  terminatedAt: number;
}

export interface JoinSuccess {
  success: true;
  bufferedMessages: unknown[];
  channelPublicKey: string | null;
  participants: ClientType[];
  terminated: boolean;
}

export interface JoinFailure {
  success: false;
  error: string;
}

export type JoinResult = JoinSuccess | JoinFailure;

export interface RouteResult {
  targetSocketId?: string;
  buffered: boolean;
  error?: string;
}

export interface ChannelStats {
  activeChannels: number;
  totalParticipants: number;
  totalBufferedMessages: number;
}

export interface ChannelManagerOptions {
  isSocketActive?: (socketId: string) => boolean;
}

class ChannelManager {
  channels = new Map<string, Channel>();
  /** FIFO of terminated channelIds, for tombstone eviction. */
  terminatedOrder: string[] = [];
  isSocketActive: (socketId: string) => boolean;
  private cleanupTimer: NodeJS.Timeout | null;

  constructor(options: ChannelManagerOptions = {}) {
    this.isSocketActive = options.isSocketActive ?? (() => false);
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, CLEANUP_INTERVAL_MS);
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
   *  - The PK is no longer carried in the QR (24x smaller URI).
   *
   * `publicKeyBase64` is dApp-only and ignored for wallet joins. First dApp
   * sets it; later dApp joins must match the stored value (protects against
   * impersonation attempts on stale channels).
   */
  join(
    channelId: string,
    socketId: string,
    clientType: ClientType,
    publicKeyBase64?: string
  ): JoinResult {
    let channel = this.channels.get(channelId);

    // Re-join to an explicitly closed channel: report the tombstone so the
    // (re)joining peer drops its stored session, but do NOT resurrect it or
    // add a participant. Parking a socket in a dead channel would both skip
    // the active-channel admission cap (getChannelInfo stays truthy) and let
    // an attacker loop join->close to flood the tombstone FIFO.
    if (channel?.terminated) {
      return {
        success: true,
        bufferedMessages: [],
        channelPublicKey: null,
        participants: [],
        terminated: true,
      };
    }

    if (!channel) {
      channel = {
        participants: new Map<string, Participant>(),
        lastActivity: Date.now(),
        messageBuffer: [],
        seqNumbers: new Map<string, number>(),
        publicKey: null,
        terminated: false,
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
      // canonicalises it; a dApp re-joining with equivalent-but-not-
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

    // Note: a wallet may legitimately join a channel with no PK bound;
    // either the dApp hasn't arrived yet (fresh scan race), or the relay
    // restarted and forgot the binding (wallet has a persisted session
    // and doesn't need to re-verify). The wallet's join ack carries
    // `channelPublicKey: null` in both cases; the wallet decides what to
    // do with that based on whether it's in a fresh-handshake flow.

    channel.participants.set(socketId, { clientType, joinedAt: Date.now() });
    channel.lastActivity = Date.now();

    // Deliver buffered messages for this client type
    const buffered: BufferedMessage[] = [];
    const newBuffer: BufferedMessage[] = [];
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
    const counterpartyTypes: ClientType[] = [];
    for (const [sid, p] of channel.participants) {
      if (sid !== socketId) counterpartyTypes.push(p.clientType);
    }

    return {
      success: true,
      bufferedMessages: buffered.map((msg) => msg.data),
      channelPublicKey: channel.publicKey,
      participants: counterpartyTypes,
      terminated: channel.terminated,
    };
  }

  /**
   * Explicitly terminate a channel (wallet- or dApp-initiated disconnect /
   * "forget"). Marks a durable tombstone so a peer re-joining later learns
   * the session was torn down on purpose and drops its stored session,
   * instead of sitting on a liveness timeout or re-pairing a dead channel.
   * The tombstone is retained for TOMBSTONE_TTL_MS and is excluded from the
   * active-channel admission count so it cannot block new channels.
   */
  close(channelId: string): void {
    const channel = this.channels.get(channelId);
    // Only mark an existing channel. Never fabricate a tombstone for an
    // unknown channelId: a non-existent channel is already dead (a re-joining
    // peer sees no participants anyway), and creating one would let an
    // attacker fill memory with tombstones that bypass the channel cap.
    if (!channel) return;
    // Idempotent: a channel can only be tombstoned once. Without this a
    // repeated close() (or a re-join->close loop on the same id) would push
    // duplicate entries into terminatedOrder and the FIFO eviction would then
    // flush out legitimate tombstones.
    if (channel.terminated) return;
    channel.terminated = true;
    channel.terminatedAt = Date.now();
    channel.lastActivity = Date.now();
    // A terminated channel routes nothing, so drop its heavy state now rather
    // than holding it for TOMBSTONE_TTL_MS. The tombstone keeps only the
    // terminated flag + timestamps.
    channel.messageBuffer = [];
    channel.participants.clear();
    channel.seqNumbers.clear();
    channel.publicKey = null;
    // Bound the number of retained tombstones (see MAX_TOMBSTONES). Evict the
    // oldest when over budget; entries already removed by the TTL cleanup are
    // skipped.
    this.terminatedOrder.push(channelId);
    while (this.terminatedOrder.length > MAX_TOMBSTONES) {
      const oldest = this.terminatedOrder.shift();
      if (oldest === undefined) break;
      const stale = this.channels.get(oldest);
      if (stale?.terminated) {
        this.channels.delete(oldest);
      }
    }
  }

  /**
   * Remove a participant from their channel. Returns the removed participant
   * record, or null if this socket was not in the channel.
   */
  leave(socketId: string, channelId: string): Participant | null {
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
   */
  routeMessage(channelId: string, senderSocketId: string, data: unknown): RouteResult {
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
    if (typeof data === 'object' && data !== null && 'seq' in data) {
      const seq = data.seq;
      if (typeof seq === 'number') {
        const lastSeq = channel.seqNumbers.get(senderSocketId) ?? -1;
        if (seq <= lastSeq) {
          return { buffered: false, error: 'Duplicate or out-of-order message (replay rejected)' };
        }
        channel.seqNumbers.set(senderSocketId, seq);
      }
    }

    // Find counterparty (the other participant)
    let targetSocketId: string | null = null;

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
    const otherClientType: ClientType = sender.clientType === 'dapp' ? 'wallet' : 'dapp';

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
   */
  getChannelInfo(channelId: string): {
    participantCount: number;
    bufferedMessages: number;
    lastActivity: number;
    age: number;
  } | null {
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
   */
  findChannelBySocket(socketId: string): string | null {
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
  cleanup(): void {
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

    // Keep the tombstone FIFO in sync with the TTL deletions above so it does
    // not retain references to channels that no longer exist.
    if (this.terminatedOrder.length > 0) {
      this.terminatedOrder = this.terminatedOrder.filter((id) => this.channels.has(id));
    }
  }

  /**
   * Get stats for health check / monitoring.
   */
  getStats(): ChannelStats {
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
  getActiveChannelCount(): number {
    let count = 0;
    for (const channel of this.channels.values()) {
      if (!channel.terminated) count += 1;
    }
    return count;
  }

  /**
   * Shutdown cleanup timer.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export { ChannelManager };
