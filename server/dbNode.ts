import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initializeDatabase, seedIfEmpty, setDbProvider } from './db.ts';
import type { SyncDb } from './syncDb.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'ledgerfx.sqlite');

let instance: SyncDb | null = null;

/** Opens (and migrates) a database at any path, including ':memory:' — used by tests and the Node server. */
export function openDatabase(filePath: string): SyncDb {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -20000');
  const wrapped = db as unknown as SyncDb;
  initializeDatabase(wrapped);
  return wrapped;
}

/** Wires the Node/SQLite file as the app database. */
export function useNodeDatabase(): void {
  setDbProvider(() => {
    if (instance) return instance;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = openDatabase(DB_PATH);
    instance = db;
    // Demo data is opt-in: fake accounts must never be mixed into a real trading journal.
    if (process.env.SEED_DEMO_DATA === 'true') seedIfEmpty(db);
    return db;
  });
}
