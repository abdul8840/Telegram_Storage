/**
 * Embedded database driver.
 *
 * Implements the exact same collection surface as the MongoDB driver, using
 * NeDB (a persistent, Mongo-query-compatible embedded datastore). This is what
 * makes the app runnable with zero configuration — no mongod, no Atlas account.
 * Point MONGODB_URI at a real cluster and the MongoDB driver takes over.
 */
import path from 'node:path';
import fs from 'node:fs';
import Datastore from '@seald-io/nedb';

function normalizeSort(sort) {
  if (!sort) return null;
  if (Array.isArray(sort)) return Object.fromEntries(sort.map(([k, v]) => [k, v === 'desc' || v === -1 ? -1 : 1]));
  const out = {};
  for (const [k, v] of Object.entries(sort)) out[k] = v === 'desc' || v === -1 ? -1 : 1;
  return out;
}

function normalizeProjection(projection) {
  if (!projection) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(projection)) out[k] = v === false || v === 0 ? 0 : 1;
  return out;
}

/**
 * NeDB is Mongo-query-compatible with one important exception: `$regex` must be
 * an actual RegExp (MongoDB also accepts a string + `$options`). We translate
 * recursively so application code can use the MongoDB spelling everywhere.
 */
function normalizeQuery(query) {
  if (Array.isArray(query)) return query.map(normalizeQuery);
  if (!query || typeof query !== 'object') return query;
  if (query instanceof RegExp || query instanceof Date) return query;

  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RegExp) && !(value instanceof Date)) {
      const inner = { ...value };
      if (typeof inner.$regex === 'string' || inner.$regex instanceof RegExp) {
        const source = inner.$regex instanceof RegExp ? inner.$regex.source : inner.$regex;
        let flags = typeof inner.$options === 'string' ? inner.$options : '';
        if (inner.$regex instanceof RegExp && !flags) flags = inner.$regex.flags;
        delete inner.$options;
        try {
          inner.$regex = new RegExp(source, flags.replace(/[^gimsuy]/g, ''));
        } catch {
          inner.$regex = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        }
      }
      out[key] = normalizeQuery(inner);
    } else if (Array.isArray(value)) {
      // $or / $and / $in arrays may themselves contain nested query documents
      out[key] = key === '$in' || key === '$nin' ? value : value.map(normalizeQuery);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clone(value) {
  // NeDB hands back references to in-memory documents; clone them so callers
  // cannot mutate the store by accident (mirrors the MongoDB driver).
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

class EmbeddedCollection {
  constructor(name, dir) {
    this.name = name;
    fs.mkdirSync(dir, { recursive: true });
    this.store = new Datastore({
      filename: path.join(dir, `${name}.db`),
      autoload: true,
      timestampData: false,
      inMemoryOnly: false,
    });
  }

  async insertOne(doc) {
    const inserted = await this.store.insertAsync(clone(doc));
    return { insertedId: inserted._id, acknowledged: true };
  }

  async insertMany(docs) {
    const inserted = await this.store.insertAsync(clone(docs));
    return { insertedIds: (Array.isArray(inserted) ? inserted : [inserted]).map((d) => d._id), acknowledged: true };
  }

  async findOne(query = {}, { projection } = {}) {
    const q = normalizeQuery(query);
    const doc = projection ? await this.store.findOneAsync(q, normalizeProjection(projection)) : await this.store.findOneAsync(q);
    return clone(doc) || null;
  }

  async find(query = {}, { sort, limit, skip, projection } = {}) {
    let cursor = this.store.findAsync(normalizeQuery(query), normalizeProjection(projection));
    const normalizedSort = normalizeSort(sort);
    if (normalizedSort) cursor = cursor.sort(normalizedSort);
    if (skip) cursor = cursor.skip(skip);
    if (limit) cursor = cursor.limit(limit);
    return clone(await cursor.execAsync()) || [];
  }

  async countDocuments(query = {}) {
    return this.store.countAsync(normalizeQuery(query));
  }

  async updateOne(query, update, { upsert = false } = {}) {
    const res = await this.store.updateAsync(normalizeQuery(query), update, {
      upsert,
      multi: false,
      returnUpdatedDocs: true,
    });
    return {
      matchedCount: res.numAffected,
      modifiedCount: res.numAffected,
      upsertedId: res.upserted ? res.upserted._id : null,
      acknowledged: true,
    };
  }

  async updateMany(query, update, { upsert = false } = {}) {
    const res = await this.store.updateAsync(normalizeQuery(query), update, { upsert, multi: true });
    return { matchedCount: res.numAffected, modifiedCount: res.numAffected, acknowledged: true };
  }

  async deleteOne(query) {
    const n = await this.store.removeAsync(normalizeQuery(query), { multi: false });
    return { deletedCount: n, acknowledged: true };
  }

  async deleteMany(query) {
    const n = await this.store.removeAsync(normalizeQuery(query), { multi: true });
    return { deletedCount: n, acknowledged: true };
  }

  async createIndex(spec, options = {}) {
    const fieldName = typeof spec === 'string' ? spec : Object.keys(spec)[0];
    await this.store.ensureIndexAsync({ fieldName, unique: !!options.unique, sparse: !!options.sparse });
    return `${fieldName}_1`;
  }

  async distinct(field, query = {}) {
    const docs = await this.store.findAsync(normalizeQuery(query));
    return [...new Set(docs.map((d) => d?.[field]).filter((v) => v !== undefined && v !== null))];
  }
}

export async function createEmbeddedDriver({ embeddedPath }) {
  const collections = new Map();
  return {
    driver: 'embedded',
    label: `Embedded (NeDB) · ${embeddedPath}`,
    collection(name) {
      if (!collections.has(name)) collections.set(name, new EmbeddedCollection(name, embeddedPath));
      return collections.get(name);
    },
    async ping() {
      return true;
    },
    async close() {
      collections.clear();
    },
  };
}

export default createEmbeddedDriver;
