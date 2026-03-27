import discordClient from './discord/bot.js';
import { fetchDatabaseCards, formatCardForTracking } from './notion/database.js';
import stateTracker from './sync/tracker.js';
import {
  findChangedCards,
  createChangeEmbeds,
  createCreatedEmbeds,
  createRemovedEmbeds,
  createDailyReportEmbed,
  createDeadlineReminderEmbeds,
} from './sync/syncer.js';
import config from './config.js';

let isRunning = false;

function normalizeLookupText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function getOrganizationValues(properties = {}) {
  const organizationValue = properties?.Organization;

  if (Array.isArray(organizationValue)) {
    return organizationValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof organizationValue === 'string') {
    return [organizationValue.trim()].filter(Boolean);
  }

  return [];
}

function cardMatchesTrackedOrganization(card) {
  const trackedOrgNormalized = normalizeLookupText(config.sync.trackedOrganization);

  if (!trackedOrgNormalized) {
    return true;
  }

  const organizations = getOrganizationValues(card?.properties || {});
  return organizations.some(org => normalizeLookupText(org) === trackedOrgNormalized);
}

function filterCardsByTrackedOrganization(cards) {
  return cards.filter(card => cardMatchesTrackedOrganization(card));
}

function buildDepartmentRoleMentions(channel) {
  const roleMentions = {};

  const roleCache = channel?.guild?.roles?.cache;
  if (!roleCache) {
    return roleMentions;
  }

  for (const role of roleCache.values()) {
    const normalizedName = normalizeLookupText(role.name);
    if (!normalizedName) {
      continue;
    }

    roleMentions[normalizedName] = `<@&${role.id}>`;
  }

  return roleMentions;
}

function extractRoleMentionsFromEmbed(embed) {
  const fields = embed?.data?.fields;
  if (!Array.isArray(fields)) {
    return [];
  }

  const departmentField = fields.find(field => field?.name === '🏢 Department');
  if (!departmentField || typeof departmentField.value !== 'string') {
    return [];
  }

  const mentionMatches = departmentField.value.match(/<@&(\d+)>/g);
  if (!mentionMatches) {
    return [];
  }

  return Array.from(new Set(mentionMatches));
}

function extractRoleIdsFromMentions(roleMentions) {
  return roleMentions
    .map(mention => mention.match(/^<@&(\d+)>$/)?.[1] || null)
    .filter(Boolean);
}

function isConfiguredChannel(channelId) {
  return config.discord.channelIds.includes(channelId);
}

function formatConfiguredChannelsMentionText() {
  return config.discord.channelIds.map(channelId => `<#${channelId}>`).join(', ');
}

async function fetchConfiguredChannels() {
  const channels = [];

  for (const channelId of config.discord.channelIds) {
    try {
      const channel = await discordClient.channels.fetch(channelId);
      if (!channel || typeof channel.send !== 'function') {
        console.warn(`⚠️  Skipping non-text or unavailable channel: ${channelId}`);
        continue;
      }

      channels.push(channel);
    } catch (error) {
      console.error(`⚠️  Failed to fetch channel ${channelId}: ${error.message}`);
    }
  }

  return channels;
}

async function sendEmbedsToChannel(channel, embeds) {
  for (const embed of embeds) {
    const roleMentions = extractRoleMentionsFromEmbed(embed);
    const roleIds = extractRoleIdsFromMentions(roleMentions);

    await channel.send({
      content: roleMentions.join(' '),
      embeds: [embed],
      allowedMentions: {
        parse: [],
        roles: roleIds,
      },
    });
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function runDailyReport(channels) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);
  const trackedCards = filterCardsByTrackedOrganization(formattedCards);
  for (const channel of channels) {
    const embed = createDailyReportEmbed(trackedCards, new Date());
    embed.setDescription(
      `Summary of current task statuses from Notion\nTracking Organization: **${config.sync.trackedOrganization}** (${trackedCards.length} card(s))`
    );
    await sendEmbedsToChannel(channel, [embed]);
  }
}

async function runReminderCheck(channels) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);
  const trackedCards = filterCardsByTrackedOrganization(formattedCards);
  const reminderStateByCardId = stateTracker.getMeta('deadlineReminderByCardId', {});
  const reminderCounts = [];

  for (const channel of channels) {
    const departmentRoleMentions = buildDepartmentRoleMentions(channel);

    const reminderResult = createDeadlineReminderEmbeds(
      trackedCards,
      departmentRoleMentions,
      reminderStateByCardId,
      new Date(),
      { ignoreDailyLimit: true }
    );

    if (reminderResult.embeds.length > 0) {
      await sendEmbedsToChannel(channel, reminderResult.embeds);
    }

    reminderCounts.push(reminderResult.embeds.length);
  }

  return reminderCounts;
}

async function registerSlashCommands(channel) {
  const guild = channel?.guild;
  if (!guild) {
    return;
  }

  const requiredCommands = [
    {
      name: 'dailyreport',
      description: 'Generate and send a daily report for Notion tasks',
    },
    {
      name: 'remindercheck',
      description: 'Run deadline reminder check now and send due/overdue reminders',
    },
  ];

  for (const commandDef of requiredCommands) {
    const exists = guild.commands.cache.find(command => command.name === commandDef.name);
    if (exists) {
      continue;
    }

    await guild.commands.create(commandDef);
  }
}

function registerCommandHandlers() {
  discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName !== 'dailyreport' && interaction.commandName !== 'remindercheck') {
      return;
    }

    if (!isConfiguredChannel(interaction.channelId)) {
      await interaction.reply({
        content: `Please use this command in a configured channel: ${formatConfiguredChannelsMentionText()}.`,
        ephemeral: true,
      });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
      const configuredChannels = await fetchConfiguredChannels();
      if (configuredChannels.length === 0) {
        throw new Error('No configured text channels are available.');
      }

      if (interaction.commandName === 'dailyreport') {
        await runDailyReport(configuredChannels);
        await interaction.editReply(`Daily report sent to ${configuredChannels.length} channel(s).`);
      }

      if (interaction.commandName === 'remindercheck') {
        const reminderCounts = await runReminderCheck(configuredChannels);
        const totalReminderCount = reminderCounts.reduce((sum, count) => sum + count, 0);
        await interaction.editReply(
          `Reminder check completed. Sent ${totalReminderCount} reminder(s) across ${configuredChannels.length} channel(s).`
        );
      }
    } catch (error) {
      console.error('Error running slash command:', error.message);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Command failed. Please check the bot logs.');
      } else {
        await interaction.reply({
          content: 'Command failed. Please check the bot logs.',
          ephemeral: true,
        });
      }
    }
  });
}

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
    const trackedCards = filterCardsByTrackedOrganization(formattedCards);
    console.log(
      `🏷️  Tracking organization "${config.sync.trackedOrganization}": ${trackedCards.length}/${formattedCards.length} cards`
    );

    // Find changed cards
    const {
      changedCards,
      createdCards,
      deletedCards,
      deletedCardIds,
      skippedNewCards,
    } = findChangedCards(stateTracker, trackedCards);

    const trackedDeletedCards = deletedCards.filter(card => cardMatchesTrackedOrganization(card));
    const trackedDeletedCardIdSet = new Set(trackedDeletedCards.map(card => card.id));
    const trackedDeletedCardIds = deletedCardIds.filter(cardId => trackedDeletedCardIdSet.has(cardId));

    console.log(
      `📈 Sync summary: created=${createdCards.length}, changed=${changedCards.length}, deleted=${trackedDeletedCardIds.length}, skippedNew=${skippedNewCards}`
    );

    // Handle deleted cards
    for (const deletedId of trackedDeletedCardIds) {
      console.log(`🗑️  Card deleted: ${deletedId}`);
    }

    if (deletedCardIds.length > 0) {
      stateTracker.removeCardStates(deletedCardIds);
    }

    const now = new Date();
    const reminderStateByCardId = stateTracker.getMeta('deadlineReminderByCardId', {});

    // Post updates and reminders when applicable.
    if (createdCards.length > 0 || changedCards.length > 0 || trackedDeletedCards.length > 0) {
      console.log(
        `✏️  Found updates: created=${createdCards.length}, changed=${changedCards.length}, removed=${trackedDeletedCards.length}`
      );
    }

    try {
      const channels = await fetchConfiguredChannels();
      if (channels.length === 0) {
        throw new Error('No configured text channels are available.');
      }

      const primaryChannel = channels[0];
      const primaryMentions = buildDepartmentRoleMentions(primaryChannel);
      const primaryReminderResult = createDeadlineReminderEmbeds(
        trackedCards,
        primaryMentions,
        reminderStateByCardId,
        now
      );
      const hasAnyEmbeds =
        primaryReminderResult.embeds.length > 0 ||
        createdCards.length > 0 ||
        changedCards.length > 0 ||
        trackedDeletedCards.length > 0;

      if (!hasAnyEmbeds) {
        console.log('✓ No changes detected');
      } else {
        for (const channel of channels) {
          const departmentRoleMentions = buildDepartmentRoleMentions(channel);
          const createdEmbeds = createCreatedEmbeds(createdCards, departmentRoleMentions);
          const changedEmbeds = createChangeEmbeds(changedCards, departmentRoleMentions);
          const removedEmbeds = createRemovedEmbeds(trackedDeletedCards, departmentRoleMentions);
          const reminderResult = createDeadlineReminderEmbeds(
            trackedCards,
            departmentRoleMentions,
            reminderStateByCardId,
            now
          );
          const embeds = [...reminderResult.embeds, ...createdEmbeds, ...changedEmbeds, ...removedEmbeds];

          if (embeds.length === 0) {
            continue;
          }

          await sendEmbedsToChannel(channel, embeds);
        }

        console.log(
          `✅ Posted updates to ${channels.length} channel(s) (reminders=${primaryReminderResult.embeds.length})`
        );
      }

      stateTracker.setMeta('deadlineReminderByCardId', primaryReminderResult.reminderStateByCardId);
    } catch (error) {
      console.error('Error sending Discord message:', error.message);
    }

    // Update tracker with current state
    stateTracker.setCardStates(trackedCards);
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
    console.log(`🏷️  Tracked organization: ${config.sync.trackedOrganization}`);
    console.log(`💬 Posting updates to Discord channels: ${config.discord.channelIds.join(', ')}`);
    const configuredChannels = await fetchConfiguredChannels();
    if (configuredChannels.length === 0) {
      throw new Error('No configured text channels are available.');
    }

    const registeredGuildIds = new Set();
    for (const configuredChannel of configuredChannels) {
      const guildId = configuredChannel?.guild?.id;
      if (!guildId || registeredGuildIds.has(guildId)) {
        continue;
      }

      await registerSlashCommands(configuredChannel);
      registeredGuildIds.add(guildId);
    }
    console.log('⌨️  Manual commands enabled: /dailyreport, /remindercheck');
    console.log(`⏱️  Polling interval: ${config.polling.intervalSeconds} seconds\n`);

    registerCommandHandlers();

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
