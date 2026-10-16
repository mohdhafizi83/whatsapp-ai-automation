# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-16

### Added
- Docker packaging: `Dockerfile.webhook` (Node webhook service) and `Dockerfile.router` (zero-LLM Python task router), non-root images with healthchecks.
- `docker-compose.yml` — webhook + router stack with persistent SQLite volume, healthchecks, and configurable host ports (`WEBHOOK_HOST_PORT`, `ROUTER_HOST_PORT`).
- Root `.env.example` documenting every required variable, including Meta Cloud API credentials.
- `BIND_HOST` env override for `router/router.py` and `router/whatsapp_webhook.py` (default unchanged: loopback-only).
- Docs: `docs/getting-started.md` (Docker quickstart), `docs/meta-cloud-api-setup.md` (step-by-step Meta Cloud API setup), `docs/configuration.md` (every env var).
- `CHANGELOG.md`, GitHub Release workflow (`.github/workflows/release.yml`) with GHCR image builds on `v*` tags.
- Security hardening: fail-closed `VERIFY_TOKEN` / `APP_SECRET` / `API_KEY`, timing-safe signature verification, `SECURITY.md` threat model, `node:test` regression suite.
- CI: SHA-pinned GitHub Actions — `npm ci`, `node --test` (Node 20/22 matrix), `npm audit --audit-level=high`, gitleaks.
