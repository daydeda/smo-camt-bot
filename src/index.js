import discordClient from './discord/bot.js';
import { fetchDatabaseCards, formatCardForTracking } from './notion/database.js';
import stateTracker from './sync/tracker.js';
import {
  findChangedCards,
  createChangeEmbeds,
  createCreatedEmbeds,
  createRemovedEmbeds,
} from './sync/syncer.js';
import config from './config.js';

let isRunning = false;

/**
 * Main sync loop - fetches Notion database and posts changes to Discord
 */
async function syncNotionToDiscord() {
  if (isRunning) {
    console.log('⏳ Sync already in progress, skipping...');
    return;
  }

  isRunning = true;

  try {
    // Fetch current database state
    const cards = await fetchDatabaseCards();
    console.log(`📊 Fetched ${cards.length} cards from Notion database`);

    // Format cards for tracking
    const formattedCards = cards.map(formatCardForTracking);

    // Find changed cards
    const {
      changedCards,
      createdCards,
      deletedCards,
      deletedCardIds,
      skippedNewCards,
    } = findChangedCards(stateTracker, formattedCards);

    console.log(
      `📈 Sync summary: created=${createdCards.length}, changed=${changedCards.length}, deleted=${deletedCardIds.length}, skippedNew=${skippedNewCards}`
    );

    // Handle deleted cards
    for (const deletedId of deletedCardIds) {
      console.log(`🗑️  Card deleted: ${deletedId}`);
    }

    if (deletedCardIds.length > 0) {
      stateTracker.removeCardStates(deletedCardIds);
    }

    // Post create/change/delete updates to Discord if any exist
    const createdEmbeds = createCreatedEmbeds(createdCards);
    const changedEmbeds = createChangeEmbeds(changedCards);
    const removedEmbeds = createRemovedEmbeds(deletedCards);
    const embeds = [...createdEmbeds, ...changedEmbeds, ...removedEmbeds];

    if (embeds.length > 0) {
      console.log(
        `✏️  Found updates: created=${createdEmbeds.length}, changed=${changedEmbeds.length}, removed=${removedEmbeds.length}`
      );

      try {
        const channel = await discordClient.channels.fetch(config.discord.channelId);

        // Send embeds in batches (Discord has a limit)
        for (const embed of embeds) {
          await channel.send({ embeds: [embed] });
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`✅ Posted ${embeds.length} update(s) to Discord`);
      } catch (error) {
        console.error('Error sending Discord message:', error.message);
      }
    } else {
      console.log('✓ No changes detected');
    }

    // Update tracker with current state
    stateTracker.setCardStates(formattedCards);
  } catch (error) {
    console.error('❌ Sync error:', error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Initialize and start the bot
 */
async function startBot() {
  try {
    console.log('🤖 Starting Notion-Discord Sync Bot...');

    // Login to Discord
    await discordClient.login(config.discord.token);

    // Wait for Discord bot to be ready
    await new Promise(resolve => {
      if (discordClient.isReady()) {
        resolve();
      } else {
        discordClient.once('ready', resolve);
      }
    });

    console.log(`✅ Bot ready! Connected to Discord`);
    console.log(`📌 Watching Notion database: ${config.notion.databaseId}`);
    console.log(`💬 Posting updates to Discord channel: ${config.discord.channelId}`);
    console.log(`⏱️  Polling interval: ${config.polling.intervalSeconds} seconds\n`);

    // Run initial sync
    await syncNotionToDiscord();

    // Set up polling loop
    const intervalId = setInterval(syncNotionToDiscord, config.polling.intervalSeconds * 1000);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n👋 Shutting down gracefully...');
      clearInterval(intervalId);
      await discordClient.destroy();
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    process.exit(1);
  }
}

// Start the bot
startBot();
