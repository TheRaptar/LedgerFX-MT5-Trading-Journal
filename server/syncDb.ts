/** Minimal synchronous SQLite surface shared by better-sqlite3 (Node/tests) and Durable Object SQLite (Cloudflare). */
export interface SyncStatement {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number };
}

export interface SyncDb {
  prepare(sql: string): SyncStatement;
  exec(sql: string): unknown;
  transaction<F extends (...args: any[]) => any>(fn: F): F;
}
