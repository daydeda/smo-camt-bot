import config from '../config.js';
import logger from '../core/logger.js';
import stateTracker from '../sync/tracker.js';
import { fetchConfiguredChannels } from '../discord/channels.js';
import { runDailyDigest, runWeeklyDigest } from './runners.js';
import { runTodoBoardReminders } from '../discord/todoBoards.js';

const TICK_INTERVAL_MS = 60 * 1000;

const DAILY_META_KEY = 'dailyDigestLastKey';
const WEEKLY_META_KEY = 'weeklyDigestLastKey';
const TODO_REMINDER_META_KEY = 'todoReminderLastKey';

/**
 * Break a Date down into wall-clock parts for a given IANA timezone.
 * Returns { dateKey: 'YYYY-MM-DD', minutes: hour*60+minute, weekday: 0-6 (Sun=0) }.
 */
export function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // 'en-CA' formats midnight as 24; normalize to 0.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);

  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return { dateKey, minutes: hour * 60 + minute, weekday };
}

// Fire once per day at/after the configured time (robust to minute drift and restarts).
export function shouldRunDaily(parts, scheduleTime, lastKey) {
  if (!scheduleTime) {
    return false;
  }

  if (lastKey === parts.dateKey) {
    return false;
  }

  return parts.minutes >= scheduleTime.hour * 60 + scheduleTime.minute;
}

export function shouldRunWeekly(parts, scheduleTime, weekday, lastKey) {
  if (!scheduleTime) {
    return false;
  }

  if (parts.weekday !== weekday) {
    return false;
  }

  if (lastKey === parts.dateKey) {
    return false;
  }

  return parts.minutes >= scheduleTime.hour * 60 + scheduleTime.minute;
}

// Like shouldRunDaily, but only on the given weekdays (Sun=0).
export function shouldRunOnWeekdays(parts, scheduleTime, weekdays, lastKey) {
  if (!Array.isArray(weekdays) || !weekdays.includes(parts.weekday)) {
    return false;
  }

  return shouldRunDaily(parts, scheduleTime, lastKey);
}

function hasAnyScheduledJob() {
  const { dailyDigestTime, weeklyDigestTime, todoReminderTime } = config.schedule;
  return Boolean(dailyDigestTime || weeklyDigestTime || todoReminderTime);
}

async function runTodoReminderJob(parts, now) {
  const { todoReminderTime, todoReminderWeekdays } = config.schedule;
  const lastKey = stateTracker.getMeta(TODO_REMINDER_META_KEY, null);
  if (!shouldRunOnWeekdays(parts, todoReminderTime, todoReminderWeekdays, lastKey)) {
    return;
  }

  // Mark first so a failure doesn't re-post every minute for the rest of the day.
  stateTracker.setMeta(TODO_REMINDER_META_KEY, parts.dateKey);
  try {
    const posted = await runTodoBoardReminders(now);
    logger.info(`📝 To-do board reminders sent: ${posted} (${parts.dateKey}).`);
  } catch (error) {
    logger.error(`To-do board reminders failed: ${error.message}`);
  }
}

async function runScheduledJobs(now = new Date()) {
  const { timezone, dailyDigestTime, weeklyDigestTime, weeklyDigestWeekday } = config.schedule;
  if (!hasAnyScheduledJob()) {
    return;
  }

  const parts = getZonedParts(now, timezone);
  await runTodoReminderJob(parts, now);

  const runDaily = shouldRunDaily(parts, dailyDigestTime, stateTracker.getMeta(DAILY_META_KEY, null));
  const runWeekly = shouldRunWeekly(
    parts,
    weeklyDigestTime,
    weeklyDigestWeekday,
    stateTracker.getMeta(WEEKLY_META_KEY, null)
  );

  if (!runDaily && !runWeekly) {
    return;
  }

  let channels = [];
  try {
    channels = await fetchConfiguredChannels();
  } catch (error) {
    logger.error(`Scheduler failed to fetch channels: ${error.message}`);
    return;
  }

  if (channels.length === 0) {
    return;
  }

  if (runDaily) {
    try {
      await runDailyDigest(channels, now);
      stateTracker.setMeta(DAILY_META_KEY, parts.dateKey);
      logger.info(`📊 Posted daily digest (${parts.dateKey}).`);
    } catch (error) {
      logger.error(`Daily digest failed: ${error.message}`);
    }
  }

  if (runWeekly) {
    try {
      await runWeeklyDigest(channels, now);
      stateTracker.setMeta(WEEKLY_META_KEY, parts.dateKey);
      logger.info(`🗓️  Posted weekly digest (${parts.dateKey}).`);
    } catch (error) {
      logger.error(`Weekly digest failed: ${error.message}`);
    }
  }
}

/**
 * Start the minute-resolution scheduler. Returns the interval id (or null when
 * no scheduled jobs are configured) so callers can clear it on shutdown.
 */
export function startScheduler() {
  if (!hasAnyScheduledJob()) {
    logger.info('🗓️  No scheduled jobs configured (DAILY_DIGEST_TIME / WEEKLY_DIGEST_TIME / TODO_REMINDER_TIME).');
    return null;
  }

  // Run an immediate catch-up check, then tick each minute.
  runScheduledJobs().catch(error => logger.error(`Scheduler tick error: ${error.message}`));
  const intervalId = setInterval(() => {
    runScheduledJobs().catch(error => logger.error(`Scheduler tick error: ${error.message}`));
  }, TICK_INTERVAL_MS);

  return intervalId;
}
