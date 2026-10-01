# Notes for AI agents

Casierul clasei is a self-hosted PWA for a school class treasury: a Node.js 24+ server (`server/`) with SQLite via `node:sqlite`, a dependency-free web app (`web/`), PDF reports with PDFKit. The interface and most docs are Romanian; code and these notes are English.

## Deploying, upgrading or rolling back

Follow [.claude/skills/deploy/SKILL.md](.claude/skills/deploy/SKILL.md) step by step. It covers fact-gathering, systemd and Docker installs, the reverse proxy, verification, the first invitation, upgrades, backups and rollback, and the rules that protect production data and secrets. Do not improvise a deployment from the README alone.

## Changing code

- `npm ci && npm test` before and after a change; CI runs the same on every pull request, plus a Docker build and smoke test.
- Web app changes: also run `node scripts/browser-check.mjs` against headless Chromium on port 9222 (see `CONTRIBUTING.md`).
- Money is integer bani (`…Minor` fields), never floating point.
- `server/ledger.mjs` is append-only: corrections are new transactions, never updates or deletes (enforced by SQLite triggers). Every mutation goes through `dispatch()` with `requestId` and `expectedRevision`.
- Schema changes are migrations that run on open and must keep older code able to read the database; add a test that opens a database in the old shape.
- User-facing text is Romanian with diacritics; escape everything interpolated into HTML with `esc()`.
- Do not add runtime dependencies or CDN resources.

More detail: `CONTRIBUTING.md`, `SECURITY.md`, `docs/api.md`, `docs/operations.md`.
