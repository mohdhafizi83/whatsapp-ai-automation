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

**Flow:** WhatsApp message → webhook/processor (AI reply) or router (task dispatch to a worker queue) → response back via your configured provider (Meta Cloud API or Baileys bridge).

## WhatsApp Provider: Official vs Unofficial

Set `WA_PROVIDER` to choose how the stack connects to WhatsApp:

| | `meta` (official) | `baileys` (unofficial) |
|---|---|---|
| Connection | WhatsApp Business Cloud API (graph.facebook.com) | Local bridge + QR pairing with your phone |
| Cost | Per-conversation pricing (Meta) | Free |
| Number type | Business number (Meta-verified) | Any personal number |
| Interactive lists / buttons | ✅ Native | ⚠️ Rendered as numbered text menu |
| Webhook push | ✅ Meta pushes to `/webhook` | ❌ Bridge must POST to `/api/inbound` |
| Media download | Via Meta media API | Bridge downloads locally, paths passed through |
| Ban risk | Low (official) | Present — unofficial protocol, use at your own risk |
| Approval | Business verification required | None |

### Meta Cloud API (default)

1. Create a WhatsApp Business app at developers.facebook.com
2. Set `WA_PROVIDER=meta`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`
3. Point Meta's webhook at your `GET/POST /webhook` (verify token = `VERIFY_TOKEN`)
4. Everything works natively: text, media, interactive lists, read receipts

### Baileys (unofficial bridge)

1. Run any Baileys-based bridge that exposes:
   - `POST /send {chatId, message}` → `{messageId}`
   - an event stream/queue of inbound events
2. Set `WA_PROVIDER=baileys` and `BAILEYS_BRIDGE=http://127.0.0.1:3000`
3. Wire the bridge to push inbound events into this stack:
   `POST http://<webhook-server>:3001/api/inbound` with the bridge event JSON
   (`messageId, chatId, senderId, senderName, body, hasMedia, mediaType, mime, fileName, mediaUrls[]`)
4. Outbound replies go through the bridge automatically; interactive lists
   degrade gracefully to numbered text menus

The rest of the pipeline (processor, LLM backends, limits, router, myinfo)
is identical for both providers — only the transport layer changes.

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
cp .env.example .env    # set WA_PROVIDER=meta (Cloud API creds) or
                        # WA_PROVIDER=baileys (BAILEYS_BRIDGE URL)
node server.js          # webhook server (also accepts /api/inbound for Baileys)
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

## Deployment Topologies

Every inter-component URL is an environment variable, so the stack can be
deployed in two layouts.

### 1. Consolidated topology (single VPS / dedicated server — recommended)

**Requirement: a VPS or dedicated server you fully control.**
This stack needs long-running daemons (webhook server, processor,
router, poller), systemd services, and optionally a local llama.cpp
server for zero-cost LLM replies. Shared hosting CANNOT run it.

```
WhatsApp/Meta Cloud ──HTTPS──▶ [VPS]
   nginx/Caddy (TLS, :443)
        └─▶ webhook server.js   127.0.0.1:3001   (Meta verify + ingest)
              └─▶ processor.js                   (AI reply pipeline)
                    └─▶ LLM: MiMo / DeepSeek / local llama.cpp

   Optional task flow (zero-LLM routing):
   whatsapp_webhook.py :3003 ──▶ router.py :3002 ──▶ worker queue
   whatsapp_poller.py ──▶ Baileys bridge :3000 (unofficial API)
```

Env (single box — everything points at 127.0.0.1):
```
# webhook/
VERIFY_TOKEN=*** rand -hex 32)
WHATSAPP_TOKEN=*** Cloud API token>
WHATSAPP_PHONE_ID=<id>
XIAOMI_API_KEY=*** DEEPSEEK_API_KEY=*** LOCAL_MODEL_URL=http://127.0.0.1:8081/v1/chat/completions

# router/
ROUTER_PORT=3002  WEBHOOK_PORT=3003
POWER_TOOL_API=http://127.0.0.1:5557/api/dispatch
WHATSAPP_BRIDGE=http://127.0.0.1:3000
WHATSAPP_GROUPS_JSON={"<group-id>@g.us":{"client":"acme","profile":"acme"}}
```

Expose ONLY 80/443 through a reverse proxy with TLS (Meta requires HTTPS
for webhooks anyway). All internal services stay on 127.0.0.1.

### 2. Split topology (public edge separate from the brain)

Use when the WhatsApp-facing edge (webhook endpoint that Meta must reach)
lives on a different machine from your agent/worker infrastructure.

```
WhatsApp/Meta ──HTTPS──▶ [EDGE SERVER: public, DMZ]
                          webhook server.js (ingest + verify only)
                                │ forwards (outbound HTTPS, HMAC)
                                ▼
                          [BRAIN SERVER: private, no public ports]
                          processor.js / router.py / agent workers
                          (local LLM optional here)
```

Rules that make split mode safe:
- Edge holds only: `VERIFY_TOKEN`, `WHATSAPP_TOKEN`, forwarding URL/secret
- Brain holds everything else (LLM keys, worker APIs, routing maps)
- Edge → brain traffic is outbound from the edge (firewall-friendly);
  the brain never opens inbound ports
- If the edge is compromised, blast radius = WhatsApp tokens only —
  rotate them; the brain's keys never existed on the edge

For the Baileys-based flow (unofficial API), the bridge must run where
the phone is reachable — typically the brain server, with the poller
pulling from it over the private network.

### Choosing

| | Consolidated | Split |
|---|---|---|
| Server requirement | 1 VPS/dedicated (full control) | 2 boxes: public edge + private brain |
| Shared hosting possible? | No | No (edge still needs daemons) |
| Latency | lowest | +1 network hop |
| Blast radius if edge breached | whole box | WhatsApp tokens only |
| Local LLM placement | same box | brain box |
| Complexity | low | medium (2 secret domains) |

> Note: unlike the WP-based front-ends, this stack cannot use shared
> hosting for its edge because Meta's webhook needs a persistent Node
> process — a shared PHP host cannot run `server.js`.

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
