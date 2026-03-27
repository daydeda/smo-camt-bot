import { EmbedBuilder } from 'discord.js';

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

/**
 * Formats a change into a human-readable string
 */
function formatChangeSummary(propName, change) {
  const formatDateTimeText = (value) => {
    if (typeof value !== 'string') {
      return null;
    }

    // Date only: 2026-03-28
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }

    // Date-time: 2026-03-28T20:00:00.000+07:00 -> 2026-03-28 20:00
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
      return `${value.slice(0, 10)} ${value.slice(11, 16)}`;
    }

    return null;
  };

  const formatValue = (val) => {
    if (Array.isArray(val)) return val.join(', ') || 'None';
    if (val === null || val === undefined) return 'None';
    if (typeof val === 'object') return JSON.stringify(val);
    const formattedDate = formatDateTimeText(val);
    if (formattedDate) return formattedDate;
    return String(val);
  };

  const old = formatValue(change.old);
  const newVal = formatValue(change.new);

  return `**${propName}**: ${old} → ${newVal}`;
}

function formatFieldValue(value) {
  const formatDateTimeText = (raw) => {
    if (typeof raw !== 'string') {
      return null;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw;
    }

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
      return `${raw.slice(0, 10)} ${raw.slice(11, 16)}`;
    }

    return null;
  };

  if (Array.isArray(value)) {
    return value.join(', ') || 'None';
  }

  if (value === null || value === undefined || value === '') {
    return 'None';
  }

  const formattedDate = formatDateTimeText(value);
  if (formattedDate) {
    return formattedDate;
  }

  return String(value);
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

function getCardName(card) {
  let cardName = card?.properties?.['กิจกรรม'];

  if (!cardName) {
    cardName = Object.values(card?.properties || {}).find(
      prop => typeof prop === 'string' && prop.length > 0 && prop.length < 200
    );
  }

  return cardName || `Card ${card.id.substring(0, 8)}`;
}

/**
 * Creates a Discord embed for property changes.
 */
function createChangeEmbed(cardName, cardUrl, changes, cardData) {
  const changedEntries = Object.entries(changes);
  const hasStatusChange = changedEntries.some(([key]) => key.toLowerCase() === 'status');
  const color = hasStatusChange ? 0x00AA44 : 0xF39C12;

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

  return embed;
}

function createCreatedEmbed(cardName, cardUrl, cardData) {
  const embed = new EmbedBuilder()
    .setTitle(`🆕 ${cardName || 'Task Created'}`)
    .setURL(cardUrl)
    .setColor(0x3498DB)
    .setDescription('New card created in Notion database')
    .setTimestamp();

  addCommonFields(embed, cardData);

  return embed;
}

function createRemovedEmbed(cardName, cardUrl, cardData) {
  const embed = new EmbedBuilder()
    .setTitle(`🗑️ ${cardName || 'Task Removed'}`)
    .setURL(cardUrl)
    .setColor(0xE74C3C)
    .setDescription('Card removed from Notion database')
    .setTimestamp();

  addCommonFields(embed, cardData);

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
  const isInitialSync = oldCardIds.length === 0;
  let skippedNewCards = 0;
  let isFirstCard = true;

  for (const newCard of newCards) {
    const oldCard = oldState.getCardState(newCard.id);

    if (!oldCard) {
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
    if (!newCards.find(c => c.id === oldCardId)) {
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
