import 'dotenv/config.js';

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
    intervalSeconds: parseInt(process.env.POLL_INTERVAL || '60', 10),
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
  }
}

validateConfig();

export default config;
