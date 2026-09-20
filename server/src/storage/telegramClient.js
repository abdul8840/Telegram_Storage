/**
 * Telegram (MTProto) client lifecycle + login flow.
 *
 * Uses `teleproto`, the actively maintained successor to GramJS. One client per
 * user is cached in memory, reused for every upload/download and disconnected
 * after a period of idleness so a long-running server does not hold sockets
 * open forever.
 *
 * Session strings and API hashes are encrypted at rest (AES-256-GCM, key
 * derived from SESSION_ENCRYPTION_KEY / JWT_SECRET). Login codes and 2FA
 * passwords are used only by the in-memory login flow and are never persisted.
 */
import teleproto from 'teleproto';
import bigInt from 'big-integer';
import os from 'node:os';
import config from '../config.js';
import { db } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { ApiError, describeTelegramError } from '../lib/errors.js';
import { decrypt, encrypt, randomId } from '../lib/crypto.js';

const { TelegramClient, Api, sessions, utils, Logger } = teleproto;

const log = createLogger('telegram');

// Keep the very chatty MTProto logger quiet by default.
const TG_LOG_LEVEL = process.env.TG_LOG_LEVEL || 'error';
function quietClient(client) {
  try {
    if (typeof client.setLogLevel === 'function') client.setLogLevel(TG_LOG_LEVEL);
    else Logger.setLevel(TG_LOG_LEVEL);
  } catch {
    /* logger level is best-effort */
  }
}

/** userId → { client, account, lastUsed, timer, connecting } */
const clients = new Map();
/** userId → the single in-flight connection promise for this process */
const connectingClients = new Map();
/** userId → { client, session, apiId, apiHash, phone, phoneCodeHash, expires } */
const pendingLogins = new Map();

const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_SCOPE = config.telegram.sessionScope;
const INSTANCE_ID = String(process.env.RENDER_INSTANCE_ID || `${os.hostname()}-${process.pid}-${randomId(4)}`);
const LEASE_TTL_MS = 60_000;
const LEASE_RENEW_MS = 20_000;
const DEPLOYMENT_FIELDS = new Set([
  'apiId',
  'apiHash',
  'apiHashEncrypted',
  'sessionString',
  'phone',
  'status',
  'connectedAt',
  'lastError',
  'leaseOwner',
  'leaseExpiresAt',
]);

const deploymentPath = (field) => `deployments.${SESSION_SCOPE}.${field}`;

function deploymentPatch(patch, includeUpdatedAt = true) {
  const set = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (DEPLOYMENT_FIELDS.has(key)) set[deploymentPath(key)] = value;
    else set[key] = value;
  }
  if (includeUpdatedAt) {
    const timestamp = new Date().toISOString();
    set.updatedAt = timestamp;
    set[deploymentPath('updatedAt')] = timestamp;
  }
  return set;
}

function clientParams() {
  return {
    connectionRetries: 5,
    downloadRetries: 5,
    requestRetries: 5,
    retryDelay: 1000,
    autoReconnect: true,
    sequentialUpdates: true,
    floodSleepThreshold: 60,
    deviceModel: `${config.telegram.deviceModel} (${SESSION_SCOPE})`,
    systemVersion: 'Node.js',
    appVersion: '1.0.0',
    langCode: 'en',
    systemLangCode: 'en',
    maxConcurrentDownloads: config.telegram.maxConcurrentDownloads,
    baseLogger: undefined,
  };
}

function buildClient(sessionString, apiId, apiHash) {
  const session = new sessions.StringSession(sessionString || '');
  const client = new TelegramClient(session, Number(apiId), String(apiHash), clientParams());
  quietClient(client);
  return { client, session };
}

// ── account persistence ────────────────────────────────────────────────────

export async function getAccount(userId) {
  const raw = await db.tgAccounts.findOne({ userId });
  if (!raw) return null;

  let deployment = raw.deployments?.[SESSION_SCOPE] || null;
  // Safely adopt pre-scope records only on localhost. Render intentionally does
  // not inherit the same key, because using it alongside localhost is exactly
  // what causes AUTH_KEY_DUPLICATED.
  if (!deployment && SESSION_SCOPE === 'local' && raw.sessionString) {
    deployment = Object.fromEntries(
      [...DEPLOYMENT_FIELDS]
        .filter((field) => raw[field] !== undefined)
        .map((field) => [field, raw[field]]),
    );
    if (/AUTH_KEY_DUPLICATED|invalidated.*session key/i.test(String(raw.lastError || ''))) {
      deployment.status = 'invalid';
      deployment.sessionString = '';
      deployment.lastError = 'This Telegram login was invalidated because its session key was opened by another server. Reconnect Telegram on this deployment.';
    }
    deployment.updatedAt = raw.updatedAt || new Date().toISOString();
    const set = {};
    for (const [key, value] of Object.entries(deployment)) set[deploymentPath(key)] = value;
    await db.tgAccounts.updateOne({ _id: raw._id }, { $set: set }).catch(() => {});
  }

  return {
    ...raw,
    ...(deployment || {}),
    apiId: deployment?.apiId || null,
    apiHash: deployment?.apiHash || '',
    apiHashEncrypted: !!deployment?.apiHashEncrypted,
    sessionString: deployment?.sessionString || '',
    phone: deployment?.phone || raw.phone || '',
    status: deployment?.status || 'disconnected',
    lastError: deployment?.lastError || null,
    deploymentScope: SESSION_SCOPE,
  };
}

/** Public-safe view of the account (never exposes the session string). */
export function publicAccount(account) {
  if (!account) return null;
  return {
    id: account._id,
    connected: account.status === 'active',
    status: account.status || 'disconnected',
    phone: account.phone ? maskPhone(account.phone) : null,
    firstName: account.firstName || null,
    lastName: account.lastName || null,
    username: account.username || null,
    userId: account.tgUserId || null,
    chatTarget: account.chatTarget || config.telegram.chatTarget,
    chatLabel: account.chatLabel || null,
    isPremium: !!account.isPremium,
    lastError: account.lastError || null,
    connectedAt: account.connectedAt || null,
    updatedAt: account.updatedAt || null,
    deploymentScope: account.deploymentScope || SESSION_SCOPE,
  };
}

export function maskPhone(phone = '') {
  const p = String(phone).replace(/[^\d+]/g, '');
  if (p.length < 6) return p;
  return `${p.slice(0, Math.max(3, p.length - 8))}••••${p.slice(-2)}`;
}

async function upsertAccount(userId, patch) {
  const existing = await db.tgAccounts.findOne({ userId });
  const now = new Date().toISOString();
  if (existing) {
    await db.tgAccounts.updateOne({ _id: existing._id }, { $set: deploymentPatch(patch) });
    return getAccount(userId);
  }
  const shared = {};
  const deployment = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (DEPLOYMENT_FIELDS.has(key)) deployment[key] = value;
    else shared[key] = value;
  }
  const doc = {
    _id: randomId(10),
    userId,
    createdAt: now,
    updatedAt: now,
    ...shared,
    deployments: { [SESSION_SCOPE]: { ...deployment, updatedAt: now } },
  };
  await db.tgAccounts.insertOne(doc);
  return getAccount(userId);
}

async function updateCurrentDeployment(userId, patch) {
  const raw = await db.tgAccounts.findOne({ userId });
  if (!raw) return null;
  await db.tgAccounts.updateOne({ _id: raw._id }, { $set: deploymentPatch(patch) });
  return getAccount(userId);
}

// ── client cache ───────────────────────────────────────────────────────────

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireSessionLease(account) {
  const ownerField = deploymentPath('leaseOwner');
  const expiresField = deploymentPath('leaseExpiresAt');
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
    const result = await db.tgAccounts.updateOne(
      {
        _id: account._id,
        $or: [
          { [ownerField]: INSTANCE_ID },
          { [expiresField]: { $lt: nowIso } },
          { [expiresField]: { $exists: false } },
        ],
      },
      { $set: { [ownerField]: INSTANCE_ID, [expiresField]: expiresAt } },
    );
    if (result.matchedCount) return true;
    if (attempt < 11) await delay(500);
  }
  throw ApiError.conflict(
    'Telegram is active on another instance of this deployment. Wait a few seconds for the previous server to shut down, then retry.',
    undefined,
    'TG_SESSION_BUSY',
  );
}

async function renewSessionLease(accountId) {
  const result = await db.tgAccounts.updateOne(
    { _id: accountId, [deploymentPath('leaseOwner')]: INSTANCE_ID },
    { $set: { [deploymentPath('leaseExpiresAt')]: new Date(Date.now() + LEASE_TTL_MS).toISOString() } },
  );
  return !!result.matchedCount;
}

async function releaseSessionLease(accountId) {
  if (!accountId) return;
  await db.tgAccounts.updateOne(
    { _id: accountId, [deploymentPath('leaseOwner')]: INSTANCE_ID },
    { $unset: { [deploymentPath('leaseOwner')]: true, [deploymentPath('leaseExpiresAt')]: true } },
  ).catch(() => {});
}

function touch(entry) {
  entry.lastUsed = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    void releaseClient(entry.userId, 'idle timeout');
  }, config.telegram.clientIdleTimeoutMs);
  entry.idleTimer.unref?.();
  if (!entry.leaseTimer) {
    entry.leaseTimer = setInterval(() => {
      void renewSessionLease(entry.account?._id).then((renewed) => {
        if (!renewed) void releaseClient(entry.userId, 'session lease lost');
      }).catch((err) => log.warn(`could not renew Telegram session lease: ${err.message}`));
    }, LEASE_RENEW_MS);
    entry.leaseTimer.unref?.();
  }
}

export async function releaseClient(userId, reason = 'released') {
  const entry = clients.get(String(userId));
  if (!entry) return;
  clients.delete(String(userId));
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (entry.leaseTimer) clearInterval(entry.leaseTimer);
  try {
    await entry.client.destroy?.();
  } catch {
    try {
      await entry.client.disconnect();
    } catch {
      /* already gone */
    }
  }
  await releaseSessionLease(entry.account?._id);
  log.debug(`client for user ${userId} disconnected (${reason})`);
}

export async function disconnectAll() {
  await Promise.all([...clients.keys()].map((id) => releaseClient(id, 'shutdown')));
  for (const [, pending] of pendingLogins) {
    try {
      await pending.client.destroy?.();
    } catch {
      /* ignore */
    }
  }
  pendingLogins.clear();
}

/**
 * Returns a connected, authorised client for the user, creating (and caching)
 * one if necessary.
 */
export async function getClient(userId) {
  const key = String(userId);
  const ready = clients.get(key);
  if (ready?.connected && ready.client?.connected) {
    touch(ready);
    return ready;
  }

  const inFlight = connectingClients.get(key);
  if (inFlight) return inFlight;

  const connecting = connectClient(userId, key);
  connectingClients.set(key, connecting);
  try {
    return await connecting;
  } finally {
    if (connectingClients.get(key) === connecting) connectingClients.delete(key);
  }
}

async function connectClient(userId, key = String(userId)) {
  const cached = clients.get(key);
  if (cached) {
    if (cached.connected && cached.client?.connected) {
      touch(cached);
      return cached;
    }
    await releaseClient(key, 'stale cached client');
  }

  const account = await getAccount(userId);
  if (!account) {
    throw ApiError.badRequest('No Telegram account is connected to this profile yet.', null, 'TG_NOT_CONNECTED');
  }
  if (account.status !== 'active' || !account.sessionString) {
    throw ApiError.badRequest(
      account.status === 'invalid'
        ? 'This deployment’s Telegram session was invalidated. Reconnect Telegram in Settings.'
        : 'Your Telegram connection is incomplete. Please finish the login flow.',
      null,
      'TG_NOT_CONNECTED',
    );
  }
  if (!account.apiId || !account.apiHash) {
    throw ApiError.badRequest('Telegram API credentials are missing for this account.', null, 'TG_NO_CREDENTIALS');
  }

  // Transparently upgrade account records created before API-hash encryption
  // was introduced. The update is atomic and does not interrupt the session.
  let apiHash = account.apiHash;
  if (account.apiHashEncrypted) {
    apiHash = decrypt(account.apiHash);
  } else {
    const encryptedHash = encrypt(account.apiHash);
    await updateCurrentDeployment(userId, { apiHash: encryptedHash, apiHashEncrypted: true });
    account.apiHash = encryptedHash;
    account.apiHashEncrypted = true;
  }

  await acquireSessionLease(account);
  const entry = { userId: key, account, connected: false, connecting: null, client: null, lastUsed: Date.now() };
  clients.set(key, entry);

  try {
    const { client, session } = buildClient(decrypt(account.sessionString), account.apiId, apiHash);
    entry.client = client;
    entry.session = session;
    await client.connect();
    const authorized = await client.isUserAuthorized();
    if (!authorized) {
      await releaseClient(key, 'unauthorized');
      await updateCurrentDeployment(userId, { status: 'unauthorized', lastError: 'Session is no longer authorised by Telegram' });
      throw ApiError.unauthorized('Your Telegram session is no longer valid. Please reconnect your Telegram account.');
    }
    entry.connected = true;
    touch(entry);
    log.info(`connected to Telegram as ${account.firstName || account.phone || userId} (scope=${SESSION_SCOPE})`);
    return entry;
  } catch (err) {
    if (clients.has(key)) await releaseClient(key, 'connect failed');
    else await releaseSessionLease(account._id);
    if (err instanceof ApiError) throw err;
    const raw = err?.errorMessage || err?.message || String(err);
    const duplicated = /AUTH_KEY_DUPLICATED/i.test(raw);
    const invalidSession = duplicated || /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i.test(raw);
    const message = describeTelegramError(err);
    log.error(`Telegram connect failed: ${message}`);
    await updateCurrentDeployment(userId, {
      ...(invalidSession ? { status: 'invalid', sessionString: '' } : {}),
      lastError: message,
    }).catch(() => {});
    if (duplicated) {
      throw ApiError.conflict(message, undefined, 'TG_SESSION_DUPLICATED');
    }
    if (invalidSession) {
      throw ApiError.conflict(message, undefined, 'TG_SESSION_INVALID');
    }
    throw ApiError.upstream(`Could not reach Telegram: ${message}`);
  }
}

/** Convenience: client + the stored account document. */
export async function getClientAndAccount(userId) {
  const entry = await getClient(userId);
  return { client: entry.client, account: entry.account, session: entry.session };
}

// ── login flow (3 steps: phone → code → optional 2FA password) ─────────────

function getPending(userId) {
  const pending = pendingLogins.get(String(userId));
  if (!pending) return null;
  if (Date.now() > pending.expires) {
    pendingLogins.delete(String(userId));
    return null;
  }
  return pending;
}

export function loginState(userId) {
  const pending = getPending(userId);
  if (pending) {
    return {
      step: pending.needsPassword ? 'password' : 'code',
      phone: maskPhone(pending.phone),
      isCodeViaApp: pending.isCodeViaApp,
      passwordHint: pending.passwordHint || null,
      expiresInSeconds: Math.max(0, Math.round((pending.expires - Date.now()) / 1000)),
    };
  }
  return { step: 'idle' };
}

/**
 * Step 1 — validate credentials and send the login code to the phone.
 */
export async function beginLogin(userId, { apiId, apiHash, phone, forceSMS = false, sessionString = '' }) {
  const cleanPhone = String(phone || '').replace(/[^\d+]/g, '');
  if (!cleanPhone || cleanPhone.replace(/\D/g, '').length < 7) throw ApiError.badRequest('Enter a valid phone number in international format, e.g. +14155550123');
  if (!apiId || !apiHash) throw ApiError.badRequest('api_id and api_hash are required (get them from my.telegram.org)');

  await releaseClient(userId, 'new Telegram login started');

  const pending = getPending(userId);
  if (pending) {
    try {
      await pending.client.destroy?.();
    } catch {
      /* ignore */
    }
    pendingLogins.delete(String(userId));
  }

  const { client, session } = buildClient(sessionString, Number(apiId), String(apiHash));
  const record = {
    userId: String(userId),
    client,
    session,
    apiId: Number(apiId),
    apiHash: String(apiHash),
    phone: cleanPhone,
    phoneCodeHash: null,
    isCodeViaApp: false,
    needsPassword: false,
    passwordHint: null,
    expires: Date.now() + LOGIN_TTL_MS,
  };
  pendingLogins.set(String(userId), record);

  try {
    await client.connect();
    const result = await client.sendCode({ apiId: Number(apiId), apiHash: String(apiHash) }, cleanPhone, !!forceSMS);
    record.phoneCodeHash = result.phoneCodeHash;
    record.isCodeViaApp = !!result.isCodeViaApp;

    // Telegram may already be authorised for this session string.
    if (await client.isUserAuthorized().catch(() => false)) {
      return await finishLogin(userId, record, { alreadyAuthorized: true });
    }

    return {
      step: 'code',
      phone: maskPhone(cleanPhone),
      isCodeViaApp: record.isCodeViaApp,
      emailRequired: !!result.emailRequired,
      emailCodeSent: !!result.emailCodeSent,
      expiresIn: LOGIN_TTL_MS / 1000,
      message: result.isCodeViaApp
        ? 'Telegram sent the code to your Telegram app.'
        : 'Telegram sent the code by SMS.',
    };
  } catch (err) {
    pendingLogins.delete(String(userId));
    try {
      await client.destroy?.();
    } catch {
      /* ignore */
    }
    const message = describeTelegramError(err);
    log.warn(`beginLogin failed: ${message}`);
    if (/API_ID_INVALID|API_HASH_INVALID/i.test(message)) {
      throw ApiError.badRequest('Telegram rejected these API credentials. Double-check api_id and api_hash from my.telegram.org.');
    }
    if (/PHONE_NUMBER_INVALID/i.test(message)) {
      throw ApiError.badRequest('Telegram says this phone number is invalid. Use the full international format including the + sign.');
    }
    throw ApiError.upstream(`Telegram login failed: ${message}`);
  }
}

/**
 * Step 2 — submit the code Telegram sent.
 */
export async function submitCode(userId, { code }) {
  const record = getPending(userId);
  if (!record) throw ApiError.badRequest('This login attempt expired. Request a new code.');
  if (!code) throw ApiError.badRequest('Enter the code Telegram sent you');

  try {
    await record.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: record.phone,
        phoneCodeHash: record.phoneCodeHash,
        phoneCode: String(code).trim(),
      }),
    );
    return await finishLogin(userId, record, {});
  } catch (err) {
    const message = err?.errorMessage || err?.message || String(err);
    if (/SESSION_PASSWORD_NEEDED/i.test(message)) {
      record.needsPassword = true;
      // Fetch the hint so the UI can show it.
      try {
        const passwordInfo = await record.client.invoke(new Api.account.GetPassword());
        record.passwordHint = passwordInfo.hint || null;
      } catch {
        record.passwordHint = null;
      }
      return { step: 'password', phone: maskPhone(record.phone), passwordHint: record.passwordHint };
    }
    if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/i.test(message)) {
      return { step: 'code', error: 'That code is incorrect. Please try again.', phone: maskPhone(record.phone) };
    }
    if (/PHONE_CODE_EXPIRED/i.test(message)) {
      pendingLogins.delete(String(userId));
      throw ApiError.badRequest('That code expired. Request a new one.');
    }
    if (/PHONE_NUMBER_UNOCCUPIED/i.test(message)) {
      pendingLogins.delete(String(userId));
      throw ApiError.badRequest('This phone number does not have a Telegram account yet. Sign up in the Telegram app first.');
    }
    if (/FLOOD_WAIT_(\d+)/i.test(message)) {
      const seconds = Number(message.match(/FLOOD_WAIT_(\d+)/i)[1]);
      throw ApiError.badRequest(`Telegram is rate limiting this login. Try again in ${seconds} seconds.`);
    }
    log.warn(`submitCode failed: ${message}`);
    throw ApiError.upstream(`Telegram login failed: ${describeTelegramError(err)}`);
  }
}

/**
 * Step 3 — two-factor authentication password (only when the account has it).
 */
export async function submitPassword(userId, { password }) {
  const record = getPending(userId);
  if (!record) throw ApiError.badRequest('This login attempt expired. Start the login again.');
  if (!password) throw ApiError.badRequest('Enter your Telegram two-step verification password');

  try {
    await record.client.signInWithPassword(
      { apiId: record.apiId, apiHash: record.apiHash },
      {
        password: async () => String(password),
        onError: (err) => {
          log.warn(`2FA error: ${err?.message}`);
          return false;
        },
      },
    );
    return await finishLogin(userId, record, {});
  } catch (err) {
    const message = err?.errorMessage || err?.message || String(err);
    if (/PASSWORD_HASH_INVALID|PASSWORD_INVALID/i.test(message)) {
      return { step: 'password', error: 'That password is incorrect.', phone: maskPhone(record.phone), passwordHint: record.passwordHint };
    }
    throw ApiError.upstream(`Telegram login failed: ${describeTelegramError(err)}`);
  }
}

export async function resendCode(userId, { forceSMS = false } = {}) {
  const record = getPending(userId);
  if (!record) throw ApiError.badRequest('This login attempt expired. Request a new code.');
  try {
    const result = await record.client.sendCode({ apiId: record.apiId, apiHash: record.apiHash }, record.phone, forceSMS);
    record.phoneCodeHash = result.phoneCodeHash;
    record.isCodeViaApp = !!result.isCodeViaApp;
    record.expires = Date.now() + LOGIN_TTL_MS;
    return { step: 'code', phone: maskPhone(record.phone), isCodeViaApp: record.isCodeViaApp, message: 'A new code was sent.' };
  } catch (err) {
    throw ApiError.upstream(`Could not resend the code: ${describeTelegramError(err)}`);
  }
}

export function cancelLogin(userId) {
  const record = pendingLogins.get(String(userId));
  pendingLogins.delete(String(userId));
  if (record) {
    record.client.destroy?.().catch(() => {});
  }
  return { step: 'idle' };
}

/** Persists the authorised session and records account details. */
async function finishLogin(userId, record, { alreadyAuthorized = false } = {}) {
  const client = record.client;
  const sessionString = record.session.save();
  let me = null;
  try {
    me = await client.getMe();
  } catch (err) {
    log.warn(`getMe failed after login: ${err.message}`);
  }

  // Resolve the destination chat once, so the UI can show a friendly label and
  // so we fail fast on a bad TG_CHAT_TARGET.
  const chatTarget = config.telegram.chatTarget || 'me';
  let chatLabel = chatTarget === 'me' ? 'Saved Messages' : chatTarget;
  let chatError = null;
  try {
    await resolveEntity(client, chatTarget);
  } catch (err) {
    chatError = describeTelegramError(err);
    chatLabel = 'Saved Messages (fallback)';
  }

  const account = await upsertAccount(String(userId), {
    apiId: record.apiId,
    apiHash: encrypt(record.apiHash),
    apiHashEncrypted: true,
    sessionString: encrypt(sessionString),
    phone: record.phone,
    status: 'active',
    firstName: me?.firstName || null,
    lastName: me?.lastName || null,
    username: me?.username || null,
    tgUserId: me?.id ? me.id.toString() : null,
    isPremium: !!me?.premium,
    chatTarget,
    chatLabel,
    connectedAt: new Date().toISOString(),
    lastError: chatError,
    leaseOwner: INSTANCE_ID,
    leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
  });

  pendingLogins.delete(String(userId));

  // Hand the authorised client straight to the cache (no reconnect needed).
  const entry = { userId: String(userId), client, session: record.session, account, connected: true, lastUsed: Date.now() };
  clients.set(String(userId), entry);
  touch(entry);

  return {
    step: 'done',
    alreadyAuthorized,
    account: publicAccount(account),
    warning: chatError ? `Connected, but the configured chat target could not be resolved: ${chatError}` : null,
  };
}

/** Disconnects and forgets the stored Telegram account. */
export async function disconnectAccount(userId) {
  await releaseClient(userId, 'user disconnect');
  const account = await getAccount(userId);
  if (account) {
    await updateCurrentDeployment(userId, {
      status: 'disconnected',
      sessionString: '',
      apiHash: '',
      apiHashEncrypted: false,
      lastError: null,
      leaseOwner: '',
      leaseExpiresAt: '',
    });
  }
  return { ok: true };
}

/** Updates where files are stored (Saved Messages vs a channel/chat). */
export async function setChatTarget(userId, target) {
  const { client, account } = await getClientAndAccount(userId);
  const resolved = await resolveEntity(client, target);
  const info = await describeEntity(client, resolved, target);
  await db.tgAccounts.updateOne(
    { _id: account._id },
    {
      $set: {
        chatTarget: target,
        chatLabel: info.label,
        chatKind: info.kind,
        updatedAt: new Date().toISOString(),
      },
    },
  );
  await updateCurrentDeployment(userId, { lastError: null });
  await releaseClient(userId, 'chat target changed');
  return info;
}

// ── entity resolution ──────────────────────────────────────────────────────

const SELF_ALIASES = new Set(['me', 'self', 'saved', 'saved messages', '']);

/**
 * Resolves the configured destination ("me", @username, t.me/xxxx, -100123…,
 * or a plain id) into an InputPeer.
 */
export async function resolveEntity(client, target) {
  const raw = target === undefined || target === null ? 'me' : String(target).trim();
  if (SELF_ALIASES.has(raw.toLowerCase())) return new Api.InputPeerSelf();

  const candidates = [];
  if (/^-?\d+$/.test(raw)) {
    const n = raw;
    candidates.push(bigInt(n));
    // Marked channel ids look like -100<id>; users often paste the bare id.
    if (!n.startsWith('-100')) candidates.push(bigInt(`-100${n.replace(/^-/, '')}`));
    else candidates.push(bigInt(n.replace(/^-100/, '')));
  } else {
    candidates.push(raw.replace(/^https?:\/\/t\.me\//i, '@').replace(/^@+/, (m) => m));
    if (!raw.startsWith('@') && !raw.includes('.')) candidates.push(`@${raw}`);
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await client.getInputEntity(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw ApiError.badRequest(
    `Could not resolve the Telegram chat "${raw}". Use "me" for Saved Messages, an @username, a t.me link, or the numeric chat id. ${
      lastError ? `(${describeTelegramError(lastError)})` : ''
    }`,
  );
}

export async function describeEntity(client, peer, target) {
  if (peer instanceof Api.InputPeerSelf) return { label: 'Saved Messages', kind: 'self', id: 'me' };
  try {
    const entity = await client.getEntity(peer);
    const title = entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(' ') || entity?.username || String(target);
    const kind = entity?.className?.toLowerCase?.().includes('channel') ? 'channel' : entity?.className?.toLowerCase?.().includes('chat') ? 'group' : 'user';
    return { label: title, kind, id: entity?.id?.toString?.() || String(target) };
  } catch {
    return { label: String(target), kind: 'unknown', id: String(target) };
  }
}

export { Api, utils, bigInt, TelegramClient, sessions };
export default { getClient, getClientAndAccount, getAccount, publicAccount, resolveEntity, beginLogin, submitCode, submitPassword, loginState };
