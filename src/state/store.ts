import Database from "better-sqlite3";
import { logger as rootLogger } from "../lib/logger.js";

const logger = rootLogger.child({ component: "state" });

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

  getCount(search?: string): number {
    if (search) {
      const like = `%${search}%`;
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM photo_mappings
           WHERE icloud_id LIKE ? OR icloud_checksum LIKE ? OR amazon_id LIKE ?`,
        )
        .get(like, like, like) as { count: number };
      return row.count;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM photo_mappings")
      .get() as { count: number };
    return row.count;
  }

  getMappingsPaginated(options: {
    page: number;
    pageSize: number;
    search?: string;
    sortBy?: "synced_at" | "icloud_id";
    sortOrder?: "asc" | "desc";
  }): PhotoMapping[] {
    const {
      page,
      pageSize,
      search,
      sortBy = "synced_at",
      sortOrder = "desc",
    } = options;
    const offset = (page - 1) * pageSize;

    // Whitelist sort column to prevent SQL injection
    const column = sortBy === "icloud_id" ? "icloud_id" : "synced_at";
    const order = sortOrder === "asc" ? "ASC" : "DESC";

    let rows: PhotoMappingRow[];
    if (search) {
      const like = `%${search}%`;
      rows = this.db
        .prepare(
          `SELECT * FROM photo_mappings
           WHERE icloud_id LIKE ? OR icloud_checksum LIKE ? OR amazon_id LIKE ?
           ORDER BY ${column} ${order}
           LIMIT ? OFFSET ?`,
        )
        .all(like, like, like, pageSize, offset) as PhotoMappingRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM photo_mappings
           ORDER BY ${column} ${order}
           LIMIT ? OFFSET ?`,
        )
        .all(pageSize, offset) as PhotoMappingRow[];
    }

    return rows.map((row) => ({
      icloudId: row.icloud_id,
      icloudChecksum: row.icloud_checksum,
      amazonId: row.amazon_id,
      syncedAt: new Date(row.synced_at),
    }));
  }

  removeMappings(icloudIds: string[]): number {
    const stmt = this.db.prepare(
      "DELETE FROM photo_mappings WHERE icloud_id = ?",
    );
    const transaction = this.db.transaction((ids: string[]) => {
      let count = 0;
      for (const id of ids) {
        const result = stmt.run(id);
        count += result.changes;
      }
      return count;
    });
    return transaction(icloudIds);
  }

  close(): void {
    this.db.close();
  }
}
