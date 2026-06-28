import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import config from '../config.js';
import { normalizeLookupText } from '../sync/filters.js';

export function isConfiguredChannel(channelId) {
  return config.discord.channelIds.includes(channelId);
}

export async function canUseCommandOutsideConfiguredChannel(interaction) {
  if (interaction.commandName === 'task') {
    return true;
  }

  if (interaction.commandName === 'clear') {
    return false;
  }

  return isAdminInteraction(interaction) || await hasAllowedTaskRole(interaction);
}

export function formatConfiguredChannelsMentionText() {
  return config.discord.channelIds.map(channelId => `<#${channelId}>`).join(', ');
}

export async function safeEphemeralReply(interaction, content) {
  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
      return;
    }

    await interaction.reply(payload);
  } catch (error) {
    if (error?.code === 40060) {
      try {
        await interaction.followUp(payload);
      } catch {
        // No-op: interaction may already be closed.
      }

      return;
    }

    throw error;
  }
}

export async function safeCommandFailureReply(interaction, message) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
      return;
    }

    await safeEphemeralReply(interaction, message);
  } catch (error) {
    if (error?.code === 40060) {
      try {
        await interaction.followUp({
          content: message,
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // No-op: interaction may already be closed.
      }

      return;
    }

    throw error;
  }
}

export function getInteractionActorText(interaction) {
  const actorId = interaction?.user?.id || 'unknown';
  const actorTag = interaction?.user?.tag || interaction?.user?.username || 'unknown';
  return `<@${actorId}> (${actorTag})`;
}

export function isAdminInteraction(interaction) {
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has(PermissionFlagsBits.Administrator));
}

function getInteractionRoleIds(interaction) {
  const memberRoles = interaction?.member?.roles;

  if (Array.isArray(memberRoles)) {
    return memberRoles.map(roleId => String(roleId));
  }

  const roleCache = memberRoles?.cache;
  if (roleCache && typeof roleCache.keys === 'function') {
    return Array.from(roleCache.keys());
  }

  return [];
}

async function getRoleNameById(guild, roleId) {
  if (!guild || !roleId) {
    return null;
  }

  const cachedRole = guild.roles?.cache?.get(roleId);
  if (cachedRole?.name) {
    return cachedRole.name;
  }

  if (typeof guild.roles?.fetch !== 'function') {
    return null;
  }

  try {
    const fetchedRole = await guild.roles.fetch(roleId);
    return fetchedRole?.name || null;
  } catch {
    return null;
  }
}

async function hasAllowedTaskRole(interaction) {
  const allowedRoleNames = config.permissions?.taskCommandRoleNames || [];
  if (!Array.isArray(allowedRoleNames) || allowedRoleNames.length === 0) {
    return false;
  }

  const normalizedAllowedRoleNames = new Set(
    allowedRoleNames
      .map(roleName => normalizeLookupText(roleName))
      .filter(Boolean)
  );
  if (normalizedAllowedRoleNames.size === 0) {
    return false;
  }

  const guild = interaction?.guild;
  if (!guild) {
    return false;
  }

  const roleIds = getInteractionRoleIds(interaction);
  for (const roleId of roleIds) {
    const roleName = await getRoleNameById(guild, roleId);
    if (!roleName) {
      continue;
    }

    if (normalizedAllowedRoleNames.has(normalizeLookupText(roleName))) {
      return true;
    }
  }

  return false;
}

export async function canManageTaskCommands(interaction) {
  return isAdminInteraction(interaction) || await hasAllowedTaskRole(interaction);
}
