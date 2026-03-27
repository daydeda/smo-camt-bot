import 'dotenv/config.js';

const MIN_POLL_INTERVAL_SECONDS = 15;
const MAX_POLL_INTERVAL_SECONDS = 3600;

function parseDiscordChannelIds(rawList, fallbackSingle) {
  const values = [];

  if (typeof rawList === 'string' && rawList.trim().length > 0) {
    values.push(...rawList.split(',').map(item => item.trim()).filter(Boolean));
  }

  if (values.length === 0 && typeof fallbackSingle === 'string' && fallbackSingle.trim().length > 0) {
    values.push(fallbackSingle.trim());
  }

  return Array.from(new Set(values));
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
const config = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    channelId: process.env.DISCORD_CHANNEL_ID,
    channelIds: parseDiscordChannelIds(
      process.env.DISCORD_CHANNEL_IDS,
      process.env.DISCORD_CHANNEL_ID
    ),
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY,
    databaseId: process.env.NOTION_DATABASE_ID,
  },
  sync: {
    trackedOrganization: (process.env.TRACKED_ORGANIZATION || 'SMO CAMT').trim(),
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

  if (config.discord.channelIds.length === 0) {
    throw new Error('Missing Discord channel config: set DISCORD_CHANNEL_ID or DISCORD_CHANNEL_IDS.');
  }

  for (const channelId of config.discord.channelIds) {
    ensureNotPlaceholder(channelId, 'DISCORD_CHANNEL_IDS');
    if (!/^\d+$/.test(String(channelId))) {
      throw new Error('All Discord channel IDs must be numeric Discord snowflakes.');
    }
  }
}

validateConfig();

export default config;
