# Release Process

## Creating a New Release

1. **Update version** in `package.json`:

   ```bash
   npm version patch  # or minor, or major
   ```

2. **Commit and push** the version change:

   ```bash
   git add package.json package-lock.json
   git commit -m "Bump version to v1.0.1"
   git push
   ```

3. **Create and push tag**:

   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

4. **Automated workflow** (`.gitea/workflows/release.yml`) will:
   - Run tests (format, lint, build, tests)
   - Build multi-stage Docker image
   - Push to Gitea Container Registry with tags:
     - `latest`
     - `1.0.1` (semantic version)
     - `1` (major version)
   - Create a Gitea Release with notes

## Gitea Secrets Configuration

Set these secrets in Gitea repository settings (Settings → Actions → Secrets):

- `GITEA_USERNAME` - Your Gitea username
- `GITEA_TOKEN` - Personal access token with these scopes:
  - `write:packages` - To push Docker images to container registry
  - `write:repository` - To create releases

To create a token:

1. Go to User Settings → Applications → Access Tokens
2. Generate New Token
3. Select the required scopes above
4. Copy the token and add it to repository secrets

## Using Released Images

### Pull latest version:

```bash
docker pull git.home.alaghband.com/farhad/alexa-photos:latest
```

### Pull specific version:

```bash
docker pull git.home.alaghband.com/farhad/alexa-photos:1.0.1
```

### Update docker-compose.yml:

```yaml
services:
  sync:
    image: git.home.alaghband.com/farhad/alexa-photos:latest
    volumes:
      - ./data:/app/data
    env_file:
      - .env
    restart: unless-stopped
```

## Versioning Scheme

This project uses [Semantic Versioning](https://semver.org/):

- **MAJOR** (v2.0.0): Breaking changes
- **MINOR** (v1.1.0): New features, backwards compatible
- **PATCH** (v1.0.1): Bug fixes, backwards compatible

## Docker Image Tags

Each release creates three tags:

- `latest` - Always points to the newest stable release
- `1.0.1` - Specific version tag
- `1` - Latest patch in major version 1.x.x
