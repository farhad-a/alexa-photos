import Database from "better-sqlite3";
import { logger } from "../lib/logger.js";

const DB_PATH = "./data/state.db";

export interface PhotoMapping {
  icloudId: string;
  icloudChecksum: string;
  amazonId: string;
  syncedAt: Date;
}

interface PhotoMappingRow {
  icloud_id: string;
  icloud_checksum: string;
  amazon_id: string;
  synced_at: string;
}

export class StateStore {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS photo_mappings (
        icloud_id TEXT PRIMARY KEY,
        icloud_checksum TEXT NOT NULL,
        amazon_id TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS idx_amazon_id ON photo_mappings(amazon_id);
      CREATE INDEX IF NOT EXISTS idx_checksum ON photo_mappings(icloud_checksum);
    `);

    logger.debug("State store initialized");
  }

  getMapping(icloudId: string): PhotoMapping | null {
    const row = this.db
      .prepare("SELECT * FROM photo_mappings WHERE icloud_id = ?")
      .get(icloudId) as PhotoMappingRow | undefined;

    if (!row) return null;

    return {
      icloudId: row.icloud_id,
      icloudChecksum: row.icloud_checksum,
      amazonId: row.amazon_id,
      syncedAt: new Date(row.synced_at),
    };
  }

  getMappingByChecksum(checksum: string): PhotoMapping | null {
    const row = this.db
      .prepare("SELECT * FROM photo_mappings WHERE icloud_checksum = ?")
      .get(checksum) as PhotoMappingRow | undefined;

    if (!row) return null;

    return {
      icloudId: row.icloud_id,
      icloudChecksum: row.icloud_checksum,
      amazonId: row.amazon_id,
      syncedAt: new Date(row.synced_at),
    };
  }

  getAllMappings(): PhotoMapping[] {
    const rows = this.db
      .prepare("SELECT * FROM photo_mappings")
      .all() as PhotoMappingRow[];

    return rows.map((row) => ({
      icloudId: row.icloud_id,
      icloudChecksum: row.icloud_checksum,
      amazonId: row.amazon_id,
      syncedAt: new Date(row.synced_at),
    }));
  }

  addMapping(mapping: Omit<PhotoMapping, "syncedAt">): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO photo_mappings 
         (icloud_id, icloud_checksum, amazon_id, synced_at) 
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        mapping.icloudId,
        mapping.icloudChecksum,
        mapping.amazonId,
        new Date().toISOString(),
      );

    logger.debug({ icloudId: mapping.icloudId }, "Added photo mapping");
  }

  removeMapping(icloudId: string): void {
    this.db
      .prepare("DELETE FROM photo_mappings WHERE icloud_id = ?")
      .run(icloudId);

    logger.debug({ icloudId }, "Removed photo mapping");
  }

  removeMappingByAmazonId(amazonId: string): void {
    this.db
      .prepare("DELETE FROM photo_mappings WHERE amazon_id = ?")
      .run(amazonId);

    logger.debug({ amazonId }, "Removed photo mapping by Amazon ID");
  }

  close(): void {
    this.db.close();
  }
}
