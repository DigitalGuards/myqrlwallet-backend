/**
 * Channel Manager - Manages relay channel lifecycle, participant tracking,
 * message buffering, and TTL cleanup for the QRL Connect protocol.
 */

const CHANNEL_TTL_MS = 30 * 60 * 1000; // 30 minutes inactivity
const MAX_PARTICIPANTS = 2;
const MAX_BUFFERED_MESSAGES = 50;
const BUFFER_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // Run cleanup every minute

class ChannelManager {
  constructor() {
    /** @type {Map<string, Channel>} */
    this.channels = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Join or create a channel. Returns buffered messages if any.
   * @param {string} channelId
   * @param {string} socketId
   * @param {string} clientType - 'dapp' or 'wallet'
   * @returns {{ success: boolean, error?: string, bufferedMessages?: Array }}
   */
  join(channelId, socketId, clientType) {
    let channel = this.channels.get(channelId);

    if (!channel) {
      channel = {
        participants: new Map(),
        lastActivity: Date.now(),
        messageBuffer: [],
      };
      this.channels.set(channelId, channel);
    }

    // Check if this client type already has a different socket connected
    for (const [existingSocketId, participant] of channel.participants) {
      if (participant.clientType === clientType && existingSocketId !== socketId) {
        // Same client type reconnecting with new socket - remove old entry
        channel.participants.delete(existingSocketId);
        break;
      }
    }

    if (!channel.participants.has(socketId) && channel.participants.size >= MAX_PARTICIPANTS) {
      return { success: false, error: 'Channel is full (max 2 participants)' };
    }

    channel.participants.set(socketId, { clientType, joinedAt: Date.now() });
    channel.lastActivity = Date.now();

    // Deliver buffered messages for this client type
    const buffered = channel.messageBuffer.filter(
      (msg) => msg.targetClientType === clientType
    );
    // Remove delivered messages from buffer
    channel.messageBuffer = channel.messageBuffer.filter(
      (msg) => msg.targetClientType !== clientType
    );

    return {
      success: true,
      bufferedMessages: buffered.map((msg) => msg.data),
    };
  }

  /**
   * Remove a participant from their channel.
   * @param {string} socketId
   * @param {string} channelId
   */
  leave(socketId, channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    channel.participants.delete(socketId);
    channel.lastActivity = Date.now();

    // Don't delete channel immediately - allow reconnection
    // Cleanup timer will handle stale channels
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

    // Find counterparty (the other participant)
    let targetSocketId = null;
    let targetClientType = null;

    for (const [sid, participant] of channel.participants) {
      if (sid !== senderSocketId) {
        targetSocketId = sid;
        targetClientType = participant.clientType;
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
      if (
        channel.participants.size === 0 &&
        now - channel.lastActivity > CHANNEL_TTL_MS
      ) {
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
