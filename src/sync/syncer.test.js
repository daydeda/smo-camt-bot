import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyReportSummary, createDeadlineReminderEmbeds } from './syncer.js';

function makeCard(id, status, date, department = 'Ops') {
  return {
    id,
    url: `https://example.com/${id}`,
    properties: {
      'กิจกรรม': `Task ${id}`,
      Status: status,
      Date: date,
      Department: department,
    },
  };
}

test('buildDailyReportSummary counts statuses and overdue tasks', () => {
  const now = new Date(2026, 2, 28, 23, 59, 0);
  const cards = [
    makeCard('1', 'Not Started', '2026-03-27'),
    makeCard('2', 'In Progress', '2026-03-29'),
    makeCard('3', 'In Review', '2026-03-28'),
    makeCard('4', 'Done', '2026-03-20'),
    makeCard('5', 'Unknown', '2026-03-26'),
  ];

  const summary = buildDailyReportSummary(cards, now);

  assert.equal(summary.counts.notStarted, 1);
  assert.equal(summary.counts.inProgress, 1);
  assert.equal(summary.counts.inReview, 1);
  assert.equal(summary.counts.done, 1);
  assert.equal(summary.counts.overdue, 2);
  assert.equal(summary.totalCards, 5);
});

test('createDeadlineReminderEmbeds sends only one-day-before/overdue and once per day', () => {
  const now = new Date(2026, 2, 28, 10, 0, 0);
  const cards = [
    makeCard('1', 'Not Started', '2026-03-27', 'Operations'),
    makeCard('2', 'In Progress', '2026-03-29', 'Operations'),
    makeCard('3', 'Done', '2026-03-27', 'Operations'),
    makeCard('4', 'In Review', '2026-03-30', 'Operations'),
  ];

  const departmentRoleMentions = {
    operations: '<@&1234567890>',
  };

  const firstRun = createDeadlineReminderEmbeds(cards, departmentRoleMentions, {}, now);
  assert.equal(firstRun.embeds.length, 2);
  assert.equal(firstRun.reminderStateByCardId['1'], '2026-03-28');
  assert.equal(firstRun.reminderStateByCardId['2'], '2026-03-28');

  const firstReminderDepartmentField = firstRun.embeds[0].data.fields.find(
    field => field.name === '🏢 Department'
  );
  assert.equal(firstReminderDepartmentField.value, '<@&1234567890>');

  const secondRun = createDeadlineReminderEmbeds(
    cards,
    departmentRoleMentions,
    firstRun.reminderStateByCardId,
    now
  );
  assert.equal(secondRun.embeds.length, 0);
});

test('createDeadlineReminderEmbeds can bypass daily dedupe for manual checks', () => {
  const now = new Date(2026, 2, 28, 10, 0, 0);
  const cards = [
    makeCard('1', 'Not Started', '2026-03-27', 'Operations'),
  ];

  const departmentRoleMentions = {
    operations: '<@&1234567890>',
  };

  const firstRun = createDeadlineReminderEmbeds(cards, departmentRoleMentions, {}, now);
  assert.equal(firstRun.embeds.length, 1);

  const forcedRun = createDeadlineReminderEmbeds(
    cards,
    departmentRoleMentions,
    firstRun.reminderStateByCardId,
    now,
    { ignoreDailyLimit: true }
  );

  assert.equal(forcedRun.embeds.length, 1);
});

test('createDeadlineReminderEmbeds handles datetime deadlines for one-day and overdue', () => {
  const departmentRoleMentions = {
    operations: '<@&1234567890>',
  };

  const oneDayCard = makeCard('dt-1', 'In Progress', '2026-03-29T10:00:00.000Z', 'Operations');
  const oneDayNow = new Date('2026-03-28T12:00:00.000Z');
  const oneDayResult = createDeadlineReminderEmbeds(
    [oneDayCard],
    departmentRoleMentions,
    {},
    oneDayNow
  );

  assert.equal(oneDayResult.embeds.length, 1);
  assert.match(oneDayResult.embeds[0].data.description, /due in 1 day/i);

  const overdueCard = makeCard('dt-2', 'In Progress', '2026-03-28T10:00:00.000Z', 'Operations');
  const overdueNow = new Date('2026-03-28T12:00:00.000Z');
  const overdueResult = createDeadlineReminderEmbeds(
    [overdueCard],
    departmentRoleMentions,
    {},
    overdueNow
  );

  assert.equal(overdueResult.embeds.length, 1);
  assert.match(overdueResult.embeds[0].data.description, /overdue/i);
});
