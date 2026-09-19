/** Mounts every API router under /api. */
import express from 'express';
import authRoutes from './auth.routes.js';
import telegramRoutes from './telegram.routes.js';
import uploadRoutes from './uploads.routes.js';
import fileRoutes from './files.routes.js';
import folderRoutes from './folders.routes.js';
import shareRoutes from './shares.routes.js';
import jobRoutes from './jobs.routes.js';
import metaRoutes from './meta.routes.js';
import eventRoutes from './events.routes.js';
import publicRoutes from './public.routes.js';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({
    name: 'ZoZoCloud API',
    version: 1,
    endpoints: [
      'POST   /api/auth/signup | /api/auth/login',
      'GET    /api/auth/me',
      'GET    /api/telegram/status  ·  POST /api/telegram/login/start|code|password',
      'POST   /api/uploads  ·  PUT /api/uploads/:id/chunks/:i  ·  POST /api/uploads/:id/complete',
      'GET    /api/files?view=&folderId=&q=  ·  GET /api/files/:id/stream (HTTP Range)',
      'POST   /api/files/:id/transcode',
      'GET    /api/events (SSE)',
      'GET    /api/public/:token (share links)',
    ],
  });
});

router.use('/auth', authRoutes);
router.use('/telegram', telegramRoutes);
router.use('/uploads', uploadRoutes);
router.use('/files', fileRoutes);
router.use('/folders', folderRoutes);
router.use('/shares', shareRoutes);
router.use('/jobs', jobRoutes);
router.use('/meta', metaRoutes);
router.use('/events', eventRoutes);
router.use('/public', publicRoutes);

export default router;
