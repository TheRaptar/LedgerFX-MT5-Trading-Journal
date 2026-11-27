import { DurableObject } from 'cloudflare:workers';
import { initializeDatabase, setDbProvider } from '../server/db.ts';
import { registerRoutes, securityHeaders } from '../server/routes.ts';
import { createDoDb } from './doDb.ts';
import { MiniApp } from './miniApp.ts';

interface Env {
  LEDGER: DurableObjectNamespace<LedgerDO>;
  ASSETS: Fetcher;
  [key: string]: unknown;
}

/**
 * The whole app (routes + SQLite database) lives in one Durable Object, so the database is
 * durable, single-writer and synchronous, exactly like the Node/SQLite version.
 */
export class LedgerDO extends DurableObject<Env> {
  private readonly app: MiniApp;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Make secrets/vars visible to code that reads process.env.
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && process.env[key] === undefined) process.env[key] = value;
    }
    const db = createDoDb(ctx.storage);
    setDbProvider(() => db);
    ctx.blockConcurrencyWhile(async () => {
      initializeDatabase(db);
    });
    this.app = new MiniApp((req, res, next) => securityHeaders(req, res, next));
    registerRoutes(this.app);
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.handle(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.LEDGER.get(env.LEDGER.idFromName('primary'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
