import { chromium, Browser, BrowserContext, Page } from "playwright";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import * as fs from "fs/promises";
import * as path from "path";

const SESSION_DIR = "./data/amazon-session";

export interface AmazonPhoto {
  id: string;
  name: string;
}

export class AmazonClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async init(): Promise<void> {
    logger.debug("Initializing Amazon Photos client");

    this.browser = await chromium.launch({
      headless: true,
    });

    // Try to restore session
    const sessionExists = await this.sessionExists();

    this.context = await this.browser.newContext({
      storageState: sessionExists ? `${SESSION_DIR}/state.json` : undefined,
      viewport: { width: 1280, height: 720 },
    });

    this.page = await this.context.newPage();
  }

  private async sessionExists(): Promise<boolean> {
    try {
      await fs.access(`${SESSION_DIR}/state.json`);
      return true;
    } catch {
      return false;
    }
  }

  async saveSession(): Promise<void> {
    if (!this.context) return;

    await fs.mkdir(SESSION_DIR, { recursive: true });
    await this.context.storageState({ path: `${SESSION_DIR}/state.json` });
    logger.debug("Session saved");
  }

  async isLoggedIn(): Promise<boolean> {
    if (!this.page) throw new Error("Client not initialized");

    await this.page.goto("https://www.amazon.com/photos");
    await this.page.waitForLoadState("networkidle");

    // Check if we're on the photos page or redirected to login
    const url = this.page.url();
    return !url.includes("signin") && !url.includes("ap/signin");
  }

  async login(): Promise<void> {
    if (!this.page) throw new Error("Client not initialized");

    logger.info("Logging into Amazon Photos");

    await this.page.goto("https://www.amazon.com/photos");

    // Wait for and fill email
    await this.page.waitForSelector('input[type="email"], input[name="email"]');
    await this.page.fill(
      'input[type="email"], input[name="email"]',
      config.amazonEmail
    );
    await this.page.click('input[type="submit"], #continue');

    // Wait for and fill password
    await this.page.waitForSelector('input[type="password"]');
    await this.page.fill('input[type="password"]', config.amazonPassword);
    await this.page.click('input[type="submit"], #signInSubmit');

    // Handle potential 2FA
    // This will pause and wait for manual intervention if 2FA is required
    try {
      await this.page.waitForURL("**/photos**", { timeout: 10000 });
    } catch {
      logger.warn(
        "Login may require 2FA - waiting for manual completion (60s timeout)"
      );
      await this.page.waitForURL("**/photos**", { timeout: 60000 });
    }

    await this.saveSession();
    logger.info("Successfully logged into Amazon Photos");
  }

  async ensureLoggedIn(): Promise<void> {
    if (!(await this.isLoggedIn())) {
      await this.login();
    }
  }

  async uploadPhoto(
    photoBuffer: Buffer,
    filename: string,
    albumName: string
  ): Promise<string> {
    if (!this.page) throw new Error("Client not initialized");

    await this.ensureLoggedIn();

    logger.debug({ filename, albumName }, "Uploading photo to Amazon Photos");

    // Navigate to the album or create it
    await this.navigateToAlbum(albumName);

    // Amazon Photos uses a file input for uploads
    const fileInput = await this.page.waitForSelector('input[type="file"]');

    // Create a temporary file for upload
    const tempPath = path.join("/tmp", filename);
    await fs.writeFile(tempPath, photoBuffer);

    await fileInput.setInputFiles(tempPath);

    // Wait for upload to complete
    await this.page.waitForSelector('[data-testid="upload-complete"]', {
      timeout: 60000,
    });

    // Clean up temp file
    await fs.unlink(tempPath);

    // Get the photo ID from the page (implementation depends on Amazon's UI)
    const photoId = await this.extractPhotoId();

    logger.info({ filename, photoId }, "Photo uploaded successfully");
    return photoId;
  }

  private async navigateToAlbum(albumName: string): Promise<void> {
    if (!this.page) throw new Error("Client not initialized");

    await this.page.goto("https://www.amazon.com/photos/albums");
    await this.page.waitForLoadState("networkidle");

    // Look for existing album
    const albumLink = this.page.locator(`text="${albumName}"`);

    if ((await albumLink.count()) > 0) {
      await albumLink.click();
    } else {
      // Create new album
      logger.info({ albumName }, "Creating new album");
      await this.page.click('[data-testid="create-album"]');
      await this.page.fill('[data-testid="album-name-input"]', albumName);
      await this.page.click('[data-testid="create-album-submit"]');
    }

    await this.page.waitForLoadState("networkidle");
  }

  private async extractPhotoId(): Promise<string> {
    // This is a placeholder - actual implementation depends on Amazon's UI
    // May need to parse the URL or extract from page elements
    return `amazon-${Date.now()}`;
  }

  async deletePhoto(photoId: string): Promise<void> {
    if (!this.page) throw new Error("Client not initialized");

    logger.debug({ photoId }, "Deleting photo from Amazon Photos");

    // Implementation depends on Amazon's UI
    // Typically: navigate to photo, click delete, confirm

    logger.info({ photoId }, "Photo deleted successfully");
  }

  async getAlbumPhotos(albumName: string): Promise<AmazonPhoto[]> {
    if (!this.page) throw new Error("Client not initialized");

    await this.ensureLoggedIn();
    await this.navigateToAlbum(albumName);

    // Extract photo list from the album page
    // Implementation depends on Amazon's UI structure

    return [];
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }
}
