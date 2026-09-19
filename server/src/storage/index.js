/**
 * Provider registry.
 *
 * Files record which backend holds their bytes, so a library can mix Telegram
 * and local objects freely. When the user prefers Telegram but has not finished
 * connecting an account, we transparently fall back to local storage (and say
 * so in the UI) instead of failing the upload.
 */
import config from '../config.js';
import { db } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { localProvider } from './local.js';
import { telegramProvider } from './telegram.js';
import { nullProvider } from './base.js';

const log = createLogger('storage');

export const providers = {
  local: localProvider,
  telegram: telegramProvider,
};

export function getProviderByName(name) {
  return providers[name] || nullProvider;
}

async function userPreference(userId) {
  const user = await db.users.findOne({ _id: userId }, { projection: { settings: 1 } });
  return user?.settings?.storageProvider || config.storage.defaultProvider || 'local';
}

/**
 * Resolves the provider used for NEW uploads for this user.
 * @returns {Promise<{provider: object, preference: string, reason: string|null}>}
 */
export async function getProviderForUser(userId) {
  const preference = await userPreference(userId);
  if (preference === 'telegram') {
    const status = await telegramProvider.status({ userId });
    if (status.ready) return { provider: telegramProvider, preference, reason: null };
    log.debug(`telegram preferred but unavailable (${status.reason}) — falling back to local storage`);
    return {
      provider: localProvider,
      preference,
      reason: status.reason || 'Telegram is not connected; the file was stored locally instead.',
      fallback: true,
    };
  }
  return { provider: localProvider, preference, reason: null };
}

/** Resolves the provider that holds an existing file's bytes. */
export function getProviderForFile(file) {
  const name = file?.storage?.provider || file?.provider;
  return getProviderByName(name);
}

/** Everything the settings screen needs about both backends. */
export async function storageStatus(userId) {
  const [telegram, local] = await Promise.all([
    telegramProvider.status({ userId }).catch((err) => ({ ready: false, reason: err.message })),
    localProvider.status({ userId }).catch((err) => ({ ready: false, reason: err.message })),
  ]);
  const preference = await userPreference(userId);
  const active = preference === 'telegram' && telegram.ready ? telegramProvider : localProvider;
  return {
    preference,
    active: active.name,
    telegram,
    local,
    fellBack: preference === 'telegram' && !telegram.ready,
    limits: {
      maxUploadSize: config.limits.maxUploadSize,
      perTelegramFile: telegram?.details?.account?.isPremium ? 4 * 1024 ** 3 : 2 * 1024 ** 3,
    },
  };
}

export async function setProviderPreference(userId, preference) {
  const value = preference === 'telegram' ? 'telegram' : 'local';
  await db.users.updateOne({ _id: userId }, { $set: { 'settings.storageProvider': value, updatedAt: new Date().toISOString() } });
  return { preference: value };
}

export default { providers, getProviderByName, getProviderForUser, getProviderForFile, storageStatus, setProviderPreference };
