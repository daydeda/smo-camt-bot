import { Client, GatewayIntentBits } from 'discord.js';
import config from '../config.js';
import { onDiscordClientReady } from './compat.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
  ],
});

onDiscordClientReady(client, () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

export default client;
