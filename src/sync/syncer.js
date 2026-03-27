import { EmbedBuilder } from 'discord.js';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SUPPORT_FOOTER_TEXT = 'Need help? Contact on IG: dda.day or on Discord.';
const STATUS_BUCKETS = ['notStarted', 'inProgress', 'inReview', 'done'];

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
    return `${value.slice(8, 10)}-${value.slice(5, 7)}-${value.slice(0, 4)}`;
  }

  if (DATETIME_REGEX.test(value)) {
    return `${value.slice(8, 10)}-${value.slice(5, 7)}-${value.slice(0, 4)} ${value.slice(11, 16)}`;
  }

  return null;
}

function toDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateLabel(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

function parseNotionDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  if (DATE_ONLY_REGEX.test(value)) {
    const [year, month, day] = value.split('-').map(part => parseInt(part, 10));
    return new Date(year, month - 1, day);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function isDateTimeValue(value) {
  return typeof value === 'string' && DATETIME_REGEX.test(value);
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

function normalizeLookupText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function collectDepartmentNames(departmentValue) {
  if (Array.isArray(departmentValue)) {
    return departmentValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof departmentValue === 'string') {
    return departmentValue
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function formatDepartmentWithRoleMention(departmentValue, departmentRoleMentions = {}) {
  const departmentNames = collectDepartmentNames(departmentValue);

  const mentionSet = new Set();
  for (const departmentName of departmentNames) {
    const normalizedKey = normalizeLookupText(departmentName);
    const mention = departmentRoleMentions[normalizedKey];
    if (mention) {
      mentionSet.add(mention);
    }
  }

  if (mentionSet.size === 0) {
    return 'None';
  }

  return Array.from(mentionSet).join(' ');
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

function addCommonFields(embed, cardData, departmentRoleMentions = {}) {
  const departmentText = formatDepartmentWithRoleMention(
    cardData?.properties?.Department,
    departmentRoleMentions
  );
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

function getStatusValue(properties = {}) {
  const exactStatus = properties.Status;
  if (typeof exactStatus === 'string') {
    return exactStatus;
  }

  const statusKey = Object.keys(properties).find(key => key.toLowerCase().includes('status'));
  if (statusKey && typeof properties[statusKey] === 'string') {
    return properties[statusKey];
  }

  return null;
}

function mapStatusBucket(statusText) {
  const normalized = normalizeStatusText(statusText);

  if (
    normalized === 'not started' ||
    normalized === 'todo' ||
    normalized === 'to do' ||
    normalized === 'backlog'
  ) {
    return 'notStarted';
  }

  if (normalized === 'in progress' || normalized === 'doing' || normalized === 'progress') {
    return 'inProgress';
  }

  if (normalized === 'in review' || normalized === 'review') {
    return 'inReview';
  }

  if (
    normalized === 'done' ||
    normalized === 'complete' ||
    normalized === 'completed'
  ) {
    return 'done';
  }

  return null;
}

function getDeadlineValue(properties = {}) {
  if (typeof properties.Date === 'string') {
    return properties.Date;
  }

  const deadlineKey = Object.keys(properties).find(key => {
    const normalized = key.toLowerCase();
    return normalized.includes('deadline') || normalized.includes('due') || normalized === 'date';
  });

  if (!deadlineKey) {
    return null;
  }

  return typeof properties[deadlineKey] === 'string' ? properties[deadlineKey] : null;
}

function isOverdue(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly) {
  if (!deadlineDate) {
    return false;
  }

  if (statusBucket === 'done') {
    return false;
  }

  if (isDateTimeValue(deadlineRaw)) {
    return deadlineDate.getTime() < now.getTime();
  }

  return toDateOnly(deadlineDate).getTime() < nowDateOnly.getTime();
}

function isDueInOneDay(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly) {
  if (!deadlineDate || statusBucket === 'done') {
    return false;
  }

  if (isDateTimeValue(deadlineRaw)) {
    const diffMs = deadlineDate.getTime() - now.getTime();
    return diffMs > 0 && diffMs <= 24 * 60 * 60 * 1000;
  }

  const reminderDate = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate() - 1);
  return reminderDate.getTime() === nowDateOnly.getTime();
}

export function buildDailyReportSummary(cards, now = new Date()) {
  const counts = {
    notStarted: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    overdue: 0,
  };

  const nowDateOnly = toDateOnly(now);

  for (const card of cards) {
    const properties = card?.properties || {};
    const statusValue = getStatusValue(properties);
    const statusBucket = mapStatusBucket(statusValue);
    const deadlineRaw = getDeadlineValue(properties);
    const deadlineDate = parseNotionDate(deadlineRaw);

    if (STATUS_BUCKETS.includes(statusBucket)) {
      counts[statusBucket] += 1;
    }

    if (isOverdue(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly)) {
      counts.overdue += 1;
    }
  }

  return {
    counts,
    generatedAt: now,
    totalCards: cards.length,
  };
}

export function createDailyReportEmbed(cards, now = new Date()) {
  const report = buildDailyReportSummary(cards, now);
  const reportDate = formatDateLabel(now);

  const embed = new EmbedBuilder()
    .setTitle(`📊 Daily Report (${reportDate})`)
    .setColor(0x1F8B4C)
    .setDescription('Summary of current task statuses from Notion')
    .addFields(
      { name: 'Not Started', value: String(report.counts.notStarted), inline: true },
      { name: 'In-Progress', value: String(report.counts.inProgress), inline: true },
      { name: 'In-Review', value: String(report.counts.inReview), inline: true },
      { name: 'Done', value: String(report.counts.done), inline: true },
      { name: 'Overdue', value: String(report.counts.overdue), inline: true },
      { name: 'Total Cards', value: String(report.totalCards), inline: true }
    )
    .setTimestamp(now);

  addSupportFooter(embed);
  return embed;
}

export function createDeadlineReminderEmbeds(
  cards,
  departmentRoleMentions = {},
  reminderStateByCardId = {},
  now = new Date(),
  options = {}
) {
  const { ignoreDailyLimit = false } = options;
  const embeds = [];
  const updatedReminderStateByCardId = { ...reminderStateByCardId };
  const todayKey = formatDateKey(now);
  const nowDateOnly = toDateOnly(now);

  for (const card of cards) {
    const properties = card?.properties || {};
    const statusValue = getStatusValue(properties);
    const statusBucket = mapStatusBucket(statusValue);
    const deadlineRaw = getDeadlineValue(properties);
    const deadlineDate = parseNotionDate(deadlineRaw);

    const overdue = isOverdue(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly);
    const dueInOneDay = isDueInOneDay(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly);
    if (!overdue && !dueInOneDay) {
      continue;
    }

    const lastReminderDate = updatedReminderStateByCardId[card.id];
    if (!ignoreDailyLimit && lastReminderDate === todayKey) {
      continue;
    }

    const cardName = getCardName(card);
    const dueLabel = deadlineRaw ? formatFieldValue(deadlineRaw) : 'None';
    const description = overdue
      ? `This card is overdue. Deadline: **${dueLabel}**`
      : `This card is due in 1 day. Deadline: **${dueLabel}**`;

    const embed = new EmbedBuilder()
      .setTitle(`⏰ Deadline Reminder: ${cardName}`)
      .setURL(card.url)
      .setColor(overdue ? 0xE74C3C : 0xF39C12)
      .setDescription(description)
      .setTimestamp(now);

    addCommonFields(embed, card, departmentRoleMentions);
    addSupportFooter(embed);

    embeds.push(embed);
    updatedReminderStateByCardId[card.id] = todayKey;
  }

  return {
    embeds,
    reminderStateByCardId: updatedReminderStateByCardId,
  };
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
function createChangeEmbed(cardName, cardUrl, changes, cardData, departmentRoleMentions = {}) {
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
  addCommonFields(embed, cardData, departmentRoleMentions);
  addSupportFooter(embed);

  return embed;
}

function createCreatedEmbed(cardName, cardUrl, cardData, departmentRoleMentions = {}) {
  const embed = new EmbedBuilder()
    .setTitle(`🆕 ${cardName || 'Task Created'}`)
    .setURL(cardUrl)
    .setColor(0x9B59B6)
    .setDescription('New card created in Notion database')
    .setTimestamp();

  addCommonFields(embed, cardData, departmentRoleMentions);
  addSupportFooter(embed);

  return embed;
}

function createRemovedEmbed(cardName, cardUrl, cardData, departmentRoleMentions = {}) {
  const embed = new EmbedBuilder()
    .setTitle(`🗑️ ${cardName || 'Task Removed'}`)
    .setURL(cardUrl)
    .setColor(0xFF3B30)
    .setDescription('Card removed from Notion database')
    .setTimestamp();

  addCommonFields(embed, cardData, departmentRoleMentions);
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
export function createChangeEmbeds(changedCards, departmentRoleMentions = {}) {
  return changedCards.map(card => {
    const cardName = getCardName(card);

    return createChangeEmbed(cardName, card.url, card.changes, card, departmentRoleMentions);
  });
}

/**
 * Creates Discord embeds for created cards.
 */
export function createCreatedEmbeds(createdCards, departmentRoleMentions = {}) {
  return createdCards.map(card => {
    const cardName = getCardName(card);
    return createCreatedEmbed(cardName, card.url, card, departmentRoleMentions);
  });
}

/**
 * Creates Discord embeds for removed cards.
 */
export function createRemovedEmbeds(deletedCards, departmentRoleMentions = {}) {
  return deletedCards.map(card => {
    const cardName = getCardName(card);
    return createRemovedEmbed(cardName, card.url, card, departmentRoleMentions);
  });
}

export default {
  detectChanges,
  findChangedCards,
  createChangeEmbeds,
  createCreatedEmbeds,
  createRemovedEmbeds,
  createDailyReportEmbed,
  createDeadlineReminderEmbeds,
  buildDailyReportSummary,
};
