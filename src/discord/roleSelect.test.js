import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.NOTION_TOKEN ||= 'test';
process.env.NOTION_DATABASE_ID ||= 'test';
process.env.DISCORD_CHANNEL_ID ||= '1';

const {
  parseRoleCapSpecs,
  createPanel,
  toggleRoleMember,
  releaseRoleMember,
  buildRoleSelectPayload,
  parseRoleSelectCustomId,
} = await import('./roleSelect.js');

test('parseRoleCapSpecs reads name:cap pairs, Thai names and optional caps', () => {
  const { specs, problems } = parseRoleCapSpecs('สวัสดิการ:10, จราจร : 15,\nMedia Team, Staff=3');
  assert.deepEqual(problems, []);
  assert.deepEqual(specs, [
    { ref: 'สวัสดิการ', cap: 10 },
    { ref: 'จราจร', cap: 15 },
    { ref: 'Media Team', cap: null },
    { ref: 'Staff', cap: 3 },
  ]);
});

test('parseRoleCapSpecs reports bad caps', () => {
  const { specs, problems } = parseRoleCapSpecs('A:0, B:x, :5, C:2');
  assert.deepEqual(specs, [{ ref: 'C', cap: 2 }]);
  assert.equal(problems.length, 3);
});

function panelWith(cap) {
  return createPanel({ title: 't', roles: [{ roleId: '111', name: 'สวัสดิการ', cap }] });
}

test('toggleRoleMember enforces the cap and frees a spot on leave', () => {
  const panel = panelWith(2);
  assert.equal(toggleRoleMember(panel, '111', 'a', false).result, 'joined');
  assert.equal(toggleRoleMember(panel, '111', 'b', false).result, 'joined');
  assert.equal(toggleRoleMember(panel, '111', 'c', false).result, 'full');
  assert.equal(toggleRoleMember(panel, '111', 'a', true).result, 'left');
  assert.equal(toggleRoleMember(panel, '111', 'c', false).result, 'joined');
  assert.deepEqual(panel.roles[0].members, ['b', 'c']);
});

test('toggleRoleMember treats a hand-removed role as a stale spot', () => {
  const panel = panelWith(1);
  toggleRoleMember(panel, '111', 'a', false);
  // a lost the role elsewhere; clicking again must rejoin, not "leave".
  assert.equal(toggleRoleMember(panel, '111', 'a', false).result, 'joined');
  assert.deepEqual(panel.roles[0].members, ['a']);
});

test('null cap means unlimited, release undoes a reservation', () => {
  const panel = panelWith(null);
  for (const id of ['a', 'b', 'c', 'd']) toggleRoleMember(panel, '111', id, false);
  assert.equal(panel.roles[0].members.length, 4);
  releaseRoleMember(panel, '111', 'd');
  assert.equal(panel.roles[0].members.length, 3);
});

test('buildRoleSelectPayload shows counts, FULL state and role-id button ids', () => {
  const panel = panelWith(1);
  toggleRoleMember(panel, '111', 'a', false);
  const { embeds, components } = buildRoleSelectPayload(panel);
  assert.match(embeds[0].data.description, /<@&111> — 1\/1 🔒 \*\*FULL\*\*/);
  const button = components[0].toJSON().components[0];
  assert.equal(button.custom_id, 'rolesel:111');
  assert.equal(button.label, 'สวัสดิการ (1/1)');
  assert.deepEqual(parseRoleSelectCustomId(button.custom_id), { roleId: '111' });
});
