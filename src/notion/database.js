import notion from './client.js';
import config from '../config.js';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DMY_ERA_REGEX = /^(\d{1,2})\/(\d{1,2})\/(\d+)(?:\s*(BC|BCE|AD|CE))?$/i;
const TIME_24H_REGEX = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const TIME_12H_REGEX = /^(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(AM|PM)$/i;
const PAGE_ID_WITHOUT_HYPHENS_REGEX = /^[0-9a-fA-F]{32}$/;
const PAGE_ID_WITH_HYPHENS_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATABASE_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTOCOMPLETE_MAX_CHOICES = 25;
const DEFAULT_ORGANIZATION = 'SMO CAMT';

let databaseSchemaCache = null;
let databaseSchemaFetchedAt = 0;
const relationTitlePersistentCache = new Map();

/**
 * Extracts text value from Notion rich text array
 */
function extractRichText(richTextArray) {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map(rt => rt.plain_text).join('');
}

function extractNotionDateValue(dateValue) {
  if (!dateValue?.start) {
    return null;
  }

  if (dateValue.end) {
    return `${dateValue.start} → ${dateValue.end}`;
  }

  return dateValue.start;
}

function extractPageTitleFromProperties(properties) {
  if (!properties || typeof properties !== 'object') {
    return null;
  }

  for (const property of Object.values(properties)) {
    if (property?.type === 'title') {
      return extractRichText(property.title) || null;
    }
  }

  return null;
}

function toNotionActorMeta(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }

  const id = typeof user.id === 'string' && user.id.trim().length > 0
    ? user.id
    : null;
  const name = typeof user.name === 'string' && user.name.trim().length > 0
    ? user.name.trim()
    : null;
  const email = typeof user.person?.email === 'string' && user.person.email.trim().length > 0
    ? user.person.email.trim()
    : null;
  const actorType = typeof user.type === 'string' && user.type.trim().length > 0
    ? user.type.trim()
    : null;

  const fallbackId = id ? id.replace(/-/g, '').slice(0, 8) : null;
  const displayName = name || email || (fallbackId ? `Unknown (${fallbackId})` : 'Unknown');

  return {
    id,
    name: displayName,
    type: actorType,
  };
}

function toHyphenatedPageId(compactPageId) {
  return [
    compactPageId.slice(0, 8),
    compactPageId.slice(8, 12),
    compactPageId.slice(12, 16),
    compactPageId.slice(16, 20),
    compactPageId.slice(20),
  ].join('-');
}

export function normalizeNotionPageId(pageIdOrUrl) {
  if (typeof pageIdOrUrl !== 'string' || pageIdOrUrl.trim().length === 0) {
    throw new Error('A Notion page ID (or page URL) is required.');
  }

  const rawValue = pageIdOrUrl.trim();
  const hyphenMatch = rawValue.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (hyphenMatch) {
    return hyphenMatch[0].toLowerCase();
  }

  const compactMatch = rawValue.match(/[0-9a-fA-F]{32}/);
  if (compactMatch) {
    return toHyphenatedPageId(compactMatch[0].toLowerCase());
  }

  if (PAGE_ID_WITH_HYPHENS_REGEX.test(rawValue)) {
    return rawValue.toLowerCase();
  }

  const compactRaw = rawValue.replace(/-/g, '');
  if (PAGE_ID_WITHOUT_HYPHENS_REGEX.test(compactRaw)) {
    return toHyphenatedPageId(compactRaw.toLowerCase());
  }

  throw new Error('Invalid Notion page ID format. Provide a page ID or Notion page URL.');
}

function normalizeDateForNotion(rawValue) {
  return buildNotionDateRangePayload(rawValue).start;
}

function extractSelectableOptionNames(propertyDefinition) {
  if (!propertyDefinition || typeof propertyDefinition !== 'object') {
    return [];
  }

  if (propertyDefinition.type === 'status') {
    return (propertyDefinition.status?.options || [])
      .map(option => option?.name)
      .filter(Boolean);
  }

  if (propertyDefinition.type === 'select') {
    return (propertyDefinition.select?.options || [])
      .map(option => option?.name)
      .filter(Boolean);
  }

  if (propertyDefinition.type === 'multi_select') {
    return (propertyDefinition.multi_select?.options || [])
      .map(option => option?.name)
      .filter(Boolean);
  }

  return [];
}

function toAutocompleteChoices(optionNames, focusedValue = '') {
  const normalizedFocused = String(focusedValue || '').trim().toLowerCase();
  const seen = new Set();

  const filtered = optionNames
    .map(name => String(name).trim())
    .filter(Boolean)
    .filter(name => {
      const normalizedName = name.toLowerCase();
      if (seen.has(normalizedName)) {
        return false;
      }

      seen.add(normalizedName);
      if (!normalizedFocused) {
        return true;
      }

      return normalizedName.includes(normalizedFocused);
    })
    .slice(0, AUTOCOMPLETE_MAX_CHOICES);

  return filtered.map(name => ({
    name,
    value: name,
  }));
}

function parseCommaSeparatedValues(rawValue) {
  if (typeof rawValue !== 'string') {
    return [];
  }

  return rawValue
    .split(/[\u002C\uFF0C\u3001]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function normalizeOptionKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeLookupText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function normalizeNotionEntityId(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/-/g, '');
}

function dedupeCaseInsensitive(values = []) {
  const seen = new Set();
  const uniqueValues = [];

  for (const value of values) {
    const normalized = normalizeOptionKey(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueValues.push(String(value).trim());
  }

  return uniqueValues;
}

function parseMultiValueInput(rawValue) {
  if (Array.isArray(rawValue)) {
    return dedupeCaseInsensitive(rawValue.map(item => String(item).trim()).filter(Boolean));
  }

  if (typeof rawValue === 'string') {
    return dedupeCaseInsensitive(parseCommaSeparatedValues(rawValue));
  }

  return [];
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function getDaysInMonth(year, month) {
  const monthIndex = Number(month);
  if (monthIndex === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  if ([4, 6, 9, 11].includes(monthIndex)) {
    return 30;
  }

  return 31;
}

function assertValidCalendarDate(year, month, day) {
  if (!Number.isInteger(year)) {
    throw new Error('Invalid year value.');
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Invalid month value. Month must be 1-12.');
  }

  if (!Number.isInteger(day) || day < 1 || day > getDaysInMonth(year, month)) {
    throw new Error('Invalid day value for this month/year.');
  }
}

function formatIsoYear(year) {
  if (year >= 0 && year <= 9999) {
    return String(year).padStart(4, '0');
  }

  const sign = year < 0 ? '-' : '+';
  return `${sign}${String(Math.abs(year)).padStart(6, '0')}`;
}

function parseTimeValue(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return null;
  }

  const value = rawValue.trim();
  const match24 = value.match(TIME_24H_REGEX);
  if (match24) {
    return {
      hour: Number.parseInt(match24[1], 10),
      minute: Number.parseInt(match24[2], 10),
    };
  }

  const match12 = value.match(TIME_12H_REGEX);
  if (match12) {
    let hour = Number.parseInt(match12[1], 10);
    const minute = Number.parseInt(match12[2] || '0', 10);
    const period = match12[3].toUpperCase();

    if (period === 'AM') {
      hour = hour % 12;
    } else {
      hour = (hour % 12) + 12;
    }

    return { hour, minute };
  }

  throw new Error('Invalid time value. Use 24-hour HH:mm or 12-hour h:mm AM/PM.');
}

function parseDateValue(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) {
    throw new Error('Date is required. Use DD/MM/YYYY [AD|BC], YYYY-MM-DD, or a valid ISO datetime.');
  }

  const dmyMatch = value.match(DMY_ERA_REGEX);
  if (dmyMatch) {
    const [, dayText, monthText, yearText, eraText] = dmyMatch;
    const day = Number.parseInt(dayText, 10);
    const month = Number.parseInt(monthText, 10);
    const parsedYear = Number.parseInt(yearText, 10);

    if (Number.isNaN(parsedYear) || parsedYear <= 0) {
      throw new Error('Invalid DD/MM/YYYY date. Year must be a positive integer.');
    }

    const normalizedEra = (eraText || 'AD').toUpperCase();
    const astronomicalYear = normalizedEra === 'BC' || normalizedEra === 'BCE'
      ? 1 - parsedYear
      : parsedYear;

    assertValidCalendarDate(astronomicalYear, month, day);

    return {
      mode: 'calendar',
      year: astronomicalYear,
      month,
      day,
    };
  }

  if (DATE_ONLY_REGEX.test(value)) {
    const [yearText, monthText, dayText] = value.split('-');
    const year = Number.parseInt(yearText, 10);
    const month = Number.parseInt(monthText, 10);
    const day = Number.parseInt(dayText, 10);
    assertValidCalendarDate(year, month, day);

    return {
      mode: 'calendar',
      year,
      month,
      day,
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date value. Use DD/MM/YYYY [AD|BC], YYYY-MM-DD, or a valid ISO datetime.');
  }

  const hasTime = /T\d{2}:\d{2}/.test(value);
  const hasExplicitOffset = /(?:Z|[+\-]\d{2}:\d{2})$/i.test(value);

  return {
    mode: 'iso',
    iso: value,
    hasTime,
    hasExplicitOffset,
  };
}

function buildDateStringFromCalendar(parts, timeParts = null) {
  const year = formatIsoYear(parts.year);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');

  if (!timeParts) {
    return `${year}-${month}-${day}`;
  }

  const hour = String(timeParts.hour).padStart(2, '0');
  const minute = String(timeParts.minute).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:00`;
}

function buildNotionDateTimeValue(dateValue, timeValue, label = 'date') {
  const parsedDate = parseDateValue(dateValue);
  const parsedTime = parseTimeValue(timeValue);

  if (parsedDate.mode === 'iso') {
    if (parsedTime) {
      throw new Error(`When ${label} includes a separate time, date must use DD/MM/YYYY [AD|BC] or YYYY-MM-DD.`);
    }

    return {
      value: parsedDate.iso,
      hasTime: Boolean(parsedDate.hasTime),
      canAttachTimeZone: Boolean(parsedDate.hasTime) && !parsedDate.hasExplicitOffset,
    };
  }

  return {
    value: buildDateStringFromCalendar(parsedDate, parsedTime),
    hasTime: Boolean(parsedTime),
    canAttachTimeZone: Boolean(parsedTime),
  };
}

function buildNotionDateRangePayload(rawValue) {
  if (typeof rawValue === 'string') {
    const startMeta = buildNotionDateTimeValue(rawValue, null, 'start date');
    return {
      start: startMeta.value,
      shouldSetTimeZone: startMeta.hasTime && startMeta.canAttachTimeZone,
    };
  }

  if (!rawValue || typeof rawValue !== 'object') {
    throw new Error('Date is required. Use DD/MM/YYYY [AD|BC], YYYY-MM-DD, or ISO datetime.');
  }

  const startDate = rawValue.startDate || rawValue.date;
  const startTime = rawValue.startTime || null;
  const endDateRaw = rawValue.endDate || null;
  const endTime = rawValue.endTime || null;

  if (typeof startDate !== 'string' || startDate.trim().length === 0) {
    throw new Error('start_date is required when setting date/time fields.');
  }

  const startMeta = buildNotionDateTimeValue(startDate, startTime, 'start date');
  const hasEnd = Boolean(endDateRaw) || Boolean(endTime);
  if (!hasEnd) {
    return {
      start: startMeta.value,
      shouldSetTimeZone: startMeta.hasTime && startMeta.canAttachTimeZone,
    };
  }

  const effectiveEndDate = endDateRaw || startDate;
  const endMeta = buildNotionDateTimeValue(effectiveEndDate, endTime, 'end date');
  const hasTimedValue = startMeta.hasTime || endMeta.hasTime;
  const shouldSetTimeZone = hasTimedValue && startMeta.canAttachTimeZone && endMeta.canAttachTimeZone;

  return {
    start: startMeta.value,
    end: endMeta.value,
    shouldSetTimeZone,
  };
}

function getPropertyEntries(schemaProperties = {}) {
  return Object.entries(schemaProperties).filter(([, definition]) => definition && definition.type);
}

function findFirstPropertyByType(schemaProperties = {}, propertyType) {
  const entry = getPropertyEntries(schemaProperties).find(([, definition]) => definition.type === propertyType);
  return entry || null;
}

function findFirstPropertyByName(schemaProperties = {}, candidateNames = [], allowedTypes = null) {
  const entries = getPropertyEntries(schemaProperties);
  const allowedTypeSet = Array.isArray(allowedTypes) && allowedTypes.length > 0
    ? new Set(allowedTypes)
    : null;

  const isAllowedType = (definition) => {
    if (!allowedTypeSet) {
      return true;
    }

    return allowedTypeSet.has(definition.type);
  };

  for (const candidateName of candidateNames) {
    const normalizedCandidate = candidateName.toLowerCase();
    const exactMatch = entries.find(([name, definition]) => (
      name.toLowerCase() === normalizedCandidate && isAllowedType(definition)
    ));
    if (exactMatch) {
      return exactMatch;
    }
  }

  for (const candidateName of candidateNames) {
    const normalizedCandidate = candidateName.toLowerCase();
    const partialMatch = entries.find(([name, definition]) => (
      name.toLowerCase().includes(normalizedCandidate) && isAllowedType(definition)
    ));
    if (partialMatch) {
      return partialMatch;
    }
  }

  return null;
}

function resolveCrudPropertyMap(schemaProperties = {}) {
  const titleEntry = findFirstPropertyByType(schemaProperties, 'title');
  const departmentEntry = findFirstPropertyByName(
    schemaProperties,
    ['department'],
    ['multi_select', 'select', 'rich_text']
  );
  const dateEntry = findFirstPropertyByName(
    schemaProperties,
    ['date', 'deadline', 'due'],
    ['date']
  );
  const statusEntry = findFirstPropertyByName(
    schemaProperties,
    ['status'],
    ['status', 'select', 'rich_text']
  );
  const organizationEntry = findFirstPropertyByName(
    schemaProperties,
    ['organization', 'organisation'],
    ['multi_select', 'select', 'rich_text']
  );

  return {
    title: titleEntry ? { name: titleEntry[0], definition: titleEntry[1] } : null,
    department: departmentEntry ? { name: departmentEntry[0], definition: departmentEntry[1] } : null,
    date: dateEntry ? { name: dateEntry[0], definition: dateEntry[1] } : null,
    status: statusEntry ? { name: statusEntry[0], definition: statusEntry[1] } : null,
    organization: organizationEntry ? { name: organizationEntry[0], definition: organizationEntry[1] } : null,
  };
}

function getCardTitleFromProperties(properties = {}, titlePropertyName = null) {
  if (titlePropertyName && typeof properties[titlePropertyName] === 'string' && properties[titlePropertyName].trim()) {
    return properties[titlePropertyName].trim();
  }

  const activityTitle = properties['กิจกรรม'];
  if (typeof activityTitle === 'string' && activityTitle.trim()) {
    return activityTitle.trim();
  }

  const firstStringValue = Object.values(properties).find(
    value => typeof value === 'string' && value.trim().length > 0
  );
  return typeof firstStringValue === 'string' ? firstStringValue.trim() : '';
}

function buildRichTextFragments(value) {
  return [{ text: { content: value.trim() } }];
}

function buildTitlePropertyValue(propertyDefinition, value) {
  if (!propertyDefinition || propertyDefinition.type !== 'title') {
    throw new Error('Configured title property is not a Notion title field.');
  }

  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error('Title is required.');
  }

  return {
    title: buildRichTextFragments(normalized),
  };
}

function resolveSelectableOptionName(propertyDefinition, requestedName, options = {}) {
  const { allowUnknown = true, fieldLabel = 'Field' } = options;
  const normalizedRequested = String(requestedName || '').trim();
  if (!normalizedRequested) {
    return '';
  }

  const optionNames = extractSelectableOptionNames(propertyDefinition);
  if (optionNames.length === 0) {
    return normalizedRequested;
  }

  const exactMatch = optionNames.find(optionName => optionName === normalizedRequested);
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedRequestedKey = normalizeOptionKey(normalizedRequested);
  const relaxedMatch = optionNames.find(optionName => normalizeOptionKey(optionName) === normalizedRequestedKey);
  if (relaxedMatch) {
    return relaxedMatch;
  }

  if (allowUnknown) {
    return normalizedRequested;
  }

  const availableOptions = optionNames.join(', ');
  throw new Error(
    `${fieldLabel} "${normalizedRequested}" is not a valid option. Available options: ${availableOptions}`
  );
}

function buildScopedPropertyValue(propertyDefinition, value, fieldLabel, options = {}) {
  const { allowUnknownOptions = true } = options;
  const names = parseMultiValueInput(value);
  if (names.length === 0) {
    throw new Error(`${fieldLabel} is required.`);
  }

  if (!propertyDefinition) {
    throw new Error(`${fieldLabel} property is not configured in this database.`);
  }

  if (propertyDefinition.type === 'multi_select') {
    return {
      multi_select: names.map(name => ({
        name: resolveSelectableOptionName(propertyDefinition, name, {
          allowUnknown: allowUnknownOptions,
          fieldLabel,
        }),
      })),
    };
  }

  if (propertyDefinition.type === 'select') {
    return {
      select: {
        name: resolveSelectableOptionName(propertyDefinition, names[0], {
          allowUnknown: allowUnknownOptions,
          fieldLabel,
        }),
      },
    };
  }

  if (propertyDefinition.type === 'rich_text') {
    return {
      rich_text: buildRichTextFragments(names.join(', ')),
    };
  }

  throw new Error(`Unsupported ${fieldLabel} property type: ${propertyDefinition.type}`);
}

function buildDepartmentPropertyValue(propertyDefinition, value) {
  return buildScopedPropertyValue(propertyDefinition, value, 'Department', {
    allowUnknownOptions: false,
  });
}

function buildOrganizationPropertyValue(propertyDefinition, value) {
  const requestedValues = parseMultiValueInput(value);
  const withDefaultOrg = dedupeCaseInsensitive([DEFAULT_ORGANIZATION, ...requestedValues]);
  return buildScopedPropertyValue(propertyDefinition, withDefaultOrg, 'Organization');
}

function buildScopedAutocompleteChoices(optionNames, focusedValue = '') {
  const rawFocused = String(focusedValue || '');
  const parts = rawFocused
    .split(',')
    .map(item => item.trim());

  const currentPart = parts.length > 0 ? parts[parts.length - 1] : '';
  const selectedParts = parts.slice(0, -1).filter(Boolean);
  const selectedKeys = new Set(selectedParts.map(item => normalizeOptionKey(item)).filter(Boolean));

  const baseChoices = toAutocompleteChoices(optionNames, currentPart)
    .filter(choice => !selectedKeys.has(normalizeOptionKey(choice.value)));

  if (selectedParts.length === 0) {
    return baseChoices;
  }

  return baseChoices.map(choice => ({
    name: choice.name,
    value: [...selectedParts, choice.value].join(', '),
  }));
}

function buildDatePropertyValue(propertyDefinition, value) {
  if (!propertyDefinition) {
    throw new Error('Date property is not configured in this database.');
  }

  if (propertyDefinition.type !== 'date') {
    throw new Error(`Unsupported Date property type: ${propertyDefinition.type}`);
  }

  const payload = buildNotionDateRangePayload(value);
  const notionDate = {
    start: payload.start,
  };

  if (payload.end) {
    notionDate.end = payload.end;
  }

  if (payload.shouldSetTimeZone && config.notion.timezone) {
    notionDate.time_zone = config.notion.timezone;
  }

  return {
    date: notionDate,
  };
}

function buildStatusPropertyValue(propertyDefinition, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return null;
  }

  if (!propertyDefinition) {
    throw new Error('Status property is not configured in this database.');
  }

  if (propertyDefinition.type === 'status') {
    return {
      status: { name: resolveSelectableOptionName(propertyDefinition, normalized) },
    };
  }

  if (propertyDefinition.type === 'select') {
    return {
      select: { name: resolveSelectableOptionName(propertyDefinition, normalized) },
    };
  }

  if (propertyDefinition.type === 'rich_text') {
    return {
      rich_text: buildRichTextFragments(normalized),
    };
  }

  throw new Error(`Unsupported Status property type: ${propertyDefinition.type}`);
}

async function getDatabaseSchema() {
  const now = Date.now();
  if (databaseSchemaCache && (now - databaseSchemaFetchedAt) < DATABASE_SCHEMA_CACHE_TTL_MS) {
    return databaseSchemaCache;
  }

  const schema = await notion.databases.retrieve({
    database_id: config.notion.databaseId,
  });

  databaseSchemaCache = schema;
  databaseSchemaFetchedAt = now;
  return schema;
}

async function assertPageInConfiguredDatabase(pageId) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const parentDatabaseId = page?.parent?.database_id;

  const normalizedParentDatabaseId = normalizeNotionEntityId(parentDatabaseId);
  const normalizedConfiguredDatabaseId = normalizeNotionEntityId(config.notion.databaseId);

  if (
    normalizedParentDatabaseId &&
    normalizedConfiguredDatabaseId &&
    normalizedParentDatabaseId !== normalizedConfiguredDatabaseId
  ) {
    throw new Error('This page does not belong to NOTION_DATABASE_ID.');
  }

  return page;
}

async function getPageTitle(pageId, titleCache) {
  // Avoid repeated API calls when multiple cards point to the same relation page.
  if (titleCache.has(pageId)) {
    return titleCache.get(pageId);
  }

  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const title = extractPageTitleFromProperties(page.properties) || `Untitled (${pageId.slice(0, 8)})`;
    titleCache.set(pageId, title);
    relationTitlePersistentCache.set(pageId, title);
    return title;
  } catch (error) {
    if (relationTitlePersistentCache.has(pageId)) {
      const cachedTitle = relationTitlePersistentCache.get(pageId);
      titleCache.set(pageId, cachedTitle);
      console.warn(`⚠️  Failed to resolve relation title for ${pageId}: ${error.message}. Using cached title.`);
      return cachedTitle;
    }

    const fallbackTitle = `Unknown (${pageId.slice(0, 8)})`;
    titleCache.set(pageId, fallbackTitle);
    console.warn(`⚠️  Failed to resolve relation title for ${pageId}: ${error.message}`);
    return fallbackTitle;
  }
}

async function extractRelationTitles(relationItems, titleCache) {
  if (!Array.isArray(relationItems) || relationItems.length === 0) {
    return [];
  }

  const titles = [];
  for (const relation of relationItems) {
    const title = await getPageTitle(relation.id, titleCache);
    titles.push(title);
  }

  return titles;
}

async function extractPageData(page, relationTitleCache = new Map()) {
  const cardData = {
    id: page.id,
    url: page.url,
    meta: {
      source: 'Notion',
      createdTime: page.created_time || null,
      lastEditedTime: page.last_edited_time || null,
      createdBy: toNotionActorMeta(page.created_by),
      lastEditedBy: toNotionActorMeta(page.last_edited_by),
    },
    properties: {},
  };

  for (const [propName, propValue] of Object.entries(page.properties)) {
    cardData.properties[propName] = await extractPropertyValue(propValue, relationTitleCache);
  }

  return cardData;
}

/**
 * Extracts value from Notion formula object.
 */
function extractFormulaValue(formula) {
  if (!formula) return null;

  switch (formula.type) {
    case 'string':
      return formula.string;
    case 'number':
      return formula.number;
    case 'boolean':
      return formula.boolean;
    case 'date':
      return extractNotionDateValue(formula.date);
    default:
      return null;
  }
}

/**
 * Extracts value from Notion property based on type
 */
async function extractPropertyValue(property, titleCache) {
  if (!property) return null;

  switch (property.type) {
    case 'title':
      return extractRichText(property.title);
    case 'rich_text':
      return extractRichText(property.rich_text);
    case 'status':
      return property.status?.name || null;
    case 'select':
      return property.select?.name || null;
    case 'multi_select':
      return property.multi_select?.map(m => m.name) || [];
    case 'people':
      return property.people?.map(p => p.name) || [];
    case 'date':
      return extractNotionDateValue(property.date);
    case 'formula':
      return extractFormulaValue(property.formula);
    case 'relation':
      // Relations store page IDs; we resolve and keep only human-friendly titles.
      return extractRelationTitles(property.relation, titleCache);
    case 'url':
      return property.url || null;
    case 'number':
      return property.number;
    case 'checkbox':
      return property.checkbox;
    default:
      return null;
  }
}

/**
 * Fetches all pages from a Notion database with pagination
 */
export async function fetchDatabaseCards() {
  try {
    const cards = [];
    const relationTitleCache = new Map();
    let cursor = undefined;
    let isFirstPage = true;

    while (true) {
      const response = await notion.databases.query({
        database_id: config.notion.databaseId,
        start_cursor: cursor,
      });

      // Extract relevant properties from each page
      for (const page of response.results) {
        const cardData = await extractPageData(page, relationTitleCache);

        // Log first card's properties for debugging
        if (isFirstPage && cards.length === 0) {
          console.log('🔍 Database properties found:', Object.keys(cardData.properties));
          isFirstPage = false;
        }

        cards.push(cardData);
      }

      // Check if there are more results
      if (!response.has_more) {
        break;
      }
      cursor = response.next_cursor;
    }

    return cards;
  } catch (error) {
    console.error('Error fetching Notion database:', error.message);
    throw error;
  }
}

/**
 * Formats card data into a standardized structure for tracking
 */
export function formatCardForTracking(card) {
  // Find the status property (usually called "Status", but this varies)
  // You may need to customize this based on your database schema
  const properties = card.properties;

  const formatted = {
    id: card.id,
    url: card.url,
    timestamp: new Date().toISOString(),
    meta: card.meta || null,
    properties: properties,
  };

  return formatted;
}

export async function createDatabaseCard({ title, department, organization, date, status } = {}) {
  const schema = await getDatabaseSchema();
  const propertyMap = resolveCrudPropertyMap(schema.properties);

  if (!propertyMap.title || !propertyMap.department || !propertyMap.date || !propertyMap.organization) {
    throw new Error('Database is missing required CRUD properties (title, Department, Organization, or Date).');
  }

  const properties = {
    [propertyMap.title.name]: buildTitlePropertyValue(propertyMap.title.definition, title),
    [propertyMap.department.name]: buildDepartmentPropertyValue(propertyMap.department.definition, department),
    [propertyMap.organization.name]: buildOrganizationPropertyValue(propertyMap.organization.definition, []),
    [propertyMap.date.name]: buildDatePropertyValue(propertyMap.date.definition, date),
  };

  const statusValue = buildStatusPropertyValue(propertyMap.status?.definition, status);
  if (statusValue && propertyMap.status) {
    properties[propertyMap.status.name] = statusValue;
  }

  if (typeof organization === 'string' && organization.trim().length > 0) {
    properties[propertyMap.organization.name] = buildOrganizationPropertyValue(
      propertyMap.organization.definition,
      organization
    );
  }

  const page = await notion.pages.create({
    parent: { database_id: config.notion.databaseId },
    properties,
  });

  return extractPageData(page, new Map());
}

export async function readDatabaseCard(pageIdOrUrl) {
  const pageId = normalizeNotionPageId(pageIdOrUrl);
  const page = await assertPageInConfiguredDatabase(pageId);
  return extractPageData(page, new Map());
}

export async function updateDatabaseCard(pageIdOrUrl, updates = {}) {
  const pageId = normalizeNotionPageId(pageIdOrUrl);
  await assertPageInConfiguredDatabase(pageId);

  const schema = await getDatabaseSchema();
  const propertyMap = resolveCrudPropertyMap(schema.properties);
  const properties = {};

  if (typeof updates.title === 'string') {
    if (!propertyMap.title) {
      throw new Error('Title property is not available in this database.');
    }

    properties[propertyMap.title.name] = buildTitlePropertyValue(propertyMap.title.definition, updates.title);
  }

  if (typeof updates.department === 'string') {
    if (!propertyMap.department) {
      throw new Error('Department property is not available in this database.');
    }

    properties[propertyMap.department.name] = buildDepartmentPropertyValue(
      propertyMap.department.definition,
      updates.department
    );
  }

  if (typeof updates.organization === 'string') {
    if (!propertyMap.organization) {
      throw new Error('Organization property is not available in this database.');
    }

    properties[propertyMap.organization.name] = buildOrganizationPropertyValue(
      propertyMap.organization.definition,
      updates.organization
    );
  }

  if (typeof updates.date === 'string' || (updates.date && typeof updates.date === 'object')) {
    if (!propertyMap.date) {
      throw new Error('Date property is not available in this database.');
    }

    properties[propertyMap.date.name] = buildDatePropertyValue(propertyMap.date.definition, updates.date);
  }

  if (typeof updates.status === 'string') {
    if (!propertyMap.status) {
      throw new Error('Status property is not available in this database.');
    }

    const statusValue = buildStatusPropertyValue(propertyMap.status.definition, updates.status);
    if (statusValue) {
      properties[propertyMap.status.name] = statusValue;
    }
  }

  if (Object.keys(properties).length === 0) {
    throw new Error('No update fields were provided.');
  }

  const page = await notion.pages.update({
    page_id: pageId,
    properties,
  });

  return extractPageData(page, new Map());
}

export async function archiveDatabaseCard(pageIdOrUrl) {
  const pageId = normalizeNotionPageId(pageIdOrUrl);
  await assertPageInConfiguredDatabase(pageId);

  const page = await notion.pages.update({
    page_id: pageId,
    archived: true,
  });

  return {
    id: page.id,
    url: page.url,
    archived: Boolean(page.archived),
  };
}

export async function resolveDatabaseCardReference({ pageIdOrUrl, title } = {}) {
  const rawIdOrUrl = typeof pageIdOrUrl === 'string' ? pageIdOrUrl.trim() : '';
  const rawTitle = typeof title === 'string' ? title.trim() : '';

  if (rawIdOrUrl) {
    return readDatabaseCard(rawIdOrUrl);
  }

  if (!rawTitle) {
    throw new Error('Please provide either id (or URL) or task_title.');
  }

  const schema = await getDatabaseSchema();
  const propertyMap = resolveCrudPropertyMap(schema.properties);
  const titlePropertyName = propertyMap.title?.name || null;

  const cards = await fetchDatabaseCards();
  const normalizedRequestedTitle = normalizeLookupText(rawTitle);
  const exactMatches = cards.filter(card => {
    const cardTitle = getCardTitleFromProperties(card.properties || {}, titlePropertyName);
    return normalizeLookupText(cardTitle) === normalizedRequestedTitle;
  });

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  if (exactMatches.length > 1) {
    const sampleIds = exactMatches.slice(0, 5).map(card => card.id).join(', ');
    throw new Error(
      `Multiple tasks matched title "${rawTitle}" (${exactMatches.length} found). Use id/url. Sample IDs: ${sampleIds}`
    );
  }

  const partialMatches = cards.filter(card => {
    const cardTitle = getCardTitleFromProperties(card.properties || {}, titlePropertyName);
    return normalizeLookupText(cardTitle).includes(normalizedRequestedTitle);
  });

  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  if (partialMatches.length > 1) {
    const sampleIds = partialMatches.slice(0, 5).map(card => card.id).join(', ');
    throw new Error(
      `Multiple tasks partially matched title "${rawTitle}" (${partialMatches.length} found). Use id/url. Sample IDs: ${sampleIds}`
    );
  }

  throw new Error(`Task not found for title "${rawTitle}".`);
}

export async function getTaskAutocompleteSuggestions(field, focusedValue = '') {
  const schema = await getDatabaseSchema();
  const propertyMap = resolveCrudPropertyMap(schema.properties);

  if (field === 'department') {
    const optionNames = extractSelectableOptionNames(propertyMap.department?.definition);
    return buildScopedAutocompleteChoices(optionNames, focusedValue);
  }

  if (field === 'status') {
    const optionNames = extractSelectableOptionNames(propertyMap.status?.definition);
    return toAutocompleteChoices(optionNames, focusedValue);
  }

  if (field === 'organization') {
    const optionNames = extractSelectableOptionNames(propertyMap.organization?.definition);
    return buildScopedAutocompleteChoices(optionNames, focusedValue);
  }

  return [];
}

export default {
  fetchDatabaseCards,
  formatCardForTracking,
  createDatabaseCard,
  readDatabaseCard,
  updateDatabaseCard,
  archiveDatabaseCard,
  resolveDatabaseCardReference,
  getTaskAutocompleteSuggestions,
  normalizeNotionPageId,
};
