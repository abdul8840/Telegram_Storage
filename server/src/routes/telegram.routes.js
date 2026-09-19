/**
 * Telegram connection routes: credentials → phone code → 2FA, plus destination
 * chat selection, remote browsing and importing existing media.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import config from '../config.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';
import {
  beginLogin,
  cancelLogin,
  disconnectAccount,
  getAccount,
  getClientAndAccount,
  loginState,
  publicAccount,
  resendCode,
  resolveEntity,
  setChatTarget,
  submitCode,
  submitPassword,
} from '../storage/telegramClient.js';
import { telegramProvider } from '../storage/telegram.js';
import { importFromTelegram } from '../services/importer.js';

const log = createLogger('telegram:http');
const router = express.Router();

router.use(requireAuth);

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many Telegram login attempts — please wait a few minutes.' },
});

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const [account, status] = await Promise.all([getAccount(req.userId), telegramProvider.status({ userId: req.userId })]);
    res.json({
      account: publicAccount(account),
      status,
      login: loginState(req.userId),
      // Prefill the wizard when the operator provided credentials via .env.
      prefill:
        config.telegram.apiId && config.telegram.apiHash
          ? { apiId: config.telegram.apiId, apiHash: config.telegram.apiHash, phone: config.telegram.phone || '' }
          : null,
      chatTarget: account?.chatTarget || config.telegram.chatTarget || 'me',
    });
  }),
);

const startSchema = z.object({
  apiId: z.union([z.number(), z.string()]).transform((v) => Number(String(v).trim())).optional(),
  apiHash: z.string().trim().optional(),
  phone: z.string().trim().min(5),
  forceSMS: z.boolean().optional(),
});

router.post(
  '/login/start',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const parsed = startSchema.safeParse(req.body || {});
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid login request');
    const apiId = parsed.data.apiId || config.telegram.apiId;
    const apiHash = parsed.data.apiHash || config.telegram.apiHash;
    if (!apiId || !apiHash) throw ApiError.badRequest('api_id and api_hash are required — create them at my.telegram.org');
    const result = await beginLogin(req.userId, {
      apiId,
      apiHash,
      phone: parsed.data.phone,
      forceSMS: !!parsed.data.forceSMS,
    });
    log.info(`telegram login started for user ${req.userId} (${result.phone})`);
    res.json(result);
  }),
);

router.post(
  '/login/code',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const code = String(req.body?.code || '').trim();
    if (!code) throw ApiError.badRequest('Enter the code Telegram sent you');
    res.json(await submitCode(req.userId, { code }));
  }),
);

router.post(
  '/login/password',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const password = String(req.body?.password || '');
    if (!password) throw ApiError.badRequest('Enter your two-step verification password');
    res.json(await submitPassword(req.userId, { password }));
  }),
);

router.post(
  '/login/resend',
  loginLimiter,
  asyncHandler(async (req, res) => {
    res.json(await resendCode(req.userId, { forceSMS: !!req.body?.forceSMS }));
  }),
);

router.post('/login/cancel', (req, res) => {
  res.json(cancelLogin(req.userId));
});

/** Actively checks the session and destination chat (opens a connection). */
router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    res.json(await telegramProvider.verifyConnection({ userId: req.userId }));
  }),
);

router.post(
  '/disconnect',
  asyncHandler(async (req, res) => {
    res.json(await disconnectAccount(req.userId));
  }),
);

router.patch(
  '/chat-target',
  asyncHandler(async (req, res) => {
    const target = String(req.body?.target ?? 'me').trim();
    const info = await setChatTarget(req.userId, target);
    res.json({ ok: true, ...info });
  }),
);

/** Lists dialogs so the user can pick a destination chat instead of typing ids. */
router.get(
  '/chats',
  asyncHandler(async (req, res) => {
    const { client } = await getClientAndAccount(req.userId);
    const limit = Math.min(Number(req.query.limit) || 40, 100);
    const dialogs = await client.getDialogs({ limit });
    const chats = [];
    for (const dialog of dialogs || []) {
      const entity = dialog.entity || dialog.dialog?.peer;
      const id = entity?.id?.toString?.() || dialog.id?.toString?.();
      if (!id) continue;
      const isChannel = !!dialog.isChannel || entity?.className === 'Channel';
      const isGroup = !!dialog.isGroup || entity?.className === 'Chat';
      const isUser = !!dialog.isUser || entity?.className === 'User';
      chats.push({
        id,
        title: dialog.title || entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || `chat ${id}`,
        username: entity?.username || null,
        kind: isChannel ? 'channel' : isGroup ? 'group' : isUser ? 'user' : 'chat',
        // Channels/groups need the marked id (-100…) when passed back to us.
        value: isChannel ? `-100${id}` : id,
      });
    }
    res.json({ chats, savedMessages: { value: 'me', title: 'Saved Messages', kind: 'self' } });
  }),
);

/** Browses media already stored in Telegram (for importing). */
router.get(
  '/remote',
  asyncHandler(async (req, res) => {
    const filter = ['all', 'video', 'photo', 'document', 'audio'].includes(req.query.filter) ? req.query.filter : 'all';
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    const offsetId = Number(req.query.offsetId) || 0;
    const target = req.query.target ? String(req.query.target) : undefined;
    const result = await telegramProvider.listRemote({ userId: req.userId, target, limit, offsetId, filter });
    res.json(result);
  }),
);

router.post(
  '/import',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      items: z.array(z.any()).optional(),
      messageIds: z.array(z.union([z.number(), z.string()])).optional(),
      folderId: z.string().nullable().optional(),
      filter: z.enum(['all', 'video', 'photo', 'document', 'audio']).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      target: z.string().optional(),
      thumbnails: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message || 'Invalid import request');

    let items = parsed.data.items || [];
    if (!items.length && parsed.data.messageIds?.length) {
      const account = await getAccount(req.userId);
      const { client } = await getClientAndAccount(req.userId);
      const peer = await resolveEntity(client, parsed.data.target || account?.chatTarget || 'me');
      const messages = await client.getMessages(peer, { ids: parsed.data.messageIds.map(Number) });
      items = (messages || [])
        .filter((m) => m?.media?.document || m?.media?.photo)
        .map((m) => {
          const doc = m.media.document || m.media.photo;
          const nameAttr = (doc.attributes || []).find((a) => a.className === 'DocumentAttributeFilename');
          return {
            messageId: m.id,
            name: nameAttr?.fileName || `telegram-${m.id}`,
            size: Number(doc.size) || 0,
            mimeType: doc.mimeType || '',
            date: m.date ? new Date(m.date * 1000).toISOString() : null,
            storage: {
              provider: 'telegram',
              entityRef: parsed.data.target || account?.chatTarget || 'me',
              messageId: m.id,
              mediaType: m.media.photo ? 'photo' : 'document',
              documentId: doc.id.toString(),
              accessHash: doc.accessHash ? doc.accessHash.toString() : '0',
              fileReference: doc.fileReference ? Buffer.from(doc.fileReference).toString('base64') : '',
              dcId: doc.dcId ?? undefined,
              size: Number(doc.size) || 0,
              mimeType: doc.mimeType || undefined,
              thumbSize: m.media.photo && Array.isArray(doc.sizes) && doc.sizes.length ? doc.sizes[doc.sizes.length - 1].type : '',
            },
          };
        });
    }
    if (!items.length && (parsed.data.filter || parsed.data.limit)) {
      const remote = await telegramProvider.listRemote({
        userId: req.userId,
        target: parsed.data.target,
        filter: parsed.data.filter || 'all',
        limit: parsed.data.limit || 50,
      });
      items = remote.items;
    }
    if (!items.length) throw ApiError.badRequest('Nothing to import — pass items, messageIds, or a filter');

    const result = await importFromTelegram({
      userId: req.userId,
      items,
      folderId: parsed.data.folderId || null,
      thumbnails: parsed.data.thumbnails !== false,
    });
    res.status(202).json(result);
  }),
);

export default router;
