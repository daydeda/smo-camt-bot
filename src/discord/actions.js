import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const CARD_ACTION_PREFIX = 'card:';

// Status quick-move buttons. Values must match the Notion status options
// (same set offered by `/task move`).
const STATUS_BUTTONS = [
  { status: 'In-Progress', label: 'In-Progress', style: ButtonStyle.Primary },
  { status: 'In-Review', label: 'In-Review', style: ButtonStyle.Secondary },
  { status: 'Done', label: 'Done', style: ButtonStyle.Success },
];

// Notion page URLs look like https://www.notion.so/<Title-Slug>-<32 hex id>.
// The id is always the trailing 32 hex chars of the last path segment. Matching
// the *first* 32 hex chars is wrong: a slug ending in hex-like text (e.g.
// "Fix-bug-2" or "Add-feed") shifts the match and yields a bogus page id.
const TRAILING_PAGE_ID_REGEX = /([0-9a-f]{32})$/i;

function normalizeStatus(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
    : '';
}

export function extractPageIdFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an absolute URL; treat the raw value as a path.
  }

  const lastSegment = path.split('/').filter(Boolean).pop() || '';
  const match = lastSegment.replace(/-/g, '').match(TRAILING_PAGE_ID_REGEX);
  return match ? match[1].toLowerCase() : null;
}

function getEmbedData(embed) {
  if (embed?.data && typeof embed.data === 'object') {
    return embed.data;
  }

  return embed && typeof embed === 'object' ? embed : {};
}

function getEmbedTitle(data) {
  return typeof data.title === 'string' ? data.title : '';
}

// Archived/removed cards can't be acted on, so skip status buttons for them.
function isRemovedEmbed(data) {
  const title = getEmbedTitle(data);
  return title.startsWith('🗑️ ') || title.startsWith('🗑 ');
}

function isReminderEmbed(data) {
  return getEmbedTitle(data).startsWith('⏰ Deadline Reminder:');
}

// Best-effort: detect the card's current status from a change embed so we can
// disable the matching button. Returns a normalized status string or null.
export function detectCurrentStatusFromEmbed(data) {
  const segments = [];
  if (typeof data.description === 'string') {
    segments.push(data.description);
  }
  if (Array.isArray(data.fields)) {
    for (const field of data.fields) {
      if (typeof field?.name === 'string' && typeof field?.value === 'string') {
        segments.push(`${field.name}: ${field.value}`);
      }
    }
  }

  for (const segment of segments) {
    for (const line of segment.split('\n')) {
      if (!/status/i.test(line)) {
        continue;
      }

      // For change lines like "**Status**: Old → New", prefer the value after the arrow.
      const afterArrow = line.includes('→') ? line.slice(line.lastIndexOf('→') + 1) : line;
      const normalizedLine = normalizeStatus(afterArrow);
      const match = STATUS_BUTTONS.find(button => normalizedLine.includes(normalizeStatus(button.status)));
      if (match) {
        return normalizeStatus(match.status);
      }
    }
  }

  return null;
}

export function buildCardActionCustomId(status, pageId) {
  return `${CARD_ACTION_PREFIX}move:${status}:${pageId}`;
}

export function buildSnoozeCustomId(days, pageId) {
  return `${CARD_ACTION_PREFIX}snooze:${days}:${pageId}`;
}

export function parseCardActionCustomId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(CARD_ACTION_PREFIX)) {
    return null;
  }

  const parts = customId.split(':');
  if (parts.length !== 4) {
    return null;
  }

  const [, action, value, pageId] = parts;
  if (!value || !pageId) {
    return null;
  }

  if (action === 'move') {
    return { action: 'move', status: value, pageId };
  }

  if (action === 'snooze') {
    const days = parseInt(value, 10);
    if (!Number.isInteger(days) || days <= 0) {
      return null;
    }

    return { action: 'snooze', days, pageId };
  }

  return null;
}

/**
 * Build interactive components for a per-card notification embed.
 * Returns an array suitable for the `components` field of channel.send(),
 * or [] when the embed has no actionable Notion page.
 */
export function buildCardActionComponents(embed) {
  const data = getEmbedData(embed);
  if (isRemovedEmbed(data)) {
    return [];
  }

  const pageId = extractPageIdFromUrl(data.url);
  if (!pageId) {
    return [];
  }

  const currentStatus = detectCurrentStatusFromEmbed(data);
  const row = new ActionRowBuilder();

  for (const { status, label, style } of STATUS_BUTTONS) {
    const button = new ButtonBuilder()
      .setCustomId(buildCardActionCustomId(status, pageId))
      .setLabel(label)
      .setStyle(style);

    // Disable the button matching the current status to avoid no-op clicks.
    if (currentStatus && normalizeStatus(status) === currentStatus) {
      button.setDisabled(true);
    }

    row.addComponents(button);
  }

  // Reminders get a snooze button so they stop nagging for a day.
  if (isReminderEmbed(data)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildSnoozeCustomId(1, pageId))
        .setLabel('Snooze 1 day')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (typeof data.url === 'string' && data.url.length > 0) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel('Open in Notion')
        .setStyle(ButtonStyle.Link)
        .setURL(data.url)
    );
  }

  return [row];
}
