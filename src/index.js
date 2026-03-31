import discordClient from './discord/bot.js';
import { ApplicationCommandOptionType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { waitForDiscordClientReady } from './discord/compat.js';
import {
  fetchDatabaseCards,
  formatCardForTracking,
  createDatabaseCard,
  readDatabaseCard,
  updateDatabaseCard,
  archiveDatabaseCard,
  resolveDatabaseCardReference,
  getTaskAutocompleteSuggestions,
} from './notion/database.js';
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
const AUTOCOMPLETE_LIMIT = 25;

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

function getDepartmentValues(properties = {}) {
  const departmentValue = properties?.Department;

  if (Array.isArray(departmentValue)) {
    return departmentValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof departmentValue === 'string') {
    return departmentValue
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function toNormalizedDepartmentSet(departmentFilters = []) {
  const normalized = new Set();

  for (const department of departmentFilters) {
    const normalizedValue = normalizeLookupText(department);
    if (normalizedValue) {
      normalized.add(normalizedValue);
    }
  }

  return normalized;
}

function cardMatchesDepartmentSet(card, departmentSet) {
  if (!(departmentSet instanceof Set) || departmentSet.size === 0) {
    return true;
  }

  const departments = getDepartmentValues(card?.properties || {});
  return departments.some(dept => departmentSet.has(normalizeLookupText(dept)));
}

function getChannelDepartmentFilters(channelId) {
  if (Object.hasOwn(config.sync.channelDepartmentsByChannelId, channelId)) {
    return config.sync.channelDepartmentsByChannelId[channelId];
  }

  return config.sync.trackedDepartments;
}

function hasChannelSpecificDepartmentRouting() {
  return Object.keys(config.sync.channelDepartmentsByChannelId).length > 0;
}

function formatDepartmentFilterForDisplay(departmentFilters = []) {
  if (!Array.isArray(departmentFilters) || departmentFilters.length === 0) {
    return 'ALL';
  }

  return departmentFilters.join(' | ');
}

function filterCardsByDepartmentFilters(cards, departmentFilters = []) {
  const departmentSet = toNormalizedDepartmentSet(departmentFilters);
  return cards.filter(card => cardMatchesDepartmentSet(card, departmentSet));
}

function filterCardsForChannel(cards, channelId) {
  // When per-channel routing is configured, do not fall back for unmapped channels.
  if (
    hasChannelSpecificDepartmentRouting() &&
    !Object.hasOwn(config.sync.channelDepartmentsByChannelId, channelId)
  ) {
    return [];
  }

  return filterCardsByDepartmentFilters(cards, getChannelDepartmentFilters(channelId));
}

function getSyncScopeDepartmentSet() {
  const mergedSet = new Set();

  for (const channelId of config.discord.channelIds) {
    if (
      hasChannelSpecificDepartmentRouting() &&
      !Object.hasOwn(config.sync.channelDepartmentsByChannelId, channelId)
    ) {
      continue;
    }

    const channelSet = toNormalizedDepartmentSet(getChannelDepartmentFilters(channelId));
    if (channelSet.size === 0) {
      return new Set();
    }

    for (const department of channelSet) {
      mergedSet.add(department);
    }
  }

  return mergedSet;
}

function filterCardsBySyncScope(cards) {
  const syncScopeDepartmentSet = getSyncScopeDepartmentSet();
  return cards.filter(card => cardMatchesDepartmentSet(card, syncScopeDepartmentSet));
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

async function canUseCommandOutsideConfiguredChannel(interaction) {
  if (interaction.commandName === 'task') {
    return true;
  }

  if (interaction.commandName === 'clear') {
    return false;
  }

  return isAdminInteraction(interaction) || await hasAllowedTaskRole(interaction);
}

function formatConfiguredChannelsMentionText() {
  return config.discord.channelIds.map(channelId => `<#${channelId}>`).join(', ');
}

async function safeEphemeralReply(interaction, content) {
  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
      return;
    }

    await interaction.reply(payload);
  } catch (error) {
    if (error?.code === 40060) {
      try {
        await interaction.followUp(payload);
      } catch {
        // No-op: interaction may already be closed.
      }

      return;
    }

    throw error;
  }
}

async function safeCommandFailureReply(interaction, message) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
      return;
    }

    await safeEphemeralReply(interaction, message);
  } catch (error) {
    if (error?.code === 40060) {
      try {
        await interaction.followUp({
          content: message,
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // No-op: interaction may already be closed.
      }

      return;
    }

    throw error;
  }
}

function getMonthKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}`;
}

function isAdminInteraction(interaction) {
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has(PermissionFlagsBits.Administrator));
}

function getInteractionRoleIds(interaction) {
  const memberRoles = interaction?.member?.roles;

  if (Array.isArray(memberRoles)) {
    return memberRoles.map(roleId => String(roleId));
  }

  const roleCache = memberRoles?.cache;
  if (roleCache && typeof roleCache.keys === 'function') {
    return Array.from(roleCache.keys());
  }

  return [];
}

async function getRoleNameById(guild, roleId) {
  if (!guild || !roleId) {
    return null;
  }

  const cachedRole = guild.roles?.cache?.get(roleId);
  if (cachedRole?.name) {
    return cachedRole.name;
  }

  if (typeof guild.roles?.fetch !== 'function') {
    return null;
  }

  try {
    const fetchedRole = await guild.roles.fetch(roleId);
    return fetchedRole?.name || null;
  } catch {
    return null;
  }
}

async function hasAllowedTaskRole(interaction) {
  const allowedRoleNames = config.permissions?.taskCommandRoleNames || [];
  if (!Array.isArray(allowedRoleNames) || allowedRoleNames.length === 0) {
    return false;
  }

  const normalizedAllowedRoleNames = new Set(
    allowedRoleNames
      .map(roleName => normalizeLookupText(roleName))
      .filter(Boolean)
  );
  if (normalizedAllowedRoleNames.size === 0) {
    return false;
  }

  const guild = interaction?.guild;
  if (!guild) {
    return false;
  }

  const roleIds = getInteractionRoleIds(interaction);
  for (const roleId of roleIds) {
    const roleName = await getRoleNameById(guild, roleId);
    if (!roleName) {
      continue;
    }

    if (normalizedAllowedRoleNames.has(normalizeLookupText(roleName))) {
      return true;
    }
  }

  return false;
}

async function canManageTaskCommands(interaction) {
  return isAdminInteraction(interaction) || await hasAllowedTaskRole(interaction);
}

function formatScalarReplyValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'None';
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : 'None';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

function getTaskTitle(card) {
  const properties = card?.properties || {};
  const directTitle = properties['กิจกรรม'];

  if (typeof directTitle === 'string' && directTitle.trim().length > 0) {
    return directTitle.trim();
  }

  const firstStringValue = Object.values(properties).find(
    value => typeof value === 'string' && value.trim().length > 0
  );

  if (typeof firstStringValue === 'string') {
    return firstStringValue;
  }

  return `Card ${card.id.slice(0, 8)}`;
}

function formatTaskReply(card, titlePrefix = 'Task') {
  const properties = card?.properties || {};
  const title = getTaskTitle(card);
  const organizationValue = Object.entries(properties).find(
    ([key]) => key.toLowerCase().includes('organization') || key.toLowerCase().includes('organisation')
  )?.[1] ?? properties.Organization;

  return [
    `**${titlePrefix}:** ${title}`,
    `**ID:** ${card.id}`,
    `**Department:** ${formatScalarReplyValue(properties.Department)}`,
    `**Organization:** ${formatScalarReplyValue(organizationValue)}`,
    `**Status:** ${formatScalarReplyValue(properties.Status)}`,
    `**Date:** ${formatScalarReplyValue(properties.Date)}`,
    `**URL:** ${card.url || 'N/A'}`,
  ].join('\n');
}

function getTaskUpdatePayloadFromInteraction(interaction) {
  const title = interaction.options.getString('title');
  const department = interaction.options.getString('department');
  const organization = interaction.options.getString('organization');
  const startDate = interaction.options.getString('start_date');
  const endDate = interaction.options.getString('end_date');
  const startTime = interaction.options.getString('start_time');
  const endTime = interaction.options.getString('end_time');
  const status = interaction.options.getString('status');

  const updates = {};
  if (typeof title === 'string') {
    updates.title = title;
  }
  if (typeof department === 'string') {
    updates.department = department;
  }
  if (typeof organization === 'string') {
    updates.organization = organization;
  }
  if (
    typeof startDate === 'string' ||
    typeof endDate === 'string' ||
    typeof startTime === 'string' ||
    typeof endTime === 'string'
  ) {
    updates.date = {
      startDate,
      endDate,
      startTime,
      endTime,
    };
  }
  if (typeof status === 'string') {
    updates.status = status;
  }

  return updates;
}

function formatDateForAutocomplete(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function buildDateAutocompleteChoices(focusedValue = '') {
  const normalizedFocused = String(focusedValue || '').trim().toLowerCase();
  const now = new Date();
  const candidates = [];

  for (let offset = 0; offset <= 14; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const formatted = formatDateForAutocomplete(date);
    candidates.push(formatted, `${formatted} AD`);
  }

  candidates.push('01/01/0044 BC', '15/03/0044 BC');

  const seen = new Set();
  return candidates
    .filter(value => {
      const normalized = value.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      if (!normalizedFocused) {
        return true;
      }

      return normalized.includes(normalizedFocused);
    })
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map(value => ({ name: value, value }));
}

function format12HourTime(hour24, minute) {
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function buildTimeAutocompleteChoices(focusedValue = '') {
  const normalizedFocused = String(focusedValue || '').trim().toLowerCase();
  const candidates = [];

  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 30]) {
      const time24 = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const time12 = format12HourTime(hour, minute);
      candidates.push(time24, time12);
    }
  }

  const seen = new Set();
  return candidates
    .filter(value => {
      const normalized = value.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }

      seen.add(normalized);
      if (!normalizedFocused) {
        return true;
      }

      return normalized.includes(normalizedFocused);
    })
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map(value => ({ name: value, value }));
}

async function handleTaskAutocomplete(interaction) {
  if (interaction.commandName !== 'task') {
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (!focused) {
    await interaction.respond([]);
    return;
  }

  if (focused.name === 'start_date' || focused.name === 'end_date') {
    await interaction.respond(buildDateAutocompleteChoices(String(focused.value || '')));
    return;
  }

  if (focused.name === 'start_time' || focused.name === 'end_time') {
    await interaction.respond(buildTimeAutocompleteChoices(String(focused.value || '')));
    return;
  }

  if (
    focused.name !== 'department' &&
    focused.name !== 'status' &&
    focused.name !== 'organization'
  ) {
    await interaction.respond([]);
    return;
  }

  try {
    const suggestions = await getTaskAutocompleteSuggestions(focused.name, String(focused.value || ''));
    await interaction.respond(suggestions);
  } catch (error) {
    console.error('Task autocomplete failed:', error.message);
    await interaction.respond([]);
  }
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
  const reminderStateByCardId = stateTracker.getMeta('deadlineReminderByCardId', {});
  const reminderCounts = [];

  for (const channel of channels) {
    const channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);
    const departmentRoleMentions = buildDepartmentRoleMentions(channel);

    const reminderResult = createDeadlineReminderEmbeds(
      channelTrackedCards,
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

  for (const channel of channels) {
    const channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);
    const embeds = createCalendarOverviewEmbeds(channelTrackedCards, range, now);
    await sendEmbedsToChannel(channel, embeds, { singleMessage: true });
  }
}

async function runMonthlyOverview(channels, now = new Date()) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);

  for (const channel of channels) {
    const channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);
    const embeds = createCalendarOverviewEmbeds(channelTrackedCards, 'month', now, {
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
    {
      name: 'task',
      description: 'CRUD task records in the connected Notion database',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'create',
          description: 'Create a new Notion task',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'title',
              description: 'Task title',
              required: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'department',
              description: 'Department(s), comma-separated (choose from suggestions)',
              required: true,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_date',
              description: 'Start date: DD/MM/YYYY [AD|BC]',
              required: true,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'organization',
              description: 'Organization(s), comma-separated. SMO CAMT is always included',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_date',
              description: 'End date: DD/MM/YYYY [AD|BC] (optional)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_time',
              description: 'Start time: HH:mm or h:mm AM/PM (optional)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_time',
              description: 'End time: HH:mm or h:mm AM/PM (optional)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'status',
              description: 'Optional status (choose from suggestions)',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'read',
          description: 'Read task details by title or page ID/URL',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'update',
          description: 'Update fields of an existing Notion task',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'title',
              description: 'New task title',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'department',
              description: 'New department(s), comma-separated',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'organization',
              description: 'New organization(s), comma-separated. SMO CAMT is always included',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_date',
              description: 'New start date: DD/MM/YYYY [AD|BC]',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_date',
              description: 'New end date: DD/MM/YYYY [AD|BC]',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_time',
              description: 'New start time: HH:mm or h:mm AM/PM',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_time',
              description: 'New end time: HH:mm or h:mm AM/PM',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'status',
              description: 'New status (choose from suggestions)',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'move',
          description: 'Move task status quickly (title or id/url)',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'to',
              description: 'Target status',
              required: true,
              choices: [
                { name: 'In-Progress', value: 'In-Progress' },
                { name: 'In-Review', value: 'In-Review' },
                { name: 'Done', value: 'Done' },
              ],
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'delete',
          description: 'Archive a task in Notion by title or page ID/URL',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
          ],
        },
      ],
    },
  ];

  for (const commandDef of requiredCommands) {
    const exists = guild.commands.cache.find(command => command.name === commandDef.name);
    if (!exists) {
      await guild.commands.create(commandDef);
      continue;
    }

    await exists.edit(commandDef);
  }
}

function registerCommandHandlers() {
  discordClient.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      await handleTaskAutocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (
      interaction.commandName !== 'remindercheck' &&
      interaction.commandName !== 'calendar' &&
      interaction.commandName !== 'clear' &&
      interaction.commandName !== 'task'
    ) {
      return;
    }

    if (!isConfiguredChannel(interaction.channelId) && !(await canUseCommandOutsideConfiguredChannel(interaction))) {
      const allowedRoles = config.permissions.taskCommandRoleNames.join(', ');
      await safeEphemeralReply(
        interaction,
        `Please use this command in a configured channel: ${formatConfiguredChannelsMentionText()}. Users with Admin permission or one of these roles can use non-admin commands in any channel: ${allowedRoles}.`
      );
      return;
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

      if (interaction.commandName === 'task') {
        const subcommand = interaction.options.getSubcommand(true);
        const isWriteSubcommand =
          subcommand === 'create' ||
          subcommand === 'update' ||
          subcommand === 'move' ||
          subcommand === 'delete';

        if (isWriteSubcommand && !(await canManageTaskCommands(interaction))) {
          const allowedRoles = config.permissions.taskCommandRoleNames.join(', ');
          await interaction.editReply(
            `Task create/update/move/delete commands require Admin permission or one of these roles: ${allowedRoles}.`
          );
          return;
        }

        if (subcommand === 'create') {
          const title = interaction.options.getString('title', true);
          const department = interaction.options.getString('department', true);
          const organization = interaction.options.getString('organization');
          const startDate = interaction.options.getString('start_date', true);
          const endDate = interaction.options.getString('end_date');
          const startTime = interaction.options.getString('start_time');
          const endTime = interaction.options.getString('end_time');
          const status = interaction.options.getString('status');

          const createdCard = await createDatabaseCard({
            title,
            department,
            organization,
            date: {
              startDate,
              endDate,
              startTime,
              endTime,
            },
            status,
          });

          await syncNotionToDiscord();
          const instanceMarker = `instance:${process.pid} db:${String(config.notion.databaseId).slice(0, 8)}`;
          await interaction.editReply(
            `Task created and sync triggered (${instanceMarker}).\n\n${formatTaskReply(createdCard, 'Created')}`
          );
        }

        if (subcommand === 'read') {
          const pageIdOrUrl = interaction.options.getString('id');
          const taskTitle = interaction.options.getString('task_title');

          if (!pageIdOrUrl && !taskTitle) {
            await interaction.editReply('Please provide either id/url or task_title for read.');
            return;
          }

          const card = await resolveDatabaseCardReference({
            pageIdOrUrl,
            title: taskTitle,
          });
          await interaction.editReply(formatTaskReply(card, 'Task'));
        }

        if (subcommand === 'update') {
          const pageIdOrUrl = interaction.options.getString('id');
          const taskTitle = interaction.options.getString('task_title');

          if (!pageIdOrUrl && !taskTitle) {
            await interaction.editReply('Please provide either id/url or task_title for update.');
            return;
          }

          const resolvedCard = await resolveDatabaseCardReference({
            pageIdOrUrl,
            title: taskTitle,
          });
          const updates = getTaskUpdatePayloadFromInteraction(interaction);

          if (
            updates.date &&
            typeof updates.date === 'object' &&
            !updates.date.startDate &&
            (updates.date.endDate || updates.date.startTime || updates.date.endTime)
          ) {
            await interaction.editReply('When setting end date/time or time fields, please include start_date.');
            return;
          }

          if (Object.keys(updates).length === 0) {
            await interaction.editReply(
              'No update fields provided. Set at least one of: title, department, organization, start_date, end_date, start_time, end_time, status.'
            );
            return;
          }

          const updatedCard = await updateDatabaseCard(resolvedCard.id, updates);
          await syncNotionToDiscord();
          await interaction.editReply(`Task updated and sync triggered.\n\n${formatTaskReply(updatedCard, 'Updated')}`);
        }

        if (subcommand === 'move') {
          const targetStatus = interaction.options.getString('to', true);
          const pageIdOrUrl = interaction.options.getString('id');
          const taskTitle = interaction.options.getString('task_title');

          if (!pageIdOrUrl && !taskTitle) {
            await interaction.editReply('Please provide either id/url or task_title for move.');
            return;
          }

          const resolvedCard = await resolveDatabaseCardReference({
            pageIdOrUrl,
            title: taskTitle,
          });

          const movedCard = await updateDatabaseCard(resolvedCard.id, {
            status: targetStatus,
          });

          await syncNotionToDiscord();
          await interaction.editReply(`Task moved to **${targetStatus}** and sync triggered.\n\n${formatTaskReply(movedCard, 'Moved')}`);
        }

        if (subcommand === 'delete') {
          const pageIdOrUrl = interaction.options.getString('id');
          const taskTitle = interaction.options.getString('task_title');

          if (!pageIdOrUrl && !taskTitle) {
            await interaction.editReply('Please provide either id/url or task_title for delete.');
            return;
          }

          const resolvedCard = await resolveDatabaseCardReference({
            pageIdOrUrl,
            title: taskTitle,
          });

          const archivedCard = await archiveDatabaseCard(resolvedCard.id);
          await syncNotionToDiscord();
          await interaction.editReply(
            [
              'Task archived in Notion and sync triggered.',
              `**Title:** ${getTaskTitle(resolvedCard)}`,
              `**ID:** ${archivedCard.id}`,
              `**Archived:** ${archivedCard.archived ? 'Yes' : 'No'}`,
              `**URL:** ${archivedCard.url || 'N/A'}`,
            ].join('\n')
          );
        }
      }
    } catch (error) {
      console.error('Error running slash command:', error.message);
      await safeCommandFailureReply(interaction, 'Command failed. Please check the bot logs.');
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
    const syncScopeDepartmentSet = getSyncScopeDepartmentSet();
    const trackedCards = filterCardsBySyncScope(formattedCards);
    console.log(
      `🏷️  Tracking sync scope (${formatDepartmentFilterForDisplay(config.sync.trackedDepartments)} default): ${trackedCards.length}/${formattedCards.length} cards`
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

    const trackedDeletedCards = deletedCards.filter(card => cardMatchesDepartmentSet(card, syncScopeDepartmentSet));
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

      const channelResults = [];
      for (const channel of channels) {
        const channelTrackedCards = filterCardsForChannel(trackedCards, channel.id);
        const channelReadyCreatedCards = filterCardsForChannel(readyCreatedCards, channel.id);
        const channelNotifiableChangedCards = filterCardsForChannel(notifiableChangedCards, channel.id);
        const channelTrackedDeletedCards = filterCardsForChannel(trackedDeletedCards, channel.id);
        const departmentRoleMentions = buildDepartmentRoleMentions(channel);
        const reminderResult = createDeadlineReminderEmbeds(
          channelTrackedCards,
          departmentRoleMentions,
          reminderStateByCardId,
          now
        );
        const createdEmbeds = createCreatedEmbeds(channelReadyCreatedCards, departmentRoleMentions);
        const changedEmbeds = createChangeEmbeds(channelNotifiableChangedCards, departmentRoleMentions);
        const removedEmbeds = createRemovedEmbeds(channelTrackedDeletedCards, departmentRoleMentions);
        const embeds = [...reminderResult.embeds, ...createdEmbeds, ...changedEmbeds, ...removedEmbeds];

        channelResults.push({
          channel,
          embeds,
          reminderResult,
          channelReadyCreatedCards,
        });
      }

      const hasAnyEmbeds = channelResults.some(result => result.embeds.length > 0);

      if (!hasAnyEmbeds) {
        console.log('✓ No changes detected');
      } else {
        for (const result of channelResults) {
          if (result.embeds.length === 0) {
            continue;
          }

          await sendEmbedsToChannel(result.channel, result.embeds);
        }

        const notifiedCreatedCardIdSet = new Set();
        for (const result of channelResults) {
          for (const card of result.channelReadyCreatedCards) {
            notifiedCreatedCardIdSet.add(card.id);
          }
        }

        for (const cardId of notifiedCreatedCardIdSet) {
          creationNotifiedByCardId[cardId] = true;
        }

        if (notifiedCreatedCardIdSet.size > 0) {
          creationMetaChanged = true;
        }

        const totalReminderCount = channelResults.reduce(
          (sum, result) => sum + result.reminderResult.embeds.length,
          0
        );

        console.log(
          `✅ Posted updates to ${channels.length} channel(s) (reminders=${totalReminderCount})`
        );
      }

      let mergedReminderStateByCardId = { ...reminderStateByCardId };
      for (const result of channelResults) {
        mergedReminderStateByCardId = {
          ...mergedReminderStateByCardId,
          ...result.reminderResult.reminderStateByCardId,
        };
      }

      stateTracker.setMeta('deadlineReminderByCardId', mergedReminderStateByCardId);

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

      await registerSlashCommands(configuredChannel);
      registeredGuildIds.add(guildId);
    }
    console.log('⌨️  Manual commands enabled: /remindercheck, /calendar, /clear, /task');
    console.log(`🔐 Task write access roles: ${config.permissions.taskCommandRoleNames.join(', ')} (Admin also allowed)`);
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
