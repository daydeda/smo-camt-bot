import config from '../config.js';

function normalizeName(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

/**
 * Collect assignee names from a card by scanning the configured assignee
 * property names (people properties extract to arrays of names).
 */
export function getAssigneeNames(card) {
  const properties = card?.properties || {};
  const wantedKeys = new Set(
    (config.notifications?.assigneeProperties || []).map(name => normalizeName(name))
  );

  if (wantedKeys.size === 0) {
    return [];
  }

  const names = [];
  for (const [key, value] of Object.entries(properties)) {
    if (!wantedKeys.has(normalizeName(key))) {
      continue;
    }

    if (Array.isArray(value)) {
      names.push(...value.map(item => String(item).trim()).filter(Boolean));
    } else if (typeof value === 'string' && value.trim().length > 0) {
      names.push(...value.split(',').map(item => item.trim()).filter(Boolean));
    }
  }

  return Array.from(new Set(names));
}

/**
 * Resolve a card's assignees to Discord user mentions using the configured
 * NOTION_DISCORD_USER_MAP. Returns [] when nothing maps.
 */
export function resolveAssigneeMentions(card) {
  const userMap = config.notifications?.notionDiscordUserMap || {};
  if (Object.keys(userMap).length === 0) {
    return [];
  }

  const mentions = new Set();
  for (const name of getAssigneeNames(card)) {
    const discordId = userMap[normalizeName(name)];
    if (discordId) {
      mentions.add(`<@${discordId}>`);
    }
  }

  return Array.from(mentions);
}

// Extract user mentions (<@123>) from an embed's fields, ignoring role mentions (<@&123>).
export function extractUserMentionsFromEmbed(embed) {
  const fields = embed?.data?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }

  const mentions = new Set();
  for (const field of fields) {
    if (typeof field?.value !== 'string') {
      continue;
    }

    const matches = field.value.match(/<@(\d+)>/g);
    if (matches) {
      for (const mention of matches) {
        mentions.add(mention);
      }
    }
  }

  return Array.from(mentions);
}

export function extractUserIdsFromMentions(mentions) {
  return mentions
    .map(mention => mention.match(/^<@(\d+)>$/)?.[1] || null)
    .filter(Boolean);
}

export function collectUserMentionsFromEmbeds(embeds) {
  const mentionSet = new Set();

  for (const embed of embeds) {
    for (const mention of extractUserMentionsFromEmbed(embed)) {
      mentionSet.add(mention);
    }
  }

  return Array.from(mentionSet);
}
