/**
 * MongoDB driver (native `mongodb` package — works with Atlas, Docker, or a
 * local mongod). Exposes the same collection surface as the embedded driver.
 */
import { MongoClient } from 'mongodb';

function normalizeSort(sort) {
  if (!sort) return undefined;
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

export async function createMongoDriver({ uri, name }) {
  const client = new MongoClient(uri, {
    maxPoolSize: 20,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    retryWrites: true,
  });
  await client.connect();
  const database = client.db(name);

  const wrap = (col) => ({
    async insertOne(doc) {
      return col.insertOne(doc);
    },
    async insertMany(docs) {
      const res = await col.insertMany(docs);
      return { insertedIds: Object.values(res.insertedIds), acknowledged: true };
    },
    async findOne(query = {}, { projection } = {}) {
      return col.findOne(query, { projection: normalizeProjection(projection) });
    },
    async find(query = {}, { sort, limit, skip, projection } = {}) {
      let cursor = col.find(query, { projection: normalizeProjection(projection) });
      const normalizedSort = normalizeSort(sort);
      if (normalizedSort) cursor = cursor.sort(normalizedSort);
      if (skip) cursor = cursor.skip(skip);
      if (limit) cursor = cursor.limit(limit);
      return cursor.toArray();
    },
    async countDocuments(query = {}) {
      return col.countDocuments(query);
    },
    async updateOne(query, update, { upsert = false } = {}) {
      const res = await col.updateOne(query, update, { upsert });
      return {
        matchedCount: res.matchedCount,
        modifiedCount: res.modifiedCount,
        upsertedId: res.upsertedId || null,
        acknowledged: true,
      };
    },
    async updateMany(query, update, { upsert = false } = {}) {
      const res = await col.updateMany(query, update, { upsert });
      return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount, acknowledged: true };
    },
    async deleteOne(query) {
      const res = await col.deleteOne(query);
      return { deletedCount: res.deletedCount, acknowledged: true };
    },
    async deleteMany(query) {
      const res = await col.deleteMany(query);
      return { deletedCount: res.deletedCount, acknowledged: true };
    },
    async createIndex(spec, options = {}) {
      return col.createIndex(spec, { background: true, ...options });
    },
    async distinct(field, query = {}) {
      return col.distinct(field, query);
    },
  });

  const cache = new Map();
  return {
    driver: 'mongodb',
    label: `MongoDB · ${name}`,
    raw: database,
    collection(colName) {
      if (!cache.has(colName)) cache.set(colName, wrap(database.collection(colName)));
      return cache.get(colName);
    },
    async ping() {
      await database.command({ ping: 1 });
      return true;
    },
    async close() {
      await client.close();
    },
  };
}

export default createMongoDriver;
