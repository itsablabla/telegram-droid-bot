# Telegram Droid Bot

A Telegram bot that bridges [Factory Droid CLI](https://factory.ai) with Telegram, enabling AI-powered conversations, reminders, scheduled tasks, and image recognition.

## Features

- **AI Conversations** — Chat with AI models (MiniMax, Claude, GPT, Gemini, etc.) through Telegram
- **Session Persistence** — Conversation context survives bot restarts
- **Reminders & Scheduled Tasks** — One-time, daily, weekly, monthly reminders; auto-execute tasks via Droid
- **Multi-Context** — Different workspaces and personas for private vs group chats
- **Image Recognition** — Route photos to mmx-cli for vision analysis
- **20+ Commands** — /remind, /model, /status, /skill, /mcp, etc.
- **Reliability** — Auto-retry, atomic writes, session corruption detection
- **Deployable on Proxmox** — Environment-driven workspace config and systemd service template

## Architecture

```
Telegram ←→ Node.js Bot (index.js) ←→ Droid CLI (droid exec)
                - Session mgmt              - AI Models
                - Reminder scheduler
                - ChatId injection
                - Command routing
```

**Reminder Flow:**
```
User message → Bot injects ctxNote (chatId + rules)
             → Droid understands intent
             → Droid calls remind-cli.js (--json)
             → remind-cli validates & writes reminders.json
             → Bot scheduler (60s) checks & fires
```

## Quick Start

### 1. Prerequisites

- Node.js v18+
- Factory Droid CLI installed and authenticated
- A Telegram Bot Token (from @BotFather)

### 2. Install

```bash
git clone https://github.com/GOSHEN192/telegram-droid-bot.git
cd telegram-droid-bot
npm install
```

### 3. Configure

Copy `.env.example` to `.env` and fill in your values, or use the systemd service template:

```bash
cp .env.example .env
# Edit .env with your tokens and IDs
```

Configure workspace paths through environment variables:

```bash
DROID_PRIVATE_CWD=/path/to/private-workspace
DROID_GROUP_CONFIGS='{"YOUR_GROUP_CHAT_ID":{"cwd":"/path/to/group-workspace","label":"MyGroup"}}'
```

### 4. Run

```bash
node index.js

# Or via systemd
sudo cp docs/systemd-service.example /etc/systemd/system/telegram-droid-bot.service
# Edit the service file with your paths and tokens
sudo systemctl enable --now telegram-droid-bot
```

For Proxmox/LXC deployment, see `docs/proxmox-deployment.md`.

## Commands

| Command | Description |
|---------|-------------|
| `/remind HH:MM text` | Set a one-time reminder |
| `/remind daily HH:MM text` | Set a daily reminder |
| `/remind weekly 周三 HH:MM text` | Set a weekly reminder |
| `/remind monthly 15号 HH:MM text` | Set a monthly reminder |
| `/list` | List reminders |
| `/delete <id>` | Delete a reminder |
| `/model <name>` | Switch AI model |
| `/status` | Show session info |
| `/new` | New conversation |
| `/skill` | Manage Droid skills |
| `/mcp` | Manage MCP servers |

## remind-cli.js

CLI for setting reminders (called by Droid via Execute tool):

```bash
node remind-cli.js add --chat ID --time "2026-05-15 09:00" --text "text" --type once --json
node remind-cli.js add --chat ID --time "09:00" --text "text" --type daily --json
node remind-cli.js add --chat ID --time "09:00" --text "text" --type weekly --day 3 --json
node remind-cli.js list --chat ID --json
node remind-cli.js delete --id ID --json
```

`--json` returns structured feedback:
- Success: `{"status":"ok","reminder":{...}}`
- Error: `{"status":"error","code":"...","message":"...","hint":"..."}`

## AGENTS.md Templates

See `docs/` for workspace AGENTS.md templates:
- `AGENTS-private-workspace.md` — Personal workspace
- `AGENTS-group-workspace.md` — Group workspace

## Key Lessons (16 bugs)

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| Reminders to wrong chatId | Droid didn't know chatId | Inject chatId in ctxNote |
| Single reminder set as daily | Droid guessed type | Default to `--type once` in ctxNote |
| Weekly fires daily | No day check | `now.getDay() !== r.day` |
| Reminders never fire | Wrong time format | remind-cli validates & normalizes |
| Droid says "set!" but didn't call CLI | No feedback | `--json` mode with retry loop |
| AGENTS.md not applied | Old session cache | Critical rules in ctxNote, not just AGENTS.md |

Full history: `docs/DEPLOYMENT.md`

## License

MIT
