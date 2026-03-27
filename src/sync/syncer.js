import { EmbedBuilder } from 'discord.js';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SUPPORT_FOOTER_TEXT = 'Need help? Contact on IG: dda.day or on Discord.';

/**
 * Normalizes values so comparisons are deterministic.
 */
function normalizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value.trim().replace(/\s+/g, ' ');
  }

  if (Array.isArray(value)) {
    const normalizedArray = value.map(normalizeValue);
    const sortedArray = normalizedArray.sort((a, b) => {
      const aString = JSON.stringify(a);
      const bString = JSON.stringify(b);
      return aString.localeCompare(bString);
    });

    return sortedArray;
  }

  if (typeof value === 'object') {
    const normalizedObject = {};

    for (const key of Object.keys(value).sort()) {
      normalizedObject[key] = normalizeValue(value[key]);
    }

    return normalizedObject;
  }

  return value;
}

/**
 * Compares two property values and detects if they changed.
 */
function hasPropertyChanged(oldValue, newValue) {
  const normalizedOld = normalizeValue(oldValue);
  const normalizedNew = normalizeValue(newValue);

  return JSON.stringify(normalizedOld) !== JSON.stringify(normalizedNew);
}

/**
 * Detects changes in all card properties.
 */
function detectChanges(oldCard, newCard, firstCheck = false) {
  const changes = {};

  if (!oldCard) {
    return changes;
  }

  const oldProperties = oldCard.properties || {};
  const newProperties = newCard.properties || {};

  if (firstCheck) {
    console.log(`📍 Tracking ${Object.keys(newProperties).length} properties`);
  }

  for (const [propertyName, newValue] of Object.entries(newProperties)) {
    const oldValue = oldProperties[propertyName];
    if (hasPropertyChanged(oldValue, newValue)) {
      changes[propertyName] = {
        old: oldValue,
        new: newValue,
      };
    }
  }

  // Track properties that existed before but were removed.
  for (const [propertyName, oldValue] of Object.entries(oldProperties)) {
    if (!Object.hasOwn(newProperties, propertyName)) {
      changes[propertyName] = {
        old: oldValue,
        new: null,
      };
    }
  }

  return changes;
}

function formatDateTimeText(value) {
  if (typeof value !== 'string') {
    return null;
  }

  if (DATE_ONLY_REGEX.test(value)) {
    return value;
  }

  if (DATETIME_REGEX.test(value)) {
    return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
  }

  return null;
}

function formatScalarValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'None';
  }

  const formattedDate = formatDateTimeText(value);
  if (formattedDate) {
    return formattedDate;
  }

  return String(value);
}

/**
 * Formats a change into a human-readable string
 */
function formatChangeSummary(propName, change) {
  const formatValue = (val) => {
    if (Array.isArray(val)) return val.join(', ') || 'None';
    if (typeof val === 'object') return JSON.stringify(val);
    return formatScalarValue(val);
  };

  const old = formatValue(change.old);
  const newVal = formatValue(change.new);

  return `**${propName}**: ${old} → ${newVal}`;
}

function formatFieldValue(value) {
  if (Array.isArray(value)) {
    return value.join(', ') || 'None';
  }

  return formatScalarValue(value);
}

function truncateFieldValue(value, maxLength = 1024) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatMeetingMinutesField(value) {
  if (!Array.isArray(value)) {
    return formatFieldValue(value);
  }

  if (value.length === 0) {
    return 'None';
  }

  const titleLines = value.map(item => String(item));
  return titleLines.join('\n');
}

function addCommonFields(embed, cardData) {
  const departmentText = formatFieldValue(cardData?.properties?.Department);
  const dateText = formatFieldValue(cardData?.properties?.Date);
  const meetingMinutesText = formatMeetingMinutesField(
    cardData?.properties?.['รายงานการประชุม (Meeting Minutes)']
  );

  embed.addFields(
    { name: '🏢 Department', value: truncateFieldValue(departmentText), inline: true },
    { name: '📅 Date', value: truncateFieldValue(dateText), inline: true },
    {
      name: '📝 รายงานการประชุม (Meeting Minutes)',
      value: truncateFieldValue(meetingMinutesText),
      inline: false,
    }
  );
}

function addSupportFooter(embed) {
  embed.setFooter({ text: SUPPORT_FOOTER_TEXT });
}

function getCardName(card) {
  let cardName = card?.properties?.['กิจกรรม'];

  if (!cardName) {
    cardName = Object.values(card?.properties || {}).find(
      prop => typeof prop === 'string' && prop.length > 0 && prop.length < 200
    );
  }

  return cardName || `Card ${card.id.substring(0, 8)}`;
}

function normalizeStatusText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function getColorByStatus(changes) {
  const statusEntry = Object.entries(changes).find(([key]) => key.toLowerCase().includes('status'));
  if (!statusEntry) {
    return 0x5865F2; // Blurple for non-status changes
  }

  const [, statusChange] = statusEntry;
  const normalizedNextStatus = normalizeStatusText(statusChange?.new);

  if (normalizedNextStatus === 'in progress') {
    return 0x4FC3F7; // Sky blue
  }

  if (normalizedNextStatus === 'in review') {
    return 0xF5A623; // Yellow-orange
  }

  if (normalizedNextStatus === 'done') {
    return 0x2ECC71; // Green
  }

  if (normalizedNextStatus === 'not started') {
    return 0x95A5A6; // Gray
  }

  return 0x5865F2;
}

/**
 * Creates a Discord embed for property changes.
 */
function createChangeEmbed(cardName, cardUrl, changes, cardData) {
  const changedEntries = Object.entries(changes);
  const color = getColorByStatus(changes);

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${cardName || 'Task Updated'}`)
    .setURL(cardUrl)
    .setColor(color)
    .setTimestamp();

  const maxVisibleChanges = 10;
  const visibleChanges = changedEntries.slice(0, maxVisibleChanges);
  const summaryLines = visibleChanges.map(([propertyName, change]) =>
    formatChangeSummary(propertyName, change)
  );

  if (changedEntries.length > maxVisibleChanges) {
    summaryLines.push(`...and ${changedEntries.length - maxVisibleChanges} more change(s)`);
  }

  embed.setDescription(summaryLines.join('\n'));
  addCommonFields(embed, cardData);
  addSupportFooter(embed);

  return embed;
}

function createCreatedEmbed(cardName, cardUrl, cardData) {
  const embed = new EmbedBuilder()
    .setTitle(`🆕 ${cardName || 'Task Created'}`)
    .setURL(cardUrl)
    .setColor(0x9B59B6)
    .setDescription('New card created in Notion database')
    .setTimestamp();

  addCommonFields(embed, cardData);
  addSupportFooter(embed);

  return embed;
}

function createRemovedEmbed(cardName, cardUrl, cardData) {
  const embed = new EmbedBuilder()
    .setTitle(`🗑️ ${cardName || 'Task Removed'}`)
    .setURL(cardUrl)
    .setColor(0xFF3B30)
    .setDescription('Card removed from Notion database')
    .setTimestamp();

  addCommonFields(embed, cardData);
  addSupportFooter(embed);

  return embed;
}

/**
 * Detects all changes between old and new database states
 * Returns an array of cards that have changed
 */
export function findChangedCards(oldState, newCards) {
  const changedCards = [];
  const createdCards = [];
  const deletedCards = [];
  const oldCardIds = oldState.getAllCardIds();
  // Set lookup keeps deletion detection O(n) instead of O(n^2).
  const newCardIdSet = new Set(newCards.map(card => card.id));
  const isInitialSync = oldCardIds.length === 0;
  let skippedNewCards = 0;
  let isFirstCard = true;

  for (const newCard of newCards) {
    const oldCard = oldState.getCardState(newCard.id);

    if (!oldCard) {
      // Initial import becomes baseline; later unseen cards are true "created" events.
      if (isInitialSync) {
        skippedNewCards += 1;
      } else {
        createdCards.push(newCard);
      }
      isFirstCard = false;
      continue;
    }

    const changes = detectChanges(oldCard, newCard, isFirstCard);
    isFirstCard = false;

    if (Object.keys(changes).length > 0) {
      console.log(`  📝 Change detected in card:`, {
        properties: Object.keys(changes),
      });
      changedCards.push({
        ...newCard,
        changes,
      });
    }
  }

  // Detect deleted cards
  const deletedCardIds = [];
  for (const oldCardId of oldCardIds) {
    if (!newCardIdSet.has(oldCardId)) {
      deletedCardIds.push(oldCardId);

      const removedCard = oldState.getCardState(oldCardId);
      if (removedCard) {
        deletedCards.push(removedCard);
      }
    }
  }

  return { changedCards, createdCards, deletedCards, deletedCardIds, skippedNewCards };
}

/**
 * Creates Discord embeds for all changed cards.
 */
export function createChangeEmbeds(changedCards) {
  return changedCards.map(card => {
    const cardName = getCardName(card);

    return createChangeEmbed(cardName, card.url, card.changes, card);
  });
}

/**
 * Creates Discord embeds for created cards.
 */
export function createCreatedEmbeds(createdCards) {
  return createdCards.map(card => {
    const cardName = getCardName(card);
    return createCreatedEmbed(cardName, card.url, card);
  });
}

/**
 * Creates Discord embeds for removed cards.
 */
export function createRemovedEmbeds(deletedCards) {
  return deletedCards.map(card => {
    const cardName = getCardName(card);
    return createRemovedEmbed(cardName, card.url, card);
  });
}

export default {
  detectChanges,
  findChangedCards,
  createChangeEmbeds,
  createCreatedEmbeds,
  createRemovedEmbeds,
};
