/** Background job routes (transcode / regenerate progress + cancellation). */
import express from 'express';
import { asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { cancelJob, getJob, listJobs } from '../services/jobs.js';

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    res.json({ jobs: await listJobs(req.userId, { limit }) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getJob(req.userId, req.params.id));
  }),
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    res.json(await cancelJob({ userId: req.userId, jobId: req.params.id }));
  }),
);

export default router;
