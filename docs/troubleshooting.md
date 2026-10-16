# Troubleshooting — WhatsApp AI Automation

## Docker

**Container restarts immediately (`wa-webhook`)**
`server.js` is fail-closed — it exits when `VERIFY_TOKEN` is empty. Check:
```bash
docker compose logs webhook | head
# "FATAL: VERIFY_TOKEN env var is required" → fill it in .env
```

**Port already allocated**
3001 or 3002 is taken on the host. Set `WEBHOOK_HOST_PORT` / `ROUTER_HOST_PORT` in `.env` and re-run `docker compose up -d`.

**Router unhealthy**
`docker compose logs router` — most common cause is an unwritable `LOG_FILE`; compose already sets it to stdout.

## Webhook

**Meta "Verify and save" fails**
- `VERIFY_TOKEN` in `.env` must byte-match Meta's form (no quotes, no trailing space).
- Callback URL must be public HTTPS on 443/443-equivalent. Test from outside: `curl https://your-url/health`.
- Check server logs for `[VERIFY] ❌ Verification failed` (token mismatch) vs no request at all (network/TLS problem).

**POST /webhook returns 401**
`APP_SECRET` wrong or Meta signed with a different app's secret. It is App Dashboard → Settings → **Basic → App Secret** — not an access token.

**POST /webhook returns 503**
`APP_SECRET` not set on the server (fail-closed). Set it and restart.

**/api/* returns 503**
`API_KEY` not set on the server (fail-closed). Set it and restart; send it as `X-API-Key` header.

**200 from POST but nothing stored**
The `messages` webhook field isn't subscribed (Configuration → Webhook fields → messages → Subscribed), or the payload isn't a `messages` change.

## WhatsApp API

**Messages not sent back**
Check `WHATSAPP_TOKEN` (expired temporary token?) and `WHATSAPP_PHONE_ID` in `.env`; watch `docker compose logs -f webhook` while sending a test message — Meta API errors are logged there.

**"Re-authorization requested" / token invalid**
Temporary tokens expire in ~24h. Create a permanent system-user token (see [Meta setup guide](meta-cloud-api-setup.md), Part 3).

## Native (no Docker)

**`better-sqlite3` build error on install**
You need Node 18+ with a matching prebuilt binary; if building from source: `python3`, `make`, `g++` must be installed.

**Router not reachable from webhook**
Router binds `127.0.0.1` by default — that's correct on one machine. Across machines, keep it loopback and tunnel/SSH-port-forward instead of setting `BIND_HOST=0.0.0.0` (the router has no auth).
