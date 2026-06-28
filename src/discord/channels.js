import config from '../config.js';
import discordClient from './bot.js';
import {
  collectRoleMentionsFromEmbeds,
  extractRoleMentionsFromEmbed,
  extractRoleIdsFromMentions,
} from './roles.js';
import {
  collectUserMentionsFromEmbeds,
  extractUserMentionsFromEmbed,
  extractUserIdsFromMentions,
} from './mentions.js';
import { buildCardActionComponents } from './actions.js';
import logger from '../core/logger.js';

const SEND_MAX_ATTEMPTS = 3;
const SEND_RETRY_BASE_DELAY_MS = 750;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Send a message with bounded retries for transient Discord failures.
// Rate-limit (429) and 5xx errors are retried with backoff; other errors throw.
async function sendWithRetry(channel, payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await channel.send(payload);
    } catch (error) {
      lastError = error;
      const status = error?.status ?? error?.httpStatus;
      const isRetryable = status === 429 || (typeof status === 'number' && status >= 500);

      if (!isRetryable || attempt === SEND_MAX_ATTEMPTS) {
        throw error;
      }

      const retryAfterMs = Number.isFinite(error?.retryAfter)
        ? error.retryAfter * 1000
        : SEND_RETRY_BASE_DELAY_MS * attempt;
      logger.warn(
        `Discord send failed (status=${status}, attempt=${attempt}/${SEND_MAX_ATTEMPTS}); retrying in ${retryAfterMs}ms: ${error.message}`
      );
      await sleep(retryAfterMs);
    }
  }

  throw lastError;
}

export async function fetchConfiguredChannels() {
  const channels = [];

  for (const channelId of config.discord.channelIds) {
    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel || typeof channel.send !== 'function') {
        console.warn(`⚠️  Skipping non-text or unavailable channel: ${channelId}`);
        continue;
      }

      channels.push(channel);
    } catch (error) {
      console.error(`⚠️  Failed to fetch channel ${channelId}: ${error.message}`);
    }
  }

  return channels;
}

export async function sendEmbedsToChannel(channel, embeds, options = {}) {
  const { singleMessage = false } = options;

  if (singleMessage) {
    const chunks = [];
    for (let i = 0; i < embeds.length; i += 10) {
      chunks.push(embeds.slice(i, i + 10));
    }

    for (const chunk of chunks) {
      const roleMentions = collectRoleMentionsFromEmbeds(chunk);
      const roleIds = extractRoleIdsFromMentions(roleMentions);
      const userMentions = collectUserMentionsFromEmbeds(chunk);
      const userIds = extractUserIdsFromMentions(userMentions);

      await sendWithRetry(channel, {
        content: [...roleMentions, ...userMentions].join(' '),
        embeds: chunk,
        allowedMentions: {
          parse: [],
          roles: roleIds,
          users: userIds,
        },
      });
      await sleep(500);
    }

    return;
  }

  for (const embed of embeds) {
    const roleMentions = extractRoleMentionsFromEmbed(embed);
    const roleIds = extractRoleIdsFromMentions(roleMentions);
    const userMentions = extractUserMentionsFromEmbed(embed);
    const userIds = extractUserIdsFromMentions(userMentions);
    const components = buildCardActionComponents(embed);

    await sendWithRetry(channel, {
      content: [...roleMentions, ...userMentions].join(' '),
      embeds: [embed],
      components,
      allowedMentions: {
        parse: [],
        roles: roleIds,
        users: userIds,
      },
    });
    await sleep(500);
  }
}

export async function clearChannelMessages(channel) {
  const MAX_FETCH = 100;
  const BULK_DELETE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  while (true) {
    const messages = await channel.messages.fetch({ limit: MAX_FETCH });
    if (messages.size === 0) {
      break;
    }

    const deletable = Array.from(messages.values()).filter(message => !message.pinned);
    if (deletable.length === 0) {
      break;
    }

    const nowMs = Date.now();
    const recentMessages = deletable.filter(
      message => nowMs - message.createdTimestamp < BULK_DELETE_WINDOW_MS
    );
    const olderMessages = deletable.filter(
      message => nowMs - message.createdTimestamp >= BULK_DELETE_WINDOW_MS
    );

    if (recentMessages.length > 0) {
      const deleted = await channel.bulkDelete(recentMessages, true);
      deletedCount += deleted.size;
    }

    for (const message of olderMessages) {
      try {
        await message.delete();
        deletedCount += 1;
      } catch {
        // Ignore undeletable messages and keep clearing remaining messages.
      }
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  return deletedCount;
}
