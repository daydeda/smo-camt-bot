# Notion-Discord Kanban Sync Bot

A real-time Discord bot that monitors your Notion Kanban database and posts updates whenever card statuses, assignments, dates, or event names change.

## Features

✅ **Real-time Sync** - Polls your Notion database every minute
✅ **Smart Change Detection** - Only posts when properties actually change
✅ **Rich Embeds** - Beautiful Discord messages with before/after values
✅ **Multiple Properties** - Tracks any extracted Notion property changes
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
6. Select scopes: `bot`
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
DISCORD_CHANNEL_ID=your_channel_id_here
POLL_INTERVAL=60
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
💬 Posting updates to Discord channel: [ID]
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

## Customization

### Polling Interval

Edit `.env` to change check frequency:
```
POLL_INTERVAL=60   # 1 minute
POLL_INTERVAL=300  # 5 minutes
POLL_INTERVAL=900  # 15 minutes
```

### Property Names

If your Notion database uses different property names, edit `src/notion/database.js` to map them correctly. The bot automatically detects all properties.

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
- Check DISCORD_CHANNEL_ID is correct
- Verify bot has permission to send messages in channel
- Check console logs for errors

**Rate limit issues:**
- Notion allows ~3 requests/second
- If you have >100 cards, increase POLL_INTERVAL

## Logs & State

- **state_tracker.json** - Stores database snapshot to detect changes
- **Console output** - Real-time sync information
- Delete `state_tracker.json` to reset all change history

## Deployment

### Deploy to Railway/Heroku/Replit

1. Push code to GitHub
2. Connect to your hosting platform
3. Set environment variables
4. Deploy!

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
