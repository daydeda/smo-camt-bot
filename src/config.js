import 'dotenv/config.js';

const MIN_POLL_INTERVAL_SECONDS = 15;
const MAX_POLL_INTERVAL_SECONDS = 3600;

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
  },
  notion: {
    apiKey: process.env.NOTION_API_KEY,
    databaseId: process.env.NOTION_DATABASE_ID,
  },
  polling: {
    intervalSeconds: parsePollInterval(process.env.POLL_INTERVAL),
  },
};

// Validate required environment variables
function validateConfig() {
  const required = [
    { key: 'discord.token', path: 'DISCORD_TOKEN' },
    { key: 'discord.channelId', path: 'DISCORD_CHANNEL_ID' },
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

  if (!/^\d+$/.test(String(config.discord.channelId))) {
    throw new Error('DISCORD_CHANNEL_ID must be a numeric Discord snowflake.');
  }
}

validateConfig();

export default config;
