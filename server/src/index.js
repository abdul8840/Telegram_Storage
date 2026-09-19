/**
 * Telegram Cloud Drive — server entry point.
 *
 *   Express  +  MongoDB (or embedded)  +  Telegram MTProto storage
 *
 * Boots with zero configuration: no Mongo? embedded DB. No Telegram account?
 * local-disk storage. Connect Telegram from the UI and the very same library
 * starts living in your Telegram account instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

import config from './config.js';
import { createLogger } from './lib/logger.js';
import { errorMiddleware, notFoundHandler } from './lib/errors.js';
import { initDb, closeDb, dbInfo } from './db/index.js';
import routes from './routes/index.js';
import { disconnectAll } from './storage/telegramClient.js';
import { getCapabilities } from './services/media.js';
import { cleanupStaleSessions, recoverOnBoot } from './services/uploadManager.js';
import { purgeFinishedJobs, recoverOnBoot as recoverJobs } from './services/jobs.js';
import { purgeOldTrash } from './services/files.js';

const log = createLogger('server');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // ── security headers ────────────────────────────────────────────────────
  // frame-ancestors must allow the dev/preview host, otherwise the SPA cannot
  // be embedded (e.g. Arena live preview, or your own dashboard).
  const frameAncestors = process.env.ALLOWED_FRAME_ANCESTORS || (config.isProd ? "'self'" : '*');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'base-uri': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'media-src': ["'self'", 'blob:', 'data:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'", ...(config.isProd ? [] : ['ws:', 'http://localhost:5173'])],
          'object-src': ["'none'"],
          'frame-src': ["'self'", 'blob:'],
          'frame-ancestors': [frameAncestors],
          'form-action': ["'self'"],
          'upgrade-insecure-requests': config.isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // ── cors ────────────────────────────────────────────────────────────────
  const allowAll = config.corsOrigins.includes('*');
  app.use(
    cors({
      origin: allowAll ? true : config.corsOrigins,
      credentials: true,
      exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag', 'X-Media-Duration', 'X-Media-Width', 'X-Media-Height'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-File-Name', 'Content-Range', 'Range', 'If-Range', 'If-None-Match'],
    }),
  );

  app.use(compression({ filter: (req, res) => !req.path?.startsWith('/api/files/') && !req.path?.includes('/stream') }));
  app.use(cookieParser());

  // Request log (SSE and media streams are skipped — they are long-lived/noisy).
  app.use(
    morgan(config.isProd ? 'combined' : 'dev', {
      skip: (req) => req.path.startsWith('/api/events') || req.path.includes('/stream') || req.path.includes('/thumbnail'),
    }),
  );

  // JSON/urlencoded bodies only — binary chunk uploads stream straight through.
  app.use(express.json({ limit: '2mb', type: ['application/json', 'application/*+json'] }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, database: dbInfo(), uptime: process.uptime() }));

  app.use('/api', routes);
  app.use('/api', notFoundHandler);

  // ── static client (production build) ────────────────────────────────────
  const dist = config.paths.clientDist;
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, filePath) => {
          if (/\.(js|css|woff2?|png|svg|jpg|webp)$/.test(filePath) && filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // SPA fallback (client-side routing).
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    log.info(`serving client build from ${dist}`);
  } else {
    app.get('*', (_req, res) => {
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><title>Telegram Cloud Drive</title>
           <style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e8ecf8;display:grid;place-items:center;min-height:100vh;margin:0}
           .card{max-width:560px;padding:32px;border-radius:16px;background:#141a2e;border:1px solid #263052}
           code{background:#0b1020;padding:2px 6px;border-radius:6px;color:#8be9fd}</style></head>
           <body><div class="card"><h1>Telegram Cloud Drive API is running</h1>
           <p>The React client has not been built yet. Run:</p>
           <p><code>npm run build --workspace client</code> or <code>npm run dev</code> from the repository root.</p>
           <p>API health: <a style="color:#8be9fd" href="/healthz">/healthz</a></p></div></body></html>`,
        );
    });
  }

  app.use(errorMiddleware);
  return app;
}

async function startJanitor() {
  const hourly = async () => {
    try {
      await cleanupStaleSessions({ olderThanHours: 24 });
      await purgeFinishedJobs({ olderThanDays: 7 });
    } catch (err) {
      log.warn(`janitor: ${err.message}`);
    }
  };
  const daily = async () => {
    try {
      const purged = await purgeOldTrash();
      if (purged) log.info(`auto-purged ${purged} file(s) from trash`);
    } catch (err) {
      log.warn(`trash purge: ${err.message}`);
    }
  };
  const t1 = setInterval(hourly, 60 * 60 * 1000);
  const t2 = setInterval(daily, 24 * 60 * 60 * 1000);
  t1.unref?.();
  t2.unref?.();
  await hourly().catch(() => {});
  await daily().catch(() => {});
}

async function main() {
  log.info(`starting Telegram Cloud Drive (env=${config.env}, node=${process.version})`);
  await initDb();
  const caps = await getCapabilities();
  log.info(`ffmpeg=${caps.ffmpeg.available ? 'yes' : 'no'} · thumbnails=${caps.thumbnails ? 'yes' : 'no'} · transcode=${caps.transcode ? 'yes' : 'no'} · heic=${caps.heic ? 'yes' : 'no'}`);

  const app = createApp();
  const server = http.createServer(app);
  // Large uploads and long-lived streams need generous timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  server.timeout = 0;

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      log.error(`port ${config.port} is already in use. Stop the other server or change PORT in .env.`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      log.error(`port ${config.port} is already in use. Stop the other server or change PORT in .env.`);
      process.exit(1);
    }
    throw err;
  });
  log.info(`listening on http://${config.host}:${config.port}`);

  await recoverJobs();
  await recoverOnBoot();
  await startJanitor();

  const shutdown = async (signal) => {
    log.info(`${signal} received — shutting down`);
    server.close();
    try {
      await disconnectAll();
    } catch {
      /* ignore */
    }
    try {
      await closeDb();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
  process.on('uncaughtException', (err) => log.error('uncaught exception:', err));

  return server;
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  const entryPath = path.resolve(process.argv[1]);
  const currentFile = path.resolve(fileURLToPath(import.meta.url));
  return path.normalize(entryPath).toLowerCase() === path.normalize(currentFile).toLowerCase();
})();

if (isDirectRun) {
  main().catch((err) => {
    log.error('failed to start:', err);
    process.exit(1);
  });
}

export default main;
