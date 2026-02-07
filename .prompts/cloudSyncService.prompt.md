---
name: cloudSyncService
description: Design and scaffold a sync service between two cloud platforms with automation
argument-hint: Source platform, target platform, and sync requirements
---
Design and implement a sync service to keep data synchronized between two cloud platforms.

## Analysis Phase
1. Identify API availability for both platforms (official APIs vs. browser automation needs)
2. Propose architecture options with trade-offs (polling frequency, state management, deployment)
3. Discuss authentication strategies (OAuth, session persistence, 2FA handling)

## Implementation Phase
1. Scaffold a TypeScript project with:
   - Devcontainer configuration for consistent development
   - Docker setup for production deployment
   - Playwright for browser automation (if APIs unavailable)
   - SQLite for state/mapping persistence
   - Structured logging (pino)
   - Zod for configuration validation

2. Create modular components:
   - Source client: Fetch data from source platform
   - Target client: Push data to target platform (with session management)
   - Sync engine: Diff detection, additions, deletions
   - State store: Track sync mappings

3. Include developer utilities:
   - Test scripts to validate platform connectivity
   - Interactive login helper for platforms requiring 2FA
   - Environment configuration examples

## Key Considerations
- Handle platform-specific quirks (package renames, API changes)
- Design for resilience (session expiry, rate limiting, retries)
- Support both real-time and scheduled sync patterns
