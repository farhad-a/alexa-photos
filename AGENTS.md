# alexa-photos — iCloud → Amazon Photos Sync Service

A polling-based sync service that mirrors an iCloud shared album to Amazon Photos for Echo Show display.

## Architecture Overview

**Data flow**: iCloud Shared Album → SyncEngine → Amazon Photos (Echo Show album)
**State tracking**: SQLite maintains `icloud_id ↔ amazon_id` mappings

```
src/
├── icloud/client.ts      # iCloud shared album public API (no auth)
├── amazon/client.ts      # Amazon Photos REST API (cookie-based auth)
├── sync/engine.ts        # Orchestrates diff detection and sync operations
├── state/store.ts        # SQLite mappings: icloud_id ↔ amazon_id
├── server/
│   ├── index.ts          # AppServer: health, metrics, mappings API, cookies API
│   └── static.ts         # Static file serving + SPA fallback
└── lib/
    ├── config.ts         # Zod-validated env config
    ├── logger.ts         # Pino structured logging
    └── notifications.ts  # Webhook/Pushover alerting

web/
├── src/pages/Home.tsx     # Admin landing page
├── src/pages/Mappings.tsx # Photo mappings UI
└── src/pages/Cookies.tsx  # Amazon cookie management UI
```

## Key Patterns & Conventions

### Configuration
- **All config via environment variables**, validated with **Zod** in [src/lib/config.ts](src/lib/config.ts)
- Use `z.coerce` for numbers from env vars
- Export singleton `config` object, not factory functions

### Logging
- Use **pino** structured logging throughout
- Always include context objects: `logger.info({ photoId, amazonId }, "message")`
- **Child loggers**: Each module creates `rootLogger.child({ component: "..." })` — filter by component in production
- **Error serializer**: Custom `serializers: { error: pino.stdSerializers.err }` ensures `{ error }` objects serialize stack/message/code (not `{}`)
- **Test mocks**: Logger mocks must include `child()` — use `vi.hoisted()` to hoist the mock above `vi.mock()` factory

### Notifications
- Optional alerting via `ALERT_WEBHOOK_URL` or `PUSHOVER_TOKEN`/`PUSHOVER_USER`
- Implementation in [src/lib/notifications.ts](src/lib/notifications.ts)
- **Throttling**: Duplicate alerts throttled to 1 per hour (prevents spam on repeated errors)
- Cookie refresh failures trigger alerts via callback from SyncEngine → AmazonClient

## Platform Clients

### ICloudClient ([src/icloud/client.ts](src/icloud/client.ts))
- **Auth**: None — uses public shared album API
- **Partition discovery**: POST to `p01-sharedstreams.icloud.com`, follow 330 redirect via `X-Apple-MMe-Host` header
- **Date parsing**: Handles both ISO strings and Apple epoch (seconds since 2001-01-01)
- **Retry logic**: Exponential backoff with jitter for downloads (configurable via `ICLOUD_DOWNLOAD_MAX_RETRIES`, default: 3)

### AmazonClient ([src/amazon/client.ts](src/amazon/client.ts))
- **Auth**: Cookie-based — cookies stored in `./data/amazon-cookies.json`
- **Ported from**: [trevorhobenshield/amazon_photos](https://github.com/trevorhobenshield/amazon_photos) Python library
- **Base URL**: `https://www.amazon.{tld}/drive/v1`
- **Upload endpoint**: `https://content-na.drive.amazonaws.com/cdproxy/nodes`
- **Base params**: `{ asset: 'ALL', tempLink: 'false', resourceVersion: 'V2', ContentType: 'JSON' }`
- **TLD detection**: Auto-detected from cookie key names (`at-main`/`at_main` → US, `at-acb{tld}` → intl)
- **Required US cookies**: `session-id`, `ubid-main`, `at-main`, `x-main`, `sess-at-main`, `sst-main`
- **Retry**: Exponential backoff with jitter, up to 3 retries. 401 → immediate auth error. 409 → conflict (duplicate), not an error.

### SyncEngine ([src/sync/engine.ts](src/sync/engine.ts))
- **Dependency injection**: Accepts `StateStore` via constructor — shared with `AppServer` for admin APIs
- **Diffing**: Set-based — compare iCloud photo GUIDs vs stored mappings
- **Additions**: Check checksum for existing content → if found, reuse Amazon node + add to album → else download → upload → add to album → save mapping
- **Checksum dedup**: Queries `StateStore.getMappingByChecksum()` before uploading — avoids re-uploading when photo GUID changes but content is identical
- **Deletions** (if `SYNC_DELETIONS=true`): remove from album → trash → purge → delete mapping
- **Append-only mode**: `SYNC_DELETIONS=false` preserves all photos in Amazon
- **Rate limiting**: Optional `UPLOAD_DELAY_MS` adds delay between uploads
- **Auth freshness on every poll**: `checkAuth()` runs each sync cycle so `metrics.amazonAuthenticated` stays current even on no-op syncs
- **Lazy work initialization**: Album lookup/work paths only execute when add/remove work exists
- **Concurrency guard**: `isRunning` flag prevents overlapping runs
- **Error handling**: Per-photo errors are caught in the run loop (not inside `addPhoto`) so `photosAdded`/`photosFailed` counts are accurate
- **Sync summary**: "Sync complete" log includes `{ durationMs, photosAdded, photosFailed, photosRemoved }`
- **No resync on external delete**: If a photo is deleted from Amazon Photos directly, the mapping still exists — the engine skips it. Delete the mapping via the admin UI to force a resync

### StateStore ([src/state/store.ts](src/state/store.ts))
- **SQLite** via `better-sqlite3`
- **Shared singleton**: Created in `index.ts`, injected into both `SyncEngine` and `AppServer`
- **Table**: `photo_mappings` (icloud_id PK, icloud_checksum, amazon_id, synced_at)
- **Indexes**: `amazon_id`, `icloud_checksum`
- **Key methods**: `getMappingByChecksum()` for deduplication, `getMappingsPaginated()` for UI, `removeMappings()` for bulk delete

## Development Workflow

```bash
# Test iCloud fetch (validates album token)
ICLOUD_ALBUM_TOKEN=xxx npm run icloud:test

# Save Amazon cookies (interactive, one-time)
npm run amazon:setup

# Run sync service in watch mode
npm run dev

# Frontend dev/build
npm run web:dev
npm run web:build

# Test notifications (webhook and/or Pushover)
npm run notifications:test

# Run tests
npm test

# Run full CI checks locally (backend build + frontend build + format + lint + test)
npm run ci
```

## Deployment

- **Docker**: `node:25-slim` base image (no browser dependencies needed)
- **Persistent state**: `./data/` directory contains SQLite DB + cookies file — mount as volume
- **Cookie expiry**: Service auto-refreshes using `sess-at-main`/`sst-main`. If refresh fails, alerts via webhook/Pushover
- **Health endpoints**: `/health` and `/metrics` for Docker health checks and monitoring
- **Admin UI**: `http://localhost:3000/` — React UI served by backend (`web/dist`)
  - Home dashboard (`/`) with links to feature pages
  - Photo mappings (`/mappings`): search, paginate, single-delete, bulk-delete
  - Amazon cookies (`/cookies`): view/save/test auth cookies
- **Auth metric behavior**: `amazonAuthenticated` refreshes each sync cycle and is updated immediately by `/api/cookies/test`

## Important Notes & Gotchas

- **Bot detection**: Amazon may return 503 from datacenter IPs (cloud VMs, Codespaces) — works fine from residential IPs
- **iCloud polling**: Public API has no webhooks — polling is the only option
- **Album filter quirk**: The `/nodes` API `name:` filter breaks on multi-word names. We fetch all albums and filter locally in `findAlbum()`
- **Search vs nodes**: The `/search` endpoint does NOT support `kind:` filter (returns 400). Use `/nodes` for album queries
- **Cookie key format**: Browser DevTools shows hyphens (`at-main`), some libraries use underscores (`at_main`). TLD detection handles both
- **Date parsing**: iCloud API returns ISO strings for some photos, Apple epoch timestamps for others. Client handles both

## Code Quality

- **ESLint**: `@typescript-eslint/no-explicit-any` is set to `warn` — use proper types (interfaces for API responses, SQLite rows, etc.) instead of `any`
- **Prettier**: Formatting enforced via `npm run format:check` in CI
- **CI**: GitHub Actions runs on Node 20 + 25 — replicate locally with `npm run ci`
- Run `npm run ci` before pushing to catch issues early

## Testing

- **148 tests** across 7 test files
- Coverage: ICloudClient, AmazonClient, StateStore, SyncEngine, login helpers, notifications, server/API endpoints
- Run with `npm test`

## Design Decisions

1. **REST API over Playwright**: Playwright couldn't run headless in devcontainer. Ported undocumented Amazon Drive v1 API from Python library instead.
2. **Cookie auth over OAuth**: Amazon Photos has no public OAuth API. Browser cookies work reliably.
3. **Polling over webhooks**: iCloud has no webhook/push support.
4. **Native photo frame**: Uses Amazon Photos album directly so Echo Show uses built-in photo frame UX.
5. **Local album filter**: API `name:` filter breaks on multi-word names — fetch all, filter locally.
