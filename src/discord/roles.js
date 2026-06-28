import { normalizeLookupText } from '../sync/filters.js';

export function buildDepartmentRoleMentions(channel) {
  const roleMentions = {};

  const roleCache = channel?.guild?.roles?.cache;
  if (!roleCache) {
    return roleMentions;
  }

  for (const role of roleCache.values()) {
    const normalizedName = normalizeLookupText(role.name);
    if (!normalizedName) {
      continue;
    }

    roleMentions[normalizedName] = `<@&${role.id}>`;
  }

  return roleMentions;
}

export function extractRoleMentionsFromEmbed(embed) {
  const fields = embed?.data?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }

  const departmentField = fields.find(field => field?.name === '🏢 Department');
  if (!departmentField || typeof departmentField.value !== 'string') {
    return [];
  }

  const mentionMatches = departmentField.value.match(/<@&(\d+)>/g);
  if (!mentionMatches) {
    return [];
  }

  return Array.from(new Set(mentionMatches));
}

export function extractRoleIdsFromMentions(roleMentions) {
  return roleMentions
    .map(mention => mention.match(/^<@&(\d+)>$/)?.[1] || null)
    .filter(Boolean);
}

export function collectRoleMentionsFromEmbeds(embeds) {
  const mentionSet = new Set();

  for (const embed of embeds) {
    const roleMentions = extractRoleMentionsFromEmbed(embed);
    for (const mention of roleMentions) {
      mentionSet.add(mention);
    }
  }

  return Array.from(mentionSet);
}
