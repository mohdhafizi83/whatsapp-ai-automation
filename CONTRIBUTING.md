# Contributing

Thanks for helping improve WhatsApp AI Automation!

## Before you start

- Read [docs/getting-started.md](docs/getting-started.md) and run the stack with Docker Compose first.
- For security issues, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/mohdhafizi83/whatsapp-ai-automation.git
cd whatsapp-ai-automation
cp .env.example .env          # fill VERIFY_TOKEN / APP_SECRET / API_KEY
cd webhook && npm ci && npm test
```

Run the stack locally with `docker compose up -d --build`; logs via `docker compose logs -f`.

## Making changes

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the fail-closed guarantees: never weaken `VERIFY_TOKEN` / `APP_SECRET` / `API_KEY` enforcement, and keep default bind addresses loopback-only.
3. Add or update tests in `webhook/test/` for behavior changes (the suite uses `node:test`, no extra deps).
4. `npm test` must pass (Node 20 and 22). CI also runs `npm audit --audit-level=high` and gitleaks.
5. Update `CHANGELOG.md` under `[Unreleased]` and docs under `docs/` when behavior or configuration changes.

## Pull requests

- One logical change per PR; describe what and why.
- CI must be green.
- Release tags are cut by maintainers — don't tag your own branch.
