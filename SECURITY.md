# Security Policy

## Threat model

The webhook server (`webhook/server.js`) binds to `127.0.0.1` only and is
expected to sit behind a TLS reverse proxy. It stores message history in a
local SQLite database.

| Asset | Threat | Mitigation |
|---|---|---|
| Inbound message integrity | Attacker forges `POST /webhook` payloads (fake orders, prompt injection into the AI processor) | Mandatory `X-Hub-Signature-256` HMAC-SHA256 verification of the raw body (`APP_SECRET`), constant-time compare; **fail-closed 503** if `APP_SECRET` unset |
| Webhook takeover via verify | Brute-force of `hub.verify_token` | Constant-time compare (`timingSafeEqual`); token is 32-byte hex; wrong token → 403 |
| Message history / stats leakage | Unauthenticated reads of `/api/*` (conversation content, daily usage, pending queue) | `X-API-Key` header required on all `/api/*` routes, constant-time compare; **fail-closed 503** if `API_KEY` unset; server binds loopback only |
| Clickjacking / MIME sniffing / data exfil via referrer | Browser-based attacks on any served response | Security headers on every response: CSP `default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`; `Cache-Control: no-store` on `/api` + `/webhook` |
| SQL injection | Crafted `wa_id`/params in API routes | All queries are better-sqlite3 prepared statements with bound parameters (audited — no string-concatenated SQL in `server.js`/`processor.js`); regression test injects quotes into `waId` |
| Resource exhaustion | Oversized webhook/API bodies | `express.json` limit `1mb` on all routes including `POST /webhook` |
| Information disclosure | Stack traces / secrets in HTTP responses or logs | Central error middleware returns generic JSON only; startup banner no longer prints `VERIFY_TOKEN`; API errors never echo exception text |
| Dependency supply chain | Vulnerable or floating deps | Exact-pinned `package.json` versions + lockfile; CI runs `npm ci`, `npm audit --audit-level=high`, gitleaks; actions pinned to full commit SHAs |

## Configuration (fail-closed by design)

| Env var | Protects | Behaviour when unset |
|---|---|---|
| `VERIFY_TOKEN` | GET /webhook hub.challenge | Server refuses to start |
| `APP_SECRET` | POST /webhook signature | `POST /webhook` returns **503** (no unverified payload is ever processed) |
| `API_KEY` | all `/api/*` routes | every `/api/*` route returns **503** (`/health` stays open) |

**Migration note:** deployments upgrading from a pre-hardening build must set
`APP_SECRET` (Meta App Dashboard → App settings → Basic → App secret) and a
generated `API_KEY` (`openssl rand -hex 32`) in `webhook/.env`, and add the
`X-API-Key` header to internal callers (processor/bridge), before restart.

## Reporting a vulnerability

Open a private security advisory on the repository (Security → Report a
vulnerability). Do not file public issues for live vulnerabilities.
