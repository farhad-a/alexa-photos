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

4. **Automated workflow** (`.github/workflows/release.yml`) will:
   - Run tests (format, lint, build, tests)
   - Build multi-stage Docker image
   - Push to GitHub Container Registry with tags:
     - `latest`
     - `1.0.1` (semantic version)
     - `1` (major version)
   - Create a GitHub Release with notes

## GitHub Configuration

The workflow uses GitHub's built-in `GITHUB_TOKEN` which is automatically provided.

For pushing to GitHub Container Registry, ensure:

1. Go to repository Settings → Actions → General
2. Under "Workflow permissions", select:
   - "Read and write permissions"
   - Check "Allow GitHub Actions to create and approve pull requests"
3. Go to your GitHub profile → Settings → Developer settings → Personal access tokens → Tokens (classic)
4. Generate a new token (if needed for manual operations) with `write:packages` scope

## Using Released Images

### Pull latest version:

```bash
docker pull ghcr.io/farhad-a/alexa-photos:latest
```

### Pull specific version:

```bash
docker pull ghcr.io/farhad-a/alexa-photos:1.0.1
```

### Update docker-compose.yml:

```yaml
services:
  sync:
    image: ghcr.io/farhad-a/alexa-photos:latest
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
