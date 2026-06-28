import discordClient from './discord/bot.js';
import config from './config.js';
import { waitForDiscordClientReady } from './discord/compat.js';
import { acquireProcessLock, releaseProcessLock } from './process/lock.js';
import {
  getChannelDepartmentFilters,
  formatDepartmentFilterForDisplay,
} from './sync/filters.js';
import { fetchConfiguredChannels } from './discord/channels.js';
import { registerSlashCommands } from './commands/definitions.js';
import { registerCommandHandlers } from './commands/index.js';
import { syncNotionToDiscord } from './core/sync.js';
import { startScheduler } from './scheduled/scheduler.js';
import { startHealthServer } from './core/health.js';

/**
 * Initialize and start the bot
 */
async function startBot() {
  try {
    acquireProcessLock();
    console.log('🤖 Starting Notion-Discord Sync Bot...');

    // Login to Discord
    await discordClient.login(config.discord.token);

    // Wait for Discord bot to be ready
    await waitForDiscordClientReady(discordClient);

    console.log(`✅ Bot ready! Connected to Discord`);
    console.log(`📌 Watching Notion database: ${config.notion.databaseId}`);
    console.log(
      `🏷️  Default department filter: ${formatDepartmentFilterForDisplay(config.sync.trackedDepartments)}`
    );
    if (Object.keys(config.sync.channelDepartmentsByChannelId).length > 0) {
      console.log('🏷️  Channel-specific department filters:');
      for (const channelId of config.discord.channelIds) {
        const channelFilters = getChannelDepartmentFilters(channelId);
        console.log(`   - ${channelId}: ${formatDepartmentFilterForDisplay(channelFilters)}`);
      }
    }
    console.log(`💬 Posting updates to Discord channels: ${config.discord.channelIds.join(', ')}`);
    const configuredChannels = await fetchConfiguredChannels();
    if (configuredChannels.length === 0) {
      console.warn('⚠️  No configured text channels are currently reachable. Bot will stay online and retry during sync.');
    }

    const registeredGuildIds = new Set();
    for (const configuredChannel of configuredChannels) {
      const guildId = configuredChannel?.guild?.id;
      if (!guildId || registeredGuildIds.has(guildId)) {
        continue;
      }

      try {
        await registerSlashCommands(configuredChannel);
      } catch (error) {
        console.error(
          `⚠️  Failed to register slash commands for guild ${guildId}: ${error.message}`
        );
      }
      registeredGuildIds.add(guildId);
    }
    console.log('⌨️  Manual commands enabled: /help, /mytasks, /remindercheck, /calendar, /clear, /task');
    console.log(`🔐 Task write access roles: ${config.permissions.taskCommandRoleNames.join(', ')} (Admin also allowed)`);
    console.log(`⏱️  Polling interval: ${config.polling.intervalSeconds} seconds\n`);

    registerCommandHandlers();

    // Run initial sync
    await syncNotionToDiscord();

    // Set up polling loop
    const intervalId = setInterval(syncNotionToDiscord, config.polling.intervalSeconds * 1000);

    // Start the time-based digest scheduler and optional health endpoint.
    const schedulerIntervalId = startScheduler();
    const healthServer = startHealthServer();

    const shutdown = async () => {
      clearInterval(intervalId);
      if (schedulerIntervalId) {
        clearInterval(schedulerIntervalId);
      }
      if (healthServer) {
        healthServer.close();
      }
      await discordClient.destroy();
      releaseProcessLock();
      process.exit(0);
    };

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n👋 Shutting down gracefully...');
      await shutdown();
    });

    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    releaseProcessLock();
    process.exit(1);
  }
}

// Start the bot
startBot();
