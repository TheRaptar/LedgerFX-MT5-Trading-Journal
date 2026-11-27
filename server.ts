import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { getDb } from './server/db.ts';
import { useNodeDatabase } from './server/dbNode.ts';
import { registerRoutes, securityHeaders } from './server/routes.ts';
import type { AppLike } from './server/web.ts';

// Node entry point for local development / self-hosting. The Cloudflare deployment uses worker/index.ts
// and shares exactly the same routes (server/routes.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => securityHeaders(req as never, res as never, next));
  app.use(express.json({ limit: '25mb' }));

  useNodeDatabase();
  getDb(); // initialise on boot

  registerRoutes(app as unknown as AppLike);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LedgerFX MT5 Journal Portal running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start LedgerFX server:', err);
  process.exit(1);
});
