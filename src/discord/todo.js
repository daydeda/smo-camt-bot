import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { filterCardsByDepartmentNamesAndStatus } from '../sync/filters.js';
import { formatScalarReplyValue, getTaskTitle, truncateText } from '../commands/task/embeds.js';

export const TODO_PREFIX = 'todo:';
export const TODO_TITLE_PREFIX = '📝 To-do — ';
// 5 tasks per page = one full row of "done" buttons, plus one navigation row.
export const TODO_PAGE_SIZE = 5;

// "b" = the shared board message; "p" = a private (ephemeral) browsing view.
// Paging inside a shared message would change it for everybody, so the board
// only shows page 1 and "Browse all" opens a private view that pages freely.
export const TODO_MODE_BOARD = 'b';
export const TODO_MODE_PRIVATE = 'p';

const ISO_DATE_REGEX = /\d{4}-\d{2}-\d{2}/;

export function getDepartmentFromTodoEmbed(embed) {
  const data = embed?.data && typeof embed.data === 'object' ? embed.data : embed;
  const title = typeof data?.title === 'string' ? data.title : '';
  if (!title.startsWith(TODO_TITLE_PREFIX)) {
    return null;
  }

  const department = title.slice(TODO_TITLE_PREFIX.length).trim();
  return department || null;
}

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
    case 'done': {
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

function getDueSortKey(card) {
  const raw = formatScalarReplyValue(card?.properties?.Date);
  return raw.match(ISO_DATE_REGEX)?.[0] || null;
}

/**
 * Open (not Done) tasks for a department, earliest deadline first. Tasks with
 * no parseable date go last, ordered by title.
 */
export function selectTodoCards(cards, department) {
  return filterCardsByDepartmentNamesAndStatus(cards, [department]).sort((left, right) => {
    const leftKey = getDueSortKey(left);
    const rightKey = getDueSortKey(right);

    if (leftKey && rightKey && leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }

    if (leftKey && !rightKey) return -1;
    if (!leftKey && rightKey) return 1;

    return getTaskTitle(left).localeCompare(getTaskTitle(right), 'th');
  });
}

function formatTodoLine(card, sequence) {
  const title = truncateText(getTaskTitle(card), 90);
  const status = formatScalarReplyValue(card?.properties?.Status);
  const date = truncateText(formatScalarReplyValue(card?.properties?.Date), 40);
  const heading = card.url ? `[${title}](${card.url})` : title;

  return `**${sequence}.** ${heading}\n└ 🗓️ ${date} • ${status}`;
}

/**
 * Build the embed + button rows for one page of a department's to-do list.
 * Returns { embeds, components, page, totalPages, total }.
 */
export function buildTodoView(cards, department, { page = 0, mode = TODO_MODE_PRIVATE, now = new Date() } = {}) {
  const todoCards = selectTodoCards(cards, department);
  const total = todoCards.length;
  const totalPages = Math.max(Math.ceil(total / TODO_PAGE_SIZE), 1);
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * TODO_PAGE_SIZE;
  const pageCards = todoCards.slice(start, start + TODO_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setColor(total > 0 ? 0x1D4ED8 : 0x16A34A)
    .setTitle(`${TODO_TITLE_PREFIX}${department}`)
    .setTimestamp(now);

  if (total === 0) {
    embed.setDescription('🎉 No open tasks. Everything is done!');
    embed.setFooter({ text: 'Nothing left to do' });
  } else {
    embed.setDescription(pageCards.map((card, index) => formatTodoLine(card, start + index + 1)).join('\n\n'));
    embed.setFooter({ text: `Page ${safePage + 1}/${totalPages} • ${total} open task${total === 1 ? '' : 's'}` });
  }

  const components = [];

  if (pageCards.length > 0) {
    const doneRow = new ActionRowBuilder();
    pageCards.forEach((card, index) => {
      doneRow.addComponents(
        new ButtonBuilder()
          .setCustomId(buildTodoCustomId(mode, 'done', card.id.replace(/-/g, ''), safePage))
          .setLabel(`✅ ${start + index + 1}`)
          .setStyle(ButtonStyle.Success)
      );
    });
    components.push(doneRow);
  }

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
  components.push(navRow);

  return { embeds: [embed], components, page: safePage, totalPages, total };
}
