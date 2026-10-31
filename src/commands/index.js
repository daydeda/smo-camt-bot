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
import {
  TODO_PREFIX,
  TODO_MODE_BOARD,
  TODO_MODE_PRIVATE,
  compactPageId,
  getDepartmentFromTodoMessage,
  parseTodoCustomId,
} from '../discord/todo.js';
import {
  buildBoardPayload,
  recordTodoTick,
  refreshTodoBoards,
  registerTodoBoard,
  renderIntoBoard,
  takeTodoTick,
} from '../discord/todoBoards.js';

import {
  ROLE_SELECT_PREFIX,
  buildRoleSelectPayload,
  createPanel,
  getRoleSelectPanel,
  parseRoleCapSpecs,
  parseRoleSelectCustomId,
  releaseRoleMember,
  resolveRole,
  saveRoleSelectPanel,
  toggleRoleMember,
} from '../discord/roleSelect.js';

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
    '• `/todo department:<name>` — post a department to-do board (✅ buttons, paged) the team can tick off',
    '• `/roleselect roles:<name:cap, ...>` — post a role panel with a member cap per role (e.g. `สวัสดิการ:10, จราจร:15`)',
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


// ---- Department to-do boards -------------------------------------------------

async function handleTodo(interaction, commandChannel) {
  if (!(await canManageTaskCommands(interaction))) {
    const allowedRoles = config.permissions.taskCommandRoleNames.join(', ');
    await interaction.editReply(
      `Posting a to-do board requires Admin permission or one of these roles: ${allowedRoles}.`
    );
    return;
  }

  const department = interaction.options.getString('department', true).trim();
  const cards = await fetchDatabaseCards();
  const { view, payload } = buildBoardPayload(cards, department);

  const message = await commandChannel.send(payload);
  registerTodoBoard({ channelId: commandChannel.id, messageId: message.id, department });

  await interaction.editReply(
    `To-do board for **${department}** posted (${view.total} open task${view.total === 1 ? '' : 's'}). Pin it so the team can find it.`
  );
}

async function canTickTodo(interaction, department) {
  if (await canManageTaskCommands(interaction)) {
    return true;
  }

  const wanted = normalizeLookupText(department);
  return getInteractionRoleNames(interaction).some(name => normalizeLookupText(name) === wanted);
}

// Private views are ephemeral, so they can only be changed through the
// interaction. Old-design private views can't take the new layout by edit;
// send a fresh private view instead.
async function showPrivateTodoView(interaction, payload) {
  try {
    await interaction.editReply(payload);
  } catch (error) {
    console.warn(`Private to-do view edit failed (${error.message}); sending a new one.`);
    await interaction.followUp({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
  }
}

function getCardStatusText(card) {
  const value = formatScalarReplyValue(card?.properties?.Status);
  return value === 'None' ? null : value;
}

// Tick (Done) or untick (Undo) a task from a board. Returns the updated card.
async function applyTodoToggle(interaction, parsed, department) {
  const pageId = parsed.pageId;

  if (parsed.action === 'done') {
    const before = (await fetchDatabaseCards()).find(card => compactPageId(card.id) === compactPageId(pageId));
    const previousStatus = getCardStatusText(before);
    const movedCard = await updateDatabaseCard(pageId, { status: 'Done' });
    recordTodoTick(pageId, {
      byUserId: interaction.user?.id || null,
      previousStatus: previousStatus && !normalizeLookupText(previousStatus).includes('done') ? previousStatus : null,
    });
    return { card: movedCard, detail: `Status: ${previousStatus || 'None'} -> Done (to-do board: ${department})` };
  }

  const tick = takeTodoTick(pageId);
  const restoreStatus = tick?.previousStatus || 'In-Progress';
  const movedCard = await updateDatabaseCard(pageId, { status: restoreStatus });
  return { card: movedCard, detail: `Status: Done -> ${restoreStatus} (undo on to-do board: ${department})` };
}

async function handleTodoButton(interaction) {
  const parsed = parseTodoCustomId(interaction.customId);
  if (!parsed) {
    return;
  }

  const department = getDepartmentFromTodoMessage(interaction.message);
  if (!department) {
    await safeEphemeralReply(interaction, 'This to-do board is out of date. Ask an admin to post a new one with `/todo`.');
    return;
  }

  if (parsed.action === 'noop') {
    await interaction.deferUpdate();
    return;
  }

  if (parsed.action === 'open') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cards = await fetchDatabaseCards();
    const { payload } = buildBoardPayload(cards, department, { mode: TODO_MODE_PRIVATE });
    await showPrivateTodoView(interaction, payload);
    return;
  }

  await interaction.deferUpdate();

  let toggled = null;
  if (parsed.action === 'done' || parsed.action === 'undo') {
    if (!(await canTickTodo(interaction, department))) {
      await interaction.followUp({
        content: `Only members of the **${department}** role (or task writers/Admins) can tick off these tasks.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    toggled = await applyTodoToggle(interaction, parsed, department);
  }

  // Redraw first so the click feels instant; slower follow-up work comes after.
  const cards = await fetchDatabaseCards();
  const { payload } = buildBoardPayload(cards, department, {
    mode: parsed.mode,
    page: parsed.mode === TODO_MODE_BOARD ? 0 : parsed.page ?? 0,
  });

  let boardMessageId = interaction.message?.id;
  if (parsed.mode === TODO_MODE_BOARD) {
    const holder = await renderIntoBoard(interaction.message, payload, department);
    boardMessageId = holder.id;
    if (holder.id !== interaction.message.id) {
      await interaction.followUp({
        content: `The board moved to the new design: ${holder.url}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } else {
    await showPrivateTodoView(interaction, payload);
  }

  if (toggled) {
    const auditChannel =
      interaction.channel || (await discordClient.channels.fetch(interaction.channelId));
    await postDiscordCrudAudit(auditChannel, {
      action: 'UPDATE',
      interaction,
      card: toggled.card,
      details: [toggled.detail],
    });
    await syncNotionToDiscord();
  }

  await refreshTodoBoards(department, cards, { skipMessageId: boardMessageId });
}

// ---- Role selection panels ---------------------------------------------------

async function handleRoleSelect(interaction, commandChannel) {
  if (!(await canManageTaskCommands(interaction))) {
    const allowedRoles = config.permissions.taskCommandRoleNames.join(', ');
    await interaction.editReply(
      `Posting a role panel requires Admin permission or one of these roles: ${allowedRoles}.`
    );
    return;
  }

  const guild = interaction.guild;
  await guild.roles.fetch();

  const { specs, problems } = parseRoleCapSpecs(interaction.options.getString('roles', true));
  const roles = [];
  const seen = new Set();

  for (const spec of specs) {
    const role = resolveRole(guild, spec.ref);
    if (!role) {
      problems.push(`role "${spec.ref}" not found`);
    } else if (role.id === guild.id || role.managed) {
      problems.push(`role "${role.name}" cannot be self-assigned`);
    } else if (!role.editable) {
      problems.push(`I can't assign "${role.name}" (move my bot role above it in Server Settings > Roles)`);
    } else if (!seen.has(role.id)) {
      seen.add(role.id);
      roles.push({ roleId: role.id, name: role.name, cap: spec.cap });
    }
  }

  if (roles.length === 0 || problems.length > 0) {
    await interaction.editReply(
      `Nothing posted:\n${problems.map(problem => `• ${problem}`).join('\n') || '• no roles given'}`
    );
    return;
  }

  if (roles.length > 25) {
    await interaction.editReply('A panel holds at most 25 roles. Split them across two panels.');
    return;
  }

  const panel = createPanel({
    title: interaction.options.getString('title') || '🎭 Role selection',
    description: interaction.options.getString('description') || '',
    roles,
  });
  const message = await commandChannel.send(buildRoleSelectPayload(panel));
  saveRoleSelectPanel(message.id, panel);

  await interaction.editReply(`Role panel posted with ${roles.length} role${roles.length === 1 ? '' : 's'}.`);
}

async function handleRoleSelectButton(interaction) {
  const parsed = parseRoleSelectCustomId(interaction.customId);
  const panel = parsed && getRoleSelectPanel(interaction.message.id);
  if (!panel) {
    await safeEphemeralReply(interaction, 'This role panel is out of date. Ask an admin to post a new one with `/roleselect`.');
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const entry = panel.roles.find(role => role.roleId === parsed.roleId);
  const member = interaction.member;
  const hasRole = Boolean(member?.roles?.cache?.has(parsed.roleId));
  const userId = interaction.user.id;

  // State is changed before any await, so two quick clicks can't both take the last spot.
  const outcome = toggleRoleMember(panel, parsed.roleId, userId, hasRole);

  if (outcome.result === 'full') {
    saveRoleSelectPanel(interaction.message.id, panel);
    await interaction.message.edit(buildRoleSelectPayload(panel)).catch(() => {});
    await interaction.editReply(`Sorry, **${entry.name}** is full (${entry.cap}/${entry.cap}).`);
    return;
  }

  try {
    if (outcome.result === 'joined') {
      await member.roles.add(parsed.roleId, 'Role selection panel');
    } else {
      await member.roles.remove(parsed.roleId, 'Role selection panel');
    }
  } catch (error) {
    // Put our records back the way they were.
    if (outcome.result === 'joined') {
      releaseRoleMember(panel, parsed.roleId, userId);
    } else if (!entry.members.includes(userId)) {
      entry.members.push(userId);
    }
    saveRoleSelectPanel(interaction.message.id, panel);
    console.error('Role selection failed:', error.message);
    await interaction.editReply('I could not change your role. An admin needs to check my role permissions.');
    return;
  }

  saveRoleSelectPanel(interaction.message.id, panel);
  await interaction.message.edit(buildRoleSelectPayload(panel)).catch(() => {});
  await interaction.editReply(
    outcome.result === 'joined' ? `You now have **${entry.name}**.` : `You gave up **${entry.name}**.`
  );
}

const handlers = {
  roleselect: { handle: handleRoleSelect },
  todo: { handle: handleTodo },
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
      const isTodoButton = interaction.customId.startsWith(TODO_PREFIX);
      const isRoleSelectButton = interaction.customId.startsWith(ROLE_SELECT_PREFIX);
      if (!isTodoButton && !isRoleSelectButton && !interaction.customId.startsWith(CARD_ACTION_PREFIX)) {
        return;
      }

      try {
        if (isRoleSelectButton) {
          await handleRoleSelectButton(interaction);
        } else if (isTodoButton) {
          await handleTodoButton(interaction);
        } else {
          await handleCardActionButton(interaction);
        }
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
