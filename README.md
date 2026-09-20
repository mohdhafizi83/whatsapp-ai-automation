# WhatsApp AI Automation

A self-hosted WhatsApp automation stack: webhook ingestion, an AI reply processor, a zero-LLM task router, and a personal data hub — everything runs on your own server.

## Components

```
┌─────────────────────────────────────────────────────────────┐
│  webhook/                                                   │
│  ├── server.js      WhatsApp Business API webhook (Express)  │
│  │                  - Meta verification (timing-safe)        │
│  │                  - conversation persistence (SQLite)      │
│  │                  - media download, rate/abuse limits      │
│  ├── processor.js   AI auto-reply pipeline (Node)           │
│  │                  - keyword routing (product/demo/task)    │
│  │                  - LLM backends: MiMo, DeepSeek, local    │
│  │                  - daily conversation limits              │
│  └── myinfo.py      Personal data hub CLI (SQLite, local)   │
├─────────────────────────────────────────────────────────────┤
│  router/                                                    │
│  ├── router.py            Zero-LLM message router (<100ms)   │
│  ├── whatsapp_poller.py   Bridge poller + dispatcher         │
│  └── whatsapp_webhook.py  Inbound → router forwarder        │
└─────────────────────────────────────────────────────────────┘
```

**Flow:** WhatsApp message → webhook/processor (AI reply) or router (task dispatch to a worker queue) → response back via WhatsApp Cloud API.

## Features

- **WhatsApp Cloud API webhook** with Meta hub verification (constant-time token compare)
- **AI auto-replies** with pluggable LLM backends (MiMo, DeepSeek, or a local llama.cpp server)
- **Keyword routing** — prefix keywords select behavior (`demo-product`, `demo-services`, `task-client`, …)
- **Abuse protection** — per-day conversation caps, phone-number limits; owner numbers configurable via env
- **Zero-LLM task router** — deterministic routing at ~0 cost, <100ms latency
- **Personal data hub** (`myinfo`) — private SQLite store queried by the assistant; data never leaves your server
- **Media handling** — inbound media downloaded and processed locally

## Setup

### 1. Webhook + processor (Node 18+)

```bash
cd webhook
npm install
cp .env.example .env    # fill in your WhatsApp Cloud API credentials
node server.js          # webhook server
node processor.js       # AI reply pipeline
```

### 2. Router (Python 3.10+)

```bash
cd router
pip install requests
ROUTER_PORT=3002 python3 router.py
python3 whatsapp_poller.py
python3 whatsapp_webhook.py
```

### 3. Routing configuration

Group/channel routing is configured via env (JSON) or a `routing.json` file next to the scripts:

```json
{
  "<whatsapp-group-id>@g.us": { "client": "acme", "profile": "acme" }
}
```

## Security

- **Fail-closed webhook verification** — server refuses to start without `VERIFY_TOKEN`; comparison is constant-time (`crypto.timingSafeEqual`)
- **No secrets in code** — all credentials via environment variables (see `webhook/.env.example`)
- **Abuse limits** — per-day conversation caps and phone-number ceilings mitigate spam/DDoS through your bot
- **Local PII** — `myinfo` data and conversation DB stay on your server; nothing is synced to third parties
- **Authorized-number gating** — personal-data queries require numbers listed in `AUTHORIZED_NUMBERS`

> ⚠️ Run behind TLS (nginx/Caddy reverse proxy). WhatsApp Cloud API requires HTTPS anyway.
> Rotate your Meta app secret and access tokens periodically.

## Requirements

- Node.js 18+ (`express`, `axios`, `better-sqlite3`, `dotenv`)
- Python 3.10+ (`requests`)
- WhatsApp Business/Cloud API access
- Optional: local llama.cpp server for zero-cost LLM replies

## License

MIT
