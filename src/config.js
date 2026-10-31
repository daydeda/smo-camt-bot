import 'dotenv/config.js';

const MIN_POLL_INTERVAL_SECONDS = 15;
const MAX_POLL_INTERVAL_SECONDS = 3600;

function parseDiscordChannelIds(rawList, fallbackSingle, additionalIds = []) {
  const values = [];

  if (typeof rawList === 'string' && rawList.trim().length > 0) {
    values.push(...rawList.split(',').map(item => item.trim()).filter(Boolean));
  }

  if (values.length === 0 && typeof fallbackSingle === 'string' && fallbackSingle.trim().length > 0) {
    values.push(fallbackSingle.trim());
  }

  if (Array.isArray(additionalIds) && additionalIds.length > 0) {
    values.push(...additionalIds.map(item => String(item).trim()).filter(Boolean));
  }

  return Array.from(new Set(values));
}

function parseScopeList(rawValue, separator = ',') {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return [];
  }

  return Array.from(
    new Set(
      rawValue
        .split(separator)
        .map(item => item.trim())
        .filter(Boolean)
    )
  );
}

function parseChannelDepartmentFilters(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return {};
  }

  let normalizedRawValue = rawValue
    .replace(/\r/g, '')
    .replace(/\n/g, ',')
    .trim();

  // Allow a quoted full value in CI secrets, e.g. "123:Dept,456:Dept".
  if (
    (normalizedRawValue.startsWith('"') && normalizedRawValue.endsWith('"')) ||
    (normalizedRawValue.startsWith("'") && normalizedRawValue.endsWith("'"))
  ) {
    normalizedRawValue = normalizedRawValue.slice(1, -1).trim();
  }

  if (normalizedRawValue.length === 0) {
    return {};
  }

  const mapping = {};
  const entries = normalizedRawValue
    .split(',')
    .map(item => item.trim().replace(/^['"]+/, '').replace(/['"]+$/, ''))
    .filter(Boolean);

  for (const entry of entries) {
    const match = entry.match(/^(\d+)\s*[:=]\s*(.*)$/);
    if (!match) {
      throw new Error(
        `Invalid DISCORD_CHANNEL_DEPARTMENT_FILTERS entry "${entry}". Use format channelId:Dept1|Dept2`
      );
    }

    const channelId = match[1];
    const departmentsRaw = match[2]?.trim() || '';
    const isAllDepartments =
      departmentsRaw.length === 0 ||
      departmentsRaw === '*' ||
      departmentsRaw.toLowerCase() === 'all';
    const departments = isAllDepartments
      ? []
      : parseScopeList(departmentsRaw, ';;');

    if (departments.length === 0) {
      mapping[channelId] = [];
      continue;
    }

    if (!Object.hasOwn(mapping, channelId)) {
      mapping[channelId] = departments;
      continue;
    }

    if (mapping[channelId].length > 0) {
      mapping[channelId] = Array.from(new Set([...mapping[channelId], ...departments]));
    }
  }

  return mapping;
}

function parsePollInterval(rawValue) {
  const parsed = parseInt(rawValue || '60', 10);

  if (Number.isNaN(parsed)) {
    return 60;
  }

  return Math.min(Math.max(parsed, MIN_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS);
}

// Parse a comma-separated list of positive day offsets, e.g. "1,3,7".
function parseReminderLeadDays(rawValue) {
  const parsed = parseScopeList(rawValue || '', ',')
    .map(item => parseInt(item, 10))
    .filter(value => Number.isInteger(value) && value >= 0);

  const unique = Array.from(new Set(parsed));
  unique.sort((left, right) => left - right);

  // Default to "remind one day before" when nothing valid is configured.
  return unique.length > 0 ? unique : [1];
}

// Parse "HH:mm" (24h). Returns { hour, minute } or null when unset/invalid.
function parseTimeOfDay(rawValue, envName) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return null;
  }

  const match = rawValue.trim().match(/^([0-1]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    throw new Error(`${envName} must be in 24-hour HH:mm format (e.g. 09:00).`);
  }

  return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10) };
}

// Day-of-week name/number to 0(Sun)-6(Sat).
function parseWeekday(rawValue) {
  const normalized = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  const names = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tuesday: 2,
    wed: 3, wednesday: 3,
    thu: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  if (Object.hasOwn(names, normalized)) {
    return names[normalized];
  }

  const numeric = parseInt(normalized, 10);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) {
    return numeric;
  }

  // Default to Monday.
  return 1;
}

const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseSingleWeekday(token) {
  const normalized = token.trim().toLowerCase().slice(0, 3);
  const byName = WEEKDAY_NAMES.indexOf(normalized);
  if (byName >= 0) return byName;

  const numeric = parseInt(token, 10);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 6 ? numeric : null;
}

/**
 * Parse a weekday list such as "mon-fri", "mon,wed,fri", "daily" or "0-6"
 * into sorted day numbers (Sun=0). Defaults to Monday-Friday.
 */
export function parseWeekdayList(rawValue, envName = 'TODO_REMINDER_DAYS') {
  const value = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (!value) return [1, 2, 3, 4, 5];
  if (value === 'daily' || value === 'all' || value === '*') return [0, 1, 2, 3, 4, 5, 6];

  const days = new Set();
  for (const token of value.split(',').map(item => item.trim()).filter(Boolean)) {
    const [fromRaw, toRaw] = token.split('-');
    const from = parseSingleWeekday(fromRaw);
    const to = toRaw === undefined ? from : parseSingleWeekday(toRaw);
    if (from === null || to === null) {
      throw new Error(`${envName} has an invalid day "${token}". Use e.g. mon-fri or mon,wed,fri.`);
    }

    // Ranges may wrap around the week, e.g. "sat-mon".
    for (let day = from; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === to) break;
    }
  }

  return Array.from(days).sort((left, right) => left - right);
}

// To-do board reminder time: defaults to 09:00; "off" disables it.
function parseTodoReminderTime(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';
  if (!value) return { hour: 9, minute: 0 };
  if (['off', 'none', 'disabled', 'false', '0'].includes(value)) return null;
  return parseTimeOfDay(rawValue, 'TODO_REMINDER_TIME');
}

function parseHealthPort(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return 0;
  }

  const parsed = parseInt(rawValue.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error('HEALTH_PORT must be an integer between 0 and 65535 (0 disables the server).');
  }

  return parsed;
}

// Parse "Name=discordId,Other Name=discordId2" into { normalizedName: discordId }.
function parseUserMap(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return {};
  }

  const mapping = {};
  const entries = rawValue
    .replace(/\r/g, '')
    .replace(/\n/g, ',')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const match = entry.match(/^(.+?)\s*[=:]\s*(\d+)$/);
    if (!match) {
      throw new Error(
        `Invalid NOTION_DISCORD_USER_MAP entry "${entry}". Use format "Notion Name=discordUserId".`
      );
    }

    const normalizedName = match[1].trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    mapping[normalizedName] = match[2];
  }

  return mapping;
}

function ensureNotPlaceholder(value, envName) {
  if (typeof value !== 'string') {
    return;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.includes('your_') || normalized.includes('_here')) {
    throw new Error(`Environment variable ${envName} looks like a placeholder. Please set a real value.`);
  }
}

// Load and validate environment variables
const trackedDepartments = parseScopeList(
  process.env.TRACKED_DEPARTMENT || '',
  ','
);
const taskCommandRoleNames = parseScopeList(
  process.env.TASK_COMMAND_ROLE_NAMES || 'SMO 69',
  ','
);
const channelDepartmentsByChannelId = parseChannelDepartmentFilters(
  process.env.DISCORD_CHANNEL_DEPARTMENT_FILTERS
);
const reminderLeadDays = parseReminderLeadDays(process.env.REMINDER_LEAD_DAYS);
const dailyDigestTime = parseTimeOfDay(process.env.DAILY_DIGEST_TIME, 'DAILY_DIGEST_TIME');
const weeklyDigestTime = parseTimeOfDay(process.env.WEEKLY_DIGEST_TIME, 'WEEKLY_DIGEST_TIME');
const weeklyDigestWeekday = parseWeekday(process.env.WEEKLY_DIGEST_DAY);
const todoReminderTime = parseTodoReminderTime(process.env.TODO_REMINDER_TIME);
const todoReminderWeekdays = parseWeekdayList(process.env.TODO_REMINDER_DAYS);
const notionDiscordUserMap = parseUserMap(process.env.NOTION_DISCORD_USER_MAP);
const assigneeProperties = parseScopeList(
  process.env.ASSIGNEE_PROPERTIES ||
    'ผู้รับผิดชอบ,ผู้รับผิดชอบงาน,Assignee,Assignees,Owner,Person',
  ','
);
const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
    channelIds: parseDiscordChannelIds(
      process.env.DISCORD_CHANNEL_IDS,
      process.env.DISCORD_CHANNEL_ID,
      Object.keys(channelDepartmentsByChannelId)
    ),
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY,
    databaseId: process.env.NOTION_DATABASE_ID,
    timezone: (process.env.NOTION_TIMEZONE || 'Asia/Bangkok').trim(),
  },
  sync: {
    trackedDepartment: trackedDepartments[0] || '',
    trackedDepartments,
    channelDepartmentsByChannelId,
  },
  permissions: {
    taskCommandRoleNames,
  },
  polling: {
    intervalSeconds: parsePollInterval(process.env.POLL_INTERVAL),
  },
  reminders: {
    leadDays: reminderLeadDays,
  },
  schedule: {
    timezone: (process.env.NOTION_TIMEZONE || 'Asia/Bangkok').trim(),
    dailyDigestTime,
    weeklyDigestTime,
    weeklyDigestWeekday,
    todoReminderTime,
    todoReminderWeekdays,
  },
  health: {
    port: parseHealthPort(process.env.HEALTH_PORT),
  },
  notifications: {
    notionDiscordUserMap,
    assigneeProperties,
  },
};

// Validate required environment variables
function validateConfig() {
  const required = [
    { key: 'discord.token', path: 'DISCORD_TOKEN' },
    { key: 'notion.apiKey', path: 'NOTION_API_KEY' },
    { key: 'notion.databaseId', path: 'NOTION_DATABASE_ID' },
  ];

  for (const { key, path } of required) {
    const keys = key.split('.');
    let value = config;
    for (const k of keys) {
      value = value[k];
    }
    if (!value) {
      throw new Error(`Missing required environment variable: ${path}`);
    }

    ensureNotPlaceholder(value, path);
  }

  ensureNotPlaceholder(config.notion.timezone, 'NOTION_TIMEZONE');

  if (config.discord.channelIds.length === 0) {
    throw new Error(
      'Missing Discord channel config: set DISCORD_CHANNEL_ID, DISCORD_CHANNEL_IDS, or DISCORD_CHANNEL_DEPARTMENT_FILTERS.'
    );
  }

  for (const channelId of config.discord.channelIds) {
    ensureNotPlaceholder(channelId, 'DISCORD_CHANNEL_IDS');
    if (!/^\d+$/.test(String(channelId))) {
      throw new Error('All Discord channel IDs must be numeric Discord snowflakes.');
    }
  }

  for (const department of config.sync.trackedDepartments) {
    ensureNotPlaceholder(department, 'TRACKED_DEPARTMENT');
  }

  for (const roleName of config.permissions.taskCommandRoleNames) {
    ensureNotPlaceholder(roleName, 'TASK_COMMAND_ROLE_NAMES');
  }

  for (const [channelId, departments] of Object.entries(config.sync.channelDepartmentsByChannelId)) {
    if (!/^\d+$/.test(String(channelId))) {
      throw new Error('Channel IDs in DISCORD_CHANNEL_DEPARTMENT_FILTERS must be numeric Discord snowflakes.');
    }

    if (!config.discord.channelIds.includes(channelId)) {
      throw new Error(
        `Channel ${channelId} in DISCORD_CHANNEL_DEPARTMENT_FILTERS is not listed in DISCORD_CHANNEL_ID/DISCORD_CHANNEL_IDS.`
      );
    }

    for (const department of departments) {
      ensureNotPlaceholder(department, 'DISCORD_CHANNEL_DEPARTMENT_FILTERS');
    }
  }
}

validateConfig();

export default config;
