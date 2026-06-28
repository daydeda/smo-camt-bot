// Configure env BEFORE importing config-dependent modules (dotenv won't override
// values already set on process.env).
process.env.DISCORD_TOKEN = 'test-token';
process.env.NOTION_API_KEY = 'test-key';
process.env.NOTION_DATABASE_ID = 'test-db';
process.env.DISCORD_CHANNEL_ID = '123456789';
process.env.REMINDER_LEAD_DAYS = '1,3';
process.env.NOTION_DISCORD_USER_MAP = 'Alice=999';
process.env.ASSIGNEE_PROPERTIES = 'Assignee';

import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import so the env above is applied before config.js loads.
const { createDeadlineReminderEmbeds } = await import('./syncer.js');

function makeCard(id, status, date, extra = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    properties: {
      'กิจกรรม': `Task ${id}`,
      Status: status,
      Date: date,
      Department: 'Ops',
      ...extra,
    },
  };
}

test('configurable lead days remind at each configured offset', () => {
  const now = new Date(2026, 2, 28, 10, 0, 0);
  const cards = [
    makeCard('due1', 'In Progress', '2026-03-29'), // due in 1 day -> remind
    makeCard('due2', 'In Progress', '2026-03-30'), // due in 2 days -> skip
    makeCard('due3', 'In Progress', '2026-03-31'), // due in 3 days -> remind
  ];

  const result = createDeadlineReminderEmbeds(cards, {}, {}, now);
  const reminded = result.embeds.map(embed => embed.data.title);

  assert.equal(result.embeds.length, 2);
  assert.ok(reminded.some(title => title.includes('due1')));
  assert.ok(reminded.some(title => title.includes('due3')));
  assert.ok(!reminded.some(title => title.includes('due2')));
});

test('snooze suppresses reminders through the snooze date', () => {
  const now = new Date(2026, 2, 28, 10, 0, 0);
  const cards = [makeCard('overdue', 'In Progress', '2026-03-20')];

  const withoutSnooze = createDeadlineReminderEmbeds(cards, {}, {}, now);
  assert.equal(withoutSnooze.embeds.length, 1);

  const withSnooze = createDeadlineReminderEmbeds(cards, {}, {}, now, {
    snoozeStateByCardId: { overdue: '2026-03-28' },
  });
  assert.equal(withSnooze.embeds.length, 0);
});

test('assignee ping field appears when a Notion person maps to a Discord user', () => {
  const now = new Date(2026, 2, 28, 10, 0, 0);
  const cards = [makeCard('a1', 'In Progress', '2026-03-29', { Assignee: ['Alice'] })];

  const result = createDeadlineReminderEmbeds(cards, {}, {}, now);
  const assigneeField = result.embeds[0].data.fields.find(field => field.name === '👤 Assignee');

  assert.ok(assigneeField);
  assert.equal(assigneeField.value, '<@999>');
});
