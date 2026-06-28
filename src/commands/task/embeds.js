import { EmbedBuilder } from 'discord.js';
import { normalizeLookupText } from '../../sync/filters.js';

const TASK_VIEW_DEFAULT_LIMIT = 15;
const TASK_VIEW_MAX_LIMIT = 50;
const TASK_VIEW_PAGE_SIZE = 8;

export { TASK_VIEW_DEFAULT_LIMIT };

export function formatScalarReplyValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'None';
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : 'None';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

export function getTaskTitle(card) {
  const properties = card?.properties || {};
  const directTitle = properties['กิจกรรม'];

  if (typeof directTitle === 'string' && directTitle.trim().length > 0) {
    return directTitle.trim();
  }

  const firstStringValue = Object.values(properties).find(
    value => typeof value === 'string' && value.trim().length > 0
  );

  if (typeof firstStringValue === 'string') {
    return firstStringValue;
  }

  return `Card ${card.id.slice(0, 8)}`;
}

export function formatTaskReply(card, titlePrefix = 'Task') {
  const properties = card?.properties || {};
  const title = getTaskTitle(card);
  const organizationValue = Object.entries(properties).find(
    ([key]) => key.toLowerCase().includes('organization') || key.toLowerCase().includes('organisation')
  )?.[1] ?? properties.Organization;

  return [
    `**${titlePrefix}:** ${title}`,
    `**ID:** ${card.id}`,
    `**Department:** ${formatScalarReplyValue(properties.Department)}`,
    `**Organization:** ${formatScalarReplyValue(organizationValue)}`,
    `**Status:** ${formatScalarReplyValue(properties.Status)}`,
    `**Date:** ${formatScalarReplyValue(properties.Date)}`,
    `**URL:** ${card.url || 'N/A'}`,
  ].join('\n');
}

function getTaskStatusBadge(statusValue) {
  const normalized = normalizeLookupText(String(statusValue || ''));
  if (!normalized) {
    return '⚪ Unknown';
  }

  if (normalized.includes('done')) {
    return '✅ Done';
  }

  if (normalized.includes('review')) {
    return '🧐 In Review';
  }

  if (normalized.includes('progress')) {
    return '🚧 In Progress';
  }

  if (normalized.includes('not started')) {
    return '📝 Not Started';
  }

  return `🔹 ${statusValue}`;
}

export function truncateText(value, maxLength = 120) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(maxLength - 3, 1))}...`;
}

export function buildTaskViewEmbeds(cards, { departmentFilters = [], statusFilters = [], limit = TASK_VIEW_DEFAULT_LIMIT } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || TASK_VIEW_DEFAULT_LIMIT, 1), TASK_VIEW_MAX_LIMIT);
  const sortedCards = [...cards].sort((left, right) => {
    return getTaskTitle(left).localeCompare(getTaskTitle(right), 'th');
  });
  const includedCards = sortedCards.slice(0, safeLimit);

  const summaryEmbed = new EmbedBuilder()
    .setColor(cards.length > 0 ? 0x1D4ED8 : 0x6B7280)
    .setTitle('📋 Department Task View')
    .addFields(
      {
        name: 'Departments',
        value: departmentFilters.join(', ') || 'All',
        inline: false,
      },
      {
        name: 'Status Filter',
        value: statusFilters.join(', ') || 'All',
        inline: true,
      },
      {
        name: 'Matched',
        value: String(cards.length),
        inline: true,
      },
      {
        name: 'Shown',
        value: String(includedCards.length),
        inline: true,
      }
    )
    .setTimestamp(new Date());

  if (cards.length === 0) {
    summaryEmbed.setDescription('No tasks matched this filter. Try a different department or status.');
    return [summaryEmbed];
  }

  if (cards.length > safeLimit) {
    summaryEmbed.setDescription(
      `Showing the first ${includedCards.length} task(s) based on your limit (${safeLimit}).`
    );
  } else {
    summaryEmbed.setDescription('Showing all matching tasks.');
  }

  const detailEmbeds = [];
  for (let i = 0; i < includedCards.length; i += TASK_VIEW_PAGE_SIZE) {
    const chunk = includedCards.slice(i, i + TASK_VIEW_PAGE_SIZE);
    const lines = chunk.map((card, index) => {
      const sequence = i + index + 1;
      const title = truncateText(getTaskTitle(card), 100);
      const status = formatScalarReplyValue(card?.properties?.Status);
      const date = truncateText(formatScalarReplyValue(card?.properties?.Date), 80);
      const idShort = card.id.slice(0, 8);
      const link = card.url ? `<${card.url}>` : 'N/A';

      return [
        `**${sequence}. ${title}**`,
        `${getTaskStatusBadge(status)} | 🗓️ ${date}`,
        `🆔 ${idShort} | ${link}`,
      ].join('\n');
    });

    const detailEmbed = new EmbedBuilder()
      .setColor(0x0EA5E9)
      .setTitle(`Tasks ${i + 1}-${i + chunk.length}`)
      .setDescription(lines.join('\n\n'));

    detailEmbeds.push(detailEmbed);
  }

  const embeds = [summaryEmbed, ...detailEmbeds];
  if (cards.length > includedCards.length) {
    const remainingCount = cards.length - includedCards.length;
    embeds[embeds.length - 1].setFooter({
      text: `${remainingCount} more task(s) not shown. Increase limit (max ${TASK_VIEW_MAX_LIMIT}) to view more.`,
    });
  }

  return embeds;
}
