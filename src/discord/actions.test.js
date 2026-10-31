import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCardActionComponents,
  buildCardActionCustomId,
  buildSnoozeCustomId,
  parseCardActionCustomId,
  detectCurrentStatusFromEmbed,
  extractPageIdFromUrl,
} from './actions.js';

const PAGE_ID = '1234567890abcdef1234567890abcdef';
const NOTION_URL = `https://www.notion.so/Some-Task-${PAGE_ID}`;

test('buildCardActionComponents builds status buttons plus a Notion link', () => {
  const rows = buildCardActionComponents({ data: { title: '📋 Some Task', url: NOTION_URL } });
  assert.equal(rows.length, 1);

  const buttons = rows[0].toJSON().components;
  assert.equal(buttons.length, 4);
  assert.deepEqual(
    buttons.slice(0, 3).map(button => button.custom_id),
    [
      buildCardActionCustomId('In-Progress', PAGE_ID),
      buildCardActionCustomId('In-Review', PAGE_ID),
      buildCardActionCustomId('Done', PAGE_ID),
    ]
  );
  assert.equal(buttons[3].url, NOTION_URL);
});

test('buildCardActionComponents skips removed/archived cards', () => {
  assert.deepEqual(
    buildCardActionComponents({ data: { title: '🗑️ Some Task', url: NOTION_URL } }),
    []
  );
});

test('buildCardActionComponents skips embeds without a Notion page id', () => {
  assert.deepEqual(buildCardActionComponents({ data: { title: '📋 Some Task' } }), []);
});

test('parseCardActionCustomId round-trips a built custom id', () => {
  const parsed = parseCardActionCustomId(buildCardActionCustomId('Done', PAGE_ID));
  assert.deepEqual(parsed, { action: 'move', status: 'Done', pageId: PAGE_ID });
});

test('parseCardActionCustomId rejects unrelated custom ids', () => {
  assert.equal(parseCardActionCustomId('other:thing'), null);
  assert.equal(parseCardActionCustomId('card:move:Done'), null);
  assert.equal(parseCardActionCustomId(null), null);
});

test('reminder embeds get a snooze button', () => {
  const rows = buildCardActionComponents({
    data: { title: '⏰ Deadline Reminder: Some Task', url: NOTION_URL },
  });
  const buttons = rows[0].toJSON().components;

  // 3 status + snooze + link.
  assert.equal(buttons.length, 5);
  assert.equal(buttons[3].custom_id, buildSnoozeCustomId(1, PAGE_ID));
});

test('parseCardActionCustomId parses a snooze action', () => {
  assert.deepEqual(parseCardActionCustomId(buildSnoozeCustomId(1, PAGE_ID)), {
    action: 'snooze',
    days: 1,
    pageId: PAGE_ID,
  });
  assert.equal(parseCardActionCustomId(`card:snooze:0:${PAGE_ID}`), null);
});

test('detectCurrentStatusFromEmbed reads the new status after the arrow', () => {
  const status = detectCurrentStatusFromEmbed({
    title: '📋 Some Task',
    description: '**Status**: In-Progress → Done',
  });
  assert.equal(status, 'done');
});

test('status-aware buttons disable the current status', () => {
  const rows = buildCardActionComponents({
    data: {
      title: '📋 Some Task',
      url: NOTION_URL,
      description: '**Status**: In-Progress → Done',
    },
  });
  const buttons = rows[0].toJSON().components;
  const doneButton = buttons.find(button => button.custom_id === buildCardActionCustomId('Done', PAGE_ID));

  assert.equal(doneButton.disabled, true);
});

test('extractPageIdFromUrl takes the trailing id even when the slug looks like hex', () => {
  const id = '34c6f2983ac180068851d62fb15f219a';
  assert.equal(extractPageIdFromUrl(`https://www.notion.so/Fix-bug-2-${id}`), id);
  assert.equal(extractPageIdFromUrl(`https://www.notion.so/Add-feed-${id}`), id);
  assert.equal(extractPageIdFromUrl(`https://www.notion.so/workspace/Add-feed-${id}?pvs=4`), id);
  assert.equal(extractPageIdFromUrl(`https://www.notion.so/${id}`), id);
  assert.equal(extractPageIdFromUrl('https://www.notion.so/No-id-here'), null);
  assert.equal(extractPageIdFromUrl(undefined), null);
});
