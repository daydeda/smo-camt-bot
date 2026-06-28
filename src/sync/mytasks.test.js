process.env.DISCORD_TOKEN = 'test-token';
process.env.NOTION_API_KEY = 'test-key';
process.env.NOTION_DATABASE_ID = 'test-db';
process.env.DISCORD_CHANNEL_ID = '123456789';

import test from 'node:test';
import assert from 'node:assert/strict';

const { filterCardsByDepartmentNamesAndStatus } = await import('./filters.js');

function makeCard(id, department, status) {
  return {
    id,
    url: `https://example.com/${id}`,
    properties: { 'กิจกรรม': `Task ${id}`, Department: department, Status: status },
  };
}

const cards = [
  makeCard('1', 'ฝ่ายการเงิน | Finance', 'In-Progress'),
  makeCard('2', 'ฝ่ายการเงิน | Finance', 'Done'),
  makeCard('3', 'ฝ่ายประธาน | President', 'Not Started'),
  makeCard('4', 'Creative Production', 'In-Review'),
];

test('matches cards by the caller role names and hides Done by default', () => {
  const result = filterCardsByDepartmentNamesAndStatus(cards, ['ฝ่ายการเงิน | Finance']);
  assert.deepEqual(result.map(card => card.id), ['1']); // Done card 2 hidden
});

test('multiple roles return the union of departments', () => {
  const result = filterCardsByDepartmentNamesAndStatus(cards, [
    'ฝ่ายการเงิน | Finance',
    'Creative Production',
  ]);
  assert.deepEqual(result.map(card => card.id).sort(), ['1', '4']);
});

test('explicit status filter overrides the hide-Done default', () => {
  const result = filterCardsByDepartmentNamesAndStatus(
    cards,
    ['ฝ่ายการเงิน | Finance'],
    ['Done']
  );
  assert.deepEqual(result.map(card => card.id), ['2']);
});

test('no matching department yields no tasks', () => {
  const result = filterCardsByDepartmentNamesAndStatus(cards, ['Nonexistent Dept']);
  assert.deepEqual(result, []);
});
