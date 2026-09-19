/**
 * Database bootstrap + collection registry.
 *
 *   MONGODB_URI set   → MongoDB driver (production / Atlas); fail fast if unavailable
 *   MONGODB_URI empty → embedded NeDB driver in ./data/db (zero-config dev)
 *
 * Both drivers implement the identical collection surface, so the rest of the
 * codebase never needs to know which one is active.
 */
import config from '../config.js';
import { createLogger } from '../lib/logger.js';
import { createEmbeddedDriver } from './drivers/embedded.js';
import { createMongoDriver } from './drivers/mongo.js';

const log = createLogger('db');

export const COLLECTIONS = {
  users: 'users',
  tgAccounts: 'tg_accounts',
  files: 'files',
  folders: 'folders',
  shares: 'shares',
  uploads: 'uploads',
  jobs: 'jobs',
  activity: 'activity',
};

let driver = null;

export function getDriver() {
  if (!driver) throw new Error('Database not initialised — call initDb() first');
  return driver;
}

export function collection(name) {
  return getDriver().collection(name);
}

/** Convenience accessors used across the app. */
export const db = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const name = COLLECTIONS[prop] || prop;
      return collection(name);
    },
  },
);

export async function initDb() {
  if (driver) return driver;
  if (config.db.uri) {
    try {
      driver = await createMongoDriver({ uri: config.db.uri, name: config.db.name });
      log.info(`connected to MongoDB database "${config.db.name}"`);
    } catch (err) {
      // A configured MongoDB URI is an explicit choice. Falling back here can
      // split user data between MongoDB and a machine-local database without
      // the operator noticing, especially on ephemeral hosting such as Render.
      log.error('MongoDB connection failed — startup aborted:', err.message);
      throw err;
    }
  } else {
    driver = await createEmbeddedDriver({ embeddedPath: config.db.embeddedPath });
    log.info(`no MONGODB_URI set — using embedded database at ${config.db.embeddedPath}`);
  }

  await ensureIndexes();
  return driver;
}

async function ensureIndexes() {
  const specs = [
    [COLLECTIONS.users, { email: 1 }, { unique: true }],
    [COLLECTIONS.tgAccounts, { userId: 1 }, { unique: true }],
    [COLLECTIONS.files, { userId: 1, status: 1 }, {}],
    [COLLECTIONS.files, { userId: 1, folderId: 1 }, {}],
    [COLLECTIONS.files, { userId: 1, kind: 1 }, {}],
    [COLLECTIONS.files, { userId: 1, trashed: 1 }, {}],
    [COLLECTIONS.files, { 'storage.messageId': 1, userId: 1 }, {}],
    [COLLECTIONS.folders, { userId: 1, parentId: 1 }, {}],
    [COLLECTIONS.shares, { token: 1 }, { unique: true }],
    [COLLECTIONS.uploads, { userId: 1, status: 1 }, {}],
    [COLLECTIONS.jobs, { status: 1, createdAt: 1 }, {}],
    [COLLECTIONS.jobs, { userId: 1, fileId: 1 }, {}],
  ];

  for (const [name, spec, options] of specs) {
    try {
      await driver.collection(name).createIndex(spec, options);
    } catch (err) {
      // Index creation is best-effort: embedded mode and some Atlas tiers
      // reject duplicate/unique index creation on non-empty collections.
      log.debug(`index skipped on ${name} ${JSON.stringify(spec)}: ${err.message}`);
    }
  }
}

export async function closeDb() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

export function dbInfo() {
  return driver ? { driver: driver.driver, label: driver.label } : { driver: 'none', label: 'not connected' };
}

export default { initDb, closeDb, db, collection, dbInfo, COLLECTIONS };
