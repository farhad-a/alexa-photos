# Copilot Instructions for alexa-photos

## Architecture Overview

This is a **polling-based sync service** that mirrors an iCloud shared album to Amazon Photos for Echo Show display. Data flows: iCloud → SyncEngine → Amazon Photos, with SQLite tracking mappings.

```
src/
├── icloud/client.ts   # Fetches from iCloud shared album public API (no auth)
├── amazon/client.ts   # Amazon Photos REST API client (cookie-based auth)
├── sync/engine.ts     # Orchestrates diff detection and sync operations
├── state/store.ts     # SQLite mappings: icloud_id ↔ amazon_id
└── lib/               # Config (Zod), logging (pino), notifications
```

## Key Patterns

### Configuration

- All config via environment variables, validated with **Zod** in `src/lib/config.ts`
- Use `z.coerce` for numbers from env vars
- Export singleton `config` object, not factory functions

#### Notifications

- Notifications are optional and configured via env vars:
  - `ALERT_WEBHOOK_URL` (generic JSON webhook)
  - `PUSHOVER_TOKEN` / `PUSHOVER_USER` (native Pushover)
- Implementation lives in `src/lib/notifications.ts` (`NotificationService`)
- **Throttling**: Duplicate alerts throttled to 1 per hour — prevents notification spam on repeated errors
- Cookie refresh failures trigger alerts via a callback wired from `SyncEngine` → `AmazonClient`

### Platform Clients

- **ICloudClient**: Stateless, uses public shared album API endpoints
  - Partition discovery via 330 redirect with `X-Apple-MMe-Host` header
  - Photo downloads with exponential backoff retry (configurable max retries)
  - Date parsing handles both ISO strings and Apple epoch (seconds since 2001-01-01)
- **AmazonClient**: REST API client using Amazon Drive v1 endpoints
  - Auth via cookies stored in `./data/amazon-cookies.json`
  - Base URL: `https://www.amazon.{tld}/drive/v1`
  - Upload via cdproxy: `https://content-na.drive.amazonaws.com/cdproxy/nodes`
  - Base params: `{ asset: 'ALL', tempLink: 'false', resourceVersion: 'V2', ContentType: 'JSON' }`
  - Auto-detects TLD from cookie key names (US: `at-main`/`at_main`, intl: `at-acb{tld}`)
  - Required US cookies: `session-id`, `ubid-main`, `at-main`, `x-main`, `sess-at-main`, `sst-main`

### Sync Logic (`SyncEngine`)

- Set-based diffing: compare iCloud photo IDs vs stored mappings
- Additions: download from iCloud → upload to Amazon → add to album → save mapping
- Deletions (if `SYNC_DELETIONS=true`): remove from album → trash → purge → remove mapping
- Append-only mode: `SYNC_DELETIONS=false` preserves all photos in Amazon, even when removed from iCloud
- Rate limiting: Optional `UPLOAD_DELAY_MS` adds delay between uploads to prevent API overload
- Guard against concurrent runs with `isRunning` flag
- Lazy initialization — only creates Amazon client when sync work exists

### Logging

- Use **pino** structured logging throughout
- Always include context objects: `logger.info({ photoId, amazonId }, "message")`

## Development Workflow

```bash
# Test iCloud fetch (validates album token)
ICLOUD_ALBUM_TOKEN=xxx npm run icloud:test

# Save Amazon cookies (interactive, one-time)
npm run amazon:setup

# Run sync service in watch mode
npm run dev

# Test notifications (webhook and/or Pushover) using .env
npm run notifications:test
```

## Important Notes

- State persists in `./data/` (SQLite DB + cookies file) — mount this volume in Docker
- Amazon cookies expire periodically — re-run `npm run amazon:setup` when needed
- iCloud public API has no webhooks — polling is the only option
- Dockerfile uses `node:20-slim` (no browser dependencies needed)
- Amazon may return 503 from datacenter IPs (cloud VMs, Codespaces) — works fine from residential IPs
