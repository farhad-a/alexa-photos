#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check for uncommitted changes
if [[ -n $(git status -s) ]]; then
  echo -e "${RED}Error: You have uncommitted changes. Commit or stash them first.${NC}"
  exit 1
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo -e "${GREEN}Current version: ${CURRENT_VERSION}${NC}"

# Ask for version bump type
echo ""
echo "Select version bump type:"
echo "  1) patch (${CURRENT_VERSION} → $(npx semver $(npm pkg get version | tr -d '"') -i patch 2>&1))"
echo "  2) minor (${CURRENT_VERSION} → $(npx semver $(npm pkg get version | tr -d '"') -i minor 2>&1))"
echo "  3) major (${CURRENT_VERSION} → $(npx semver $(npm pkg get version | tr -d '"') -i major 2>&1))"
read -p "Enter choice (1-3): " choice

case $choice in
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
NEW_VERSION=$(npm version $BUMP_TYPE --no-git-tag-version)

echo -e "${GREEN}New version: ${NEW_VERSION}${NC}"

# Commit version bump
echo ""
echo -e "${YELLOW}Committing version bump...${NC}"
git add package.json package-lock.json
git commit -m "Bump version to ${NEW_VERSION}"

# Create and push tag
echo ""
echo -e "${YELLOW}Creating tag ${NEW_VERSION}...${NC}"
git tag ${NEW_VERSION}

echo ""
echo -e "${YELLOW}Pushing to origin...${NC}"
git push origin main --follow-tags

echo ""
echo -e "${GREEN}✓ Release ${NEW_VERSION} initiated!${NC}"
echo -e "${GREEN}✓ GitHub workflow will build and push Docker image.${NC}"
echo -e "${GREEN}✓ Check: https://github.com/farhad-a/alexa-photos/actions${NC}"
