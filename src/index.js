import discordClient from './discord/bot.js';
import { PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fetchDatabaseCards, formatCardForTracking } from './notion/database.js';
import stateTracker from './sync/tracker.js';
import {
  findChangedCards,
  createChangeEmbeds,
  createCreatedEmbeds,
  createRemovedEmbeds,
  createDeadlineReminderEmbeds,
  createCalendarOverviewEmbeds,
  hasRequiredTaskDetails,
  getMissingRequiredTaskDetails,
} from './sync/syncer.js';
import config from './config.js';

let isRunning = false;
const PROCESS_LOCK_FILE = path.join(process.cwd(), '.notionbot.lock');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid() {
  try {
    const raw = fs.readFileSync(PROCESS_LOCK_FILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function acquireProcessLock() {
  try {
    fs.writeFileSync(PROCESS_LOCK_FILE, String(process.pid), { flag: 'wx' });
    return;
  } catch {
    const existingPid = readLockPid();
    if (existingPid && isProcessAlive(existingPid)) {
      throw new Error(`Another bot instance is already running (PID ${existingPid}).`);
    }

    try {
      fs.unlinkSync(PROCESS_LOCK_FILE);
    } catch {
      // Ignore stale lock cleanup errors and retry lock creation below.
    }

    fs.writeFileSync(PROCESS_LOCK_FILE, String(process.pid), { flag: 'wx' });
  }
}

function releaseProcessLock() {
  try {
    if (!fs.existsSync(PROCESS_LOCK_FILE)) {
      return;
    }

    const lockPid = readLockPid();
    if (lockPid === process.pid) {
      fs.unlinkSync(PROCESS_LOCK_FILE);
    }
  } catch {
    // Best-effort cleanup.
  }
}

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

function getMonthKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

function isAdminInteraction(interaction) {
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has(PermissionFlagsBits.Administrator));
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

function collectRoleMentionsFromEmbeds(embeds) {
  const mentionSet = new Set();

  for (const embed of embeds) {
    const roleMentions = extractRoleMentionsFromEmbed(embed);
    for (const mention of roleMentions) {
      mentionSet.add(mention);
    }
  }

  return Array.from(mentionSet);
}

async function sendEmbedsToChannel(channel, embeds, options = {}) {
  const { singleMessage = false } = options;

  if (singleMessage) {
    const chunks = [];
    for (let i = 0; i < embeds.length; i += 10) {
      chunks.push(embeds.slice(i, i + 10));
    }

    for (const chunk of chunks) {
      const roleMentions = collectRoleMentionsFromEmbeds(chunk);
      const roleIds = extractRoleIdsFromMentions(roleMentions);

      await channel.send({
        content: roleMentions.join(' '),
        embeds: chunk,
        allowedMentions: {
          parse: [],
          roles: roleIds,
        },
      });
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return;
  }

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

async function runCalendarOverview(channels, range = 'week', now = new Date()) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);
  const trackedCards = filterCardsByTrackedOrganization(formattedCards);

  for (const channel of channels) {
    const embeds = createCalendarOverviewEmbeds(trackedCards, range, now);
    await sendEmbedsToChannel(channel, embeds, { singleMessage: true });
  }
}

async function runMonthlyOverview(channels, now = new Date()) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);
  const trackedCards = filterCardsByTrackedOrganization(formattedCards);

  for (const channel of channels) {
    const embeds = createCalendarOverviewEmbeds(trackedCards, 'month', now, {
      title: '📅 Monthly Overview',
    });
    await sendEmbedsToChannel(channel, embeds, { singleMessage: true });
  }
}

async function clearChannelMessages(channel) {
  const MAX_FETCH = 100;
  const BULK_DELETE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  while (true) {
    const messages = await channel.messages.fetch({ limit: MAX_FETCH });
    if (messages.size === 0) {
      break;
    }

    const deletable = Array.from(messages.values()).filter(message => !message.pinned);
    if (deletable.length === 0) {
      break;
    }

    const nowMs = Date.now();
    const recentMessages = deletable.filter(
      message => nowMs - message.createdTimestamp < BULK_DELETE_WINDOW_MS
    );
    const olderMessages = deletable.filter(
      message => nowMs - message.createdTimestamp >= BULK_DELETE_WINDOW_MS
    );

    if (recentMessages.length > 0) {
      const deleted = await channel.bulkDelete(recentMessages, true);
      deletedCount += deleted.size;
    }

    for (const message of olderMessages) {
      try {
        await message.delete();
        deletedCount += 1;
      } catch {
        // Ignore undeletable messages and keep clearing remaining messages.
      }
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }

  return deletedCount;
}

async function registerSlashCommands(channel) {
  const guild = channel?.guild;
  if (!guild) {
    return;
  }

  const requiredCommands = [
    {
      name: 'remindercheck',
      description: 'Run deadline reminder check now and send due/overdue reminders',
    },
    {
      name: 'calendar',
      description: 'Post calendar overview for today, week, or month',
      options: [
        {
          name: 'range',
          description: 'Select calendar range',
          type: 3,
          required: true,
          choices: [
            { name: 'today', value: 'today' },
            { name: 'week', value: 'week' },
            { name: 'month', value: 'month' },
          ],
        },
      ],
    },
    {
      name: 'clear',
      description: 'Admin only: clear all messages in this configured channel',
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

    if (
      interaction.commandName !== 'remindercheck' &&
      interaction.commandName !== 'calendar' &&
      interaction.commandName !== 'clear'
    ) {
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
      const commandChannel = interaction.channel || await discordClient.channels.fetch(interaction.channelId);
      if (!commandChannel || typeof commandChannel.send !== 'function') {
        throw new Error('This command can only be used in a text channel.');
      }

      const targetChannels = [commandChannel];

      if (interaction.commandName === 'remindercheck') {
        const reminderCounts = await runReminderCheck(targetChannels);
        const totalReminderCount = reminderCounts.reduce((sum, count) => sum + count, 0);
        await interaction.editReply(`Reminder check completed. Sent ${totalReminderCount} reminder(s).`);
      }

      if (interaction.commandName === 'calendar') {
        const range = interaction.options.getString('range', true);
        await runCalendarOverview(targetChannels, range, new Date());
        await interaction.editReply(`Calendar overview (${range}) posted.`);
      }

      if (interaction.commandName === 'clear') {
        if (!isAdminInteraction(interaction)) {
          await interaction.editReply('This command is admin-only.');
          return;
        }

        const deletedCount = await clearChannelMessages(commandChannel);
        await interaction.editReply(`Cleared ${deletedCount} message(s) from this channel.`);
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
    const wasInitialSync = stateTracker.getAllCardIds().length === 0;

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
    const creationNotifiedByCardId = {
      ...stateTracker.getMeta('creationNotifiedByCardId', {}),
    };

    let creationMetaChanged = false;
    for (const deletedId of deletedCardIds) {
      if (Object.hasOwn(creationNotifiedByCardId, deletedId)) {
        delete creationNotifiedByCardId[deletedId];
        creationMetaChanged = true;
      }
    }

    if (wasInitialSync && Object.keys(creationNotifiedByCardId).length === 0) {
      // Treat existing cards as baseline to avoid flooding create notifications on first run.
      for (const card of trackedCards) {
        creationNotifiedByCardId[card.id] = true;
      }
      creationMetaChanged = true;
    }

    const readyCreatedCards = trackedCards.filter(card => {
      if (creationNotifiedByCardId[card.id]) {
        return false;
      }

      return hasRequiredTaskDetails(card);
    });
    const blockedCreatedCards = trackedCards.filter(card => {
      if (creationNotifiedByCardId[card.id]) {
        return false;
      }

      return !hasRequiredTaskDetails(card);
    });

    // Detail updates should always notify for tracked existing cards, regardless of create-notice state.
    const notifiableChangedCards = changedCards;

    const trackedDeletedCards = deletedCards.filter(card => cardMatchesTrackedOrganization(card));
    const trackedDeletedCardIdSet = new Set(trackedDeletedCards.map(card => card.id));
    const trackedDeletedCardIds = deletedCardIds.filter(cardId => trackedDeletedCardIdSet.has(cardId));

    console.log(
      `📈 Sync summary: created=${createdCards.length}, readyForCreateNotice=${readyCreatedCards.length}, blockedForCreateNotice=${blockedCreatedCards.length}, changed=${changedCards.length}, changedNotified=${notifiableChangedCards.length}, deleted=${trackedDeletedCardIds.length}, skippedNew=${skippedNewCards}`
    );

    if (blockedCreatedCards.length > 0) {
      const previewCards = blockedCreatedCards.slice(0, 5);
      for (const card of previewCards) {
        const missingFields = getMissingRequiredTaskDetails(card);
        const cardName = card?.properties?.['กิจกรรม'] || card.id;
        console.log(`⛔ Create notice blocked for "${cardName}": missing [${missingFields.join(', ')}]`);
      }

      if (blockedCreatedCards.length > previewCards.length) {
        console.log(`⛔ ...and ${blockedCreatedCards.length - previewCards.length} more blocked card(s)`);
      }
    }

    // Handle deleted cards
    for (const deletedId of trackedDeletedCardIds) {
      console.log(`🗑️  Card deleted: ${deletedId}`);
    }

    if (deletedCardIds.length > 0) {
      stateTracker.removeCardStates(deletedCardIds);
    }

    const now = new Date();
    const reminderStateByCardId = stateTracker.getMeta('deadlineReminderByCardId', {});

    if (
      readyCreatedCards.length > 0 ||
      notifiableChangedCards.length > 0 ||
      trackedDeletedCards.length > 0
    ) {
      console.log(
        `✏️  Found updates: created=${readyCreatedCards.length}, changed=${notifiableChangedCards.length}, removed=${trackedDeletedCards.length}`
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
        readyCreatedCards.length > 0 ||
        notifiableChangedCards.length > 0 ||
        trackedDeletedCards.length > 0;

      if (!hasAnyEmbeds) {
        console.log('✓ No changes detected');
      } else {
        for (const channel of channels) {
          const departmentRoleMentions = buildDepartmentRoleMentions(channel);
          const reminderResult = createDeadlineReminderEmbeds(
            trackedCards,
            departmentRoleMentions,
            reminderStateByCardId,
            now
          );
          const createdEmbeds = createCreatedEmbeds(readyCreatedCards, departmentRoleMentions);
          const changedEmbeds = createChangeEmbeds(notifiableChangedCards, departmentRoleMentions);
          const removedEmbeds = createRemovedEmbeds(trackedDeletedCards, departmentRoleMentions);
          const embeds = [...reminderResult.embeds, ...createdEmbeds, ...changedEmbeds, ...removedEmbeds];

          if (embeds.length === 0) {
            continue;
          }

          await sendEmbedsToChannel(channel, embeds);
        }

        for (const card of readyCreatedCards) {
          creationNotifiedByCardId[card.id] = true;
        }
        creationMetaChanged = true;

        console.log(
          `✅ Posted updates to ${channels.length} channel(s) (reminders=${primaryReminderResult.embeds.length})`
        );
      }

      stateTracker.setMeta('deadlineReminderByCardId', primaryReminderResult.reminderStateByCardId);

      const currentMonthKey = getMonthKey(now);
      const lastMonthlyOverviewKey = stateTracker.getMeta('monthlyOverviewLastSentKey', null);
      if (now.getDate() === 1 && lastMonthlyOverviewKey !== currentMonthKey) {
        await runMonthlyOverview(channels, now);
        stateTracker.setMeta('monthlyOverviewLastSentKey', currentMonthKey);
        console.log('📅 Posted automatic monthly overview.');
      }
    } catch (error) {
      console.error('Error sending Discord message:', error.message);
    }

    if (creationMetaChanged) {
      stateTracker.setMeta('creationNotifiedByCardId', creationNotifiedByCardId);
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
    acquireProcessLock();
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
      console.warn('⚠️  No configured text channels are currently reachable. Bot will stay online and retry during sync.');
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
    console.log('⌨️  Manual commands enabled: /remindercheck, /calendar, /clear');
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
      releaseProcessLock();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      clearInterval(intervalId);
      await discordClient.destroy();
      releaseProcessLock();
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Failed to start bot:', error.message);
    releaseProcessLock();
    process.exit(1);
  }
}

// Start the bot
startBot();
