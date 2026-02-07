# Copilot Instructions for alexa-photos

## Architecture Overview

This is a **polling-based sync service** that mirrors an iCloud shared album to Amazon Photos for Echo Show display. Data flows: iCloud → SyncEngine → Amazon Photos, with SQLite tracking mappings.

```
src/
├── icloud/client.ts   # Fetches from iCloud shared album public API (no auth)
├── amazon/client.ts   # Playwright browser automation (session-based auth)
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
  - Partition logic in `getPartition()` — Apple shards by token prefix
- **AmazonClient**: Stateful Playwright automation
  - Session persisted to `./data/amazon-session/state.json`
  - Lazy initialization — only starts browser when sync work exists
  - **Selectors are placeholders** — need updating based on actual Amazon Photos UI

### Sync Logic (`SyncEngine`)
- Set-based diffing: compare iCloud photo IDs vs stored mappings
- Additions: download from iCloud → upload to Amazon → save mapping
- Deletions: delete from Amazon → remove mapping
- Guard against concurrent runs with `isRunning` flag

### Logging
- Use **pino** structured logging throughout
- Always include context objects: `logger.info({ photoId, amazonId }, "message")`

## Development Workflow

```bash
# Test iCloud fetch (validates album token)
ICLOUD_ALBUM_TOKEN=xxx npm run icloud:test

# Interactive Amazon login (one-time, saves session)
npm run amazon:login

# Run sync service in watch mode
npm run dev
```

## Important Notes

- **Amazon automation is fragile** — UI selectors in `amazon/client.ts` need real values
- State persists in `./data/` (SQLite DB + browser session) — mount this volume in Docker
- iCloud public API has no webhooks — polling is the only option
