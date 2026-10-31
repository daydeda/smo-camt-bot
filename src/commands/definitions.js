import { ApplicationCommandOptionType } from 'discord.js';

export async function registerSlashCommands(channel) {
  const guild = channel?.guild;
  if (!guild) {
    return;
  }

  const requiredCommands = [
    {
      name: 'help',
      description: 'Show available commands and how to use them',
    },
    {
      name: 'mytasks',
      description: 'Show tasks for your department(s), based on your Discord roles',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'status',
          description: 'Optional status filter(s), comma-separated (default: hide Done)',
          required: false,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.Integer,
          name: 'limit',
          description: 'Max tasks to show (default 15, max 50)',
          required: false,
          min_value: 1,
          max_value: 50,
        },
      ],
    },
    {
      name: 'todo',
      description: 'Post a department to-do board with tick-off buttons and paging (Admin/task writers)',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'department',
          description: 'Department (Notion Department / Discord role name)',
          required: true,
          autocomplete: true,
        },
      ],
    },
    {
      name: 'roleselect',
      description: 'Post a role selection panel with a member cap per role (Admin/task writers)',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'roles',
          description: 'Roles and caps, comma-separated, e.g. สวัสดิการ:10, จราจร:15, Media (no cap = unlimited)',
          required: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'title',
          description: 'Panel title (optional)',
          required: false,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'description',
          description: 'Text shown above the role list (optional)',
          required: false,
        },
      ],
    },
    {
      name: 'remindercheck',
      description: 'Run deadline reminder check now and send due/overdue reminders',
    },
    {
      name: 'calendar',
      description: 'Post calendar overview for today, week, or month',
      options: [
        {
          name: 'range',
          description: 'Select calendar range',
          type: 3,
          required: true,
          choices: [
            { name: 'today', value: 'today' },
            { name: 'week', value: 'week' },
            { name: 'month', value: 'month' },
            { name: 'all', value: 'all' },
          ],
        },
        {
          name: 'department',
          description: 'Filter by department (optional)',
          type: 3,
          required: false,
          autocomplete: true,
        },
        {
          name: 'organization',
          description: 'Filter by organization (optional, default: SMO CAMT)',
          type: 3,
          required: false,
          autocomplete: true,
        },
      ],
    },
    {
      name: 'clear',
      description: 'Admin only: clear all messages in this configured channel',
    },
    {
      name: 'task',
      description: 'Manage task records in the connected Notion database',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'create',
          description: 'Create a new Notion task',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'title',
              description: 'Task title',
              required: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'department',
              description: 'Department(s), comma-separated (choose from suggestions)',
              required: true,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_date',
              description: 'Start date: DD/MM/YYYY [AD Only]',
              required: true,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'organization',
              description: 'Organization(s), comma-separated. SMO CAMT is always included',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_date',
              description: 'End date: DD/MM/YYYY [AD Only] (optional)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_time',
              description: 'Start time: HH:mm or h:mm AM/PM (optional)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_time',
              description: 'End time: HH:mm or h:mm AM/PM (optional)',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'status',
              description: 'Optional status (choose from suggestions)',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'read',
          description: 'Read task details by title or page ID/URL',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'view',
          description: 'View tasks by department, optionally filtered by status',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'department',
              description: 'Department(s), comma-separated (choose from suggestions)',
              required: true,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'status',
              description: 'Optional status filter(s), comma-separated',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: 'limit',
              description: 'Max tasks to show (default 15, max 50)',
              required: false,
              min_value: 1,
              max_value: 50,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'update',
          description: 'Update fields of an existing Notion task',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'title',
              description: 'New task title',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'department',
              description: 'New department(s), comma-separated',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'organization',
              description: 'New organization(s), comma-separated. SMO CAMT is always included',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_date',
              description: 'New start date: DD/MM/YYYY [AD Only]',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_date',
              description: 'New end date: DD/MM/YYYY [AD Only]',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'start_time',
              description: 'New start time: HH:mm or h:mm AM/PM',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'end_time',
              description: 'New end time: HH:mm or h:mm AM/PM',
              required: false,
              autocomplete: true,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'status',
              description: 'New status (choose from suggestions)',
              required: false,
              autocomplete: true,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'move',
          description: 'Move task status quickly (title or id/url)',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'to',
              description: 'Target status',
              required: true,
              choices: [
                { name: 'In-Progress', value: 'In-Progress' },
                { name: 'In-Review', value: 'In-Review' },
                { name: 'Done', value: 'Done' },
              ],
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
          ],
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'delete',
          description: 'Archive a task in Notion by title or page ID/URL',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'id',
              description: 'Notion page ID or URL (optional if task_title is provided)',
              required: false,
            },
            {
              type: ApplicationCommandOptionType.String,
              name: 'task_title',
              description: 'Task title to identify task (optional if id is provided)',
              required: false,
            },
          ],
        },
      ],
    },
  ];

  for (const commandDef of requiredCommands) {
    const exists = guild.commands.cache.find(command => command.name === commandDef.name);
    if (!exists) {
      await guild.commands.create(commandDef);
      continue;
    }

    await exists.edit(commandDef);
  }
}
