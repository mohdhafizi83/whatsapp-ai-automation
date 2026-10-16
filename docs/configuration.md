# Configuration — WhatsApp AI Automation

Every variable lives in `.env` (copy from [`.env.example`](../.env.example)). With Docker Compose, the file is read automatically (`env_file: .env`); natively, `webhook/server.js` and `processor.js` load it via `dotenv`.

## Required secrets (fail-closed)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VERIFY_TOKEN` | **Yes** | — | Meta webhook handshake token. Server **exits at boot** if empty. Generate: `openssl rand -hex 32`. Must match the value entered in Meta's webhook config. |
| `APP_SECRET` | **Yes** | — | Meta App Secret (App Dashboard → Settings → Basic). Verifies `X-Hub-Signature-256` on `POST /webhook`. Without it every POST returns **503**. |
| `API_KEY` | **Yes** | — | Shared secret for `X-API-Key` on all `/api/*` routes. Without it every `/api/*` route returns **503**. |
| `WHATSAPP_TOKEN` | When `WA_PROVIDER=meta` | — | Cloud API access token (system-user token recommended; temporary tokens expire in ~24h). |
| `WHATSAPP_PHONE_ID` | When `WA_PROVIDER=meta` | — | Numeric Phone Number ID from WhatsApp → API Setup. |

## Provider

| Variable | Default | Description |
|---|---|---|
| `WA_PROVIDER` | `meta` | `meta` = official Cloud API. `baileys` = unofficial bridge (ban risk, at your own risk). |
| `BAILEYS_BRIDGE` | `http://127.0.0.1:3000` | Base URL of a running Baileys bridge (used only when `WA_PROVIDER=baileys`). |

## Webhook server (`webhook/server.js`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Container-internal listen port. Host port = `WEBHOOK_HOST_PORT` (compose). |
| `DB_PATH` | `./whatsapp.db` | SQLite database path. Compose sets `/data/whatsapp.db` (persistent volume). |

Hard limits (in code): max 40 active phone numbers, max 25 conversations/day/number (owner numbers can be exempted via `UNLIMITED_NUMBERS`).

## AI processor (`webhook/processor.js`, optional worker)

| Variable | Default | Description |
|---|---|---|
| `XIAOMI_API_KEY` | — | MiMo API key (primary LLM backend). |
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (alternative backend). |
| `LOCAL_MODEL_URL` | `http://127.0.0.1:8081/v1/chat/completions` | llama.cpp / any OpenAI-compatible local server (zero-cost). |
| `SYSTEM_PROMPT` | built-in | Bot personality + product data (name, price, stock, shipping). |
| `AUTHORIZED_NUMBERS` | — | Comma-separated WhatsApp numbers allowed to query personal data. |
| `UNLIMITED_NUMBERS` | — | Comma-separated owner numbers exempt from daily conversation limits. |
| `POLL_INTERVAL_MS` | `3000` | How often the processor polls for pending messages. |
| `POWER_TOOL_API` | `http://localhost:5557` | Worker queue API. |

## Router (`router/router.py`, `router/whatsapp_webhook.py`)

| Variable | Default | Description |
|---|---|---|
| `ROUTER_PORT` | `3002` | Task router listen port. Host port = `ROUTER_HOST_PORT` (compose). |
| `WEBHOOK_PORT` | `3003` | `whatsapp_webhook.py` forwarder listen port. |
| `BIND_HOST` | `127.0.0.1` | Bind address. Loopback by default; compose sets `0.0.0.0` **inside the container** only. |
| `LOG_FILE` | `router.log` | Log file path. Compose sends logs to stdout. |
| `POWER_TOOL_API` | `http://localhost:5557/api/dispatch` | Where routed tasks are dispatched. |
| `TELEGRAM_NOTIFY` | `http://localhost:3001/api/telegram/notify` | Notification endpoint after dispatch. |
| `WHATSAPP_GROUPS_JSON` | `{}` | Routing map: `{"<group-id>@g.us": {"client": "acme", "profile": "acme"}}`. Alternative: `router/routing.json`. |
| `TELEGRAM_CHANNELS_JSON` | `{}` | Same idea for Telegram channels. |
| `WHATSAPP_BRIDGE` | `http://127.0.0.1:3000` | Baileys bridge used by `whatsapp_poller.py`. |

## Docker Compose host ports

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_HOST_PORT` | `3001` | Host port mapped to the webhook container. Change if 3001 is taken. |
| `ROUTER_HOST_PORT` | `3002` | Host port mapped to the router container. |

## myinfo personal data hub (`webhook/myinfo.py`)

| Variable | Default | Description |
|---|---|---|
| `MYINFO_DB` | `~/.myinfo/data.db` | SQLite path for the personal data hub. |

## Endpoints reference

| Route | Auth | Purpose |
|---|---|---|
| `GET /webhook` | `hub.verify_token` | Meta subscription handshake |
| `POST /webhook` | `X-Hub-Signature-256` | Inbound WhatsApp events |
| `GET /health` | none | Liveness (used by Docker healthcheck) |
| `GET /api/messages/pending`, `POST /api/inbound`, `POST /api/messages/:id/processed`, `GET /api/conversations/:waId/messages`, `GET /api/stats`, `GET /api/limits/:waId` | `X-API-Key` | processor ↔ webhook API |
| `GET /health` (router, :3002) | none | Router liveness |
| `POST /` (router, :3002) | none — loopback-only by design | Task dispatch |
