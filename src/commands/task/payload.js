export function getTaskUpdatePayloadFromInteraction(interaction) {
  const title = interaction.options.getString('title');
  const department = interaction.options.getString('department');
  const organization = interaction.options.getString('organization');
  const startDate = interaction.options.getString('start_date');
  const endDate = interaction.options.getString('end_date');
  const startTime = interaction.options.getString('start_time');
  const endTime = interaction.options.getString('end_time');
  const status = interaction.options.getString('status');

  const updates = {};
  if (typeof title === 'string') {
    updates.title = title;
  }
  if (typeof department === 'string') {
    updates.department = department;
  }
  if (typeof organization === 'string') {
    updates.organization = organization;
  }
  if (
    typeof startDate === 'string' ||
    typeof endDate === 'string' ||
    typeof startTime === 'string' ||
    typeof endTime === 'string'
  ) {
    updates.date = {
      startDate,
      endDate,
      startTime,
      endTime,
    };
  }
  if (typeof status === 'string') {
    updates.status = status;
  }

  return updates;
}
