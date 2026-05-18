# Lark Droid Bridge deployment snapshot

This repository is a sanitized snapshot of the live `lark-droid-bridge` deployment created on 2026-05-18.

## Live target

- Proxmox node: `pve`
- Container: LXC `115`, hostname `lark-droid-bridge`
- Container IP: `10.10.10.115/24`
- Runtime path: `/opt/lark-droid-bridge`
- Systemd unit: `lark-droid-bridge.service`
- Service command: `/opt/lark-droid-bridge/.venv/bin/python /opt/lark-droid-bridge/main.py`

## What changed from upstream

- Added `droid_runner.py`, which invokes Factory Droid CLI instead of Claude CLI.
- Patched `main.py` to use `run_droid` and default model `custom:garza-gpt54-mini`.
- Patched `bot_config.py` to prefer `DROID_MODEL` / `custom:garza-gpt54-mini`.
- Configured Lark CLI for brand `lark`; using `feishu` caused `1000040351: Incorrect domain name`.
- Configured Droid custom model `custom:garza-gpt54-mini` against Garza OpenAI-compatible endpoint.

## Required runtime secrets/config

Secrets are intentionally not committed. On the live container they are stored in:

- `/opt/lark-droid-bridge/.env` (`0600`) for Lark app ID/secret and runtime vars.
- `/root/.lark-cli/config.json` for Lark CLI app binding.
- `/root/.factory/settings.local.json` for Droid custom-model config.

Important runtime note: Droid did not expand `${GARZA_LLM_BASE_URL}` / `${GARZA_LLM_API_KEY}` placeholders in `settings.local.json` during deployment, so the live workaround used explicit values in that root-only file.

## Current status at snapshot time

- Backend service connected to Lark WebSocket successfully.
- Droid/Garza smoke test succeeded with `droid exec -m custom:garza-gpt54-mini --output-format text "Reply exactly READY"` returning `READY`.
- The blocking issue for end-to-end chat was Lark app configuration: app `cli_aa8ad76b0c78c060` had live `callback_info.subscribed_callbacks` containing only `card.action.trigger`, missing `im.message.receive_v1`.
- Published app version metadata did include `im.message.receive_v1`, but the live callback config did not deliver message events.

## To finish Lark ingress

In Lark Developer console for app `cli_aa8ad76b0c78c060`:

1. Go to **Events and callbacks → Event Configuration**.
2. Ensure subscription mode is **Long Connection / WebSocket**.
3. Add event `im.message.receive_v1` / **Receive message**.
4. Publish/release the app version.
5. Send a message to the bot and check `journalctl -u lark-droid-bridge -f` for `[收到消息]`, `run_droid`, and reply activity.

## Verification commands

```bash
systemctl status lark-droid-bridge --no-pager -l
journalctl -u lark-droid-bridge --since "30 min ago" --no-pager
/root/.local/bin/droid exec -m custom:garza-gpt54-mini --output-format text "Reply exactly READY"
```
