#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Ensure we're in repo root (script expected to run there)
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo -e "${RED}Error: Not inside a git repository.${NC}"
  exit 1
fi

# Check branch safety
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo -e "${RED}Error: Releases must be run from 'main' (current: ${CURRENT_BRANCH}).${NC}"
  exit 1
fi

# Check for uncommitted changes
if [[ -n "$(git status -s)" ]]; then
  echo -e "${RED}Error: You have uncommitted changes. Commit or stash them first.${NC}"
  exit 1
fi

# Ensure local main is in sync with remote main
echo -e "${YELLOW}Fetching latest origin/main...${NC}"
git fetch origin main --tags

LOCAL_MAIN_SHA="$(git rev-parse HEAD)"
REMOTE_MAIN_SHA="$(git rev-parse origin/main)"
if [[ "$LOCAL_MAIN_SHA" != "$REMOTE_MAIN_SHA" ]]; then
  echo -e "${RED}Error: local main is not in sync with origin/main.${NC}"
  echo -e "${YELLOW}Run: git pull --ff-only origin main${NC}"
  exit 1
fi

# Pre-release validation
echo -e "${YELLOW}Running pre-release checks (npm run ci)...${NC}"
npm run ci

# Get current version from package.json
CURRENT_VERSION="$(node -p "require('./package.json').version")"
echo -e "${GREEN}Current version: ${CURRENT_VERSION}${NC}"

NEXT_PATCH="$(npx semver "$CURRENT_VERSION" -i patch 2>&1)"
NEXT_MINOR="$(npx semver "$CURRENT_VERSION" -i minor 2>&1)"
NEXT_MAJOR="$(npx semver "$CURRENT_VERSION" -i major 2>&1)"

# Ask for version bump type
echo ""
echo "Select version bump type:"
echo "  1) patch (${CURRENT_VERSION} → ${NEXT_PATCH})"
echo "  2) minor (${CURRENT_VERSION} → ${NEXT_MINOR})"
echo "  3) major (${CURRENT_VERSION} → ${NEXT_MAJOR})"
read -r -p "Enter choice (1-3): " choice

case "$choice" in
  1) BUMP_TYPE="patch" ;;
  2) BUMP_TYPE="minor" ;;
  3) BUMP_TYPE="major" ;;
  *)
    echo -e "${RED}Invalid choice${NC}"
    exit 1
    ;;
esac

# Bump version in package.json
echo ""
echo -e "${YELLOW}Bumping ${BUMP_TYPE} version...${NC}"
NEW_VERSION="$(npm version "$BUMP_TYPE" --no-git-tag-version)"
echo -e "${GREEN}New version: ${NEW_VERSION}${NC}"

# Commit version bump
echo ""
echo -e "${YELLOW}Committing version bump...${NC}"
FILES_TO_ADD=("package.json")
if [[ -f package-lock.json ]]; then
  FILES_TO_ADD+=("package-lock.json")
fi
git add "${FILES_TO_ADD[@]}"

if git diff --cached --quiet; then
  echo -e "${RED}Error: No version changes staged for commit.${NC}"
  exit 1
fi

git commit -m "chore(release): ${NEW_VERSION}"

# Create annotated tag
echo ""
echo -e "${YELLOW}Creating annotated tag ${NEW_VERSION}...${NC}"
if git rev-parse "${NEW_VERSION}" >/dev/null 2>&1; then
  echo -e "${RED}Error: Tag ${NEW_VERSION} already exists.${NC}"
  exit 1
fi
git tag -a "${NEW_VERSION}" -m "Release ${NEW_VERSION}"

# Push commit + tag explicitly
echo ""
echo -e "${YELLOW}Pushing to origin...${NC}"
git push origin main
git push origin "${NEW_VERSION}"

echo ""
echo -e "${GREEN}✓ Release ${NEW_VERSION} initiated!${NC}"
echo -e "${GREEN}✓ GitHub workflow will build and push Docker image.${NC}"
echo -e "${GREEN}✓ Check: https://github.com/farhad-a/alexa-photos/actions${NC}"
