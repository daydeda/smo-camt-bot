import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { filterCardsByDepartmentNamesAndStatus, getStatusValues, normalizeLookupText } from '../sync/filters.js';
import { formatScalarReplyValue, getTaskTitle, truncateText } from '../commands/task/embeds.js';

export const TODO_PREFIX = 'todo:';
// Boards are Components V2 messages whose first text block starts with this.
export const TODO_HEADER_PREFIX = '## 📝 To-do — ';
// Title used by the first (embed-based) board design; still parsed so old
// boards keep working and can be upgraded on Refresh.
export const TODO_TITLE_PREFIX = '📝 To-do — ';
export const TODO_PAGE_SIZE = 5;

// "b" = the shared board message; "p" = a private (ephemeral) browsing view.
// Paging inside a shared message would change it for everybody, so the board
// only shows page 1 and "Browse all" opens a private view that pages freely.
export const TODO_MODE_BOARD = 'b';
export const TODO_MODE_PRIVATE = 'p';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIME_ZONE = 'Asia/Bangkok';
const COLOR_OVERDUE = 0xDC2626;
const COLOR_OPEN = 0x1D4ED8;
const COLOR_CLEAR = 0x16A34A;

export const compactPageId = id => String(id || '').replace(/-/g, '').toLowerCase();

// YYYY-MM-DD for a Date as seen on the wall clock in `timeZone`.
export function toZonedDateKey(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)) {
    parts[part.type] = part.value;
  }

  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Deadline day (YYYY-MM-DD) of a card: the end of a date range when present,
 * otherwise the start. Matches how deadline reminders read the Date property.
 */
export function getTodoDueKey(card, timeZone = DEFAULT_TIME_ZONE) {
  const raw = card?.properties?.Date;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }

  const [start, end] = raw.split('→').map(part => part.trim());
  const candidate = end || start;
  if (!candidate) {
    return null;
  }

  if (ISO_DATE_REGEX.test(candidate)) {
    return candidate;
  }

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : toZonedDateKey(parsed, timeZone);
}

export function getTodoUrgency(card, todayKey, timeZone = DEFAULT_TIME_ZONE) {
  const dueKey = getTodoDueKey(card, timeZone);
  if (!dueKey || !todayKey) return null;
  if (dueKey < todayKey) return 'overdue';
  if (dueKey === todayKey) return 'today';
  return null;
}

/**
 * Open (not Done) tasks for a department, earliest deadline first. Tasks with
 * no parseable date go last, ordered by title.
 */
export function selectTodoCards(cards, department, { timeZone = DEFAULT_TIME_ZONE } = {}) {
  return filterCardsByDepartmentNamesAndStatus(cards, [department]).sort((left, right) => {
    const leftKey = getTodoDueKey(left, timeZone);
    const rightKey = getTodoDueKey(right, timeZone);

    if (leftKey && rightKey && leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }

    if (leftKey && !rightKey) return -1;
    if (!leftKey && rightKey) return 1;

    return getTaskTitle(left).localeCompare(getTaskTitle(right), 'th');
  });
}

function isDoneCard(card) {
  return getStatusValues(card?.properties || {}).some(status => normalizeLookupText(status).includes('done'));
}

/**
 * Tasks ticked from a board today that are still Done. They stay on the board
 * (checked) until the day ends, so a mis-click can be undone.
 * `ticks` maps compact page id -> { dateKey, byUserId, previousStatus }.
 */
export function selectTickedCards(cards, department, ticks = {}, todayKey) {
  const departmentCards = filterCardsByDepartmentNamesAndStatus(cards, [department], [], {
    excludeDoneWhenNoStatus: false,
  });

  return departmentCards.filter(card => {
    const tick = ticks[compactPageId(card.id)];
    return tick && tick.dateKey === todayKey && isDoneCard(card);
  });
}

/** Counts used by the board header and the daily reminder. */
export function summarizeTodo(cards, department, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const todayKey = toZonedDateKey(now, timeZone);
  const todoCards = selectTodoCards(cards, department, { timeZone });
  let overdue = 0;
  let dueToday = 0;

  for (const card of todoCards) {
    const urgency = getTodoUrgency(card, todayKey, timeZone);
    if (urgency === 'overdue') overdue += 1;
    if (urgency === 'today') dueToday += 1;
  }

  return { open: todoCards.length, overdue, dueToday };
}

/**
 * Text of the daily reminder for one board, or null when nothing is open.
 * The role is mentioned only when something is overdue or due today.
 */
export function buildTodoReminderMessage(summary, department, { roleMention = null, boardUrl = null } = {}) {
  if (!summary || summary.open === 0) {
    return null;
  }

  const urgent = summary.overdue + summary.dueToday > 0;
  const who = urgent && roleMention ? roleMention : `**${department}**`;
  const parts = [`${summary.open} open task${summary.open === 1 ? '' : 's'}`];
  if (summary.overdue > 0) parts.push(`🔴 ${summary.overdue} overdue`);
  if (summary.dueToday > 0) parts.push(`🟠 ${summary.dueToday} due today`);

  const lines = [`☀️ Good morning ${who}: ${parts.join(' • ')}.`];
  if (boardUrl) {
    lines.push(`Tick them off on the to-do board: ${boardUrl}`);
  }

  return { content: lines.join('\n'), mentionRole: urgent && Boolean(roleMention) };
}

// ---- custom ids --------------------------------------------------------------

export function buildTodoCustomId(mode, action, ...args) {
  return [TODO_PREFIX.slice(0, -1), mode, action, ...args].join(':');
}

export function parseTodoCustomId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(TODO_PREFIX)) {
    return null;
  }

  const [, mode, action, first, second] = customId.split(':');
  if (mode !== TODO_MODE_BOARD && mode !== TODO_MODE_PRIVATE) {
    return null;
  }

  switch (action) {
    case 'noop':
    case 'open':
      return { mode, action };
    case 'page':
    case 'refresh': {
      const page = parseInt(first, 10);
      return Number.isInteger(page) && page >= 0 ? { mode, action, page } : null;
    }
    case 'done':
    case 'undo': {
      const page = parseInt(second, 10);
      if (!first || !Number.isInteger(page) || page < 0) {
        return null;
      }

      return { mode, action, pageId: first, page };
    }
    default:
      return null;
  }
}

// ---- reading a board message back ------------------------------------------

function toPlain(component) {
  return typeof component?.toJSON === 'function' ? component.toJSON() : component;
}

function collectTextDisplayContents(components = [], out = []) {
  for (const raw of components || []) {
    const component = toPlain(raw);
    if (!component || typeof component !== 'object') continue;

    if (component.type === ComponentType.TextDisplay && typeof component.content === 'string') {
      out.push(component.content);
    }

    if (Array.isArray(component.components)) {
      collectTextDisplayContents(component.components, out);
    }
  }

  return out;
}

export function getDepartmentFromTodoEmbed(embed) {
  const data = embed?.data && typeof embed.data === 'object' ? embed.data : embed;
  const title = typeof data?.title === 'string' ? data.title : '';
  if (!title.startsWith(TODO_TITLE_PREFIX)) {
    return null;
  }

  return title.slice(TODO_TITLE_PREFIX.length).trim() || null;
}

/** True for boards still using the first, embed-based design. */
export function isLegacyTodoMessage(message) {
  return Boolean(getDepartmentFromTodoEmbed(message?.embeds?.[0]));
}

/** Department of a board / private view message (new or legacy design). */
export function getDepartmentFromTodoMessage(message) {
  const legacy = getDepartmentFromTodoEmbed(message?.embeds?.[0]);
  if (legacy) return legacy;

  for (const content of collectTextDisplayContents(message?.components)) {
    const firstLine = content.split('\n')[0];
    if (firstLine.startsWith(TODO_HEADER_PREFIX)) {
      return firstLine.slice(TODO_HEADER_PREFIX.length).trim() || null;
    }
  }

  return null;
}

// ---- rendering ---------------------------------------------------------------

const URGENCY_TAGS = { overdue: ' • 🔴 **Overdue**', today: ' • 🟠 **Due today**' };

function formatOpenItem(card, sequence, todayKey, timeZone) {
  const title = truncateText(getTaskTitle(card), 90);
  const heading = card.url ? `[${title}](${card.url})` : title;
  const date = truncateText(formatScalarReplyValue(card?.properties?.Date), 40);
  const status = formatScalarReplyValue(card?.properties?.Status);
  const urgencyTag = URGENCY_TAGS[getTodoUrgency(card, todayKey, timeZone)] || '';

  return `**${sequence}. ${heading}**\n-# 🗓️ ${date} • ${status}${urgencyTag}`;
}

function formatTickedItem(card, sequence, tick) {
  const title = truncateText(getTaskTitle(card), 90);
  const by = tick?.byUserId ? ` by <@${tick.byUserId}>` : '';

  return `✅  ~~${sequence}. ${title}~~\n-# Done today${by}`;
}

function buildHeaderText(department, summary, doneToday) {
  const parts = [`**${summary.open}** open`];
  if (doneToday > 0) parts.push(`✅ ${doneToday} done today`);
  if (summary.overdue > 0) parts.push(`🔴 ${summary.overdue} overdue`);
  if (summary.dueToday > 0) parts.push(`🟠 ${summary.dueToday} due today`);

  return `${TODO_HEADER_PREFIX}${department}\n${parts.join('  •  ')}`;
}

/**
 * Build one page of a department's to-do list as a Components V2 message:
 * a line per task with a Done (or Undo) button beside it.
 * Returns { components, flags, page, totalPages, total }. Spread `components`
 * and `flags` into send()/edit()/editReply().
 */
export function buildTodoView(
  cards,
  department,
  { page = 0, mode = TODO_MODE_PRIVATE, now = new Date(), timeZone = DEFAULT_TIME_ZONE, ticks = {} } = {}
) {
  const todayKey = toZonedDateKey(now, timeZone);
  const openCards = selectTodoCards(cards, department, { timeZone });
  const tickedCards = selectTickedCards(cards, department, ticks, todayKey);
  const summary = summarizeTodo(cards, department, { now, timeZone });

  // Open tasks first, then today's ticked ones, all on the same pages.
  const items = [
    ...openCards.map(card => ({ card, checked: false })),
    ...tickedCards.map(card => ({ card, checked: true })),
  ];
  const total = items.length;
  const totalPages = Math.max(Math.ceil(total / TODO_PAGE_SIZE), 1);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * TODO_PAGE_SIZE;
  const pageItems = items.slice(start, start + TODO_PAGE_SIZE);

  const accentColor = summary.overdue > 0 ? COLOR_OVERDUE : summary.open > 0 ? COLOR_OPEN : COLOR_CLEAR;
  const container = new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildHeaderText(department, summary, tickedCards.length)))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));

  if (pageItems.length === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('🎉 Nothing left to do. Every task is done!')
    );
  }

  pageItems.forEach(({ card, checked }, index) => {
    const sequence = start + index + 1;
    const id = compactPageId(card.id);
    const tick = ticks[id];

    const text = checked
      ? formatTickedItem(card, sequence, tick)
      : formatOpenItem(card, sequence, todayKey, timeZone);

    const button = checked
      ? new ButtonBuilder()
          .setCustomId(buildTodoCustomId(mode, 'undo', id, safePage))
          .setLabel('Undo')
          .setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder()
          .setCustomId(buildTodoCustomId(mode, 'done', id, safePage))
          .setLabel('✓ Done')
          .setStyle(ButtonStyle.Success);

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
        .setButtonAccessory(button)
    );
  });

  const navRow = new ActionRowBuilder();
  if (mode === TODO_MODE_PRIVATE) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildTodoCustomId(mode, 'page', Math.max(safePage - 1, 0)))
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId(buildTodoCustomId(mode, 'noop'))
        .setLabel(`${safePage + 1}/${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(buildTodoCustomId(mode, 'page', Math.min(safePage + 1, totalPages - 1)))
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage >= totalPages - 1)
    );
  } else if (total > TODO_PAGE_SIZE) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(buildTodoCustomId(mode, 'open'))
        .setLabel(`📄 Browse all ${total}`)
        .setStyle(ButtonStyle.Primary)
    );
  }

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId(buildTodoCustomId(mode, 'refresh', safePage))
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  const unix = Math.floor(now.getTime() / 1000);
  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(navRow)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Page ${safePage + 1}/${totalPages} • Updated <t:${unix}:R>`)
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    page: safePage,
    totalPages,
    total,
  };
}

/** The part of a view that goes into send()/edit()/editReply(). */
export function toTodoPayload(view) {
  return { components: view.components, flags: view.flags, allowedMentions: { parse: [] } };
}
