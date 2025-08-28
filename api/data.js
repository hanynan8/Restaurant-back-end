import mongoose from 'mongoose';

// Dynamic Next.js / Express-style API handler for MongoDB collections
// - Automatically lists collections when no `collection` query param is provided
// - Creates Mongoose models on the fly with strict: false (accepts any fields)
// - Supports GET (list or single), POST (create / insertMany), PUT (update by id), DELETE (delete by id)
// - Basic CORS included

let isConnected = false;
const modelCache = {}; // cache dynamic models to avoid re-defining

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(payload);
}

function sanitizeCollectionName(name) {
  // allow only letters, numbers, hyphen and underscore to avoid prototype pollution
  if (!name || typeof name !== 'string') return null;
  const match = name.match(/^[a-zA-Z0-9-_]+$/);
  return match ? name : null;
}

function getModelForCollection(collectionName) {
  const name = collectionName;
  if (modelCache[name]) return modelCache[name];

  // dynamic schema (accept any fields)
  const schema = new mongoose.Schema({}, { strict: false, timestamps: false });
  // Mongoose model names must be unique per connection; we prefix to avoid collisions
  const modelName = `Dynamic__${name}`;
  const model = mongoose.models[modelName] || mongoose.model(modelName, schema, name);
  modelCache[name] = model;
  return model;
}

export default async function handler(req, res) {
  // Basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isConnected) {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        // use the default recommended options for Mongoose 6+
        // keep it minimal here; the environment should provide a correct URI
      });
      isConnected = true;
    } catch (err) {
      return sendJson(res, 500, { error: 'Database connection failed', details: err.message });
    }
  }

  try {
    const { method, query, body } = req;
    const { collection, id } = query;

    // If no collection specified -> return all collections + their docs
    if (!collection) {
      // list collections from the DB (filter out system collections)
      const raw = await mongoose.connection.db.listCollections().toArray();
      const names = raw
        .map(c => c.name)
        .filter(n => !n.startsWith('system.'))
        .filter(Boolean);

      const payload = {};

      // fetch docs for each collection in parallel but limit concurrency mildly
      const promises = names.map(async (name) => {
        try {
          const coll = mongoose.connection.db.collection(name);
          // fetch first 100 docs by default to avoid huge responses
          const docs = await coll.find({}).limit(100).toArray();
          payload[name] = docs;
        } catch (e) {
          payload[name] = { error: e.message };
        }
      });

      await Promise.all(promises);
      return sendJson(res, 200, payload);
    }

    // sanitize collection name
    const sanitized = sanitizeCollectionName(String(collection));
    if (!sanitized) return sendJson(res, 400, { error: 'Invalid collection name' });

    const Model = getModelForCollection(sanitized);

    // helper: try to fetch by id with multiple fallbacks (safer: avoid ObjectId cast errors)
    async function findByIdFlexible(model, idValue) {
      // try convert to number if possible
      const maybeNum = Number(idValue);
      const idAsNumber = !Number.isNaN(maybeNum) ? maybeNum : undefined;

      // 1) if it's a valid ObjectId -> use findById (safe)
      if (mongoose.Types.ObjectId.isValid(idValue)) {
        try {
          const doc = await model.findById(idValue).lean();
          if (doc) return doc;
        } catch (e) {
          // continue to other fallbacks if casting still fails
        }
      }

      // 2) try native driver to find _id as string (avoids Mongoose casting errors)
      try {
        const collName = model.collection && model.collection.name ? model.collection.name : model.modelName;
        const nativeDoc = await mongoose.connection.db.collection(collName).findOne({ _id: idValue });
        if (nativeDoc) return nativeDoc;
      } catch (e) {
        // ignore native errors and continue to other fallbacks
      }

      // 3) try field `id` as string or number
      try {
        const docByIdField = await model.findOne({
          $or: [
            { id: idValue },
            ...(idAsNumber !== undefined ? [{ id: idAsNumber }] : [])
          ]
        }).lean();
        if (docByIdField) return docByIdField;
      } catch (e) {
        // ignore and continue
      }

      // 4) try top-level id2 field
      try {
        const docById2 = await model.findOne({
          $or: [
            { id2: idValue },
            ...(idAsNumber !== undefined ? [{ id2: idAsNumber }] : [])
          ]
        }).lean();
        if (docById2) return docById2;
      } catch (e) {
        // ignore and continue
      }

      // 5) FALLBACK: search inside documents recursively for nested `id` or `id2`
      //    (this scans documents in the collection and returns all matched nested items)
      const results = [];

      function searchRecursive(obj) {
        if (obj == null) return;
        if (Array.isArray(obj)) {
          for (const el of obj) searchRecursive(el);
          return;
        }
        if (typeof obj === 'object') {
          for (const [k, v] of Object.entries(obj)) {
            if ((k === 'id' || k === 'id2')) {
              if (String(v) === String(idValue) || (idAsNumber !== undefined && v === idAsNumber)) {
                // push the parent object (obj) which contains the matched field
                results.push(obj);
              }
            }
            if (v && (typeof v === 'object' || Array.isArray(v))) {
              searchRecursive(v);
            }
          }
        }
      }

      // limit scan to avoid huge collections; adjust limit if needed
      const cursorDocs = await model.find({}).limit(1000).lean();
      for (const d of cursorDocs) {
        searchRecursive(d);
      }

      if (results.length > 0) return results;

      return null;
    }

    switch (method) {
      case 'GET': {
        if (id) {
          const doc = await findByIdFlexible(Model, id);
          if (!doc) return sendJson(res, 404, { error: 'Document not found' });
          return sendJson(res, 200, doc);
        }

        // support optional query params for pagination: ?limit=50&skip=0
        const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 1000);
        const skip = parseInt(query.skip || '0', 10) || 0;

        const docs = await Model.find({}).skip(skip).limit(limit).lean();
        return sendJson(res, 200, docs);
      }

      case 'POST': {
        if (!body) return sendJson(res, 400, { error: 'Missing request body' });

        // create single or many
        if (Array.isArray(body)) {
          const created = await Model.insertMany(body);
          return sendJson(res, 201, created);
        }

        const created = await Model.create(body);
        return sendJson(res, 201, created);
      }

      case 'PUT': {
        if (!id) return sendJson(res, 400, { error: 'ID is required for PUT' });
        if (!body) return sendJson(res, 400, { error: 'Missing request body' });

        // try ObjectId update first, then fallback to string _id
        let updated = null;
        if (mongoose.Types.ObjectId.isValid(id)) {
          updated = await Model.findByIdAndUpdate(id, body, { new: true, runValidators: false }).lean();
        }
        if (!updated) {
          updated = await Model.findOneAndUpdate({ _id: id }, body, { new: true, runValidators: false }).lean();
        }
        if (!updated) {
          updated = await Model.findOneAndUpdate({ id: id }, body, { new: true, runValidators: false }).lean();
        }

        if (!updated) return sendJson(res, 404, { error: 'Document not found' });
        return sendJson(res, 200, updated);
      }

      case 'DELETE': {
        if (!id) return sendJson(res, 400, { error: 'ID is required for DELETE' });

        let deleted = null;
        if (mongoose.Types.ObjectId.isValid(id)) {
          deleted = await Model.findByIdAndDelete(id).lean();
        }
        if (!deleted) {
          deleted = await Model.findOneAndDelete({ _id: id }).lean();
        }
        if (!deleted) {
          deleted = await Model.findOneAndDelete({ id: id }).lean();
        }

        if (!deleted) return sendJson(res, 404, { error: 'Document not found' });
        return sendJson(res, 200, deleted);
      }

      default:
        return sendJson(res, 405, { error: 'Method not allowed' });
    }
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
}
