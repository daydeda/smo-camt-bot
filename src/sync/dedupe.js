import { createHash } from 'crypto';
import discordClient from '../discord/bot.js';

const HARD_DEDUPE_META_KEY = 'hardDedupeHistoryByKey';
const HARD_DEDUPE_HYDRATION_META_KEY = 'hardDedupeHydratedAtByChannelId';
const HARD_DEDUPE_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const HARD_DEDUPE_MAX_KEYS = 5000;
const HARD_DEDUPE_DISCORD_HISTORY_FETCH_LIMIT = 250;
const HARD_DEDUPE_HYDRATION_INTERVAL_MS = 5 * 60 * 1000;

export { HARD_DEDUPE_META_KEY, HARD_DEDUPE_HYDRATION_META_KEY };

export function getMonthKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

function sanitizeEmbedForHardDedupe(embed) {
  const data = embed?.data && typeof embed.data === 'object'
    ? embed.data
    : (embed && typeof embed === 'object' ? embed : {});
  const fields = Array.isArray(data.fields)
    ? data.fields.map(field => ({
      name: typeof field?.name === 'string' ? field.name : '',
      value: typeof field?.value === 'string' ? field.value : '',
      inline: Boolean(field?.inline),
    }))
    : [];

  return {
    title: typeof data.title === 'string' ? data.title : '',
    url: typeof data.url === 'string' ? data.url : '',
    description: typeof data.description === 'string' ? data.description : '',
    color: Number.isInteger(data.color) ? data.color : null,
    author: typeof data.author?.name === 'string' ? data.author.name : '',
    footer: typeof data.footer?.text === 'string' ? data.footer.text : '',
    fields,
  };
}

function buildHardDedupeKey({ channelId, messageType, scopeToken = '', embed }) {
  const payload = {
    channelId: String(channelId || ''),
    messageType: String(messageType || ''),
    scopeToken: String(scopeToken || ''),
    embed: sanitizeEmbedForHardDedupe(embed),
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function pruneHardDedupeHistory(rawHistory, nowMs = Date.now()) {
  const history = rawHistory && typeof rawHistory === 'object' ? rawHistory : {};
  const validEntries = [];

  for (const [key, value] of Object.entries(history)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      continue;
    }

    const timestampMs = Date.parse(value);
    if (Number.isNaN(timestampMs)) {
      continue;
    }

    if ((nowMs - timestampMs) > HARD_DEDUPE_TTL_MS) {
      continue;
    }

    validEntries.push([key, value]);
  }

  validEntries.sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]));

  return Object.fromEntries(validEntries.slice(0, HARD_DEDUPE_MAX_KEYS));
}

export function applyHardDedupeToEmbeds(
  embeds,
  {
    channelId,
    messageType,
    scopeToken = '',
    dedupeHistoryByKey = {},
  } = {}
) {
  const acceptedEmbeds = [];
  const acceptedKeys = [];
  let skippedCount = 0;

  for (const embed of embeds) {
    const dedupeKey = buildHardDedupeKey({
      channelId,
      messageType,
      scopeToken,
      embed,
    });

    if (Object.hasOwn(dedupeHistoryByKey, dedupeKey)) {
      skippedCount += 1;
      continue;
    }

    acceptedEmbeds.push(embed);
    acceptedKeys.push(dedupeKey);
  }

  return {
    embeds: acceptedEmbeds,
    keys: acceptedKeys,
    skippedCount,
  };
}

export function markHardDedupeKeys(dedupeHistoryByKey, keys = [], timestampIso = new Date().toISOString()) {
  let changed = false;

  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }

    if (Object.hasOwn(dedupeHistoryByKey, key)) {
      continue;
    }

    dedupeHistoryByKey[key] = timestampIso;
    changed = true;
  }

  return changed;
}

function inferMessageTypeFromEmbed(embed) {
  const data = embed?.data && typeof embed.data === 'object'
    ? embed.data
    : (embed && typeof embed === 'object' ? embed : {});
  const title = typeof data.title === 'string' ? data.title : '';
  const description = typeof data.description === 'string' ? data.description : '';

  if (title.startsWith('⏰ Deadline Reminder:')) {
    return 'reminder';
  }

  if (title.startsWith('🆕 ')) {
    return 'created';
  }

  if (title.startsWith('📋 ')) {
    return 'changed';
  }

  if (title.startsWith('🗑️ ') || title.startsWith('🗑 ')) {
    return 'removed';
  }

  if (description.includes('New card created in Notion database')) {
    return 'created';
  }

  if (description.includes('Card removed from Notion database')) {
    return 'removed';
  }

  return null;
}

export function shouldHydrateHardDedupeForChannel(channelId, hydrationMetaByChannelId, nowMs = Date.now()) {
  const rawTimestamp = hydrationMetaByChannelId?.[channelId];
  if (typeof rawTimestamp !== 'string') {
    return true;
  }

  const lastHydratedAtMs = Date.parse(rawTimestamp);
  if (Number.isNaN(lastHydratedAtMs)) {
    return true;
  }

  return (nowMs - lastHydratedAtMs) >= HARD_DEDUPE_HYDRATION_INTERVAL_MS;
}

export async function hydrateHardDedupeHistoryFromDiscord(
  channel,
  dedupeHistoryByKey,
  { now = new Date() } = {}
) {
  if (!channel || !channel.id || typeof channel.messages?.fetch !== 'function') {
    return { added: 0, scannedMessages: 0, scannedEmbeds: 0 };
  }

  const botUserId = discordClient?.user?.id;
  if (!botUserId) {
    return { added: 0, scannedMessages: 0, scannedEmbeds: 0 };
  }

  let scannedMessages = 0;
  let scannedEmbeds = 0;
  let added = 0;
  const timestampIso = now.toISOString();

  try {
    const messages = await channel.messages.fetch({
      limit: HARD_DEDUPE_DISCORD_HISTORY_FETCH_LIMIT,
    });

    for (const message of messages.values()) {
      if (message?.author?.id !== botUserId) {
        continue;
      }

      scannedMessages += 1;
      const embeds = Array.isArray(message.embeds) ? message.embeds : [];
      if (embeds.length === 0) {
        continue;
      }

      for (const embed of embeds) {
        scannedEmbeds += 1;
        const messageType = inferMessageTypeFromEmbed(embed);
        if (!messageType) {
          continue;
        }

        const reminderScopeToken = messageType === 'reminder'
          ? formatDateKey(new Date(message.createdTimestamp || now.getTime()))
          : '';
        const dedupeKey = buildHardDedupeKey({
          channelId: channel.id,
          messageType,
          scopeToken: reminderScopeToken,
          embed,
        });

        if (Object.hasOwn(dedupeHistoryByKey, dedupeKey)) {
          continue;
        }

        dedupeHistoryByKey[dedupeKey] = timestampIso;
        added += 1;
      }
    }
  } catch (error) {
    console.warn(
      `⚠️  Failed to hydrate hard dedupe history from channel ${channel.id}: ${error.message}`
    );
  }

  return { added, scannedMessages, scannedEmbeds };
}
