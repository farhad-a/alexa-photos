# Copilot Instructions for alexa-photos

## Architecture Overview

This is a **polling-based sync service** that mirrors an iCloud shared album to Amazon Photos for Echo Show display. Data flows: iCloud → SyncEngine → Amazon Photos, with SQLite tracking mappings.

```
src/
├── icloud/client.ts   # Fetches from iCloud shared album public API (no auth)
├── amazon/client.ts   # Amazon Photos REST API client (cookie-based auth)
├── sync/engine.ts     # Orchestrates diff detection and sync operations
├── state/store.ts     # SQLite mappings: icloud_id ↔ amazon_id
└── lib/               # Config (Zod), logging (pino)
```

## Key Patterns

### Configuration

- All config via environment variables, validated with **Zod** in `src/lib/config.ts`
- Use `z.coerce` for numbers from env vars
- Export singleton `config` object, not factory functions

### Platform Clients

- **ICloudClient**: Stateless, uses public shared album API endpoints
  - Partition discovery via 330 redirect with `X-Apple-MMe-Host` header
- **AmazonClient**: REST API client using Amazon Drive v1 endpoints
  - Auth via cookies stored in `./data/amazon-cookies.json`
  - Base URL: `https://www.amazon.{tld}/drive/v1`
  - Upload via cdproxy: `https://content-na.drive.amazonaws.com/cdproxy/nodes`
  - Base params: `{ asset: 'ALL', tempLink: 'false', resourceVersion: 'V2', ContentType: 'JSON' }`
  - Auto-detects TLD from cookie key names (US: `_main`, intl: `at-acb{tld}`)

### Sync Logic (`SyncEngine`)

- Set-based diffing: compare iCloud photo IDs vs stored mappings
- Additions: download from iCloud → upload to Amazon → add to album → save mapping
- Deletions: remove from album → trash → purge → remove mapping
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
```

## Important Notes

- State persists in `./data/` (SQLite DB + cookies file) — mount this volume in Docker
- Amazon cookies expire periodically — re-run `npm run amazon:setup` when needed
- iCloud public API has no webhooks — polling is the only option
- Dockerfile uses `node:20-slim` (no browser dependencies needed)
