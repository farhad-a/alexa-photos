# Alexa Photos Sync

Sync photos from an iCloud shared album to Amazon Photos for display on Echo Show devices.

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  iCloud Shared  │ ──── │   Sync Service   │ ──── │  Amazon Photos  │
│  Album (RSS)    │ poll │   (TypeScript)   │ auto │  (Playwright)   │
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
- Amazon Photos account
- Docker (for production) or Node.js 20+ (for development)

### Development (Devcontainer)

1. Open this folder in VS Code
2. Click "Reopen in Container" when prompted
3. Copy `.env.example` to `.env` and fill in your values
4. Run `npm run icloud:test` to verify iCloud access
5. Run `npm run amazon:login` to authenticate with Amazon (one-time)
6. Run `npm run dev` to start the sync service

### Getting Your iCloud Album Token

1. Open the Photos app on Mac/iPhone
2. Go to your shared album → Settings
3. Enable "Public Website"
4. Copy the URL (e.g., `https://www.icloud.com/sharedalbum/#ABC123DEF456`)
5. The token is the part after `#` (e.g., `ABC123DEF456`)

### Production Deployment

```bash
# Build and run with Docker Compose
docker compose up -d

# View logs
docker compose logs -f
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start sync service in watch mode |
| `npm run build` | Build for production |
| `npm run start` | Run production build |
| `npm run icloud:test` | Test iCloud album fetch |
| `npm run amazon:login` | Interactive Amazon login (saves session) |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ICLOUD_ALBUM_TOKEN` | Token from shared album URL | (required) |
| `AMAZON_EMAIL` | Amazon account email | (required) |
| `AMAZON_PASSWORD` | Amazon account password | (required) |
| `AMAZON_ALBUM_NAME` | Album name in Amazon Photos | `Echo Show` |
| `POLL_INTERVAL_MS` | Sync interval in milliseconds | `60000` |
| `LOG_LEVEL` | Logging level | `info` |

## How It Works

1. **Poll iCloud**: Fetches photo list from shared album's public API
2. **Compare State**: Checks local SQLite database for sync status
3. **Sync Changes**:
   - New photos: Download from iCloud → Upload to Amazon Photos
   - Removed photos: Delete from Amazon Photos
4. **Update State**: Record new mappings in database

## Troubleshooting

### Amazon Session Expired
Run `npm run amazon:login` again to re-authenticate.

### iCloud Fetch Fails
- Verify the album has "Public Website" enabled
- Check the token is correct (part after `#` in URL)
- Try accessing the public URL in a browser

### Sync Not Running
Check logs with `docker compose logs -f` or console output in dev mode.
