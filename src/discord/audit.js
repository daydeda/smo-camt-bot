import { EmbedBuilder } from 'discord.js';
import { getInteractionActorText } from './permissions.js';
import { getTaskTitle, truncateText } from '../commands/task/embeds.js';

function createDiscordCrudAuditEmbed({ action, interaction, card = null, details = [] } = {}) {
  const actionText = typeof action === 'string' ? action.toUpperCase() : 'UNKNOWN';
  const colorByAction = {
    CREATE: 0x2ECC71,
    READ: 0x3498DB,
    UPDATE: 0xF39C12,
    DELETE: 0xE74C3C,
  };

  const titleByAction = {
    CREATE: '🧾 Discord CRUD: CREATE',
    READ: '🧾 Discord CRUD: READ',
    UPDATE: '🧾 Discord CRUD: UPDATE',
    DELETE: '🧾 Discord CRUD: DELETE',
  };

  const taskTitle = card ? getTaskTitle(card) : 'N/A';
  const taskId = card?.id || 'N/A';
  const taskUrl = card?.url || 'N/A';
  const detailLines = Array.isArray(details)
    ? details.map(item => String(item).trim()).filter(Boolean)
    : [];

  const embed = new EmbedBuilder()
    .setTitle(titleByAction[actionText] || '🧾 Discord CRUD')
    .setColor(colorByAction[actionText] || 0x5865F2)
    .setTimestamp(new Date())
    .addFields(
      { name: 'Source', value: 'Discord Slash Command', inline: true },
      { name: 'Action', value: actionText, inline: true },
      { name: 'Actor', value: getInteractionActorText(interaction), inline: false },
      { name: 'Task', value: truncateText(taskTitle, 256) || 'N/A', inline: false },
      { name: 'Task ID', value: taskId, inline: true },
      { name: 'Task URL', value: taskUrl, inline: true }
    );

  if (detailLines.length > 0) {
    embed.setDescription(detailLines.join('\n'));
  }

  return embed;
}

export async function postDiscordCrudAudit(channel, payload) {
  if (!channel || typeof channel.send !== 'function') {
    return;
  }

  try {
    const embed = createDiscordCrudAuditEmbed(payload);
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error(`⚠️  Failed to post Discord CRUD audit embed: ${error.message}`);
  }
}
