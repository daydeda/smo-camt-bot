import discordClient from './discord/bot.js';
import { ApplicationCommandOptionType, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
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
const TASK_VIEW_DEFAULT_LIMIT = 15;
const TASK_VIEW_MAX_LIMIT = 50;
const TASK_VIEW_PAGE_SIZE = 8;
const HARD_DEDUPE_META_KEY = 'hardDedupeHistoryByKey';
const HARD_DEDUPE_HYDRATION_META_KEY = 'hardDedupeHydratedAtByChannelId';
const HARD_DEDUPE_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const HARD_DEDUPE_MAX_KEYS = 5000;
const HARD_DEDUPE_DISCORD_HISTORY_FETCH_LIMIT = 250;
const HARD_DEDUPE_HYDRATION_INTERVAL_MS = 5 * 60 * 1000;

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

function getOrganizationValues(properties = {}) {
  const orgValue = Object.entries(properties).find(
    ([key]) => key.toLowerCase().includes('organization') || key.toLowerCase().includes('organisation')
  )?.[1] ?? properties.Organization;

  if (Array.isArray(orgValue)) {
    return orgValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof orgValue === 'string') {
    return orgValue
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function cardMatchesOrganizationSet(card, organizationSet) {
  if (!(organizationSet instanceof Set) || organizationSet.size === 0) {
    return true;
  }

  const organizations = getOrganizationValues(card?.properties || {});
  if (organizations.length === 0) {
    // If no organization is specified on the card, we consider it a match if "SMO CAMT" is in the filter set,
    // assuming it's the default.
    return organizationSet.has(normalizeLookupText('SMO CAMT'));
  }

  return organizations.some(org => organizationSet.has(normalizeLookupText(org)));
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

function sanitizeEmbedForHardDedupe(embed) {
  const data = embed?.data && typeof embed.data === 'object'
    ? embed.data
    : (embed && typeof embed === 'object' ? embed : {});
  const fields = Array.isArray(data.fields)
    ? data.fields.map(field => ({
      name: typeof field?.name === 'string' ? field.name : '',
      value: typeof field?.value === 'string' ? field.value : '',
      inline: Boolean(field?.inline),
    }))
    : [];

  return {
    title: typeof data.title === 'string' ? data.title : '',
    url: typeof data.url === 'string' ? data.url : '',
    description: typeof data.description === 'string' ? data.description : '',
    color: Number.isInteger(data.color) ? data.color : null,
    author: typeof data.author?.name === 'string' ? data.author.name : '',
    footer: typeof data.footer?.text === 'string' ? data.footer.text : '',
    fields,
  };
}

function buildHardDedupeKey({ channelId, messageType, scopeToken = '', embed }) {
  const payload = {
    channelId: String(channelId || ''),
    messageType: String(messageType || ''),
    scopeToken: String(scopeToken || ''),
    embed: sanitizeEmbedForHardDedupe(embed),
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function pruneHardDedupeHistory(rawHistory, nowMs = Date.now()) {
  const history = rawHistory && typeof rawHistory === 'object' ? rawHistory : {};
  const validEntries = [];

  for (const [key, value] of Object.entries(history)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      continue;
    }

    const timestampMs = Date.parse(value);
    if (Number.isNaN(timestampMs)) {
      continue;
    }

    if ((nowMs - timestampMs) > HARD_DEDUPE_TTL_MS) {
      continue;
    }

    validEntries.push([key, value]);
  }

  validEntries.sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]));

  return Object.fromEntries(validEntries.slice(0, HARD_DEDUPE_MAX_KEYS));
}

function applyHardDedupeToEmbeds(
  embeds,
  {
    channelId,
    messageType,
    scopeToken = '',
    dedupeHistoryByKey = {},
  } = {}
) {
  const acceptedEmbeds = [];
  const acceptedKeys = [];
  let skippedCount = 0;

  for (const embed of embeds) {
    const dedupeKey = buildHardDedupeKey({
      channelId,
      messageType,
      scopeToken,
      embed,
    });

    if (Object.hasOwn(dedupeHistoryByKey, dedupeKey)) {
      skippedCount += 1;
      continue;
    }

    acceptedEmbeds.push(embed);
    acceptedKeys.push(dedupeKey);
  }

  return {
    embeds: acceptedEmbeds,
    keys: acceptedKeys,
    skippedCount,
  };
}

function markHardDedupeKeys(dedupeHistoryByKey, keys = [], timestampIso = new Date().toISOString()) {
  let changed = false;

  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }

    if (Object.hasOwn(dedupeHistoryByKey, key)) {
      continue;
    }

    dedupeHistoryByKey[key] = timestampIso;
    changed = true;
  }

  return changed;
}

function inferMessageTypeFromEmbed(embed) {
  const data = embed?.data && typeof embed.data === 'object'
    ? embed.data
    : (embed && typeof embed === 'object' ? embed : {});
  const title = typeof data.title === 'string' ? data.title : '';
  const description = typeof data.description === 'string' ? data.description : '';

  if (title.startsWith('⏰ Deadline Reminder:')) {
    return 'reminder';
  }

  if (title.startsWith('🆕 ')) {
    return 'created';
  }

  if (title.startsWith('📋 ')) {
    return 'changed';
  }

  if (title.startsWith('🗑️ ') || title.startsWith('🗑 ')) {
    return 'removed';
  }

  if (description.includes('New card created in Notion database')) {
    return 'created';
  }

  if (description.includes('Card removed from Notion database')) {
    return 'removed';
  }

  return null;
}

function shouldHydrateHardDedupeForChannel(channelId, hydrationMetaByChannelId, nowMs = Date.now()) {
  const rawTimestamp = hydrationMetaByChannelId?.[channelId];
  if (typeof rawTimestamp !== 'string') {
    return true;
  }

  const lastHydratedAtMs = Date.parse(rawTimestamp);
  if (Number.isNaN(lastHydratedAtMs)) {
    return true;
  }

  return (nowMs - lastHydratedAtMs) >= HARD_DEDUPE_HYDRATION_INTERVAL_MS;
}

async function hydrateHardDedupeHistoryFromDiscord(
  channel,
  dedupeHistoryByKey,
  { now = new Date() } = {}
) {
  if (!channel || !channel.id || typeof channel.messages?.fetch !== 'function') {
    return { added: 0, scannedMessages: 0, scannedEmbeds: 0 };
  }

  const botUserId = discordClient?.user?.id;
  if (!botUserId) {
    return { added: 0, scannedMessages: 0, scannedEmbeds: 0 };
  }

  let scannedMessages = 0;
  let scannedEmbeds = 0;
  let added = 0;
  const timestampIso = now.toISOString();

  try {
    const messages = await channel.messages.fetch({
      limit: HARD_DEDUPE_DISCORD_HISTORY_FETCH_LIMIT,
    });

    for (const message of messages.values()) {
      if (message?.author?.id !== botUserId) {
        continue;
      }

      scannedMessages += 1;
      const embeds = Array.isArray(message.embeds) ? message.embeds : [];
      if (embeds.length === 0) {
        continue;
      }

      for (const embed of embeds) {
        scannedEmbeds += 1;
        const messageType = inferMessageTypeFromEmbed(embed);
        if (!messageType) {
          continue;
        }

        const reminderScopeToken = messageType === 'reminder'
          ? formatDateKey(new Date(message.createdTimestamp || now.getTime()))
          : '';
        const dedupeKey = buildHardDedupeKey({
          channelId: channel.id,
          messageType,
          scopeToken: reminderScopeToken,
          embed,
        });

        if (Object.hasOwn(dedupeHistoryByKey, dedupeKey)) {
          continue;
        }

        dedupeHistoryByKey[dedupeKey] = timestampIso;
        added += 1;
      }
    }
  } catch (error) {
    console.warn(
      `⚠️  Failed to hydrate hard dedupe history from channel ${channel.id}: ${error.message}`
    );
  }

  return { added, scannedMessages, scannedEmbeds };
}

function getInteractionActorText(interaction) {
  const actorId = interaction?.user?.id || 'unknown';
  const actorTag = interaction?.user?.tag || interaction?.user?.username || 'unknown';
  return `<@${actorId}> (${actorTag})`;
}

function createDiscordCrudAuditEmbed({ action, interaction, card = null, details = [] } = {}) {
  const actionText = typeof action === 'string' ? action.toUpperCase() : 'UNKNOWN';
  const colorByAction = {
    CREATE: 0x2ECC71,
    READ: 0x3498DB,
    UPDATE: 0xF39C12,
    DELETE: 0xE74C3C,
  };

  const titleByAction = {
    CREATE: '🧾 Discord CRUD: CREATE',
    READ: '🧾 Discord CRUD: READ',
    UPDATE: '🧾 Discord CRUD: UPDATE',
    DELETE: '🧾 Discord CRUD: DELETE',
  };

  const taskTitle = card ? getTaskTitle(card) : 'N/A';
  const taskId = card?.id || 'N/A';
  const taskUrl = card?.url || 'N/A';
  const detailLines = Array.isArray(details)
    ? details.map(item => String(item).trim()).filter(Boolean)
    : [];

  const embed = new EmbedBuilder()
    .setTitle(titleByAction[actionText] || '🧾 Discord CRUD')
    .setColor(colorByAction[actionText] || 0x5865F2)
    .setTimestamp(new Date())
    .addFields(
      { name: 'Source', value: 'Discord Slash Command', inline: true },
      { name: 'Action', value: actionText, inline: true },
      { name: 'Actor', value: getInteractionActorText(interaction), inline: false },
      { name: 'Task', value: truncateText(taskTitle, 256) || 'N/A', inline: false },
      { name: 'Task ID', value: taskId, inline: true },
      { name: 'Task URL', value: taskUrl, inline: true }
    );

  if (detailLines.length > 0) {
    embed.setDescription(detailLines.join('\n'));
  }

  return embed;
}

async function postDiscordCrudAudit(channel, payload) {
  if (!channel || typeof channel.send !== 'function') {
    return;
  }

  try {
    const embed = createDiscordCrudAuditEmbed(payload);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error(`⚠️  Failed to post Discord CRUD audit embed: ${error.message}`);
  }
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

function getDepartmentsForChannel(channelId) {
  return config.sync.channelDepartmentsByChannelId[channelId] || [];
}

function parseCommaSeparatedLookupValues(rawValue) {
  if (typeof rawValue !== 'string') {
    return [];
  }

  const seen = new Set();
  const values = [];

  for (const item of rawValue.split(/[\u002C\uFF0C\u3001]/)) {
    const value = item.trim();
    const normalized = normalizeLookupText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    values.push(value);
  }

  return values;
}

function getStatusValues(properties = {}) {
  const statusValue = properties?.Status;

  if (Array.isArray(statusValue)) {
    return statusValue
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (typeof statusValue === 'string') {
    const normalizedValue = statusValue.trim();
    return normalizedValue ? [normalizedValue] : [];
  }

  return [];
}

function getTaskStatusBadge(statusValue) {
  const normalized = normalizeLookupText(String(statusValue || ''));
  if (!normalized) {
    return '⚪ Unknown';
  }

  if (normalized.includes('done')) {
    return '✅ Done';
  }

  if (normalized.includes('review')) {
    return '🧐 In Review';
  }

  if (normalized.includes('progress')) {
    return '🚧 In Progress';
  }

  if (normalized.includes('not started')) {
    return '📝 Not Started';
  }

  return `🔹 ${statusValue}`;
}

function truncateText(value, maxLength = 120) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(maxLength - 3, 1))}...`;
}

function buildTaskViewEmbeds(cards, { departmentFilters = [], statusFilters = [], limit = TASK_VIEW_DEFAULT_LIMIT } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || TASK_VIEW_DEFAULT_LIMIT, 1), TASK_VIEW_MAX_LIMIT);
  const sortedCards = [...cards].sort((left, right) => {
    return getTaskTitle(left).localeCompare(getTaskTitle(right), 'th');
  });
  const includedCards = sortedCards.slice(0, safeLimit);

  const summaryEmbed = new EmbedBuilder()
    .setColor(cards.length > 0 ? 0x1D4ED8 : 0x6B7280)
    .setTitle('📋 Department Task View')
    .addFields(
      {
        name: 'Departments',
        value: departmentFilters.join(', ') || 'All',
        inline: false,
      },
      {
        name: 'Status Filter',
        value: statusFilters.join(', ') || 'All',
        inline: true,
      },
      {
        name: 'Matched',
        value: String(cards.length),
        inline: true,
      },
      {
        name: 'Shown',
        value: String(includedCards.length),
        inline: true,
      }
    )
    .setTimestamp(new Date());

  if (cards.length === 0) {
    summaryEmbed.setDescription('No tasks matched this filter. Try a different department or status.');
    return [summaryEmbed];
  }

  if (cards.length > safeLimit) {
    summaryEmbed.setDescription(
      `Showing the first ${includedCards.length} task(s) based on your limit (${safeLimit}).`
    );
  } else {
    summaryEmbed.setDescription('Showing all matching tasks.');
  }

  const detailEmbeds = [];
  for (let i = 0; i < includedCards.length; i += TASK_VIEW_PAGE_SIZE) {
    const chunk = includedCards.slice(i, i + TASK_VIEW_PAGE_SIZE);
    const lines = chunk.map((card, index) => {
      const sequence = i + index + 1;
      const title = truncateText(getTaskTitle(card), 100);
      const status = formatScalarReplyValue(card?.properties?.Status);
      const date = truncateText(formatScalarReplyValue(card?.properties?.Date), 80);
      const idShort = card.id.slice(0, 8);
      const link = card.url ? `<${card.url}>` : 'N/A';

      return [
        `**${sequence}. ${title}**`,
        `${getTaskStatusBadge(status)} | 🗓️ ${date}`,
        `🆔 ${idShort} | ${link}`,
      ].join('\n');
    });

    const detailEmbed = new EmbedBuilder()
      .setColor(0x0EA5E9)
      .setTitle(`Tasks ${i + 1}-${i + chunk.length}`)
      .setDescription(lines.join('\n\n'));

    detailEmbeds.push(detailEmbed);
  }

  const embeds = [summaryEmbed, ...detailEmbeds];
  if (cards.length > includedCards.length) {
    const remainingCount = cards.length - includedCards.length;
    embeds[embeds.length - 1].setFooter({
      text: `${remainingCount} more task(s) not shown. Increase limit (max ${TASK_VIEW_MAX_LIMIT}) to view more.`,
    });
  }

  return embeds;
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
    candidates.push(formatted);
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
  if (interaction.commandName !== 'task' && interaction.commandName !== 'calendar') {
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

async function runCalendarOverview(channels, range = 'week', now = new Date(), departmentFilter = null, organizationFilter = null) {
  const cards = await fetchDatabaseCards();
  const formattedCards = cards.map(formatCardForTracking);

  const effectiveOrgFilter = organizationFilter; // No default filter for viewing unless specified
  const orgSet = effectiveOrgFilter ? toNormalizedDepartmentSet(parseCommaSeparatedLookupValues(effectiveOrgFilter)) : null;

  for (const channel of channels) {
    let channelTrackedCards = filterCardsForChannel(formattedCards, channel.id);

    // Only filter by Organization if explicitly provided in the command
    if (orgSet && orgSet.size > 0) {
      channelTrackedCards = channelTrackedCards.filter(card => cardMatchesOrganizationSet(card, orgSet));
    }

    if (departmentFilter) {
      const filters = parseCommaSeparatedLookupValues(departmentFilter);
      channelTrackedCards = filterCardsByDepartmentFilters(channelTrackedCards, filters);
    }

    const filterParts = [];
    if (departmentFilter) filterParts.push(departmentFilter);
    if (effectiveOrgFilter && effectiveOrgFilter !== 'SMO CAMT') filterParts.push(effectiveOrgFilter);
    const filterTitle = filterParts.length > 0 ? `: ${filterParts.join(' | ')}` : '';
    const titlePrefix = `📅 Calendar${filterTitle}`;

    const embeds = createCalendarOverviewEmbeds(channelTrackedCards, range, now, {
      title: titlePrefix,
      organization: effectiveOrgFilter || 'SMO CAMT',
    });
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
            { name: 'all', value: 'all' },
          ],
        },
        {
          name: 'department',
          description: 'Filter by department (optional)',
          type: 3,
          required: false,
          autocomplete: true,
        },
        {
          name: 'organization',
          description: 'Filter by organization (optional, default: SMO CAMT)',
          type: 3,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: 'clear',
      description: 'Admin only: clear all messages in this configured channel',
    },
    {
      name: 'task',
      description: 'Manage task records in the connected Notion database',
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
              description: 'Start date: DD/MM/YYYY [AD Only]',
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
              description: 'End date: DD/MM/YYYY [AD Only] (optional)',
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
          name: 'view',
          description: 'View tasks by department, optionally filtered by status',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'department',
              description: 'Department(s), comma-separated (choose from suggestions)',
              required: true,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'status',
              description: 'Optional status filter(s), comma-separated',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: 'limit',
              description: 'Max tasks to show (default 15, max 50)',
              required: false,
              min_value: 1,
              max_value: 50,
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
              description: 'New start date: DD/MM/YYYY [AD Only]',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_date',
              description: 'New end date: DD/MM/YYYY [AD Only]',
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
        const department = interaction.options.getString('department');
        const organization = interaction.options.getString('organization');
        await runCalendarOverview(targetChannels, range, new Date(), department, organization);
        const filters = [];
        if (department) filters.push(`dept: ${department}`);
        if (organization) filters.push(`org: ${organization}`);
        const filterSuffix = filters.length > 0 ? ` [${filters.join(', ')}]` : '';
        await interaction.editReply(`Calendar overview (${range})${filterSuffix} posted.`);
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
          await postDiscordCrudAudit(commandChannel, {
            action: 'CREATE',
            interaction,
            card: createdCard,
            details: [
              `Department: ${formatScalarReplyValue(createdCard?.properties?.Department)}`,
              `Date: ${formatScalarReplyValue(createdCard?.properties?.Date)}`,
            ],
          });
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
            filterDepartments: getDepartmentsForChannel(interaction.channelId),
          });
          await postDiscordCrudAudit(commandChannel, {
            action: 'READ',
            interaction,
            card,
          });
          await interaction.editReply(formatTaskReply(card, 'Task'));
        }

        if (subcommand === 'view') {
          const departmentInput = interaction.options.getString('department', true);
          const statusInput = interaction.options.getString('status');
          const limitInput = interaction.options.getInteger('limit');

          const departmentFilters = parseCommaSeparatedLookupValues(departmentInput);
          const statusFilters = parseCommaSeparatedLookupValues(statusInput || '');

          if (departmentFilters.length === 0) {
            await interaction.editReply('Please provide at least one department for task view.');
            return;
          }

          const normalizedDepartmentSet = toNormalizedDepartmentSet(departmentFilters);
          const normalizedStatusSet = new Set(
            statusFilters
              .map(statusValue => normalizeLookupText(statusValue))
              .filter(Boolean)
          );

          const cards = await fetchDatabaseCards();
          const matchingCards = cards.filter(card => {
            const cardProperties = card?.properties || {};
            const departmentMatched = getDepartmentValues(cardProperties)
              .some(departmentValue => normalizedDepartmentSet.has(normalizeLookupText(departmentValue)));

            if (!departmentMatched) {
              return false;
            }

            if (normalizedStatusSet.size === 0) {
              return true;
            }

            return getStatusValues(cardProperties)
              .some(statusValue => normalizedStatusSet.has(normalizeLookupText(statusValue)));
          });

          const taskViewEmbeds = buildTaskViewEmbeds(matchingCards, {
            departmentFilters,
            statusFilters,
            limit: limitInput || TASK_VIEW_DEFAULT_LIMIT,
          });

          await sendEmbedsToChannel(commandChannel, taskViewEmbeds, { singleMessage: true });

          await interaction.editReply(
            `Task view posted in <#${commandChannel.id}>. Matched ${matchingCards.length} task(s).`
          );
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
            filterDepartments: getDepartmentsForChannel(interaction.channelId),
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
          await postDiscordCrudAudit(commandChannel, {
            action: 'UPDATE',
            interaction,
            card: updatedCard,
            details: [
              `Updated fields: ${Object.keys(updates).join(', ')}`,
              `Status: ${formatScalarReplyValue(resolvedCard?.properties?.Status)} -> ${formatScalarReplyValue(updatedCard?.properties?.Status)}`,
            ],
          });
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
            filterDepartments: getDepartmentsForChannel(interaction.channelId),
          });

          const movedCard = await updateDatabaseCard(resolvedCard.id, {
            status: targetStatus,
          });

          await syncNotionToDiscord();
          await postDiscordCrudAudit(commandChannel, {
            action: 'UPDATE',
            interaction,
            card: movedCard,
            details: [
              `Status move: ${formatScalarReplyValue(resolvedCard?.properties?.Status)} -> ${targetStatus}`,
            ],
          });
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
            filterDepartments: getDepartmentsForChannel(interaction.channelId),
          });

          const archivedCard = await archiveDatabaseCard(resolvedCard.id);
          await syncNotionToDiscord();
          await postDiscordCrudAudit(commandChannel, {
            action: 'DELETE',
            interaction,
            card: resolvedCard,
            details: [
              `Archived in Notion: ${archivedCard.archived ? 'Yes' : 'No'}`,
            ],
          });
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
    const todayKey = now.toISOString().slice(0, 10);
    const reminderStateByCardId = stateTracker.getMeta('deadlineReminderByCardId', {});
    const rawHardDedupeHistoryByKey = stateTracker.getMeta(HARD_DEDUPE_META_KEY, {});
    const hardDedupeHistoryByKey = pruneHardDedupeHistory(rawHardDedupeHistoryByKey, now.getTime());
    const rawHardDedupeHydrationMetaByChannelId = stateTracker.getMeta(HARD_DEDUPE_HYDRATION_META_KEY, {});
    const hardDedupeHydrationMetaByChannelId =
      rawHardDedupeHydrationMetaByChannelId && typeof rawHardDedupeHydrationMetaByChannelId === 'object'
        ? { ...rawHardDedupeHydrationMetaByChannelId }
        : {};
    let hardDedupeMetaChanged =
      JSON.stringify(rawHardDedupeHistoryByKey || {}) !== JSON.stringify(hardDedupeHistoryByKey);
    let hardDedupeHydrationMetaChanged = false;

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
        if (shouldHydrateHardDedupeForChannel(channel.id, hardDedupeHydrationMetaByChannelId, now.getTime())) {
          const hydrationResult = await hydrateHardDedupeHistoryFromDiscord(channel, hardDedupeHistoryByKey, {
            now,
          });
          hardDedupeHydrationMetaByChannelId[channel.id] = now.toISOString();
          hardDedupeHydrationMetaChanged = true;

          if (hydrationResult.added > 0) {
            hardDedupeMetaChanged = true;
            console.log(
              `🔄 Hydrated ${hydrationResult.added} dedupe key(s) from channel ${channel.id} (messages=${hydrationResult.scannedMessages}, embeds=${hydrationResult.scannedEmbeds})`
            );
          }
        }

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
        const dedupedReminders = applyHardDedupeToEmbeds(reminderResult.embeds, {
          channelId: channel.id,
          messageType: 'reminder',
          scopeToken: todayKey,
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });
        const dedupedCreated = applyHardDedupeToEmbeds(createdEmbeds, {
          channelId: channel.id,
          messageType: 'created',
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });
        const dedupedChanged = applyHardDedupeToEmbeds(changedEmbeds, {
          channelId: channel.id,
          messageType: 'changed',
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });
        const dedupedRemoved = applyHardDedupeToEmbeds(removedEmbeds, {
          channelId: channel.id,
          messageType: 'removed',
          dedupeHistoryByKey: hardDedupeHistoryByKey,
        });

        const embeds = [
          ...dedupedReminders.embeds,
          ...dedupedCreated.embeds,
          ...dedupedChanged.embeds,
          ...dedupedRemoved.embeds,
        ];
        const dedupeKeys = [
          ...dedupedReminders.keys,
          ...dedupedCreated.keys,
          ...dedupedChanged.keys,
          ...dedupedRemoved.keys,
        ];
        const skippedByHardDedupe =
          dedupedReminders.skippedCount +
          dedupedCreated.skippedCount +
          dedupedChanged.skippedCount +
          dedupedRemoved.skippedCount;

        channelResults.push({
          channel,
          embeds,
          dedupeKeys,
          skippedByHardDedupe,
          sentReminderCount: dedupedReminders.embeds.length,
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
          if (markHardDedupeKeys(hardDedupeHistoryByKey, result.dedupeKeys, now.toISOString())) {
            hardDedupeMetaChanged = true;
          }
        }

        const totalHardDedupeSkips = channelResults.reduce(
          (sum, result) => sum + result.skippedByHardDedupe,
          0
        );

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
          (sum, result) => sum + result.sentReminderCount,
          0
        );

        console.log(
          `✅ Posted updates to ${channels.length} channel(s) (reminders=${totalReminderCount}, hardDedupeSkipped=${totalHardDedupeSkips})`
        );
      }

      if (!hasAnyEmbeds) {
        const totalHardDedupeSkips = channelResults.reduce(
          (sum, result) => sum + result.skippedByHardDedupe,
          0
        );

        if (totalHardDedupeSkips > 0) {
          console.log(`🔁 Hard dedupe suppressed ${totalHardDedupeSkips} duplicate embed(s).`);
        }
      }

      let mergedReminderStateByCardId = { ...reminderStateByCardId };
      for (const result of channelResults) {
        mergedReminderStateByCardId = {
          ...mergedReminderStateByCardId,
          ...result.reminderResult.reminderStateByCardId,
        };
      }

      stateTracker.setMeta('deadlineReminderByCardId', mergedReminderStateByCardId);
      if (hardDedupeMetaChanged) {
        stateTracker.setMeta(HARD_DEDUPE_META_KEY, hardDedupeHistoryByKey);
      }
      if (hardDedupeHydrationMetaChanged) {
        stateTracker.setMeta(HARD_DEDUPE_HYDRATION_META_KEY, hardDedupeHydrationMetaByChannelId);
      }

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

      try {
        await registerSlashCommands(configuredChannel);
      } catch (error) {
        console.error(
          `⚠️  Failed to register slash commands for guild ${guildId}: ${error.message}`
        );
      }
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
