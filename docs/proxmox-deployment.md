# Proxmox deployment

This guide deploys `telegram-droid-bot` on a Proxmox host or, preferably, inside a dedicated Debian/Ubuntu LXC container.

## Recommended target

Use a dedicated LXC container instead of running the bot directly on the Proxmox host. This keeps Telegram tokens, Droid credentials, Node.js packages, session files, and reminder state isolated from the hypervisor.

## 1. Prepare the container

Install runtime dependencies:

```bash
apt update
apt install -y git curl nodejs npm
node --version
npm --version
```

Install and authenticate Factory Droid CLI according to the Droid install instructions, then confirm the service user can run it:

```bash
droid --version
```

## 2. Clone and install the bot

```bash
git clone https://github.com/itsablabla/telegram-droid-bot.git /opt/telegram-droid-bot
cd /opt/telegram-droid-bot
npm install
```

## 3. Configure environment

Create `/etc/telegram-droid-bot.env` and keep it readable only by root:

```bash
cat >/etc/telegram-droid-bot.env <<'EOF'
TELEGRAM_BOT_TOKEN=replace_with_bot_token
ALLOWED_USERS=replace_with_allowed_telegram_user_ids
DROID_MODEL=custom:minimax-m2.7
DROID_PATH=/usr/local/bin/droid
DROID_CWD=/root
DROID_PRIVATE_CWD=/root/private-workspace
DROID_TIMEOUT=120000
# DROID_GROUP_CONFIGS={"-1001234567890":{"cwd":"/root/family-workspace","label":"Family"}}
# GARZA_LLM_BASE_URL=https://llm.garza.online/v1
# GARZA_LLM_MODEL=gpt-5.4-mini
# GARZA_LLM_API_KEY=replace_if_using_garza_llm
# MINIMAX_API_KEY=replace_if_using_custom_minimax
# ZAI_API_KEY=replace_if_using_zai
# XFYUN_API_KEY=replace_if_using_xfyun
EOF
chmod 600 /etc/telegram-droid-bot.env
```

`DROID_GROUP_CONFIGS` is JSON where each key is a Telegram group chat ID and each value has:

- `cwd`: workspace path for that group
- `label`: display label used in Telegram replies and logs

## 4. Configure Droid custom models

If using the Garza OpenAI-compatible LLM endpoint, add a custom model entry to the Droid settings file for the service user, usually `/root/.factory/settings.local.json` when the service runs as root:

```json
{
  "customModels": [
    {
      "model": "gpt-5.4-mini",
      "id": "custom:garza-gpt-5.4-mini",
      "baseUrl": "${GARZA_LLM_BASE_URL}",
      "apiKey": "${GARZA_LLM_API_KEY}",
      "displayName": "CLIProxyAPI llm.garza.online",
      "maxOutputTokens": 131072,
      "noImageSupport": true,
      "provider": "generic-chat-completion-api"
    }
  ]
}
```

Then set `DROID_MODEL=custom:garza-gpt-5.4-mini` in `/etc/telegram-droid-bot.env`.

## 5. Install systemd service

Copy the example unit and update paths if needed:

```bash
cp /opt/telegram-droid-bot/docs/systemd-service.example /etc/systemd/system/telegram-droid-bot.service
sed -i 's#/path/to/telegram-droid-bot#/opt/telegram-droid-bot#g' /etc/systemd/system/telegram-droid-bot.service
systemctl daemon-reload
systemctl enable --now telegram-droid-bot
```

Check startup logs:

```bash
systemctl status telegram-droid-bot
journalctl -u telegram-droid-bot -f
```

The bot should log its model, Droid path, private working directory, configured group mappings, timeout, and allowed users at startup.

## 6. Verify Telegram behavior

From an allowed Telegram account:

1. Send `/start` and confirm the bot replies.
2. Send `/status` and confirm the working directory is correct.
3. Send `/model` and confirm available models render.
4. Send a simple prompt and confirm Droid responds.
5. Send `/remind 1m test reminder` and confirm it fires.
6. Restart the service and confirm `/session` still shows persisted state when expected:

```bash
systemctl restart telegram-droid-bot
```

## 7. Update deployment

```bash
cd /opt/telegram-droid-bot
git pull
npm install
systemctl restart telegram-droid-bot
journalctl -u telegram-droid-bot -n 100 --no-pager
```
