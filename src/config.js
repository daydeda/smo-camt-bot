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
