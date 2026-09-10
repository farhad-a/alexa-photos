# alexa-photos — iCloud → Amazon Photos Sync Service

A polling-based sync service that mirrors an iCloud shared album to Amazon Photos for Echo Show display.

## Architecture Overview

**Data flow**: iCloud Shared Album → SyncEngine → Amazon Photos (Echo Show album)
**State tracking**: SQLite maintains `icloud_id ↔ amazon_id` mappings

```
server/src/
├── icloud/client.ts      # iCloud shared album public API (no auth)
├── amazon/client.ts      # Amazon Photos REST API (cookie transport)
├── amazon/registration.ts     # Device-registration flow behind the admin UI
├── amazon/registration-proxy.ts # alexa-cookie2 wrapper (only importer)
├── amazon/credentials.ts      # Auth + session credential store
├── sync/engine.ts        # Orchestrates diff detection and sync operations
├── state/store.ts        # SQLite mappings: icloud_id ↔ amazon_id
├── server/
│   ├── index.ts          # AppServer bootstrap + HTTP wiring
│   ├── router.ts         # Route dispatcher for API + monitoring endpoints
│   ├── http.ts           # Shared request/response helpers
│   ├── static.ts         # Static file serving + SPA fallback
│   ├── types.ts          # Request context model
│   ├── controllers/      # Route handlers (health, mappings, amazon, sync)
│   └── services/         # Shared server-side service helpers
└── lib/
    ├── config.ts         # Zod-validated env config
    ├── logger.ts         # Pino structured logging
    └── notifications.ts  # Webhook/Pushover alerting

web/
├── src/pages/Home.tsx     # Admin landing page
├── src/pages/Mappings.tsx # Photo mappings UI
└── src/pages/Amazon.tsx   # Amazon account + device registration UI
```

## Key Patterns & Conventions

### Configuration

- **All config via environment variables**, validated with **Zod** in [server/src/lib/config.ts](server/src/lib/config.ts)
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
- Implementation in [server/src/lib/notifications.ts](server/src/lib/notifications.ts)
- **Throttling**: Duplicate alerts throttled (default 60 minutes, configurable via `NOTIFICATION_THROTTLE_MINUTES`; `-1` = throttle indefinitely until process restart). Per-call `skipThrottle` bypasses throttling for one-off operational events (e.g. sync summaries)
- Refresh failures trigger alerts via `NotificationService`. A rejected refresh token is a distinct, sticky state: it means the device was deregistered or the password changed, so it alerts once and asks for re-registration rather than retrying

## Platform Clients

### ICloudClient ([server/src/icloud/client.ts](server/src/icloud/client.ts))

- **Auth**: None — uses public shared album API
- **Partition discovery**: POST to `p01-sharedstreams.icloud.com`, follow 330 redirect via `X-Apple-MMe-Host` header
- **Date parsing**: Handles both ISO strings and Apple epoch (seconds since 2001-01-01)
- **Retry logic**: Exponential backoff with jitter for downloads (configurable via `ICLOUD_DOWNLOAD_MAX_RETRIES`, default: 3)

### AmazonClient ([server/src/amazon/client.ts](server/src/amazon/client.ts))

- **Auth**: Device registration. A one-time browser sign-in yields a durable `Atnr|` refresh token; the client mints its own cookies from it. Stored in `./data/amazon-auth.json` (durable, mode 0600) and `./data/amazon-session.json` (rotating cookies)
- **Ported from**: [trevorhobenshield/amazon_photos](https://github.com/trevorhobenshield/amazon_photos) Python library
- **Base URL**: `https://www.amazon.{tld}/drive/v1`
- **Upload endpoint**: `https://content-na.drive.amazonaws.com/cdproxy/nodes`
- **Base params**: `{ asset: 'ALL', tempLink: 'false', resourceVersion: 'V2', ContentType: 'JSON' }`
- **Marketplace**: Comes from the registration record. `detectTld()` survives only as a mismatch warning, which is what catches a registration made against the wrong Amazon site
- **Refresh**: Age-gated. Cookies live ~14 days, so a proactive call on a young set is a no-op; anything driven by a 401 passes `force`, and forced refreshes are throttled to one a minute to avoid tripping bot detection
- **Retry**: Exponential backoff with jitter, up to 3 retries. 401 → immediate auth error. 409 → conflict (duplicate), not an error.

### SyncEngine ([server/src/sync/engine.ts](server/src/sync/engine.ts))

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

### StateStore ([server/src/state/store.ts](server/src/state/store.ts))

- **SQLite** via `better-sqlite3`
- **Shared singleton**: Created in `index.ts`, injected into both `SyncEngine` and `AppServer`
- **Table**: `photo_mappings` (icloud_id PK, icloud_checksum, amazon_id, synced_at)
- **Indexes**: `amazon_id`, `icloud_checksum`
- **Key methods**: `getMappingByChecksum()` for deduplication, `getMappingsPaginated()` for UI, `removeMappings()` for bulk delete

## Development Workflow

```bash
# Test iCloud fetch (validates album token)
ICLOUD_ALBUM_TOKEN=xxx npm run icloud:test

# Register the device with Amazon (one-time)
# Use the web UI at /amazon

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

- **Docker**: `node:26-slim` base image (no browser dependencies needed). Multi-stage: the builder installs deps once with `--ignore-scripts`, builds, runs `npm prune --omit=dev`, and the runtime stage copies `node_modules` — one install, and no npm cache left in the final layer
- **Persistent state**: `./data/` holds the SQLite DB plus the auth and session files — mount as volume. `amazon-auth.json` is the one artifact that needs a human with a browser to recreate
- **Cookie expiry**: Cookies are minted from the device token and refreshed automatically. `COOKIE_REFRESH_INTERVAL_HOURS` (default: 12) is how often freshness is _checked_; `AMAZON_COOKIE_MAX_AGE_DAYS` (default: 7) is when a refresh actually happens. A restart re-checks age, which is what really keeps cookies alive on a box that reboots nightly
- **Login proxy**: Registration runs a temporary proxy on `AMAZON_PROXY_PORT` (default 3456). Publish it with **matching host and container ports** — the proxy rewrites Amazon's pages to embed that address. `AMAZON_PROXY_OWN_IP` is **required in Docker**: auto-detection returns the bridge address, which no browser can reach, and the proxy still appears to start
- **Health endpoints**: `/health` and `/metrics` for Docker health checks and monitoring
- **Admin UI**: `http://localhost:3000/` — React UI served by backend (`web/dist`)
  - Home dashboard (`/`) with links to feature pages
  - Photo mappings (`/mappings`): search, paginate, single-delete, bulk-delete
  - Amazon account (`/amazon`): register a device, test auth, force a refresh
- **Auth metric behavior**: `amazonAuthenticated` refreshes each sync cycle and is updated immediately by `/api/amazon/auth/test`.

## Important Notes & Gotchas

- **Bot detection**: Amazon may return 503 from datacenter IPs (cloud VMs, Codespaces) — works fine from residential IPs
- **iCloud polling**: Public API has no webhooks — polling is the only option
- **Album filter quirk**: The `/nodes` API `name:` filter breaks on multi-word names. We fetch all albums and filter locally in `findAlbum()`
- **Search vs nodes**: The `/search` endpoint does NOT support `kind:` filter (returns 400). Use `/nodes` for album queries
- **alexa-cookie2 quirks** (all confirmed live): its callback fires more than once on the proxy path — the first call is a progress notice delivered through the _error_ argument, so a naive settled-guard tears the proxy down before anyone can log in. It is CommonJS exporting a runtime-built object, so a named ESM import compiles and then throws; use the default import. And it defaults to the **German** marketplace, so marketplace options must be passed on every call, not just registration
- **Date parsing**: iCloud API returns ISO strings for some photos, Apple epoch timestamps for others. Client handles both
- **Docker `--ignore-scripts`** (don't remove): npm runs `node-gyp rebuild` for any package with a `binding.gyp`, and `node:*-slim` has no python/make/g++ — so a plain `npm ci` fails on better-sqlite3. Installing the toolchain is not the fix: better-sqlite3 v13 bundles prebuilt N-API binaries (`prebuilds/linux-{x64,arm64}.node`) and its `binding.gyp` sets both targets to `type: none` when a prebuild exists, so node-gyp compiles **nothing** either way — the toolchain adds 263MB to the builder for zero output. Only `--build-from-source` (`force_build=1`) actually compiles
- **Native module build guard**: `--ignore-scripts` fails silently, and better-sqlite3 only ships prebuilds for x64/arm64. The Dockerfile asserts the binary loads (`node -e "new (require('better-sqlite3'))(':memory:')..."`) after pruning, so a platform without a prebuild (e.g. adding `linux/arm/v7`) fails the build instead of producing a container that crashes on start. If that ever fires, add `python3 make g++` to the builder stage — that's the case where compiling is genuinely needed

## Code Quality

- **ESLint**: `@typescript-eslint/no-explicit-any` is set to `warn` — use proper types (interfaces for API responses, SQLite rows, etc.) instead of `any`
- **Prettier**: Formatting enforced via `npm run format:check` in CI
- **CI**: GitHub Actions runs on Node 24 + 26 — replicate locally with `npm run ci`
- Run `npm run ci` before pushing to catch issues early

## Testing

- Coverage: ICloudClient, AmazonClient, StateStore, SyncEngine, login helpers, notifications, server/API endpoints
- Run with `npm test`

## Design Decisions

1. **REST API over Playwright**: Playwright couldn't run headless in devcontainer. Ported undocumented Amazon Drive v1 API from Python library instead.
2. **Device registration over manual cookies**: Amazon Photos has no public OAuth API. Pasted browser cookies died within minutes because the refresh was seeded with a browser-session token rather than a durable one. Registering a device yields a real refresh token; cookies are still the transport, but they are now minted rather than copied.
3. **Polling over webhooks**: iCloud has no webhook/push support.
4. **Native photo frame**: Uses Amazon Photos album directly so Echo Show uses built-in photo frame UX.
5. **Local album filter**: API `name:` filter breaks on multi-word names — fetch all, filter locally.
