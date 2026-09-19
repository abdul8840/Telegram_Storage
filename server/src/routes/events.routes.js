/**
 * Server-Sent Events stream.
 *
 * One connection per browser tab; every upload-progress tick, job update and
 * library change for *this user* is pushed here. SSE (rather than websockets)
 * keeps the stack simple, works through any HTTP proxy and reconnects natively.
 * EventSource cannot set headers, so the JWT may also arrive as ?access_token.
 */
import express from 'express';
import { createLogger } from '../lib/logger.js';
import { bus } from '../lib/events.js';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../db/index.js';

const log = createLogger('sse');
const router = express.Router();

const HEARTBEAT_MS = 25_000;

router.get('/', requireAuth, (req, res) => {
  const userId = String(req.userId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send('connected', { userId, at: Date.now() });

  const onAny = ({ scope, event, payload }) => {
    if (scope !== `user:${userId}`) return;
    send(event, payload);
  };
  bus.on('*', onAny);

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(`: ping ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // Deliver anything that happened between page load and subscription.
  db.jobs
    .find({ userId, status: { $in: ['queued', 'running'] } })
    .then((jobs) => jobs.length && send('jobs:snapshot', { jobs }))
    .catch(() => {});

  const cleanup = () => {
    clearInterval(heartbeat);
    bus.off('*', onAny);
    if (!res.writableEnded) res.end();
    log.debug(`SSE connection closed for user ${userId}`);
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
});

export default router;
