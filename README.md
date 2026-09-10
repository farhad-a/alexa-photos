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
- Amazon Photos account
- Docker (for production) or Node.js 24+ (CI validates on 24 and 26)

### Development (Devcontainer)

1. Open this folder in VS Code
2. Click "Reopen in Container" when prompted
3. Copy `.env.example` to `.env` and fill in your values
4. Run `npm run icloud:test` to verify iCloud access
5. Start the app and register a device in the web UI (`/amazon`)
6. Run `npm run dev` to start the sync service

### Getting Your iCloud Album Token

1. Open the Photos app on Mac/iPhone
2. Go to your shared album → Settings
3. Enable "Public Website"
4. Copy the URL (e.g., `https://www.icloud.com/sharedalbum/#ABC123DEF456`)
5. The token is the part after `#` (e.g., `ABC123DEF456`)

### Amazon Device Registration (recommended)

The service signs in to Amazon **once** and keeps a long-lived device token,
then mints its own auth cookies from it. Cookies last about two weeks and are
refreshed automatically before they expire. Your password is never sent to or
stored by this app.

**Before you register**, set the marketplace if you are not on `amazon.com`, and
in Docker set `AMAZON_PROXY_OWN_IP`. A registration made against the wrong
marketplace can only be fixed by registering again in a browser.

1. Open the admin UI at `http://<host>:3000/amazon`
2. Click **Register device**. The app starts a login proxy and shows an address
3. Open that address in a browser on any device on your network
4. Sign in to Amazon. Two-step verification and CAPTCHAs are handled there
5. The browser returns to the admin UI and the page flips to registered

The proxy runs only during registration and is shut down afterwards.

> **If the address is unreachable**, set `AMAZON_PROXY_OWN_IP` to an IP literal
> your browser can reach. Auto-detection inside Docker returns the container
> bridge address, which nothing on your network can reach, and the proxy still
> appears to start.

> **Publish the proxy port with matching host and container numbers**
> (`3456:3456`). The proxy rewrites Amazon's pages to embed that address, so a
> remapped host port produces links the browser cannot follow. Keep the port on
> your LAN: it proxies a live Amazon sign-in.

> **Upgrading from cookie auth:** manual cookie entry has been removed. Any
> existing `data/amazon-cookies.json` and `AMAZON_COOKIES_PATH` are ignored, and
> the service logs a warning once if it finds either. Register a device at
> `/amazon` and the old file can be deleted.

Removing a registration in the UI only forgets the local credentials. The device
stays listed in your Amazon account until you remove it at `amazon.com/mycd`.

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

| Command                      | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                | Start sync service in watch mode                                 |
| `npm run build`              | Build backend for production                                     |
| `npm run web:dev`            | Start React UI (Vite dev server)                                 |
| `npm run web:build`          | Build React UI for production                                    |
| `npm run start`              | Run production build                                             |
| `npm run ci`                 | Run full CI pipeline (backend + frontend + format + lint + test) |
| `npm run icloud:test`        | Test iCloud album fetch                                          |
| `npm run amazon:verify`      | Live-check the registration, auth state and cookie rotation      |
| `npm run notifications:test` | Test notification system                                         |

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
npm run ci  # backend build + frontend build + format:check + lint + test
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

| Variable                        | Description                                     | Default                   |
| ------------------------------- | ----------------------------------------------- | ------------------------- |
| `ICLOUD_ALBUM_TOKEN`            | Token from shared album URL                     | (required)                |
| `ICLOUD_DOWNLOAD_MAX_RETRIES`   | Retry attempts for photo downloads              | `3`                       |
| `AMAZON_ALBUM_NAME`             | Album name in Amazon Photos                     | `Echo Show`               |
| `AMAZON_AUTH_PATH`              | Registration + session credential store         | `./data/amazon-auth.json` |
| `AMAZON_MARKETPLACE`            | Amazon site to register against                 | `amazon.com`              |
| `AMAZON_DEVICE_APP_NAME`        | Device name shown at amazon.com/mycd            | `alexa-photos`            |
| `AMAZON_PROXY_OWN_IP`           | LAN IP for the login proxy (required in Docker) | (auto-detected)           |
| `AMAZON_PROXY_PORT`             | Login proxy port (publish host:container 1:1)   | `3456`                    |
| `AMAZON_COOKIE_MAX_AGE_DAYS`    | Refresh cookies once older than this            | `7`                       |
| `AMAZON_AUTO_REFRESH_COOKIES`   | Automatically refresh expired auth tokens       | `true`                    |
| `COOKIE_REFRESH_INTERVAL_HOURS` | How often cookie freshness is checked (hours)   | `12`                      |
| `SYNC_DELETIONS`                | Delete from Amazon when removed from iCloud     | `true`                    |
| `POLL_INTERVAL_SECONDS`         | Sync interval in seconds                        | `60`                      |
| `UPLOAD_DELAY_MS`               | Delay between uploads (rate limiting)           | `0` (no delay)            |
| `SERVER_PORT`                   | Port for health/metrics/admin HTTP server       | `3000`                    |
| `LOG_LEVEL`                     | Logging level                                   | `info`                    |
| `ALERT_WEBHOOK_URL`             | Webhook URL for alerts (optional)               | (none)                    |
| `PUSHOVER_TOKEN`                | Pushover app token (optional)                   | (none)                    |
| `PUSHOVER_USER`                 | Pushover user key (optional)                    | (none)                    |

## Notifications

The service can send alerts when critical errors occur, such as when a refresh fails or the device registration is rejected and you need to register again.

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
  "message": "Amazon device registration is no longer valid. Re-register in the Alexa Photos web UI.",
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

### API Reference

Base URL is `http://localhost:3000` by default (`SERVER_PORT`).

- `GET /health`
  - Health status + uptime/timestamp
  - Response: `{ status, uptime, timestamp }` where `status` is typically `healthy` or `starting`
  - Example:
    ```bash
    curl http://localhost:3000/health
    ```

- `GET /metrics`
  - Runtime metrics
  - Response fields include `status`, `uptime`, `lastSync`, `totalSyncs`, `totalErrors`, `amazonAuthenticated`
  - Example:
    ```bash
    curl http://localhost:3000/metrics
    ```

- `GET /api/mappings`
  - List mappings with optional query params:
    - `page` (default `1`)
    - `pageSize` (default `50`, max `200`)
    - `search`
    - `sortBy=icloud_id|synced_at`
    - `sortOrder=asc|desc`
  - Returns `[]` when store is present but no mappings exist
  - Returns `404` if state store is unavailable
  - Example:
    ```bash
    curl "http://localhost:3000/api/mappings?page=1&pageSize=20&sortBy=synced_at&sortOrder=desc"
    ```

- `POST /api/mappings/bulk-delete`
  - Bulk-delete mappings by iCloud IDs
  - Body: `{ "icloudIds": ["id1", "id2"] }`
  - Returns `{ deleted }`
  - Example:
    ```bash
    curl -X POST http://localhost:3000/api/mappings/bulk-delete \
      -H "Content-Type: application/json" \
      -d '{"icloudIds":["icloud-1","icloud-2"]}'
    ```

- `DELETE /api/mappings/{icloudId}`
  - Delete a single mapping by URL-decoded `icloudId`
  - Returns `{ deleted }`
  - Example:
    ```bash
    curl -X DELETE http://localhost:3000/api/mappings/icloud-abc-123
    ```

- `GET /api/amazon/status`
  - Registration state, marketplace, masked device serial, cookie age
  - Returns `{ registered: false }` with a `200` when no device is registered

    ```bash
    curl http://localhost:3000/api/amazon/status
    ```

- `POST /api/amazon/registration/start`
  - Starts the login proxy, returns `{ proxyUrl, expiresAt }`
  - `409` if a registration is already running, `400` if the proxy address is unusable

- `GET /api/amazon/registration/status`
  - Poll target while signing in

- `POST /api/amazon/registration/cancel`
  - Stops the login proxy

- `DELETE /api/amazon/registration`
  - Forgets the local registration. Does **not** deregister the device at Amazon

- `POST /api/amazon/auth/test`
  - Checks the stored credentials against Amazon

- `POST /api/amazon/auth/refresh`
  - Forces a refresh, bypassing the age gate

### Error Handling Notes

- Invalid request payloads return `400` with an `error` message.
- Missing state-backed routes (for mappings) return `404`.

### Admin UI

A web-based admin interface is available at `http://localhost:3000/`. Use it to:

- Browse, search, and paginate photo mappings (iCloud ↔ Amazon Photos)
- Delete individual mappings or bulk-delete selected mappings to force a resync
- Register this app with Amazon and see registration status
- Test authentication and force a cookie refresh

The frontend lives in `web/` (React + Vite), the backend lives in `server/`, and production assets are served by the backend from `web/dist`.

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

### Amazon Authentication Failing

Cookies are minted from the device token and refreshed automatically before
they expire, so this should be rare. When it does happen, the cause matters:

- **A transient failure** is retried. The service alerts and keeps going.
- **A rejected refresh token** is not retried, because retrying cannot help. It
  means the device was deregistered or the account password changed. The
  service alerts once and the Amazon Account page shows the registration as
  revoked. Register again at `/amazon`.

If the service was offline longer than the cookie lifetime, no action is
needed: the token outlives the cookies, so it mints a fresh set on the next
start.

### Verify Live Amazon Auth Behavior

Use this to check the stored registration against real Amazon responses, and to confirm cookie rotation is being persisted:

```bash
npm run amazon:verify
```

The command prints a JSON summary with:

- current auth state and HTTP status
- whether a normal authenticated request path was exercised
- the marketplace, masked device serial, and when it was registered
- how old the current cookies are, and whether a re-registration is needed
- which cookie names are stored, and which rotated during verification
  (names only, never values)

This is intended as an integration-level smoke test against live Amazon behavior, not a unit test replacement.

To disable automatic refresh, set `AMAZON_AUTO_REFRESH_COOKIES=false` in your `.env` file.

### iCloud Fetch Fails

- Verify the album has "Public Website" enabled
- Check the token is correct (part after `#` in URL)
- Try accessing the public URL in a browser

### Photo Deleted from Amazon Photos Directly

If you delete a photo directly from Amazon Photos (not via the sync service), the local mapping still exists and the engine will skip that photo indefinitely — it won't re-upload it. To force a resync, delete the mapping via the admin UI at `http://localhost:3000/`, then the next poll will re-upload the photo.

### Sync Not Running

Check logs with `docker compose logs -f` or console output in dev mode.
