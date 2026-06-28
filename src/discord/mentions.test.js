process.env.DISCORD_TOKEN = 'test-token';
process.env.NOTION_API_KEY = 'test-key';
process.env.NOTION_DATABASE_ID = 'test-db';
process.env.DISCORD_CHANNEL_ID = '123456789';
process.env.NOTION_DISCORD_USER_MAP = 'Alice Example=111,สมชาย=222';
process.env.ASSIGNEE_PROPERTIES = 'Assignee,ผู้รับผิดชอบ';

import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import so the env above is applied before config.js loads.
const {
  getAssigneeNames,
  resolveAssigneeMentions,
  extractUserMentionsFromEmbed,
  extractUserIdsFromMentions,
} = await import('./mentions.js');

test('getAssigneeNames reads configured assignee properties', () => {
  const card = { properties: { Assignee: ['Alice Example', 'Bob'], ผู้รับผิดชอบ: 'สมชาย' } };
  assert.deepEqual(getAssigneeNames(card).sort(), ['Alice Example', 'Bob', 'สมชาย'].sort());
});

test('resolveAssigneeMentions maps names to Discord mentions', () => {
  const card = { properties: { Assignee: ['Alice Example'], ผู้รับผิดชอบ: 'สมชาย' } };
  assert.deepEqual(resolveAssigneeMentions(card).sort(), ['<@111>', '<@222>'].sort());
});

test('resolveAssigneeMentions ignores unmapped names', () => {
  const card = { properties: { Assignee: ['Nobody'] } };
  assert.deepEqual(resolveAssigneeMentions(card), []);
});

test('extractUserMentionsFromEmbed ignores role mentions', () => {
  const embed = {
    data: {
      fields: [
        { name: '👤 Assignee', value: '<@111> <@222>' },
        { name: '🏢 Department', value: '<@&333>' },
      ],
    },
  };
  assert.deepEqual(extractUserMentionsFromEmbed(embed).sort(), ['<@111>', '<@222>'].sort());
  assert.deepEqual(extractUserIdsFromMentions(['<@111>', '<@222>']), ['111', '222']);
});
