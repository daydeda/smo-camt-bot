process.env.DISCORD_TOKEN = 'test-token';
process.env.NOTION_API_KEY = 'test-key';
process.env.NOTION_DATABASE_ID = 'test-db';
process.env.DISCORD_CHANNEL_ID = '123456789';

import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentType, MessageFlags } from 'discord.js';

const {
  TODO_PAGE_SIZE,
  TODO_MODE_BOARD,
  TODO_MODE_PRIVATE,
  TODO_TITLE_PREFIX,
  buildTodoCustomId,
  buildTodoView,
  getDepartmentFromTodoMessage,
  isLegacyTodoMessage,
  parseTodoCustomId,
  selectTodoCards,
  getTodoDueKey,
  summarizeTodo,
  buildTodoReminderMessage,
} = await import('./todo.js');
const { parseWeekdayList } = await import('../config.js');

const DEPT = 'ฝ่ายการเงิน | Finance';
const NOW = new Date('2026-11-02T03:00:00Z'); // 10:00 Bangkok, 2 Nov

function makeCard(n, { department = DEPT, status = 'In-Progress', date = '2026-11-05' } = {}) {
  const id = String(n).padStart(32, '0');
  return {
    id,
    url: `https://www.notion.so/Task-${id}`,
    properties: { 'กิจกรรม': `Task ${n}`, Department: department, Status: status, Date: date },
  };
}

// Flatten a view into { header, sections: [{ text, button }], navButtons, footer }.
function inspect(view) {
  const [container] = view.components.map(component => component.toJSON());
  const children = container.components;
  const texts = children.filter(child => child.type === ComponentType.TextDisplay).map(child => child.content);
  const sections = children
    .filter(child => child.type === ComponentType.Section)
    .map(section => ({ text: section.components[0].content, button: section.accessory }));
  const navButtons = children.find(child => child.type === ComponentType.ActionRow)?.components || [];

  return { header: texts[0], sections, navButtons, footer: texts[texts.length - 1], container };
}

test('selectTodoCards keeps only open tasks of the department, earliest deadline first', () => {
  const cards = [
    makeCard(1, { date: '2026-12-01' }),
    makeCard(2, { date: '2026-11-01' }),
    makeCard(3, { status: 'Done' }),
    makeCard(4, { department: 'Other' }),
    makeCard(5, { date: '' }),
  ];

  assert.deepEqual(selectTodoCards(cards, DEPT).map(c => c.id.slice(-1)), ['2', '1', '5']);
});

test('each task is a checkbox line with a Done button beside it, in a V2 message', () => {
  const view = buildTodoView([makeCard(1), makeCard(2)], DEPT, { now: NOW, mode: TODO_MODE_BOARD });
  assert.equal(view.flags, MessageFlags.IsComponentsV2);

  const { header, sections } = inspect(view);
  assert.ok(header.startsWith(`## 📝 To-do — ${DEPT}`));
  assert.equal(sections.length, 2);
  assert.ok(sections[0].text.startsWith('⬜'));
  assert.equal(sections[0].button.label, '✓ Done');
  assert.equal(sections[0].button.custom_id, buildTodoCustomId(TODO_MODE_BOARD, 'done', makeCard(1).id, 0));
});

test('tasks ticked today stay on the board checked, with an Undo button', () => {
  const ticked = makeCard(7, { status: 'Done' });
  const ticks = { [ticked.id]: { dateKey: '2026-11-02', byUserId: '99', previousStatus: 'In-Progress' } };
  const { header, sections } = inspect(buildTodoView([makeCard(1), ticked], DEPT, { now: NOW, ticks }));

  assert.equal(sections.length, 2);
  assert.ok(sections[1].text.startsWith('✅'));
  assert.match(sections[1].text, /~~2\. Task 7~~/);
  assert.match(sections[1].text, /<@99>/);
  assert.equal(sections[1].button.label, 'Undo');
  assert.match(header, /1 done today/);

  // Ticks from an earlier day are not shown.
  const stale = { [ticked.id]: { ...ticks[ticked.id], dateKey: '2026-11-01' } };
  assert.equal(inspect(buildTodoView([makeCard(1), ticked], DEPT, { now: NOW, ticks: stale })).sections.length, 1);
});

test('private view paginates five tasks per page with working prev/next', () => {
  const cards = Array.from({ length: 12 }, (_, i) => makeCard(i + 1, { date: `2026-11-${String(i + 10).padStart(2, '0')}` }));

  const first = buildTodoView(cards, DEPT, { now: NOW, page: 0, mode: TODO_MODE_PRIVATE });
  assert.equal(first.totalPages, 3);
  const firstParts = inspect(first);
  assert.equal(firstParts.sections.length, TODO_PAGE_SIZE);
  assert.match(firstParts.sections[0].text, /\*\*1\. /);
  assert.equal(firstParts.navButtons[0].disabled, true); // Prev on first page
  assert.equal(firstParts.navButtons[2].custom_id, buildTodoCustomId(TODO_MODE_PRIVATE, 'page', 1));
  assert.match(firstParts.footer, /Page 1\/3/);

  const last = buildTodoView(cards, DEPT, { now: NOW, page: 99, mode: TODO_MODE_PRIVATE });
  assert.equal(last.page, 2); // clamped
  const lastParts = inspect(last);
  assert.equal(lastParts.sections.length, 2); // tasks 11 and 12
  assert.match(lastParts.sections[0].text, /\*\*11\. /);
  assert.equal(lastParts.navButtons[2].disabled, true); // Next on last page
});

test('board view has Browse all only when there is more than a page', () => {
  const many = Array.from({ length: 7 }, (_, i) => makeCard(i + 1));
  assert.deepEqual(inspect(buildTodoView(many, DEPT, { now: NOW, mode: TODO_MODE_BOARD })).navButtons.map(b => b.custom_id), [
    buildTodoCustomId(TODO_MODE_BOARD, 'open'),
    buildTodoCustomId(TODO_MODE_BOARD, 'refresh', 0),
  ]);

  const few = Array.from({ length: 3 }, (_, i) => makeCard(i + 1));
  assert.equal(inspect(buildTodoView(few, DEPT, { now: NOW, mode: TODO_MODE_BOARD })).navButtons.length, 1);
});

test('empty department shows a friendly message and no task buttons', () => {
  const parts = inspect(buildTodoView([], DEPT, { now: NOW, mode: TODO_MODE_BOARD }));
  assert.equal(parts.sections.length, 0);
  assert.ok(parts.container.components.some(c => c.type === ComponentType.TextDisplay && /Nothing left to do/.test(c.content)));
});

test('overdue and due-today tasks are tagged and turn the board red', () => {
  const view = buildTodoView([makeCard(1, { date: '2026-10-30' }), makeCard(2, { date: '2026-11-02' })], DEPT, { now: NOW });
  const { sections, header, container } = inspect(view);
  assert.match(sections[0].text, /Overdue/);
  assert.match(sections[1].text, /Due today/);
  assert.match(header, /1 overdue/);
  assert.equal(container.accent_color, 0xDC2626);
});

test('the V2 board message stays within Discord limits on a full page', () => {
  const cards = Array.from({ length: 12 }, (_, i) => makeCard(i + 1));
  const { container } = inspect(buildTodoView(cards, DEPT, { now: NOW, mode: TODO_MODE_PRIVATE }));

  let count = 0;
  let textLength = 0;
  const walk = component => {
    count += 1;
    if (typeof component.content === 'string') textLength += component.content.length;
    (component.components || []).forEach(walk);
    if (component.accessory) walk(component.accessory);
  };
  walk(container);

  assert.ok(count <= 40, `component count ${count}`);
  assert.ok(textLength <= 4000, `text length ${textLength}`);
});

test('custom ids round-trip, including done/undo, and fit Discord limits', () => {
  const card = makeCard(1);
  const doneId = inspect(buildTodoView([card], DEPT, { now: NOW })).sections[0].button.custom_id;
  assert.ok(doneId.length <= 100);
  assert.deepEqual(parseTodoCustomId(doneId), { mode: TODO_MODE_PRIVATE, action: 'done', pageId: card.id, page: 0 });
  assert.deepEqual(parseTodoCustomId(`todo:b:undo:${card.id}:0`), { mode: 'b', action: 'undo', pageId: card.id, page: 0 });

  assert.equal(parseTodoCustomId('card:move:Done:abc'), null);
  assert.equal(parseTodoCustomId('todo:x:open'), null);
  assert.equal(parseTodoCustomId('todo:p:page:-1'), null);
  assert.equal(parseTodoCustomId('todo:p:done:abc'), null);
  assert.deepEqual(parseTodoCustomId('todo:b:open'), { mode: 'b', action: 'open' });
});

test('department is read back from both new and old board messages', () => {
  const view = buildTodoView([makeCard(1)], DEPT, { now: NOW, mode: TODO_MODE_BOARD });
  const newMessage = { embeds: [], components: view.components };
  assert.equal(getDepartmentFromTodoMessage(newMessage), DEPT);
  assert.equal(isLegacyTodoMessage(newMessage), false);

  const oldMessage = { embeds: [{ data: { title: `${TODO_TITLE_PREFIX}${DEPT}` } }], components: [] };
  assert.equal(getDepartmentFromTodoMessage(oldMessage), DEPT);
  assert.equal(isLegacyTodoMessage(oldMessage), true);

  assert.equal(getDepartmentFromTodoMessage({ embeds: [{ data: { title: 'Something else' } }], components: [] }), null);
});

test('getTodoDueKey uses the end of a date range and the Bangkok day for datetimes', () => {
  assert.equal(getTodoDueKey(makeCard(1, { date: '2026-11-01 → 2026-11-05' })), '2026-11-05');
  assert.equal(getTodoDueKey(makeCard(1, { date: '2026-11-01' })), '2026-11-01');
  // 20:00 UTC on the 1st is already the 2nd in Bangkok (UTC+7).
  assert.equal(getTodoDueKey(makeCard(1, { date: '2026-11-01T20:00:00.000Z' })), '2026-11-02');
  assert.equal(getTodoDueKey(makeCard(1, { date: '' })), null);
});

test('summarizeTodo counts open, overdue and due-today tasks for the department', () => {
  const cards = [
    makeCard(1, { date: '2026-10-30' }),
    makeCard(2, { date: '2026-11-02' }),
    makeCard(3, { date: '2026-11-09' }),
    makeCard(4, { date: '2026-10-01', status: 'Done' }),
    makeCard(5, { date: '2026-10-01', department: 'Other' }),
  ];

  assert.deepEqual(summarizeTodo(cards, DEPT, { now: NOW }), { open: 3, overdue: 1, dueToday: 1 });
});

test('reminder pings the role only when something is urgent, and is silent when empty', () => {
  const role = '<@&42>';
  const url = 'https://discord.com/channels/1/2/3';

  const urgent = buildTodoReminderMessage({ open: 4, overdue: 1, dueToday: 2 }, DEPT, { roleMention: role, boardUrl: url });
  assert.equal(urgent.mentionRole, true);
  assert.match(urgent.content, /<@&42>/);
  assert.match(urgent.content, /1 overdue/);
  assert.match(urgent.content, /2 due today/);

  const calm = buildTodoReminderMessage({ open: 3, overdue: 0, dueToday: 0 }, DEPT, { roleMention: role, boardUrl: url });
  assert.equal(calm.mentionRole, false);
  assert.doesNotMatch(calm.content, /<@&42>/);

  assert.equal(buildTodoReminderMessage({ open: 0, overdue: 0, dueToday: 0 }, DEPT, { roleMention: role }), null);
});

test('parseWeekdayList understands ranges, lists and daily', () => {
  assert.deepEqual(parseWeekdayList(''), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWeekdayList('mon-fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseWeekdayList('Mon,Wed,Friday'), [1, 3, 5]);
  assert.deepEqual(parseWeekdayList('daily'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseWeekdayList('sat-mon'), [0, 1, 6]);
  assert.throws(() => parseWeekdayList('someday'));
});
