import { MessageFlags } from 'discord.js';
import discordClient from '../discord/bot.js';
import config from '../config.js';
import {
  fetchDatabaseCards,
  createDatabaseCard,
  resolveDatabaseCardReference,
  updateDatabaseCard,
  archiveDatabaseCard,
  normalizeNotionPageId,
} from '../notion/database.js';
import stateTracker from '../sync/tracker.js';
import { getZonedParts } from '../scheduled/scheduler.js';
import {
  isConfiguredChannel,
  canUseCommandOutsideConfiguredChannel,
  formatConfiguredChannelsMentionText,
  safeEphemeralReply,
  safeCommandFailureReply,
  isAdminInteraction,
  canManageTaskCommands,
} from '../discord/permissions.js';
import { sendEmbedsToChannel, clearChannelMessages } from '../discord/channels.js';
import { postDiscordCrudAudit } from '../discord/audit.js';
import {
  parseCommaSeparatedLookupValues,
  toNormalizedDepartmentSet,
  normalizeLookupText,
  getDepartmentValues,
  getStatusValues,
  getDepartmentsForChannel,
  filterCardsByDepartmentNamesAndStatus,
} from '../sync/filters.js';
import {
  formatScalarReplyValue,
  getTaskTitle,
  formatTaskReply,
  buildTaskViewEmbeds,
  TASK_VIEW_DEFAULT_LIMIT,
} from './task/embeds.js';
import { getTaskUpdatePayloadFromInteraction } from './task/payload.js';
import { handleTaskAutocomplete } from './task/autocomplete.js';
import { runReminderCheck, runCalendarOverview } from '../scheduled/runners.js';
import { syncNotionToDiscord } from '../core/sync.js';
import { CARD_ACTION_PREFIX, extractPageIdFromUrl, parseCardActionCustomId } from '../discord/actions.js';

async function handleHelp(interaction) {
  const allowedRoles = config.permissions.taskCommandRoleNames.join(', ') || 'Admin only';
  const lines = [
    '**📖 Notion–Discord Bot Commands**',
    '',
    '__Everyone (in configured channels)__',
    '• `/help` — show this message',
    '• `/mytasks [status] [limit]` — privately list tasks for your department role(s) (Done hidden by default)',
    '• `/calendar range:<today|week|month|all> [department] [organization]` — post a schedule overview',
    '• `/task read` / `/task view` — look up tasks',
    '',
    `__Task writers (Admin or roles: ${allowedRoles})__`,
    '• `/task create` — create a Notion task',
    '• `/task update` — edit task fields',
    '• `/task move to:<status>` — quick status change',
    '• `/task delete` — archive a task',
    '• `/remindercheck` — send due/overdue reminders now',
    '• Card buttons — **In-Progress / In-Review / Done**, **Snooze 1 day** (on reminders), **Open in Notion**',
    '',
    '__Admin only__',
    '• `/clear` — delete all messages in this channel',
    '',
    '__Automatic__',
    '• Live sync of created/changed/removed cards',
    '• Deadline reminders (lead days: ' + config.reminders.leadDays.join(', ') + ')',
    config.schedule.dailyDigestTime
      ? `• Daily digest at ${String(config.schedule.dailyDigestTime.hour).padStart(2, '0')}:${String(config.schedule.dailyDigestTime.minute).padStart(2, '0')} (${config.schedule.timezone})`
      : '• Daily digest: disabled',
    config.schedule.weeklyDigestTime
      ? `• Weekly digest on weekday ${config.schedule.weeklyDigestWeekday} at ${String(config.schedule.weeklyDigestTime.hour).padStart(2, '0')}:${String(config.schedule.weeklyDigestTime.minute).padStart(2, '0')} (${config.schedule.timezone})`
      : '• Weekly digest: disabled',
    '• Monthly overview on day 1',
  ];

  await interaction.editReply(lines.join('\n'));
}

// Collect the caller's Discord role names (excluding @everyone).
function getInteractionRoleNames(interaction) {
  const roleCache = interaction?.member?.roles?.cache;
  if (!roleCache || typeof roleCache.values !== 'function') {
    return [];
  }

  return Array.from(roleCache.values())
    .map(role => role?.name)
    .filter(name => typeof name === 'string' && name.length > 0 && name !== '@everyone');
}

async function handleMyTasks(interaction, commandChannel) {
  const roleNames = getInteractionRoleNames(interaction);
  if (roleNames.length === 0) {
    await interaction.editReply(
      'You have no roles that map to a department, so there are no tasks to show. Ask an admin to give you your department role.'
    );
    return;
  }

  const statusInput = interaction.options.getString('status');
  const limitInput = interaction.options.getInteger('limit');
  const statusFilters = parseCommaSeparatedLookupValues(statusInput || '');

  const cards = await fetchDatabaseCards();
  const matchingCards = filterCardsByDepartmentNamesAndStatus(cards, roleNames, statusFilters);

  const embeds = buildTaskViewEmbeds(matchingCards, {
    departmentFilters: roleNames,
    statusFilters: statusFilters.length > 0 ? statusFilters : ['Open (Done hidden)'],
    limit: limitInput || TASK_VIEW_DEFAULT_LIMIT,
  });

  // Reply privately (ephemeral) so each member sees only their own list.
  await interaction.editReply({
    content: `Showing tasks for your role(s): ${roleNames.join(', ')}`,
    embeds,
  });
}

async function handleReminderCheck(interaction, commandChannel, targetChannels) {
  const reminderCounts = await runReminderCheck(targetChannels);
  const totalReminderCount = reminderCounts.reduce((sum, count) => sum + count, 0);
  await interaction.editReply(`Reminder check completed. Sent ${totalReminderCount} reminder(s).`);
}

async function handleCalendar(interaction, commandChannel, targetChannels) {
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

async function handleClear(interaction, commandChannel, targetChannels) {
  if (!isAdminInteraction(interaction)) {
    await interaction.editReply('This command is admin-only.');
    return;
  }

  const deletedCount = await clearChannelMessages(commandChannel);
  await interaction.editReply(`Cleared ${deletedCount} message(s) from this channel.`);
}

async function handleTask(interaction, commandChannel, targetChannels) {
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

async function handleCardMoveButton(interaction, parsed) {
  const { status, pageId } = parsed;

  let previousCard = null;
  try {
    previousCard = await resolveDatabaseCardReference({ pageIdOrUrl: pageId });
  } catch {
    // Non-fatal: we only use the previous card to show the status transition.
  }

  const movedCard = await updateDatabaseCard(pageId, { status });
  await syncNotionToDiscord();

  const commandChannel =
    interaction.channel || (await discordClient.channels.fetch(interaction.channelId));
  if (commandChannel && typeof commandChannel.send === 'function') {
    await postDiscordCrudAudit(commandChannel, {
      action: 'UPDATE',
      interaction,
      card: movedCard,
      details: [
        `Status move (button): ${formatScalarReplyValue(previousCard?.properties?.Status)} -> ${status}`,
      ],
    });
  }

  await interaction.editReply(
    `Task moved to **${status}** and sync triggered.\n\n${formatTaskReply(movedCard, 'Moved')}`
  );
}

async function handleCardSnoozeButton(interaction, parsed) {
  const { days, pageId } = parsed;

  // Suppress reminders through (today + days - 1) in the configured timezone.
  const targetDate = new Date(Date.now() + (days - 1) * 24 * 60 * 60 * 1000);
  const untilKey = getZonedParts(targetDate, config.schedule.timezone).dateKey;

  const cardId = normalizeNotionPageId(pageId);
  const snoozeMap = { ...stateTracker.getMeta('deadlineSnoozeByCardId', {}) };
  snoozeMap[cardId] = untilKey;
  stateTracker.setMeta('deadlineSnoozeByCardId', snoozeMap);

  await interaction.editReply(
    `🔕 Reminder snoozed. You won't be reminded about this task again until after **${untilKey}**.`
  );
}

async function handleCardActionButton(interaction) {
  const parsed = parseCardActionCustomId(interaction.customId);
  if (!parsed) {
    return;
  }

  // Cards posted before the page-id parsing fix may carry a wrong id in their
  // button custom ids. The embed URL on the message is authoritative, so
  // prefer the id derived from it when available.
  const embedPageId = extractPageIdFromUrl(interaction.message?.embeds?.[0]?.url);
  if (embedPageId) {
    parsed.pageId = embedPageId;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!(await canManageTaskCommands(interaction))) {
    const allowedRoles = config.permissions.taskCommandRoleNames.join(', ');
    await interaction.editReply(
      `This action requires Admin permission or one of these roles: ${allowedRoles}.`
    );
    return;
  }

  if (parsed.action === 'snooze') {
    await handleCardSnoozeButton(interaction, parsed);
    return;
  }

  await handleCardMoveButton(interaction, parsed);
}

const handlers = {
  help: { handle: handleHelp },
  mytasks: { handle: handleMyTasks },
  remindercheck: { handle: handleReminderCheck },
  calendar: { handle: handleCalendar },
  clear: { handle: handleClear },
  task: { handle: handleTask },
};

export function registerCommandHandlers() {
  discordClient.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete()) {
      await handleTaskAutocomplete(interaction);
      return;
    }

    if (interaction.isButton()) {
      if (!interaction.customId.startsWith(CARD_ACTION_PREFIX)) {
        return;
      }

      try {
        await handleCardActionButton(interaction);
      } catch (error) {
        console.error('Error handling card action button:', error.message);
        await safeCommandFailureReply(interaction, 'Action failed. Please check the bot logs.');
      }

      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const entry = handlers[interaction.commandName];
    if (!entry) {
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

      await entry.handle(interaction, commandChannel, targetChannels);
    } catch (error) {
      console.error('Error running slash command:', error.message);
      await safeCommandFailureReply(interaction, 'Command failed. Please check the bot logs.');
    }
  });
}
