# Alexa Photos Sync

[![CI](https://github.com/farhad-a/alexa-photos/actions/workflows/ci.yml/badge.svg)](https://github.com/farhad-a/alexa-photos/actions)

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
3. Run `npm run amazon:setup` and paste the cookie values:
   - **US**: `session-id`, `ubid-main`, `at-main`, `x-main`, `sess-at-main`, `sst-main`
   - **International**: `session-id`, `ubid-acb{tld}`, `at-acb{tld}`
4. Cookies are saved to `./data/amazon-cookies.json`

> **Note:** Cookies expire periodically. Re-run `npm run amazon:setup` when
> the sync service reports an authentication error.

### Production Deployment

Using pre-built Docker images from GitHub Container Registry:

```bash
# Pull latest release
docker pull ghcr.io/farhad-a/alexa-photos:latest

# Or use docker-compose.yml with registry image
services:
  sync:
    image: ghcr.io/farhad-a/alexa-photos:latest
    volumes:
      - ./data:/app/data
    env_file:
      - .env
    restart: unless-stopped
```

Or build from source locally:

```bash
# Build and run with Docker Compose
docker compose up -d

# View logs
docker compose logs -f
```

> **Release process:** See [RELEASE.md](RELEASE.md) for details on versioning, tagging, and automated builds.

## Commands

### Development

| Command                      | Description                      |
| ---------------------------- | -------------------------------- |
| `npm run dev`                | Start sync service in watch mode |
| `npm run build`              | Build backend for production     |
| `npm run web:install`        | Install frontend dependencies     |
| `npm run web:dev`            | Start React UI (Vite dev server) |
| `npm run web:build`          | Build React UI for production     |
| `npm run start`              | Run production build             |
| `npm run ci`                 | Run full CI pipeline (backend + frontend + format + lint + test) |
| `npm run icloud:test`        | Test iCloud album fetch          |
| `npm run amazon:setup`       | Save Amazon Photos cookies       |
| `npm run notifications:test` | Test notification system         |

### Docker

| Command                  | Description                       |
| ------------------------ | --------------------------------- |
| `npm run docker:build`   | Build Docker image locally        |
| `npm run docker:run`     | Run locally built Docker image    |
| `docker compose up -d`   | Build and run with Docker Compose |
| `docker compose logs -f` | View service logs                 |

## CI / Testing

Run the full CI pipeline locally with a single command:

```bash
npm run ci  # backend build + frontend build + format:check + lint + test (148 tests)
```

Or run steps individually:

```bash
npm run format:check  # Check code formatting
npm run lint          # Check for lint errors
npm run build         # Backend TypeScript compilation
npm run web:build     # Frontend (React/Vite) build
npm run test:run      # Run test suite
```

Additional commands:

```bash
npm run format     # Auto-fix formatting issues
npm run lint:fix   # Auto-fix lint issues (limited)
npm test           # Run tests in watch mode
```

> **GitHub Actions**: Full CI/CD workflows are configured in `.github/workflows/` for automated testing and releases.

## Environment Variables

| Variable                      | Description                                 | Default                      |
| ----------------------------- | ------------------------------------------- | ---------------------------- |
| `ICLOUD_ALBUM_TOKEN`          | Token from shared album URL                 | (required)                   |
| `ICLOUD_DOWNLOAD_MAX_RETRIES` | Retry attempts for photo downloads          | `3`                          |
| `AMAZON_COOKIES_PATH`         | Path to cookies JSON file                   | `./data/amazon-cookies.json` |
| `AMAZON_ALBUM_NAME`           | Album name in Amazon Photos                 | `Echo Show`                  |
| `AMAZON_AUTO_REFRESH_COOKIES` | Automatically refresh expired auth tokens   | `true`                       |
| `SYNC_DELETIONS`              | Delete from Amazon when removed from iCloud | `true`                       |
| `POLL_INTERVAL_SECONDS`       | Sync interval in seconds                    | `60`                         |
| `UPLOAD_DELAY_MS`             | Delay between uploads (rate limiting)       | `0` (no delay)               |
| `LOG_LEVEL`                   | Logging level                               | `info`                       |
| `ALERT_WEBHOOK_URL`           | Webhook URL for alerts (optional)           | (none)                       |
| `PUSHOVER_TOKEN`              | Pushover app token (optional)               | (none)                       |
| `PUSHOVER_USER`               | Pushover user key (optional)                | (none)                       |

## Notifications

The service can send alerts when critical errors occur, such as when cookie refresh fails and manual re-authentication is required.

**Two notification methods are supported:**

1. **Generic Webhook** - Flexible, works with any HTTP endpoint (Slack, Discord, ntfy.sh, custom servers)
2. **Pushover Native Integration** - Direct push notifications to your mobile device (no intermediary needed)

You can configure one, both, or neither. When both are configured, alerts are sent to all channels in parallel.

> **📢 Throttling:** Duplicate alerts are automatically throttled to prevent spam — the same error message will only be sent once per hour. The throttle automatically clears when the issue is resolved (e.g., after successful cookie refresh).

---

### Option 1: Generic Webhook (Flexible)

Send alerts to any webhook endpoint that accepts JSON POST requests. Use this if you want to integrate with Slack, Discord, ntfy.sh, or your own notification system.

**Configuration:**

```bash
ALERT_WEBHOOK_URL=https://your-webhook-url
```

**Payload format sent to your webhook:**

```json
{
  "service": "alexa-photos",
  "level": "error",
  "message": "Amazon Photos cookies expired and auto-refresh failed. Please run: npm run amazon:setup",
  "timestamp": "2026-02-09T10:00:00.000Z",
  "details": {}
}
```

**Example integrations:**

| Service     | Setup                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ntfy.sh** | No account needed! Set `ALERT_WEBHOOK_URL=https://ntfy.sh/your-unique-topic` then subscribe via mobile app                                          |
| **Discord** | Create a [Discord webhook](https://support.discord.com/hc/en-us/articles/228383668), use transformation service (Zapier/n8n) to convert JSON format |
| **Slack**   | Create [Incoming Webhook](https://api.slack.com/messaging/webhooks), use transformation service for payload format                                  |
| **Custom**  | Point to your own HTTP server that processes the JSON payload                                                                                       |

**Note:** Some services (like Slack/Discord) may require a transformation service (Zapier, n8n, Make.com) to convert the JSON payload to their expected format.

---

### Option 2: Pushover Native Integration (Direct)

Send push notifications directly to your mobile device using [Pushover](https://pushover.net). No intermediary services required.

**When to use this:** You want instant push notifications on your phone/tablet without setting up webhooks or transformation services.

**Setup:**

1. Create a Pushover account at [pushover.net](https://pushover.net)
2. Install the Pushover mobile app ([iOS](https://apps.apple.com/us/app/pushover-notifications/id506088175) / [Android](https://play.google.com/store/apps/details?id=net.superblock.pushover))
3. Create an application in the [Pushover dashboard](https://pushover.net/apps/build) to get an API token
4. Copy your user key from the Pushover dashboard
5. Add to `.env`:

```bash
PUSHOVER_TOKEN=your-app-token-here
PUSHOVER_USER=your-user-key-here
```

**Priority mapping:**

- `error` → High priority (1) - bypasses quiet hours
- `warning`, `info` → Normal priority (0)

**Testing:**

```bash
npm run notifications:test
```

This will send 3 test notifications (error, warning, info) to verify your configuration works.

---

### Using Both Methods

You can configure both webhook and Pushover simultaneously for redundancy:

```bash
# Generic webhook for dashboard/logging
ALERT_WEBHOOK_URL=https://ntfy.sh/my-alerts

# Pushover for mobile notifications
PUSHOVER_TOKEN=your-app-token
PUSHOVER_USER=your-user-key
```

The service will send to all configured channels in parallel.

## How It Works

1. **Poll iCloud**: Fetches photo list from shared album's public API
2. **Compare State**: Checks local SQLite database for sync status
3. **Sync Changes**:
   - New photos: Check checksum → if duplicate content exists, reuse Amazon node → else download from iCloud → Upload to Amazon Photos → Add to album
   - Removed photos (if `SYNC_DELETIONS=true`): Remove from album → Trash → Purge from Amazon Photos
4. **Update State**: Record new mappings in database

> **Append-only mode**: Set `SYNC_DELETIONS=false` to preserve all photos in Amazon Photos, even when removed from iCloud.

## Health & Monitoring

The service exposes HTTP endpoints for health checks and metrics:

### Health Endpoint

```bash
curl http://localhost:3000/health
```

Returns:

```json
{
  "status": "healthy",
  "uptime": 3600,
  "timestamp": "2026-02-09T10:00:00.000Z"
}
```

### Metrics Endpoint

```bash
curl http://localhost:3000/metrics
```

Returns detailed metrics:

```json
{
  "status": "healthy",
  "uptime": 3600,
  "lastSync": {
    "timestamp": "2026-02-09T10:00:00.000Z",
    "durationMs": 1234,
    "photosAdded": 5,
    "photosRemoved": 0,
    "success": true
  },
  "totalSyncs": 60,
  "totalErrors": 0,
  "amazonAuthenticated": true
}
```

**Docker health check**: The compose file includes automatic health checks using the `/health` endpoint.

### Admin UI

A web-based admin interface is available at `http://localhost:3000/`. Use it to:

- Browse, search, and paginate photo mappings (iCloud ↔ Amazon Photos)
- Delete individual mappings or bulk-delete selected mappings to force a resync
- View and manage Amazon authentication cookies
- Test current cookie auth status against Amazon

The frontend now lives in `web/` (React + Vite), and production assets are served by the backend from `web/dist`.

## Tips & Advanced Usage

### Rate Limiting

If you're syncing a large album for the first time or experiencing API throttling from Amazon Photos, you can add a delay between uploads:

```bash
# Add 1 second delay between uploads
UPLOAD_DELAY_MS=1000
```

**When to use:**

- Large initial sync (100+ photos)
- Amazon API returns 429 (Too Many Requests) errors
- Running multiple sync instances

**Impact on sync time:**

- 50 photos with 1s delay = ~50 seconds added
- Only applies to new uploads, not existing photos
- No delay for checksum deduplication (reused photos)

**Default**: 0 (no delay)

## Troubleshooting

### Amazon Cookies Expired

The service automatically attempts to refresh expired authentication tokens using session cookies (`sess-at-main`, `sst-main`). If automatic refresh fails, the service will send an alert (if notifications are configured) and you'll need to run `npm run amazon:setup` again to save fresh cookies from your browser.

To disable automatic refresh, set `AMAZON_AUTO_REFRESH_COOKIES=false` in your `.env` file.

### iCloud Fetch Fails

- Verify the album has "Public Website" enabled
- Check the token is correct (part after `#` in URL)
- Try accessing the public URL in a browser

### Photo Deleted from Amazon Photos Directly

If you delete a photo directly from Amazon Photos (not via the sync service), the local mapping still exists and the engine will skip that photo indefinitely — it won't re-upload it. To force a resync, delete the mapping via the admin UI at `http://localhost:3000/`, then the next poll will re-upload the photo.

### Sync Not Running

Check logs with `docker compose logs -f` or console output in dev mode.
