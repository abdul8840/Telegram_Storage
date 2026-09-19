/**
 * Storage provider registry.
 *
 * New files are always stored in Telegram. The local provider remains in the
 * registry only so objects created by older versions can still be read and
 * deleted.
 */
import config from '../config.js';
import { db } from '../db/index.js';
import { localProvider } from './local.js';
import { telegramProvider } from './telegram.js';
import { nullProvider } from './base.js';

export const providers = {
  local: localProvider,
  telegram: telegramProvider,
};

export function getProviderByName(name) {
  return providers[name] || nullProvider;
}

/**
 * Resolves the provider used for every new upload. This intentionally throws
 * before upload bytes are accepted when Telegram is unavailable.
 */
export async function getProviderForUser(userId) {
  const status = await telegramProvider.status({ userId });
  if (!status.ready) {
    const error = new Error(status.reason || 'Connect Telegram before uploading files.');
    error.status = 409;
    error.code = 'TG_NOT_CONNECTED';
    throw error;
  }
  return { provider: telegramProvider, preference: 'telegram', reason: null };
}

/** Resolves the provider that holds an existing file's bytes. */
export function getProviderForFile(file) {
  const name = file?.storage?.provider || file?.provider;
  return getProviderByName(name);
}

/** Everything the settings screen needs about Telegram storage. */
export async function storageStatus(userId) {
  const telegram = await telegramProvider.status({ userId }).catch((err) => ({ ready: false, reason: err.message }));
  return {
    preference: 'telegram',
    active: telegram.ready ? 'telegram' : 'unavailable',
    telegram,
    uploadReady: !!telegram.ready,
    requiresTelegram: true,
    limits: {
      maxUploadSize: config.limits.maxUploadSize,
      perTelegramFile: telegram?.details?.account?.isPremium ? 4 * 1024 ** 3 : 2 * 1024 ** 3,
    },
  };
}

/** Compatibility export for older callers; local storage cannot be selected. */
export async function setProviderPreference(userId) {
  const value = 'telegram';
  await db.users.updateOne({ _id: userId }, { $set: { 'settings.storageProvider': value, updatedAt: new Date().toISOString() } });
  return { preference: value };
}

export default { providers, getProviderByName, getProviderForUser, getProviderForFile, storageStatus, setProviderPreference };
