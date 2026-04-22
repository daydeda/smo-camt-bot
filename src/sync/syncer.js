import { EmbedBuilder } from 'discord.js';
import config from '../config.js';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const SUPPORT_FOOTER_TEXT = 'Need help? Contact on IG: dda.day or on Discord.';
const STATUS_BUCKETS = ['notStarted', 'inProgress', 'inReview', 'done'];
const CALENDAR_MAX_LINES = 20;
const CALENDAR_DESCRIPTION_MAX_LENGTH = 3500;
const REQUIRED_CREATE_FIELDS = ['กิจกรรม', 'Department', 'Date'];

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
function isEmptyValue(val) {
  if (val === null || val === undefined || val === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

function hasPropertyChanged(oldValue, newValue) {
  if (isEmptyValue(oldValue) && isEmptyValue(newValue)) return false;

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

  const normalizedValue = value.trim();

  if (DATE_ONLY_REGEX.test(normalizedValue)) {
    return `${normalizedValue.slice(8, 10)}-${normalizedValue.slice(5, 7)}-${normalizedValue.slice(0, 4)}`;
  }

  if (DATETIME_REGEX.test(normalizedValue)) {
    const date = new Date(normalizedValue);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    try {
      const timezone = config?.notion?.timezone || 'Asia/Bangkok';
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      const parts = formatter.formatToParts(date);
      const p = {};
      for (const { type, value: partValue } of parts) {
        p[type] = partValue;
      }

      return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
    } catch (error) {
      // Fallback to UTC slice if Intl fails or timezone is invalid
      return `${normalizedValue.slice(8, 10)}-${normalizedValue.slice(5, 7)}-${normalizedValue.slice(0, 4)} ${normalizedValue.slice(11, 16)}`;
    }
  }

  return null;
}

function splitDateRangeValue(value) {
  if (typeof value !== 'string') {
    return { start: null, end: null };
  }

  const [startPart, endPart] = value.split('→').map(part => part?.trim());

  return {
    start: startPart || null,
    end: endPart || null,
  };
}

function getDatePartForEvaluation(value, { preferEnd = false } = {}) {
  const { start, end } = splitDateRangeValue(value);
  if (preferEnd && typeof end === 'string') {
    return end;
  }

  return start;
}

function formatDateRangeText(value) {
  const { start, end } = splitDateRangeValue(value);
  if (!start || !end) {
    return null;
  }

  const startText = formatDateTimeText(start) || start;
  const endText = formatDateTimeText(end) || end;
  return `${startText} → ${endText}`;
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

function parseNotionDate(value, { preferEnd = false } = {}) {
  const candidateDate = getDatePartForEvaluation(value, { preferEnd });
  if (typeof candidateDate !== 'string') {
    return null;
  }

  if (DATE_ONLY_REGEX.test(candidateDate)) {
    const [year, month, day] = candidateDate.split('-').map(part => parseInt(part, 10));
    return new Date(year, month - 1, day);
  }

  const parsed = new Date(candidateDate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function isDateTimeValue(value, { preferEnd = false } = {}) {
  const candidateDate = getDatePartForEvaluation(value, { preferEnd });
  return typeof candidateDate === 'string' && DATETIME_REGEX.test(candidateDate);
}

function formatScalarValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'None';
  }

  const formattedDateRange = formatDateRangeText(value);
  if (formattedDateRange) {
    return formattedDateRange;
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
  const properties = cardData?.properties || {};

  // 🏢 Department
  const departmentText = formatDepartmentWithRoleMention(properties.Department, departmentRoleMentions);
  if (departmentText && departmentText !== 'None') {
    embed.addFields({
      name: '🏢 Department',
      value: truncateFieldValue(departmentText),
      inline: true,
    });
  }

  // 📅 Date
  const dateText = formatFieldValue(properties.Date);
  if (dateText && dateText !== 'None') {
    embed.addFields({
      name: '📅 Date',
      value: truncateFieldValue(dateText),
      inline: true,
    });
  }

  // 📄 ร่างโครงการ (Project Draft)
  const projectDraftText = formatFieldValue(properties['ร่างโครงการ (Project Draft)']);
  if (projectDraftText && projectDraftText !== 'None') {
    embed.addFields({
      name: '📄 ร่างโครงการ (Project Draft)',
      value: truncateFieldValue(projectDraftText),
      inline: false,
    });
  }

  // 📝 รายงานการประชุม (Meeting Minutes)
  const meetingMinutesText = formatMeetingMinutesField(
    properties['รายงานการประชุม (Meeting Minutes)']
  );
  if (meetingMinutesText && meetingMinutesText !== 'None') {
    embed.addFields({
      name: '📝 รายงานการประชุม (Meeting Minutes)',
      value: truncateFieldValue(meetingMinutesText),
      inline: false,
    });
  }
}

function addSupportFooter(embed) {
  embed.setFooter({ text: SUPPORT_FOOTER_TEXT });
}

function formatActorDisplay(actorMeta) {
  if (!actorMeta || typeof actorMeta !== 'object') {
    return 'Unknown';
  }

  const actorName = typeof actorMeta.name === 'string' && actorMeta.name.trim().length > 0
    ? actorMeta.name.trim()
    : 'Unknown';
  const actorId = typeof actorMeta.id === 'string' && actorMeta.id.trim().length > 0
    ? actorMeta.id.replace(/-/g, '').slice(0, 8)
    : null;

  if (!actorId) {
    return actorName;
  }

  // Avoid repeating the ID if it's already in the display name
  if (actorName.includes(`(${actorId})`)) {
    return actorName;
  }

  return `${actorName} (${actorId})`;
}

function addCrudAuditField(embed, cardData, actionLabel, fallbackSource = 'Notion') {
  const meta = cardData?.meta && typeof cardData.meta === 'object' ? cardData.meta : {};
  const source = typeof meta.source === 'string' && meta.source.trim().length > 0
    ? meta.source.trim()
    : fallbackSource;
  const actor = meta.lastEditedBy || meta.createdBy || null;
  const actorText = formatActorDisplay(actor);
  const editedTimeRaw = meta.lastEditedTime || meta.createdTime || null;
  const editedTime = editedTimeRaw ? formatScalarValue(editedTimeRaw) : 'Unknown';

  embed.addFields({
    name: '🧾 CRUD Log',
    value: truncateFieldValue(
      [
        `Action: ${actionLabel}`,
        `Source: ${source}`,
        `Actor: ${actorText}`,
        `Edited: ${editedTime}`,
      ].join('\n')
    ),
    inline: false,
  });
}

function getOrganizationValues(properties = {}) {
  const orgValue = Object.entries(properties).find(
    ([key]) => {
      const low = key.toLowerCase();
      return low.includes('organization') || low.includes('organisation') || low === 'องค์กร';
    }
  )?.[1];

  if (Array.isArray(orgValue)) {
    return orgValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof orgValue === 'string') {
    return orgValue
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
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
  const statusValue = Object.entries(properties).find(
    ([key]) => {
      const low = key.toLowerCase();
      return low === 'status' || low === 'state' || low === 'เบอร์' || low === 'สถานะ';
    }
  )?.[1];

  return typeof statusValue === 'string' ? statusValue : null;
}

function mapStatusBucket(statusText) {
  const normalized = normalizeStatusText(statusText);
  const hasWord = (word) => new RegExp(`(^|\\s)${word}(\\s|$)`).test(normalized);

  if (
    hasWord('not started') ||
    hasWord('todo') ||
    hasWord('to do') ||
    hasWord('backlog')
  ) {
    return 'notStarted';
  }

  if (hasWord('in progress') || hasWord('doing') || hasWord('progress')) {
    return 'inProgress';
  }

  if (hasWord('in review') || hasWord('review')) {
    return 'inReview';
  }

  if (
    hasWord('done') ||
    hasWord('complete') ||
    hasWord('completed')
  ) {
    return 'done';
  }

  return null;
}

function getDeadlineValue(properties) {
  // First try the common English/Thai keywords
  const entry = Object.entries(properties).find(([key]) => {
    const low = key.toLowerCase();
    return (
      low.includes('deadline') ||
      low.includes('due') ||
      low === 'date' ||
      low === 'วันที่' ||
      low === 'เวลา'
    );
  });

  if (entry) {
    return entry[1];
  }

  // Fallback: look for any property that has the Notion date extraction signature we use
  const dateEntry = Object.values(properties).find(
    val => val && typeof val === 'object' && val.type === 'date'
  );

  return dateEntry || null;
}

function isOverdue(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly, deadlineIsDateTime = false) {
  if (!deadlineDate) {
    return false;
  }

  if (statusBucket === 'done') {
    return false;
  }

  if (deadlineIsDateTime) {
    return deadlineDate.getTime() < now.getTime();
  }

  return toDateOnly(deadlineDate).getTime() < nowDateOnly.getTime();
}

function isDueInOneDay(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly, deadlineIsDateTime = false) {
  if (!deadlineDate || statusBucket === 'done') {
    return false;
  }

  if (deadlineIsDateTime) {
    const diffMs = deadlineDate.getTime() - now.getTime();
    return diffMs > 0 && diffMs <= 24 * 60 * 60 * 1000;
  }

  const reminderDate = new Date(deadlineDate.getFullYear(), deadlineDate.getMonth(), deadlineDate.getDate() - 1);
  return reminderDate.getTime() === nowDateOnly.getTime();
}

function formatDateRangeLabel(range, start, endExclusive) {
  if (range === 'all') {
    return 'All Time';
  }
  const end = new Date(endExclusive.getFullYear(), endExclusive.getMonth(), endExclusive.getDate() - 1);
  return `${formatDateLabel(start)} - ${formatDateLabel(end)}`;
}

function getRangeStart(range, now) {
  if (range === 'all') {
    return new Date(0); // Epoch start
  }

  const today = toDateOnly(now);

  if (range === 'today') {
    return today;
  }

  if (range === 'month') {
    return new Date(today.getFullYear(), today.getMonth(), 1);
  }

  const weekday = today.getDay();
  const diffToMonday = (weekday + 6) % 7;
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - diffToMonday);
}

function getRangeEndExclusive(range, rangeStart) {
  if (range === 'all') {
    return new Date(8640000000000000); // Max possible JS date
  }

  if (range === 'today') {
    return new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + 1);
  }

  if (range === 'month') {
    return new Date(rangeStart.getFullYear(), rangeStart.getMonth() + 1, 1);
  }

  return new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + 7);
}

function isDeadlineInsideRange(deadlineRaw, deadlineDate, rangeStart, rangeEndExclusive) {
  if (!deadlineDate) {
    return false;
  }

  // Range 'all' is handled by checking a special condition.
  // If either range bounds suggest 'All Time', we include everything with a date.
  if (rangeStart.getTime() <= 0 && rangeEndExclusive.getTime() > 1e15) {
    return true;
  }

  if (isDateTimeValue(deadlineRaw)) {
    const ms = deadlineDate.getTime();
    return ms >= rangeStart.getTime() && ms < rangeEndExclusive.getTime();
  }

  const deadlineDateOnly = toDateOnly(deadlineDate);
  const ms = deadlineDateOnly.getTime();
  return ms >= rangeStart.getTime() && ms < rangeEndExclusive.getTime();
}

function getStatusLabel(statusValue) {
  const normalized = mapStatusBucket(statusValue);

  if (normalized === 'notStarted') return 'Not Started';
  if (normalized === 'inProgress') return 'In Progress';
  if (normalized === 'inReview') return 'In Review';
  if (normalized === 'done') return 'Done';

  if (typeof statusValue === 'string' && statusValue.trim()) {
    return statusValue.trim();
  }

  return 'Unknown';
}

function buildCalendarLines(cardsInRange) {
  return cardsInRange.map(item => {
    const statusText = getStatusLabel(getStatusValue(item.card.properties || {}));
    const dueText = formatFieldValue(item.deadlineRaw || '');
    const taskName = getCardName(item.card);

    // Try to get a short organization prefix if there are multiple organizations
    const orgs = getOrganizationValues(item.card.properties || {});
    const orgPrefix = orgs.length > 0 ? `[${orgs[0].slice(0, 8)}] ` : '';

    return `• ${dueText} | ${statusText} | ${orgPrefix}${taskName}`;
  });
}

function getCardsInRange(cards, normalizedRange, now) {
  const rangeStart = getRangeStart(normalizedRange, now);
  const rangeEndExclusive = getRangeEndExclusive(normalizedRange, rangeStart);
  const cardsInRange = [];

  for (const card of cards) {
    const properties = card?.properties || {};
    const deadlineRaw = getDeadlineValue(properties);
    const deadlineDate = parseNotionDate(deadlineRaw);

    if (!isDeadlineInsideRange(deadlineRaw, deadlineDate, rangeStart, rangeEndExclusive)) {
      continue;
    }

    cardsInRange.push({
      card,
      deadlineRaw,
      deadlineDate,
      statusValue: getStatusValue(properties),
    });
  }

  cardsInRange.sort((a, b) => a.deadlineDate.getTime() - b.deadlineDate.getTime());

  return {
    cardsInRange,
    rangeStart,
    rangeEndExclusive,
  };
}

function createCalendarSummaryEmbed(cardsInRange, normalizedRange, now, rangeStart, rangeEndExclusive, options = {}) {
  const titleByRange = {
    today: '📅 Calendar: Today',
    week: '📅 Calendar: This Week',
    month: '📅 Monthly Overview',
    all: '📅 Calendar: All Tasks',
  };

  const headerText = options.title || titleByRange[normalizedRange];
  const rangeLabel = formatDateRangeLabel(normalizedRange, rangeStart, rangeEndExclusive);
  const lines = buildCalendarLines(cardsInRange);
  const visibleLines = lines.slice(0, CALENDAR_MAX_LINES);

  const statusCounts = {
    notStarted: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    unknown: 0,
  };

  for (const item of cardsInRange) {
    const bucket = mapStatusBucket(item.statusValue);
    if (bucket && Object.hasOwn(statusCounts, bucket)) {
      statusCounts[bucket] += 1;
    } else {
      statusCounts.unknown += 1;
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`${headerText} (${rangeLabel})`)
    .setColor(0x2D7D9A)
    .setTimestamp(now)
    .addFields(
      { name: 'Total Scheduled Tasks', value: String(cardsInRange.length), inline: true },
      { name: 'Range', value: normalizedRange, inline: true }
    );

  if (options.organization) {
    embed.addFields({ name: 'Organization', value: options.organization, inline: true });
  }

  embed.addFields(
    { name: 'Not Started', value: String(statusCounts.notStarted), inline: true },
    { name: 'In Progress', value: String(statusCounts.inProgress), inline: true },
    { name: 'In Review', value: String(statusCounts.inReview), inline: true },
    { name: 'Done', value: String(statusCounts.done), inline: true }
  );

  if (visibleLines.length === 0) {
    embed.setDescription('No scheduled tasks in this range.');
  } else {
    const extraCount = lines.length - visibleLines.length;
    const suffix = extraCount > 0 ? `\n...and ${extraCount} more task(s)` : '';
    embed.setDescription(`${visibleLines.join('\n')}${suffix}`);
  }

  addSupportFooter(embed);
  return embed;
}

function createCalendarDetailedEmbed(cardsInRange, normalizedRange, now, rangeStart, rangeEndExclusive) {
  const titleByRange = {
    today: '🗂️ Detailed Schedule: Today',
    week: '🗂️ Detailed Schedule: This Week',
    month: '🗂️ Detailed Schedule: This Month',
    all: '🗂️ Detailed Schedule: All Tasks',
  };

  const grouped = new Map();
  for (const item of cardsInRange) {
    const key = formatFieldValue(item.deadlineRaw || 'None');
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(item);
  }

  const sections = [];
  for (const [dueText, items] of grouped.entries()) {
    const lines = items.map(item => {
      const statusText = getStatusLabel(item.statusValue);
      const taskName = getCardName(item.card);
      return `- [${taskName}](${item.card.url}) (${statusText})`;
    });

    sections.push(`**${dueText}**\n${lines.join('\n')}`);
  }

  let description = sections.join('\n\n');
  if (!description) {
    description = 'No scheduled tasks in this range.';
  } else if (description.length > CALENDAR_DESCRIPTION_MAX_LENGTH) {
    description = `${description.slice(0, CALENDAR_DESCRIPTION_MAX_LENGTH - 3)}...`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`${titleByRange[normalizedRange]} (${formatDateRangeLabel(normalizedRange, rangeStart, rangeEndExclusive)})`)
    .setColor(0x1B4F72)
    .setDescription(description)
    .setTimestamp(now);

  addSupportFooter(embed);
  return embed;
}

export function createCalendarOverviewEmbeds(cards, range = 'week', now = new Date(), options = {}) {
  const normalizedRange = ['today', 'week', 'month', 'all'].includes(range) ? range : 'week';
  const { cardsInRange, rangeStart, rangeEndExclusive } = getCardsInRange(cards, normalizedRange, now);

  const summaryEmbed = createCalendarSummaryEmbed(
    cardsInRange,
    normalizedRange,
    now,
    rangeStart,
    rangeEndExclusive,
    options
  );
  const detailedEmbed = createCalendarDetailedEmbed(
    cardsInRange,
    normalizedRange,
    now,
    rangeStart,
    rangeEndExclusive
  );

  return [summaryEmbed, detailedEmbed];
}

export function createCalendarOverviewEmbed(cards, range = 'week', now = new Date(), options = {}) {
  return createCalendarOverviewEmbeds(cards, range, now, options)[0];
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
    const deadlineDate = parseNotionDate(deadlineRaw, { preferEnd: true });
    const deadlineIsDateTime = isDateTimeValue(deadlineRaw, { preferEnd: true });

    if (STATUS_BUCKETS.includes(statusBucket)) {
      counts[statusBucket] += 1;
    }

    if (isOverdue(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly, deadlineIsDateTime)) {
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
    const deadlineDate = parseNotionDate(deadlineRaw, { preferEnd: true });
    const deadlineIsDateTime = isDateTimeValue(deadlineRaw, { preferEnd: true });

    const overdue = isOverdue(deadlineRaw, deadlineDate, statusBucket, now, nowDateOnly, deadlineIsDateTime);
    const dueInOneDay = isDueInOneDay(
      deadlineRaw,
      deadlineDate,
      statusBucket,
      now,
      nowDateOnly,
      deadlineIsDateTime
    );
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
  addCrudAuditField(embed, cardData, 'Update');
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
  addCrudAuditField(embed, cardData, 'Create');
  addSupportFooter(embed);

  return embed;
}

function isFilledDetailValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0 && normalized !== 'none';
  }

  return true;
}

export function hasRequiredTaskDetails(card, requiredFields = REQUIRED_CREATE_FIELDS) {
  const properties = card?.properties || {};
  return requiredFields.every(fieldName => isFilledDetailValue(properties[fieldName]));
}

export function getMissingRequiredTaskDetails(card, requiredFields = REQUIRED_CREATE_FIELDS) {
  const properties = card?.properties || {};
  return requiredFields.filter(fieldName => !isFilledDetailValue(properties[fieldName]));
}

function hasStatusChangedToDone(changes = {}) {
  for (const [propertyName, change] of Object.entries(changes)) {
    if (!propertyName.toLowerCase().includes('status')) {
      continue;
    }

    const nextStatus = mapStatusBucket(change?.new);
    const prevStatus = mapStatusBucket(change?.old);
    return nextStatus === 'done' && prevStatus !== 'done';
  }

  return false;
}

export function getCompletedCards(changedCards = []) {
  return changedCards.filter(card => hasStatusChangedToDone(card?.changes || {}));
}

function createCompletedEmbed(cardName, cardUrl, cardData, departmentRoleMentions = {}) {
  const embed = new EmbedBuilder()
    .setTitle(`✅ ${cardName || 'Task Finished'}`)
    .setURL(cardUrl)
    .setColor(0x2ECC71)
    .setDescription('Task status changed to Done')
    .setTimestamp();

  addCommonFields(embed, cardData, departmentRoleMentions);
  addCrudAuditField(embed, cardData, 'Update');
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
  addCrudAuditField(embed, cardData, 'Delete');
  addSupportFooter(embed);

  return embed;
}

/**
 * Detects all changes between old and new database states
 * Returns an array of cards that have changed
 */
export function findChangedCards(oldState, trackedCards, allCards = []) {
  const changedCards = [];
  const createdCards = [];
  const deletedCards = [];
  const oldCardIds = oldState.getAllCardIds();
  // Set lookup keeps deletion detection O(n) instead of O(n^2).
  const trackedCardIdSet = new Set(trackedCards.map(card => card.id));
  const allCardIdSet = new Set(allCards.map(card => card.id));
  const isInitialSync = oldCardIds.length === 0;
  let skippedNewCards = 0;
  let isFirstCard = true;

  for (const trackedCard of trackedCards) {
    const oldCard = oldState.getCardState(trackedCard.id);

    if (!oldCard) {
      // Initial import becomes baseline; later unseen cards are true "created" events.
      if (isInitialSync) {
        skippedNewCards += 1;
      } else {
        createdCards.push(trackedCard);
      }
      isFirstCard = false;
      continue;
    }

    const changes = detectChanges(oldCard, trackedCard, isFirstCard);
    isFirstCard = false;

    if (Object.keys(changes).length > 0) {
      console.log(`  📝 Change detected in card:`, {
        properties: Object.keys(changes),
      });
      changedCards.push({
        ...trackedCard,
        changes,
      });
    }
  }

  // Detect deleted cards
  const deletedCardIds = [];
  const silentRemovedCardIds = [];

  for (const oldCardId of oldCardIds) {
    if (trackedCardIdSet.has(oldCardId)) {
      continue;
    }

    // If it's not in trackedCards, it's either deleted from Notion OR just filtered out.
    if (allCardIdSet.has(oldCardId)) {
      // Still exists in Notion, just no longer matches our department/scope filters.
      // We remove it from state silently to avoid noisy notifications.
      silentRemovedCardIds.push(oldCardId);
    } else {
      // Actually gone from Notion.
      deletedCardIds.push(oldCardId);

      const removedCard = oldState.getCardState(oldCardId);
      if (removedCard) {
        deletedCards.push(removedCard);
      }
    }
  }

  return {
    changedCards,
    createdCards,
    deletedCards,
    deletedCardIds,
    silentRemovedCardIds,
    skippedNewCards,
  };
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

export function createCompletedEmbeds(completedCards, departmentRoleMentions = {}) {
  return completedCards.map(card => {
    const cardName = getCardName(card);
    return createCompletedEmbed(cardName, card.url, card, departmentRoleMentions);
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
  createCompletedEmbeds,
  createRemovedEmbeds,
  getCompletedCards,
  hasRequiredTaskDetails,
  getMissingRequiredTaskDetails,
  createDailyReportEmbed,
  createDeadlineReminderEmbeds,
  buildDailyReportSummary,
  createCalendarOverviewEmbeds,
  createCalendarOverviewEmbed,
};
