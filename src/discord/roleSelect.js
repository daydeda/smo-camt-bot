import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import stateTracker from '../sync/tracker.js';
import { normalizeLookupText } from '../sync/filters.js';

export const ROLE_SELECT_PREFIX = 'rolesel:';
const ROLE_SELECT_META_KEY = 'roleSelectPanels';
const MAX_PANELS = 30;
const MAX_ROLES_PER_PANEL = 25; // 5 rows x 5 buttons

// ---- parsing -----------------------------------------------------------------

/**
 * Parse "สวัสดิการ:10, จราจร:15, Media" into [{ ref, cap }]. The cap is
 * optional (null = unlimited). Entries are split on commas or newlines.
 */
export function parseRoleCapSpecs(text) {
  const specs = [];
  const problems = [];

  for (const raw of String(text || '').split(/[,\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;

    const match = entry.match(/^(.*?)\s*[:=]\s*(.*)$/);
    const ref = (match ? match[1] : entry).trim();
    const capText = match ? match[2].trim() : '';

    if (!ref) {
      problems.push(`"${entry}" has no role name`);
      continue;
    }

    let cap = null;
    if (match && capText !== '') {
      if (!/^\d+$/.test(capText) || Number(capText) < 1) {
        problems.push(`"${entry}": cap must be a whole number of 1 or more`);
        continue;
      }
      cap = Number(capText);
    }

    specs.push({ ref, cap });
  }

  return { specs, problems };
}

/** Find a guild role from a spec ref (role name, case-insensitive, or <@&id>). */
export function resolveRole(guild, ref) {
  const roles = guild?.roles?.cache;
  if (!roles) return null;

  const mentionId = ref.match(/^<@&(\d+)>$/)?.[1];
  if (mentionId) return roles.get(mentionId) || null;

  const wanted = normalizeLookupText(ref);
  return roles.find(role => normalizeLookupText(role.name) === wanted) || null;
}

// ---- panel state -------------------------------------------------------------

function loadPanels() {
  const panels = stateTracker.getMeta(ROLE_SELECT_META_KEY, {});
  return panels && typeof panels === 'object' ? panels : {};
}

export function getRoleSelectPanel(messageId) {
  return loadPanels()[messageId] || null;
}

export function saveRoleSelectPanel(messageId, panel) {
  const panels = { ...loadPanels(), [messageId]: panel };
  const ids = Object.keys(panels);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PANELS))) {
    delete panels[id];
  }
  stateTracker.setMeta(ROLE_SELECT_META_KEY, panels);
}

export function createPanel({ title, description, roles }) {
  return {
    title: title || 'Role selection',
    description: description || '',
    roles: roles.slice(0, MAX_ROLES_PER_PANEL).map(({ roleId, name, cap }) => ({
      roleId,
      name,
      cap: cap ?? null,
      members: [],
    })),
  };
}

/**
 * Toggle a member's spot on one role. `hasRole` is the member's real Discord
 * state, which wins over our records (someone may have had the role removed
 * by hand). Mutates the panel and returns what happened:
 *   'joined' | 'left' | 'full' | 'unknown-role'
 */
export function toggleRoleMember(panel, roleId, userId, hasRole) {
  const entry = panel.roles.find(role => role.roleId === roleId);
  if (!entry) return { result: 'unknown-role' };

  const isTracked = entry.members.includes(userId);

  if (hasRole) {
    entry.members = entry.members.filter(id => id !== userId);
    return { result: 'left', entry };
  }

  if (isTracked) {
    // Role was removed outside the panel; free the stale spot and re-evaluate.
    entry.members = entry.members.filter(id => id !== userId);
  }

  if (entry.cap !== null && entry.members.length >= entry.cap) {
    return { result: 'full', entry };
  }

  entry.members.push(userId);
  return { result: 'joined', entry };
}

/** Undo a 'joined' reservation when Discord refused to give the role. */
export function releaseRoleMember(panel, roleId, userId) {
  const entry = panel.roles.find(role => role.roleId === roleId);
  if (entry) entry.members = entry.members.filter(id => id !== userId);
}

// ---- rendering ---------------------------------------------------------------

function countText(entry) {
  return entry.cap === null ? `${entry.members.length}` : `${entry.members.length}/${entry.cap}`;
}

function isFull(entry) {
  return entry.cap !== null && entry.members.length >= entry.cap;
}

export function buildRoleSelectPayload(panel) {
  const lines = panel.roles.map(entry => {
    const status = isFull(entry) ? ' 🔒 **FULL**' : '';
    return `<@&${entry.roleId}> — ${countText(entry)}${status}`;
  });

  const description = [panel.description, lines.join('\n'), '_Click a button to take a role; click again to give it up._']
    .filter(Boolean)
    .join('\n\n');

  const embed = new EmbedBuilder().setTitle(panel.title).setDescription(description).setColor(0x5865f2);

  const rows = [];
  for (let i = 0; i < panel.roles.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const entry of panel.roles.slice(i, i + 5)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`${ROLE_SELECT_PREFIX}${entry.roleId}`)
          .setLabel(`${entry.name} (${countText(entry)})`.slice(0, 80))
          .setStyle(isFull(entry) ? ButtonStyle.Secondary : ButtonStyle.Primary)
      );
    }
    rows.push(row);
  }

  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export function parseRoleSelectCustomId(customId) {
  if (!customId?.startsWith(ROLE_SELECT_PREFIX)) return null;
  const roleId = customId.slice(ROLE_SELECT_PREFIX.length);
  return /^\d+$/.test(roleId) ? { roleId } : null;
}
