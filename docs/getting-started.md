# Getting Started — WhatsApp AI Automation

Goal: a running webhook + router stack in ~10 minutes with Docker, then connected to WhatsApp in ~30.

## Requirements

- Docker + Docker Compose (recommended)
- OR native: Node.js 18+ and Python 3.10+
- A Meta developer account (only needed to receive real WhatsApp traffic — see [Meta Cloud API setup](meta-cloud-api-setup.md))

## Quickstart (Docker — recommended)

```bash
git clone https://github.com/mohdhafizi83/whatsapp-ai-automation.git
cd whatsapp-ai-automation
cp .env.example .env
```

Edit `.env` and set the three required secrets (the server refuses to start without them — fail-closed):

```bash
VERIFY_TOKEN="$(openssl rand -hex 32)"   # paste the output into .env
APP_SECRET="***"     # from Meta App Dashboard → Settings → Basic
API_KEY="$(open…x 32)"   # paste the output into .env
```

Then start the stack:

```bash
docker compose up -d --build
docker compose ps        # both services should be "healthy"
```

Verify:

```bash
curl http://localhost:3001/health   # webhook → {"status":"ok",...}
curl http://localhost:3002/health   # router  → {"status":"healthy","service":"task-router"}
```

If ports 3001/3002 are taken on your host, set `WEBHOOK_HOST_PORT` / `ROUTER_HOST_PORT` in `.env` before `docker compose up`.

Next step: connect real WhatsApp traffic with the [Meta Cloud API setup guide](meta-cloud-api-setup.md).

## Running without Docker

```bash
# Webhook (Node 18+)
cd webhook
cp ../.env.example .env      # fill VERIFY_TOKEN / APP_SECRET / API_KEY
npm ci
node server.js               # listens on PORT (default 3001)

# Router (Python 3.10+) — separate terminal
cd router
pip install -r requirements.txt
python router.py             # listens on ROUTER_PORT (default 3002, loopback-only)
```

The AI reply worker (`webhook/processor.js`) is optional — see [configuration.md](configuration.md) for its LLM keys.

## Verify it works (no WhatsApp account needed)

The webhook rejects everything unverified, which is exactly what you want to confirm:

```bash
# Unsigned POST must be rejected:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3001/webhook \
  -H 'Content-Type: application/json' -d '{"object":"whatsapp_business_account"}'
# → 401

# Health endpoint is always open:
curl -s http://localhost:3001/health
# → {"status":"ok",...}
```

## Next

- [Meta Cloud API setup](meta-cloud-api-setup.md) — click-by-click guide to get real messages flowing
- [Configuration](configuration.md) — every environment variable
- [Troubleshooting](troubleshooting.md) — common failures
- [SECURITY.md](../SECURITY.md) — threat model and fail-closed behavior

## Teardown

```bash
docker compose down          # stop containers
docker compose down -v       # also delete the SQLite volume (wipes message history)
```
