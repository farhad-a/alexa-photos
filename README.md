# Alexa Photos Sync

Sync photos from an iCloud shared album to Amazon Photos for display on Echo Show devices.

Uses the Amazon Photos REST API (no browser required).

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  iCloud Shared  │ ──── │   Sync Service   │ ──── │  Amazon Photos  │
│  Album (public) │ poll │   (TypeScript)   │ REST │  (Drive v1 API) │
└─────────────────┘      └──────────────────┘      └─────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   State Store    │
                         │    (SQLite)      │
                         └──────────────────┘
```

## Setup

### Prerequisites

- iCloud shared album with "Public Website" enabled
- Amazon Photos account (cookies from a browser session)
- Docker (for production) or Node.js 20+ (for development)

### Development (Devcontainer)

1. Open this folder in VS Code
2. Click "Reopen in Container" when prompted
3. Copy `.env.example` to `.env` and fill in your values
4. Run `npm run icloud:test` to verify iCloud access
5. Run `npm run amazon:setup` to save your Amazon cookies
6. Run `npm run dev` to start the sync service

### Getting Your iCloud Album Token

1. Open the Photos app on Mac/iPhone
2. Go to your shared album → Settings
3. Enable "Public Website"
4. Copy the URL (e.g., `https://www.icloud.com/sharedalbum/#ABC123DEF456`)
5. The token is the part after `#` (e.g., `ABC123DEF456`)

### Amazon Photos Cookies

The sync service authenticates to Amazon Photos via cookies (no passwords stored).

1. Log in to [Amazon Photos](https://www.amazon.com/photos) in your browser
2. Open DevTools → Application → Cookies → `www.amazon.com`
3. Run `npm run amazon:setup` and paste the three cookie values:
   - **US**: `session-id`, `ubid_main`, `at_main`
   - **International**: `session-id`, `ubid-acb{tld}`, `at-acb{tld}`
4. Cookies are saved to `./data/amazon-cookies.json`

> **Note:** Cookies expire periodically. Re-run `npm run amazon:setup` when
> the sync service reports an authentication error.

### Production Deployment

```bash
# Build and run with Docker Compose
docker compose up -d

# View logs
docker compose logs -f
```

## Commands

| Command                | Description                      |
| ---------------------- | -------------------------------- |
| `npm run dev`          | Start sync service in watch mode |
| `npm run build`        | Build for production             |
| `npm run start`        | Run production build             |
| `npm run icloud:test`  | Test iCloud album fetch          |
| `npm run amazon:setup` | Save Amazon Photos cookies       |

## Environment Variables

| Variable                      | Description                               | Default                      |
| ----------------------------- | ----------------------------------------- | ---------------------------- |
| `ICLOUD_ALBUM_TOKEN`          | Token from shared album URL               | (required)                   |
| `ICLOUD_DOWNLOAD_MAX_RETRIES` | Retry attempts for photo downloads        | `3`                          |
| `AMAZON_COOKIES_PATH`         | Path to cookies JSON file                 | `./data/amazon-cookies.json` |
| `AMAZON_ALBUM_NAME`           | Album name in Amazon Photos               | `Echo Show`                  |
| `SYNC_DELETIONS`              | Delete from Amazon when removed from iCloud | `true`                       |
| `POLL_INTERVAL_SECONDS`       | Sync interval in seconds                  | `60`                         |
| `LOG_LEVEL`                   | Logging level                             | `info`                       |

## How It Works

1. **Poll iCloud**: Fetches photo list from shared album's public API
2. **Compare State**: Checks local SQLite database for sync status
3. **Sync Changes**:
   - New photos: Download from iCloud → Upload to Amazon Photos → Add to album
   - Removed photos (if `SYNC_DELETIONS=true`): Remove from album → Trash → Purge from Amazon Photos
4. **Update State**: Record new mappings in database

> **Append-only mode**: Set `SYNC_DELETIONS=false` to preserve all photos in Amazon Photos, even when removed from iCloud.

## Troubleshooting

### Amazon Cookies Expired

Run `npm run amazon:setup` again to save fresh cookies from your browser.

### iCloud Fetch Fails

- Verify the album has "Public Website" enabled
- Check the token is correct (part after `#` in URL)
- Try accessing the public URL in a browser

### Sync Not Running

Check logs with `docker compose logs -f` or console output in dev mode.
