import type { SyncDb, SyncStatement } from '../server/syncDb.ts';

type SqlValue = string | number | null | ArrayBuffer;

/** Durable Object SQLite rejects booleans/undefined; better-sqlite3 call sites rely on the looser behaviour. */
function normalise(params: unknown[]): SqlValue[] {
  return params.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return Number(v);
    return v as SqlValue;
  });
}

/** Adapts Durable Object storage (synchronous SQLite API) to the SyncDb surface the app uses. */
export function createDoDb(storage: DurableObjectStorage): SyncDb {
  const sql = storage.sql;
  return {
    prepare(query: string): SyncStatement {
      return {
        get: (...params: unknown[]) => sql.exec(query, ...normalise(params)).toArray()[0],
        all: (...params: unknown[]) => sql.exec(query, ...normalise(params)).toArray(),
        run: (...params: unknown[]) => {
          const cursor = sql.exec(query, ...normalise(params));
          cursor.toArray(); // fully consume so rowsWritten is final
          return { changes: cursor.rowsWritten };
        },
      };
    },
    exec(query: string) {
      sql.exec(query).toArray();
    },
    transaction<F extends (...args: any[]) => any>(fn: F): F {
      return ((...args: any[]) => storage.transactionSync(() => fn(...args))) as F;
    },
  };
}
