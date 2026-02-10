---
name: cloudSyncService
description: Polling-based sync service mirroring an iCloud shared album to Amazon Photos for Echo Show display
argument-hint: Sync configuration, debugging, or feature changes
---

# alexa-photos — iCloud → Amazon Photos Sync Service

A polling-based sync service that mirrors an iCloud shared album to Amazon Photos, so an Echo Show displays photos via its native photo frame experience.

## Architecture

```
Data flow: iCloud Shared Album → SyncEngine → Amazon Photos (Echo Show album)
State: SQLite tracks icloud_id ↔ amazon_id mappings

src/
├── icloud/client.ts      # iCloud shared album public API (no auth required)
├── icloud/test.ts        # Standalone test script for iCloud fetch
├── amazon/client.ts      # Amazon Photos REST API (cookie-based auth)
├── amazon/login.ts       # Interactive CLI to save browser cookies
├── sync/engine.ts        # Set-based diff → add/remove photos
├── state/store.ts        # SQLite: icloud_id ↔ amazon_id mappings
├── lib/config.ts         # Zod-validated env config
├── lib/logger.ts         # pino structured logging
├── lib/notifications.ts  # Optional alerting (webhook + Pushover)
└── index.ts              # Entry point with polling loop + graceful shutdown
```

## Platform Clients

### ICloudClient (`src/icloud/client.ts`)

- **Auth**: None — uses public shared album API
- **Partition discovery**: POST to `p01-sharedstreams.icloud.com`, follow 330 redirect via `X-Apple-MMe-Host` header
- **Endpoints**: `/webstream` (metadata + photo GUIDs), `/webasseturls` (download URLs)
- **Date parsing**: Handles both ISO strings and Apple epoch (seconds since 2001-01-01)
- **Retry logic**: Exponential backoff with jitter for photo downloads (configurable via `ICLOUD_DOWNLOAD_MAX_RETRIES`, default: 3)
- **Output**: `ICloudPhoto[]` with id, checksum, url, dimensions, dateCreated

### AmazonClient (`src/amazon/client.ts`)

- **Auth**: Cookie-based — cookies extracted from browser session, stored in `./data/amazon-cookies.json`
- **Ported from**: [trevorhobenshield/amazon_photos](https://github.com/trevorhobenshield/amazon_photos) Python library
- **Base URL**: `https://www.amazon.{tld}/drive/v1`
- **Upload endpoint**: `https://content-{region}.drive.amazonaws.com/cdproxy/nodes` (binary POST)
- **Base params**: `{ asset: 'ALL', tempLink: 'false', resourceVersion: 'V2', ContentType: 'JSON' }`
- **TLD detection**: Auto-detected from cookie key names — `at-main` / `at_main` → US (`com`), `at-acb{tld}` → international
- **Required US cookies**: `session-id`, `ubid-main`, `at-main`, `x-main`, `sess-at-main`, `sst-main` (hyphen-based names)
- **Key API operations**:
  - `checkAuth()` → GET `/account/info`
  - `getRoot()` → GET `/nodes?filters=isRoot:true`
  - `getNodes(filters)` → GET `/nodes` (supports `kind:`, `status:`, `name:` filters)
  - `search(filters)` → GET `/search` (supports `type:`, `things:`, `time:`, `location:` — NOT `kind:`)
  - `findAlbum(name)` → fetches all `kind:VISUAL_COLLECTION` nodes, filters locally (multi-word names break API filter)
  - `createAlbum(name)` → POST `/nodes` with `kind: VISUAL_COLLECTION`
  - `uploadPhoto(buffer, filename)` → POST to cdproxy (handles 409 duplicate)
  - `addToAlbum()` / `removeFromAlbum()` → PATCH `/nodes/{albumId}/children` with `op: add|remove`
  - `trash()` → PATCH `/trash` (batched, max 50)
  - `purge()` → POST `/bulk/nodes/purge`
  - `deleteNodes()` → trash then purge
- **Retry**: Exponential backoff with jitter, up to 3 retries. 401 → immediate auth error. 409 → conflict (duplicate), not an error.
- **Bot detection**: Datacenter IPs may get 503 from Amazon; works from residential networks.

### SyncEngine (`src/sync/engine.ts`)

- **Diffing**: Set-based — compare iCloud photo GUIDs vs stored mappings
- **Additions**: download from iCloud → upload to Amazon → add to album → save mapping
- **Removals**: remove from album → trash → purge → delete mapping
- **Lazy init**: Amazon client created only when there's work to do
- **Concurrency guard**: `isRunning` flag prevents overlapping runs
- **Album**: Found or created on first sync via `findOrCreateAlbum()`

### StateStore (`src/state/store.ts`)

- **SQLite** via `better-sqlite3`
- **Table**: `photo_mappings` (icloud_id PK, icloud_checksum, amazon_id, synced_at)
- **Indexes**: `amazon_id`, `icloud_checksum`

## Configuration

All env vars validated with Zod in `src/lib/config.ts`:

| Variable                      | Required | Default                      | Description                                   |
| ----------------------------- | -------- | ---------------------------- | --------------------------------------------- |
| `ICLOUD_ALBUM_TOKEN`          | ✅       | —                            | Shared album token from iCloud URL            |
| `ICLOUD_DOWNLOAD_MAX_RETRIES` | ❌       | `3`                          | Max retry attempts for photo downloads        |
| `AMAZON_COOKIES_PATH`         | ❌       | `./data/amazon-cookies.json` | Path to cookies JSON                          |
| `AMAZON_ALBUM_NAME`           | ❌       | `Echo Show`                  | Target album name in Amazon Photos            |
| `AMAZON_AUTO_REFRESH_COOKIES` | ❌       | `true`                       | Auto-refresh auth cookies on 401              |
| `SYNC_DELETIONS`              | ❌       | `true`                       | Delete from Amazon when removed from iCloud   |
| `POLL_INTERVAL_SECONDS`       | ❌       | `60`                         | Polling interval (converted to ms internally) |
| `LOG_LEVEL`                   | ❌       | `info`                       | pino log level                                |
| `ALERT_WEBHOOK_URL`           | ❌       | —                            | Optional JSON webhook for alerts              |
| `PUSHOVER_TOKEN`              | ❌       | —                            | Optional Pushover app token                   |
| `PUSHOVER_USER`               | ❌       | —                            | Optional Pushover user key                    |

## Development Workflow

```bash
# Install dependencies
npm install

# Test iCloud fetch (validates album token + partition discovery)
ICLOUD_ALBUM_TOKEN=xxx npm run icloud:test

# Save Amazon cookies (interactive CLI, one-time setup)
npm run amazon:setup

# Test notifications (webhook and/or Pushover) using .env
npm run notifications:test

# Run sync service in watch mode
npm run dev

# Build for production
npm run build && npm start
```

## Production Deployment

- **Dockerfile**: `node:20-slim` — no browser dependencies needed
- **docker-compose.yml**: Mounts `./data` volume, reads `.env`, restarts unless stopped
- **Persistent state**: `./data/` directory contains SQLite DB + cookies file — mount as volume
- **Cookie expiry**: Service attempts auto-refresh using `sess-at-main`/`sst-main`. If refresh fails, it can alert via webhook/Pushover and you'll need to re-run `npm run amazon:setup`.

## Key Design Decisions

1. **REST API over Playwright**: Playwright couldn't run headless in devcontainer (no X server) and wasn't viable for always-on Docker. Ported the undocumented Amazon Drive v1 API from the Python `amazon_photos` library instead.
2. **Cookie auth over OAuth**: Amazon Photos has no public OAuth API. Browser cookies with `x-amzn-sessionid` header work reliably.
3. **Polling over webhooks**: iCloud public shared album API has no webhook/push support. Polling is the only option.
4. **Native photo frame**: Using Amazon Photos album directly so Echo Show uses its built-in photo frame UX — not APL widgets or custom skills.
5. **Local album filter**: The `/nodes` API `name:` filter breaks on multi-word names. We fetch all albums and filter locally.

## Known Issues / Gotchas

- **Bot detection 503**: Amazon returns 503 from datacenter IPs (cloud VMs, GitHub Codespaces). Works fine from residential IPs.
- **Cookie key format**: Browser DevTools shows hyphens (`at-main`), some libraries use underscores (`at_main`). TLD detection handles both.
- **`/search` vs `/nodes`**: The `/search` endpoint does NOT support `kind:` filter (returns 400). Use `/nodes` for album queries.
- **iCloud partition**: Must follow the 330 redirect on first request to discover the correct `pXX-sharedstreams.icloud.com` host.
- **Date parsing**: iCloud API returns ISO strings for some photos, Apple epoch timestamps for others. Client handles both.

## TODOs / Next Steps

- [x] **Write tests**: 86 tests passing across 5 test files (ICloudClient, AmazonClient, StateStore, SyncEngine, login helpers)
- [x] **Retry on download failures**: iCloud downloads now retry with exponential backoff (configurable via `ICLOUD_DOWNLOAD_MAX_RETRIES`)
- [x] **Optional deletion sync**: Set `SYNC_DELETIONS=false` for append-only mode
- [x] **CI pipeline**: GitHub Actions and Gitea workflows to lint, type-check, and run tests on push
- [x] **Cookie refresh automation**: Automatically refreshes Amazon `at-main` token using `sess-at-main`/`sst-main` session cookies when 401 is encountered
- [x] **Metrics / health endpoint**: HTTP endpoints `/health` and `/metrics` for Docker health checks and monitoring. Tracks sync status, uptime, and authentication state.
- [x] **End-to-end sync test**: Run a full sync cycle against real accounts and verify photos appear on Echo Show
- [ ] **Rate limiting / throttle**: Add configurable concurrency limit for uploads (currently sequential but no explicit rate limit)
- [ ] **Checksum dedup**: Use `icloud_checksum` to avoid re-uploading identical content when a photo GUID changes (e.g. re-shared)
- [x] **Cookie expiry alerting**: Detect refresh failures and send a notification (webhook, Pushover) to re-authenticate
