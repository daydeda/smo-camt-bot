# Notion-Discord Kanban Sync Bot

A real-time Discord bot that monitors your Notion Kanban database and posts updates whenever card statuses, assignments, dates, or event names change.

## Features

✅ **Real-time Sync** - Polls your Notion database every minute
✅ **Smart Change Detection** - Only posts when properties actually change
✅ **Rich Embeds** - Beautiful Discord messages with before/after values
✅ **Multiple Properties** - Tracks any extracted Notion property changes
✅ **Department Filter** - Tracks only cards in configured Notion Department values
✅ **Per-Channel Department Routing** - Route different departments to different Discord channels
✅ **Reminder Check Command** - Run /remindercheck in Discord to trigger due-today/overdue reminders immediately
✅ **Deadline Reminders** - Sends due-today/overdue reminders and tags department roles
✅ **Calendar Command** - Run /calendar with range `today`, `week`, or `month` to post rich schedule embeds
✅ **Clear Command (Admin Only)** - Run /clear to clear all messages in the current configured channel
✅ **Task CRUD + Move Commands** - Run /task create|read|update|move|delete to manage and move Notion tasks from Discord
✅ **Interactive Status Buttons** - Each card notification/reminder has In-Progress / In-Review / Done buttons plus an "Open in Notion" link, so you can change status in one click (same permissions as /task move). The current status button is disabled, and reminders get a **Snooze 1 day** button
✅ **Scheduled Digests** - Automatic daily report and weekly digest posted at configured local times (DAILY_DIGEST_TIME / WEEKLY_DIGEST_TIME)
✅ **Configurable Reminder Lead Time** - Set REMINDER_LEAD_DAYS (e.g. `1,3`) to remind multiple days before a deadline
✅ **Personal Assignee Pings** - Map Notion assignees to Discord users (NOTION_DISCORD_USER_MAP) to @mention them on reminders and updates
✅ **/help Command** - Self-documenting list of commands and who can use them
✅ **Health Endpoint** - Optional HTTP endpoint (HEALTH_PORT) reporting last sync time and tracked card count
✅ **Leveled Logging & Send Retries** - LOG_LEVEL-controlled logs and automatic retry of transient Discord send failures
✅ **Monthly Overview** - Auto-posts rich monthly overview on day 1 of each month
✅ **Error Resilient** - Gracefully handles API errors and reconnects

## Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **Discord Bot** - Create one on [Discord Developer Portal](https://discord.com/developers/applications)
- **Notion Integration** - Create an integration at [Notion Integrations](https://www.notion.so/my-integrations)
- **Notion Database** - A Kanban database to monitor

## Setup Instructions

### 1. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Go to **Bot** section, click "Add Bot"
4. Under TOKEN, click "Copy" to copy your bot token
5. Go to **OAuth2 → URL Generator**
6. Select scopes: `bot`, `applications.commands`
7. Select permissions: `Send Messages`, `Embed Links`, `Manage Messages`
8. Copy the generated URL and open it to invite bot to your server

### 2. Create Notion Integration

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Click "Create new integration"
3. Name it "Discord Bot" and click "Create integration"
4. Copy the "Internal Integration Token"
5. Go to your Notion database
6. Click "..." (top right) → "Connections" → Search for your integration → Connect it

### 3. Get Required IDs

**Discord Channel ID:**
1. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
2. Right-click the channel where you want notifications
3. Click "Copy Channel ID"

**Notion Database ID:**
1. Open your Kanban database in Notion
2. Copy the ID from the URL: `https://www.notion.so/[WORKSPACE]/[DATABASE_ID]?v=[VIEW_ID]`
3. The DATABASE_ID is the string right before the `?`

### 4. Install & Configure Bot

```bash
# Clone/download the bot
cd NotionBot

# Install dependencies
npm install

# Create .env file
cp .env.example .env

# Edit .env with your credentials
nano .env  # or use your preferred editor
```

Fill in `.env`:
```
DISCORD_TOKEN=your_bot_token_here
NOTION_API_KEY=your_integration_token_here
NOTION_DATABASE_ID=your_database_id_here
# Optional but recommended for timed tasks
NOTION_TIMEZONE=Asia/Bangkok
DISCORD_CHANNEL_ID=your_channel_id_here
# Optional: comma-separated channel IDs for broadcasting to multiple channels
# You can omit this if DISCORD_CHANNEL_DEPARTMENT_FILTERS already includes channel IDs
# DISCORD_CHANNEL_IDS=123456789012345678,234567890123456789
POLL_INTERVAL=60
# Optional: role names allowed to run /task write commands (admin always allowed)
# TASK_COMMAND_ROLE_NAMES=SMO 69
# Optional default department filter (comma-separated). Leave unset to include all departments.
# TRACKED_DEPARTMENT=ฝ่ายประธาน,ฝ่ายประสาน
# Optional: channel-specific department filters
# DISCORD_CHANNEL_DEPARTMENT_FILTERS=1339363141720477791:ฝ่ายประธาน|ฝ่ายประสาน,123456789012345678:ฝ่ายกิจกรรม

# --- Optional: reminders, digests, ops ---
# Comma-separated days-before-deadline to remind (default: 1). "0,1,3" also reminds on the due day.
# REMINDER_LEAD_DAYS=1,3
# Daily digest post time (24h HH:mm, in NOTION_TIMEZONE). Unset = disabled.
# DAILY_DIGEST_TIME=09:00
# Weekly digest time + weekday (Mon-Sun or 0-6, Sun=0). Unset time = disabled.
# WEEKLY_DIGEST_TIME=08:30
# WEEKLY_DIGEST_DAY=monday
# Personal pings: map Notion assignee names to Discord user IDs.
# NOTION_DISCORD_USER_MAP=Somchai=111111111111111111,Alice Example=222222222222222222
# Property names treated as the assignee (comma-separated). Has sensible defaults.
# ASSIGNEE_PROPERTIES=ผู้รับผิดชอบ,Assignee,Owner
# Log verbosity: debug | info | warn | error (default: info).
# LOG_LEVEL=info
# Expose an HTTP health endpoint on this port (0/unset = disabled).
# HEALTH_PORT=8080
```

### 5. Run the Bot

```bash
# Start the bot
npm start

# Or with auto-reload during development
npm run dev
```

You should see:
```
🤖 Starting Notion-Discord Sync Bot...
✅ Discord bot logged in as YourBot#1234
✅ Bot ready! Connected to Discord
📌 Watching Notion database: [ID]
💬 Posting updates to Discord channels: [ID]
⏱️  Polling interval: 60 seconds
```

## Usage

The bot automatically monitors your Notion database. When card properties change:

1. **Status Change**: "Status: To Do → In Progress"
2. **Assignee Change**: "Assigned person: None → John Doe"
3. **Date Change**: "Due date: 2024-03-27 → 2024-03-30"
4. **Other Property Changes**: Any tracked property with before/after values

First-seen cards are treated as baseline and are not posted as new-card alerts.

Changes are posted as Discord embeds with:
- Card name as title
- Link to the Notion card
- All property changes listed
- Timestamp

Additionally:
- Run /remindercheck in any configured Discord channel to test and trigger deadline reminders instantly.
- Run /calendar range:today|week|month in any configured Discord channel to post rich calendar embeds.
- Run `/todo department:<name>` (Admin or allowed role) to post a department to-do board. It shows a checklist of that Notion `Department`'s open tasks (earliest deadline first), 5 per page: each task has a ⬜ checkbox and a **✓ Done** button beside it. Ticking marks the task Done in Notion and shows it as ✅ ~~struck through~~ until the end of the day, with an **Undo** button that restores its previous status. Boards made with the first (embed) design are re-posted in the new design the first time someone presses Refresh (re-pinned if they were pinned). Anyone with the matching Discord role (or an Admin/allowed role) can tick tasks. **Browse all** opens a private, paged view so paging never changes the shared board; ticking a task refreshes every posted board for that department. Pin the board in the department channel.
- **Boards follow Notion:** when the sync sees a task change or new task in a department, that department's to-do boards are refreshed right away, so the checklist matches Notion without waiting for a click.
- **Daily to-do reminder:** on weekdays at 09:00 (`TODO_REMINDER_TIME`, `TODO_REMINDER_DAYS`, in `NOTION_TIMEZONE`) the bot refreshes every board and posts one short message per board: open / overdue / due-today counts plus a link to the board. The department role is @mentioned only when something is overdue or due today; nothing is posted when the department has no open tasks. Yesterday's reminder is deleted so the channel stays clean. Overdue and due-today tasks are tagged on the board itself.
- Run /clear in a configured channel to clear channel messages (admin only).
- Run `/task create title:<name> department:<comma-separated, guided> [organization:<comma-separated, guided>] start_date:<DD/MM/YYYY [AD|BC]> [end_date] [start_time] [end_time] [status:<guided>]` to create a Notion task (Admin or allowed role).
- Run `/task read task_title:<title> [id:<page-id-or-url>]` to read a task from Notion.
- Run `/task view department:<comma-separated, guided> [status:<comma-separated, guided>] [limit:<1-50>]` to list tasks for one or more departments.
- Run `/task update task_title:<title> [id:<page-id-or-url>] [title] [department] [organization] [start_date] [end_date] [start_time] [end_time] [status]` to update one or more fields (Admin or allowed role).
- Run `/task move to:In-Progress|In-Review|Done task_title:<title> [id:<page-id-or-url>]` to move status quickly (Admin or allowed role).
- Run `/task delete task_title:<title> [id:<page-id-or-url>]` to archive a task in Notion (Admin or allowed role).

Lookup notes:
- For `/task read`, `/task move`, `/task update`, and `/task delete`, provide either `task_title` or `id`/URL.
- If multiple tasks share the same title, bot will ask you to use `id`/URL.

Date input notes:
- Preferred format: `DD/MM/YYYY` (for example `31/03/2026`).
- Era is supported by suffix: `AD` or `BC` (for example `31/03/2026 AD`, `01/01/0044 BC`).
- `YYYY-MM-DD` and valid ISO datetime values are also accepted for compatibility.

Time input notes:
- 24-hour format: `HH:mm` (for example `14:30`).
- 12-hour format: `h:mm AM/PM` (for example `2:30 PM`).
- Timed values are sent with `NOTION_TIMEZONE` (default `Asia/Bangkok`) to prevent hour shifts.

Organization notes:
- `SMO CAMT` is automatically included on create/update organization writes.
- Department and Organization support comma-separated multi-values.
- Task write commands (`/task create`, `/task update`, `/task move`, `/task delete`) require Admin or one of the role names in `TASK_COMMAND_ROLE_NAMES` (default: `SMO 69`).
- Monthly overview auto-posts on the first day of each month.
- Overdue count is computed from deadline dates (Date property) when due date is in the past and task is not Done.
- Deadline reminder messages are sent for due-today and overdue cards (once per card per day), tagging matching Department roles.

## Customization

### Polling Interval

Edit `.env` to change check frequency:
```
POLL_INTERVAL=60   # 1 minute
POLL_INTERVAL=300  # 5 minutes
POLL_INTERVAL=900  # 15 minutes
```

### Department Scope

The bot filters cards using the Notion `Department` property.

```env
# Optional default department filter
TRACKED_DEPARTMENT=ฝ่ายประธาน,ฝ่ายประสาน
```

For per-channel routing, use `DISCORD_CHANNEL_DEPARTMENT_FILTERS`:

```env
DISCORD_CHANNEL_DEPARTMENT_FILTERS=1339363141720477791:ฝ่ายประธาน|ฝ่ายประสาน,123456789012345678:ฝ่ายกิจกรรม
```

Notes:
- If a channel is not listed in `DISCORD_CHANNEL_DEPARTMENT_FILTERS`, it falls back to `TRACKED_DEPARTMENT`.
- If `TRACKED_DEPARTMENT` is unset, fallback is all departments.
- Use `channelId:*` (or `channelId:all`) for a channel to receive all departments.
- You can remove `DISCORD_CHANNEL_IDS` when channel IDs are fully defined in `DISCORD_CHANNEL_DEPARTMENT_FILTERS`.

### Property Names

If your Notion database uses different property names, edit `src/notion/database.js` to map them correctly. The bot automatically detects all properties.

### Department Role Mentions

The `Department` field now automatically mentions matching Discord roles in notifications.

- Matching is name-based and case-insensitive.
- Example: Notion Department `Marketing` matches Discord role `Marketing`.
- For multi-select departments, all matched roles are mentioned.

### Embed Colors

Edit `src/sync/syncer.js` line with `.setColor()` to change notification colors:
```javascript
.setColor(0xFF5722)  // Change to your color
```

## Troubleshooting

**Bot not connecting to Discord:**
- Verify DISCORD_TOKEN is correct
- Check bot is invited to your server
- Ensure bot has "Send Messages" permission in the channel

**Not fetching Notion data:**
- Verify NOTION_API_KEY is correct
- Verify NOTION_DATABASE_ID is correct (not view ID)
- Ensure integration is connected to database in Notion

**No notifications sent:**
- Check DISCORD_CHANNEL_ID (or DISCORD_CHANNEL_IDS) is correct
- Verify bot has permission to send messages in every configured channel
- If using per-channel filters, verify `DISCORD_CHANNEL_DEPARTMENT_FILTERS` is correctly formatted (`channelId:Dept1|Dept2`)
- Check console logs for errors

**Rate limit issues:**
- Notion allows ~3 requests/second
- If you have >100 cards, increase POLL_INTERVAL

## Logs & State

- **state_tracker.json** - Stores database snapshot to detect changes
- **Console output** - Real-time sync information
- Delete `state_tracker.json` to reset all change history

## Deployment

### Free Options (Always-on)

1. **Koyeb (recommended free tier)**
2. **Render free web service with periodic pings** (free tier may sleep)
3. **Fly.io** (good free credits in some regions)

### Deploy to Koyeb (easy)

1. Push code to GitHub
2. Create a Koyeb app from repository
3. Set Start Command to `npm start`
4. Add environment variables from `.env.example`
5. Deploy and verify logs

### Security Tips for Deployment

1. Never commit `.env` or tokens.
2. Rotate Discord/Notion tokens if they were ever exposed.
3. Use least privilege: Discord bot only needs guild-level messaging permissions.
4. Keep `POLL_INTERVAL` at 60+ seconds unless you need faster updates.

### Docker (optional)

Add `Dockerfile`:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]
```

## License

MIT

## Support

If you encounter issues:
1. Check console for error messages
2. Verify all credentials in `.env`
3. Check Discord bot permissions
4. Ensure Notion integration is connected to database
