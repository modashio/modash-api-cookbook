import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './env';
import type { ModashApi } from './modash/api';
import { registerChatRoute, type ChatRouteOptions } from './routes/chat';

export interface AppOptions extends ChatRouteOptions {
  serveStaticWeb?: boolean;
}

export function createApp(api: ModashApi, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/config', (_req, res) => {
    res.json({
      mock: api.isMock,
      creditBudget: config.creditBudget,
      maxPageSize: config.maxPageSize,
    });
  });

  registerChatRoute(app, api, options);

  // In production the React bundle is served by this same process.
  const webDist = resolve(process.cwd(), 'dist/web');
  if (options.serveStaticWeb && existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(resolve(webDist, 'index.html'));
    });
  }

  return app;
}
