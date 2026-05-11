# 💣 Channel cleaner bot

A Discord.js bot that deletes and recreates channels — preserving **every permission, category, and position** exactly as before.

---

## Setup

### 1. Clone or download the repo
```bash
git clone https://github.com/yutomiwana/auto-cleaner
```
### 2. Install dependencies
```bash
npm install
```

### 2. Set your bot token
Create a `.env` file (or export the variable):
```env
DISCORD_TOKEN=your_bot_token_here
```
Or just:
```bash
export DISCORD_TOKEN=your_bot_token_here
```

### 3. Run the bot
```bash
npm start
# or with auto-restart on file changes:
npm run dev
```

### 4. Required Bot Permissions
In the Discord Developer Portal, enable:
- `MESSAGE CONTENT INTENT` (required)
- `SERVER MEMBERS INTENT` (required)

Bot permissions needed in server:
- `Manage Channels`
- `Send Messages`
- `Read Message History`
- `View Channels`

---

## Commands

All commands require **Manage Channels** or **Administrator** permission.

### Set a scheduled nuke
```
,set nuke #channel <time> <message>
```
- Sets an automatic nuke timer on the channel
- Only **one timer** can be active per channel
- The bot is **enabled by default** once set
- `<message>` is sent as the first message after every nuke

**Time formats:** `5hr` `30min` `10s` `2d` `1h` `45sec` `3day`

**Examples:**
```
,set nuke #general 5hr Hello everyone!
,set nuke #spam 30min Channel cleared!
,set nuke #logs 2d Log rotation complete.
```

---

### Edit an existing timer
```
,edit nuke #channel <newtime> <newmessage>
```
Updates the interval and/or message. Resets the countdown from now.

```
,edit nuke #general 1hr Good morning!
```

---

### Delete a nuke setup entirely
```
,delete nuke #channel
```
Removes all timer data for that channel. The channel itself is **not** nuked.

---

### Disable a timer (pause it)
```
,disable nuke #channel
```
Stops the timer without deleting the config. Use `,enable` to resume.

---

### Enable a timer (resume it)
```
,enable nuke #channel
```
Re-enables a disabled timer. Countdown restarts from now.

---

### Manual nuke (with confirmation)
```
,nuke
,nuke #channel
```
Shows a confirmation prompt with **Confirm** and **Cancel** buttons.
- If confirmed: channel is deleted and recreated with identical permissions, category, and position.
- If the timer has a post-nuke message configured, it's sent. Otherwise nothing is sent.

---

### Check nuke status
```
,nukestatus
,nukestatus #channel
```
Shows whether the timer is enabled, the interval, time until next nuke, and the post-nuke message.

---

## How the nuke works

When a nuke fires (scheduled or manual):

1. Snapshots: name, topic, NSFW, slowmode, position, parent category, **all permission overwrites** (roles + users, allow/deny bits)
2. Deletes the channel
3. Recreates it with all snapshots applied
4. Sets channel position back to its original slot
5. Sends the configured first message

Nothing changes — not a single permission, not the category, not the position.

---

## Data storage

Timer configs are saved to `nukeData.json` in the bot's directory. Timers survive bot restarts — the bot reschedules all active timers on startup using the stored `nextNuke` timestamp.

---

## Notes

- When a channel is nuked, its ID changes (Discord gives the new channel a new ID). The bot automatically updates its internal storage to track the new ID.
- If a timer fires while the bot is offline, it fires immediately on the next startup.
