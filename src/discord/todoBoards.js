import { MessageFlags } from 'discord.js';
import discordClient from './bot.js';
import config from '../config.js';
import logger from '../core/logger.js';
import stateTracker from '../sync/tracker.js';
import { fetchDatabaseCards } from '../notion/database.js';
import { normalizeLookupText } from '../sync/filters.js';
import {
  TODO_MODE_BOARD,
  buildTodoReminderMessage,
  buildTodoView,
  compactPageId,
  summarizeTodo,
  toTodoPayload,
  toZonedDateKey,
} from './todo.js';

const TODO_BOARDS_META_KEY = 'todoBoards';
const TODO_TICKS_META_KEY = 'todoTicks';
const MAX_TODO_BOARDS = 50;
// Discord errors meaning the board (or its channel) no longer exists.
const GONE_ERROR_CODES = new Set([10003, 10008]);

// ---- board registry ----------------------------------------------------------

function getBoards() {
  const boards = stateTracker.getMeta(TODO_BOARDS_META_KEY, []);
  return Array.isArray(boards) ? boards : [];
}

function saveBoards(boards) {
  stateTracker.setMeta(TODO_BOARDS_META_KEY, boards.slice(-MAX_TODO_BOARDS));
}

export function registerTodoBoard(entry) {
  saveBoards([...getBoards().filter(board => board.messageId !== entry.messageId), entry]);
}

function updateBoard(messageId, patch) {
  saveBoards(getBoards().map(board => (board.messageId === messageId ? { ...board, ...patch } : board)));
}

function unregisterTodoBoard(messageId) {
  saveBoards(getBoards().filter(board => board.messageId !== messageId));
}

// ---- ticks (tasks checked from a board today) ------------------------------

function todayKey(now = new Date()) {
  return toZonedDateKey(now, config.schedule.timezone);
}

/** Today's ticks; older ones are dropped so state doesn't grow. */
export function getTodayTicks(now = new Date()) {
  const key = todayKey(now);
  const ticks = stateTracker.getMeta(TODO_TICKS_META_KEY, {});
  const fresh = {};
  for (const [id, tick] of Object.entries(ticks || {})) {
    if (tick?.dateKey === key) fresh[id] = tick;
  }

  return fresh;
}

export function recordTodoTick(pageId, { byUserId = null, previousStatus = null } = {}, now = new Date()) {
  const ticks = getTodayTicks(now);
  ticks[compactPageId(pageId)] = { dateKey: todayKey(now), byUserId, previousStatus };
  stateTracker.setMeta(TODO_TICKS_META_KEY, ticks);
}

/** Removes and returns the tick for a task (used by Undo). */
export function takeTodoTick(pageId, now = new Date()) {
  const ticks = getTodayTicks(now);
  const id = compactPageId(pageId);
  const tick = ticks[id] || null;
  delete ticks[id];
  stateTracker.setMeta(TODO_TICKS_META_KEY, ticks);
  return tick;
}

// ---- rendering into Discord --------------------------------------------------

export function buildBoardPayload(cards, department, { now = new Date(), mode = TODO_MODE_BOARD, page = 0 } = {}) {
  const view = buildTodoView(cards, department, {
    page,
    mode,
    now,
    timeZone: config.schedule.timezone,
    ticks: getTodayTicks(now),
  });

  return { view, payload: toTodoPayload(view) };
}

/**
 * Put a rendered board into an existing board message. Boards in the new
 * design are edited in place. Boards still in the old embed design can't be
 * switched by editing, so a new board is posted (and pinned if the old one
 * was), the old one is deleted, and the registry is moved over. Returns the
 * message that now holds the board.
 */
export async function renderIntoBoard(message, payload, department) {
  if (message.flags?.has?.(MessageFlags.IsComponentsV2)) {
    await message.edit(payload);
    registerTodoBoard({
      ...(getBoards().find(board => board.messageId === message.id) || {}),
      channelId: message.channelId,
      messageId: message.id,
      department,
    });
    return message;
  }

  const previous = getBoards().find(board => board.messageId === message.id) || {};
  const fresh = await message.channel.send(payload);

  unregisterTodoBoard(message.id);
  registerTodoBoard({
    channelId: fresh.channelId,
    messageId: fresh.id,
    department,
    lastReminderMessageId: previous.lastReminderMessageId || null,
  });

  if (message.pinned) {
    await fresh.pin().catch(error => logger.warn(`Could not pin upgraded to-do board: ${error.message}`));
  }

  await message.delete().catch(error => logger.warn(`Could not delete old to-do board: ${error.message}`));
  logger.info(`📝 Upgraded to-do board for ${department} to the new design (${message.id} -> ${fresh.id}).`);
  return fresh;
}

async function fetchBoardMessage(board) {
  try {
    const channel = await discordClient.channels.fetch(board.channelId);
    const message = await channel.messages.fetch(board.messageId);
    return { channel, message };
  } catch (error) {
    if (GONE_ERROR_CODES.has(error?.code)) {
      unregisterTodoBoard(board.messageId);
      logger.info(`🗑️  To-do board ${board.messageId} was deleted; forgetting it.`);
    } else {
      logger.error(`⚠️  Could not load to-do board ${board.messageId}: ${error.message}`);
    }

    return null;
  }
}

/**
 * Re-render every posted board for a department (e.g. after a task was ticked
 * from a private view or another board). Failures never block the caller.
 */
export async function refreshTodoBoards(department, cards, { skipMessageId = null } = {}) {
  const wanted = normalizeLookupText(department);

  for (const board of getBoards()) {
    if (board.messageId === skipMessageId || normalizeLookupText(board.department) !== wanted) {
      continue;
    }

    const loaded = await fetchBoardMessage(board);
    if (!loaded) continue;

    try {
      const { payload } = buildBoardPayload(cards, board.department);
      await renderIntoBoard(loaded.message, payload, board.department);
    } catch (error) {
      logger.error(`⚠️  Failed to refresh to-do board ${board.messageId}: ${error.message}`);
    }
  }
}

function findRoleMention(guild, department) {
  const wanted = normalizeLookupText(department);
  const role = guild?.roles?.cache?.find(candidate => normalizeLookupText(candidate.name) === wanted);
  return role ? { mention: `<@&${role.id}>`, id: role.id } : null;
}

/**
 * Daily reminder: refresh each board and post one short message per board.
 * The department role is pinged only when something is overdue or due today;
 * nothing is posted when the department has no open tasks. Yesterday's
 * reminder is deleted so the channel doesn't fill up. Returns how many
 * reminders were posted.
 */
export async function runTodoBoardReminders(now = new Date()) {
  const boards = getBoards();
  if (boards.length === 0) {
    return 0;
  }

  const cards = await fetchDatabaseCards();
  const seen = new Set();
  let posted = 0;

  // Newest first, so if one channel has several boards for the same
  // department, only the latest one sends a reminder.
  for (const board of [...boards].reverse()) {
    const key = `${board.channelId}:${normalizeLookupText(board.department)}`;
    const loaded = await fetchBoardMessage(board);
    if (!loaded) continue;

    const { channel } = loaded;
    let boardMessage = loaded.message;

    try {
      const { payload } = buildBoardPayload(cards, board.department, { now });
      boardMessage = await renderIntoBoard(boardMessage, payload, board.department);
    } catch (error) {
      logger.error(`⚠️  Failed to refresh to-do board ${board.messageId}: ${error.message}`);
    }

    if (seen.has(key)) continue;
    seen.add(key);

    // The board may have been re-posted above, so read its entry again.
    const entry = getBoards().find(item => item.messageId === boardMessage.id) || board;

    if (entry.lastReminderMessageId) {
      try {
        const previous = await channel.messages.fetch(entry.lastReminderMessageId);
        await previous.delete();
      } catch {
        // Already gone or not deletable; ignore.
      }
    }

    const summary = summarizeTodo(cards, board.department, { now, timeZone: config.schedule.timezone });
    const role = findRoleMention(channel.guild, board.department);
    const reminder = buildTodoReminderMessage(summary, board.department, {
      roleMention: role?.mention || null,
      boardUrl: boardMessage.url,
    });

    if (!reminder) {
      updateBoard(boardMessage.id, { lastReminderMessageId: null });
      continue;
    }

    try {
      const sent = await channel.send({
        content: reminder.content,
        allowedMentions: { parse: [], roles: reminder.mentionRole && role ? [role.id] : [] },
      });
      updateBoard(boardMessage.id, { lastReminderMessageId: sent.id });
      posted += 1;
    } catch (error) {
      logger.error(`⚠️  Failed to post to-do reminder for ${board.department}: ${error.message}`);
    }
  }

  return posted;
}
