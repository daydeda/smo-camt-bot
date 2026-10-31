process.env.DISCORD_TOKEN = 'test-token';
process.env.NOTION_API_KEY = 'test-key';
process.env.NOTION_DATABASE_ID = 'test-db';
process.env.DISCORD_CHANNEL_ID = '123456789';

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  TODO_PAGE_SIZE,
  TODO_MODE_BOARD,
  TODO_MODE_PRIVATE,
  buildTodoCustomId,
  buildTodoView,
  getDepartmentFromTodoEmbed,
  parseTodoCustomId,
  selectTodoCards,
} = await import('./todo.js');

const DEPT = 'ฝ่ายการเงิน | Finance';

function makeCard(n, { department = DEPT, status = 'In-Progress', date = '2026-11-01' } = {}) {
  const id = String(n).padStart(32, '0');
  return {
    id,
    url: `https://www.notion.so/Task-${id}`,
    properties: { 'กิจกรรม': `Task ${n}`, Department: department, Status: status, Date: date },
  };
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

test('private view paginates five tasks per page with working prev/next', () => {
  const cards = Array.from({ length: 12 }, (_, i) => makeCard(i + 1, { date: `2026-11-${String(i + 1).padStart(2, '0')}` }));

  const first = buildTodoView(cards, DEPT, { page: 0, mode: TODO_MODE_PRIVATE });
  assert.equal(first.totalPages, 3);
  assert.equal(first.total, 12);

  const [doneRow, navRow] = first.components.map(row => row.toJSON().components);
  assert.equal(doneRow.length, TODO_PAGE_SIZE);
  assert.equal(doneRow[0].label, '✅ 1');
  assert.equal(navRow[0].disabled, true); // Prev on first page
  assert.equal(navRow[2].custom_id, buildTodoCustomId(TODO_MODE_PRIVATE, 'page', 1));

  const last = buildTodoView(cards, DEPT, { page: 99, mode: TODO_MODE_PRIVATE });
  assert.equal(last.page, 2); // clamped
  const lastButtons = last.components.map(row => row.toJSON().components);
  assert.equal(lastButtons[0].length, 2); // tasks 11 and 12
  assert.equal(lastButtons[0][0].label, '✅ 11');
  assert.equal(lastButtons[1][2].disabled, true); // Next on last page
});

test('board view shows page one with a Browse all button only when there is more than a page', () => {
  const many = Array.from({ length: 7 }, (_, i) => makeCard(i + 1));
  const manyRows = buildTodoView(many, DEPT, { mode: TODO_MODE_BOARD }).components.map(r => r.toJSON().components);
  assert.deepEqual(manyRows[1].map(b => b.custom_id), [
    buildTodoCustomId(TODO_MODE_BOARD, 'open'),
    buildTodoCustomId(TODO_MODE_BOARD, 'refresh', 0),
  ]);

  const few = Array.from({ length: 3 }, (_, i) => makeCard(i + 1));
  const fewRows = buildTodoView(few, DEPT, { mode: TODO_MODE_BOARD }).components.map(r => r.toJSON().components);
  assert.equal(fewRows[1].length, 1); // refresh only
});

test('empty department shows a friendly message and only a refresh button', () => {
  const view = buildTodoView([], DEPT, { mode: TODO_MODE_BOARD });
  assert.match(view.embeds[0].toJSON().description, /No open tasks/);
  assert.equal(view.components.length, 1);
});

test('done button ids round-trip and fit Discord limits', () => {
  const card = makeCard(1);
  const view = buildTodoView([card], DEPT, { mode: TODO_MODE_PRIVATE });
  const customId = view.components[0].toJSON().components[0].custom_id;

  assert.ok(customId.length <= 100);
  assert.deepEqual(parseTodoCustomId(customId), {
    mode: TODO_MODE_PRIVATE,
    action: 'done',
    pageId: card.id,
    page: 0,
  });
});

test('parseTodoCustomId rejects unrelated or malformed ids', () => {
  assert.equal(parseTodoCustomId('card:move:Done:abc'), null);
  assert.equal(parseTodoCustomId('todo:x:open'), null);
  assert.equal(parseTodoCustomId('todo:p:page:-1'), null);
  assert.equal(parseTodoCustomId('todo:p:done:abc'), null);
  assert.deepEqual(parseTodoCustomId('todo:b:open'), { mode: 'b', action: 'open' });
});

test('department is recovered from the board embed title (including Thai / pipes)', () => {
  const view = buildTodoView([], DEPT, { mode: TODO_MODE_BOARD });
  assert.equal(getDepartmentFromTodoEmbed(view.embeds[0]), DEPT);
  assert.equal(getDepartmentFromTodoEmbed({ data: { title: 'Something else' } }), null);
});
