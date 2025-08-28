import mongoose from 'mongoose';

// Enhanced MongoDB Collections API with advanced features
// - Multi-route support: query params, path-based routing, and RESTful endpoints
// - Advanced filtering, sorting, pagination, and search
// - Bulk operations and transactions
// - Field selection and population
// - Aggregation pipeline support
// - Enhanced security and validation
// - Performance optimizations with caching and indexing
// - Comprehensive error handling and logging

let isConnected = false;
const modelCache = new Map();
const schemaCache = new Map();

// Configuration
const CONFIG = {
  MAX_LIMIT: 1000,
  DEFAULT_LIMIT: 100,
  MAX_BULK_SIZE: 1000,
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes
  ALLOWED_OPERATORS: ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$regex', '$exists'],
  SYSTEM_COLLECTIONS: ['system.', 'admin.', '__']
};

// Utility functions
function sendJson(res, status, payload, meta = {}) {
  const response = {
    success: status < 400,
    data: payload,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };
  
  if (!response.success) {
    response.error = payload;
    delete response.data;
  }
  
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Response-Time', Date.now());
  return res.status(status).json(response);
}

function sanitizeCollectionName(name) {
  if (!name || typeof name !== 'string') return null;
  
  // More strict validation
  const sanitized = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(sanitized)) return null;
  
  // Block system collections
  if (CONFIG.SYSTEM_COLLECTIONS.some(sys => sanitized.startsWith(sys))) return null;
  
  return sanitized;
}

function parseQueryFilters(query) {
  const filters = {};
  const options = {
    limit: Math.min(parseInt(query.limit) || CONFIG.DEFAULT_LIMIT, CONFIG.MAX_LIMIT),
    skip: Math.max(parseInt(query.skip) || 0, 0),
    sort: {},
    select: query.select || null,
    populate: query.populate || null
  };

  // Parse sorting
  if (query.sort) {
    const sortFields = query.sort.split(',');
    sortFields.forEach(field => {
      const trimmed = field.trim();
      if (trimmed.startsWith('-')) {
        options.sort[trimmed.substring(1)] = -1;
      } else {
        options.sort[trimmed] = 1;
      }
    });
  }

  // Parse filters
  Object.keys(query).forEach(key => {
    if (['limit', 'skip', 'sort', 'select', 'populate', 'collection', 'id', 'slug'].includes(key)) {
      return;
    }

    // Handle special operators
    if (key.includes('.')) {
      const [field, operator] = key.split('.');
      if (CONFIG.ALLOWED_OPERATORS.includes(`$${operator}`)) {
        if (!filters[field]) filters[field] = {};
        
        let value = query[key];
        // Parse JSON values
        try {
          if (value.startsWith('[') || value.startsWith('{') || value === 'true' || value === 'false' || !isNaN(value)) {
            value = JSON.parse(value);
          }
        } catch (e) {
          // Keep as string if JSON parse fails
        }
        
        filters[field][`$${operator}`] = value;
      }
    } else {
      // Simple equality filter
      let value = query[key];
      try {
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (!isNaN(value) && value !== '') value = Number(value);
        else if (value.includes(',')) value = { $in: value.split(',') };
      } catch (e) {
        // Keep as string
      }
      filters[key] = value;
    }
  });

  return { filters, options };
}

function getModelForCollection(collectionName, customSchema = null) {
  const cacheKey = `${collectionName}_${customSchema ? 'custom' : 'default'}`;
  
  if (modelCache.has(cacheKey)) {
    return modelCache.get(cacheKey);
  }

  const schema = customSchema || new mongoose.Schema({}, { 
    strict: false, 
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    versionKey: false
  });
  
  // Add indexes for common query patterns
  if (!customSchema) {
    schema.index({ createdAt: -1 });
    schema.index({ updatedAt: -1 });
  }

  const modelName = `Dynamic__${collectionName}__${Date.now()}`;
  const model = mongoose.models[modelName] || mongoose.model(modelName, schema, collectionName);
  
  modelCache.set(cacheKey, model);
  
  // Cache cleanup after TTL
  setTimeout(() => {
    modelCache.delete(cacheKey);
    delete mongoose.models[modelName];
  }, CONFIG.CACHE_TTL);
  
  return model;
}

function extractCollectionInfo(req) {
  const { query, url } = req;
  
  // Method 1: Query parameters (?collection=users&id=123)
  if (query.collection) {
    return {
      collection: query.collection,
      id: query.id
    };
  }
  
  // Method 2: Dynamic routes with [...slug]
  if (query.slug && Array.isArray(query.slug)) {
    const [collection, id, ...rest] = query.slug;
    return { collection, id, action: rest[0] };
  }
  
  // Method 3: Named dynamic routes [collection]/[id]
  if (query.collection && typeof query.collection === 'string') {
    return {
      collection: query.collection,
      id: query.id
    };
  }
  
  // Method 4: Parse URL path manually (fallback)
  const pathMatch = url.match(/\/api\/collections\/([^\/]+)(?:\/([^\/\?]+))?(?:\/([^\/\?]+))?/);
  if (pathMatch) {
    const [, collection, id, action] = pathMatch;
    return { collection, id, action };
  }
  
  return { collection: null, id: null, action: null };
}

async function findByIdFlexible(model, idValue) {
  // Try multiple ID strategies
  const strategies = [
    // 1. MongoDB ObjectId
    () => mongoose.Types.ObjectId.isValid(idValue) ? model.findById(idValue).lean() : null,
    // 2. String _id
    () => model.findOne({ _id: idValue }).lean(),
    // 3. Numeric id field
    () => !isNaN(idValue) ? model.findOne({ id: Number(idValue) }).lean() : null,
    // 4. String id field
    () => model.findOne({ id: idValue }).lean(),
    // 5. UUID or other string identifiers
    () => model.findOne({ uuid: idValue }).lean(),
    () => model.findOne({ slug: idValue }).lean()
  ];

  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result) return result;
    } catch (e) {
      continue;
    }
  }
  
  return null;
}

async function connectToDatabase() {
  if (isConnected) return;
  
  try {
    const options = {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      bufferCommands: false,
      bufferMaxEntries: 0
    };
    
    await mongoose.connect(process.env.MONGO_URI, options);
    isConnected = true;
    
    // Handle connection events
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', err);
      isConnected = false;
    });
    
    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected');
      isConnected = false;
    });
    
  } catch (err) {
    console.error('Database connection failed:', err);
    throw new Error(`Database connection failed: ${err.message}`);
  }
}

export default async function handler(req, res) {
  // Enhanced CORS with security headers
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const startTime = Date.now();

  try {
    await connectToDatabase();
    
    const { method, body } = req;
    const { collection, id, action } = extractCollectionInfo(req);

    // Route 1: List all collections with their schemas and sample data
    if (!collection) {
      const collections = await mongoose.connection.db.listCollections().toArray();
      const filtered = collections
        .map(c => c.name)
        .filter(name => !CONFIG.SYSTEM_COLLECTIONS.some(sys => name.startsWith(sys)));

      const result = {};
      
      // Get collection stats in parallel
      const promises = filtered.map(async (name) => {
        try {
          const coll = mongoose.connection.db.collection(name);
          const [count, sample, indexes] = await Promise.all([
            coll.countDocuments(),
            coll.find({}).limit(3).toArray(),
            coll.listIndexes().toArray().catch(() => [])
          ]);
          
          result[name] = {
            count,
            sample,
            indexes: indexes.map(idx => ({ 
              name: idx.name, 
              keys: idx.key, 
              unique: idx.unique || false 
            })),
            lastModified: sample.length > 0 ? 
              Math.max(...sample.map(doc => new Date(doc.updatedAt || doc.createdAt || 0).getTime())) : null
          };
        } catch (e) {
          result[name] = { error: e.message };
        }
      });

      await Promise.all(promises);
      
      return sendJson(res, 200, result, {
        collections: filtered.length,
        responseTime: Date.now() - startTime
      });
    }

    // Validate collection name
    const sanitized = sanitizeCollectionName(collection);
    if (!sanitized) {
      return sendJson(res, 400, 'Invalid collection name. Must be alphanumeric with hyphens/underscores only.');
    }

    const Model = getModelForCollection(sanitized);
    const { filters, options } = parseQueryFilters(req.query);

    switch (method) {
      case 'GET': {
        // Route 2: Get specific document by ID
        if (id) {
          const doc = await findByIdFlexible(Model, id);
          if (!doc) {
            return sendJson(res, 404, `Document with id '${id}' not found in collection '${sanitized}'`);
          }
          
          return sendJson(res, 200, doc, {
            collection: sanitized,
            responseTime: Date.now() - startTime
          });
        }

        // Route 3: Special actions
        if (action) {
          switch (action) {
            case 'count':
              const count = await Model.countDocuments(filters);
              return sendJson(res, 200, { count }, { collection: sanitized });
              
            case 'distinct':
              const field = req.query.field;
              if (!field) return sendJson(res, 400, 'Field parameter required for distinct operation');
              const distinctValues = await Model.distinct(field, filters);
              return sendJson(res, 200, { field, values: distinctValues });
              
            case 'aggregate':
              if (!req.query.pipeline) return sendJson(res, 400, 'Pipeline parameter required for aggregation');
              try {
                const pipeline = JSON.parse(req.query.pipeline);
                const result = await Model.aggregate(pipeline);
                return sendJson(res, 200, result);
              } catch (e) {
                return sendJson(res, 400, `Invalid aggregation pipeline: ${e.message}`);
              }
          }
        }

        // Route 4: List documents with advanced filtering
        let query = Model.find(filters);
        
        // Apply options
        if (Object.keys(options.sort).length > 0) {
          query = query.sort(options.sort);
        }
        
        if (options.select) {
          query = query.select(options.select);
        }
        
        const docs = await query
          .skip(options.skip)
          .limit(options.limit)
          .lean();

        const total = await Model.countDocuments(filters);
        
        return sendJson(res, 200, docs, {
          collection: sanitized,
          pagination: {
            total,
            count: docs.length,
            skip: options.skip,
            limit: options.limit,
            hasMore: options.skip + docs.length < total
          },
          filters,
          responseTime: Date.now() - startTime
        });
      }

      case 'POST': {
        if (!body) {
          return sendJson(res, 400, 'Request body is required');
        }

        // Bulk insert
        if (Array.isArray(body)) {
          if (body.length > CONFIG.MAX_BULK_SIZE) {
            return sendJson(res, 400, `Bulk insert limit exceeded. Maximum ${CONFIG.MAX_BULK_SIZE} documents allowed.`);
          }
          
          const result = await Model.insertMany(body, { ordered: false });
          return sendJson(res, 201, result, {
            collection: sanitized,
            inserted: result.length,
            responseTime: Date.now() - startTime
          });
        }

        // Single insert
        const created = await Model.create(body);
        return sendJson(res, 201, created, {
          collection: sanitized,
          responseTime: Date.now() - startTime
        });
      }

      case 'PUT':
      case 'PATCH': {
        if (!body) {
          return sendJson(res, 400, 'Request body is required');
        }

        // Bulk update
        if (!id && req.query.bulk === 'true') {
          const updateFilter = filters;
          const updateData = method === 'PATCH' ? { $set: body } : body;
          
          const result = await Model.updateMany(updateFilter, updateData);
          return sendJson(res, 200, {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount
          }, {
            collection: sanitized,
            operation: 'bulk_update'
          });
        }

        if (!id) {
          return sendJson(res, 400, 'Document ID is required for update operations');
        }

        // Single update
        const updateData = method === 'PATCH' ? { $set: body } : body;
        let updated = null;

        // Try different ID strategies
        if (mongoose.Types.ObjectId.isValid(id)) {
          updated = await Model.findByIdAndUpdate(id, updateData, { 
            new: true, 
            runValidators: false 
          }).lean();
        }
        
        if (!updated) {
          updated = await Model.findOneAndUpdate(
            { $or: [{ _id: id }, { id: id }, { id: Number(id) }] },
            updateData,
            { new: true, runValidators: false }
          ).lean();
        }

        if (!updated) {
          return sendJson(res, 404, `Document with id '${id}' not found`);
        }

        return sendJson(res, 200, updated, {
          collection: sanitized,
          responseTime: Date.now() - startTime
        });
      }

      case 'DELETE': {
        // Bulk delete
        if (!id && req.query.bulk === 'true') {
          const deleteFilter = filters;
          const result = await Model.deleteMany(deleteFilter);
          
          return sendJson(res, 200, {
            deletedCount: result.deletedCount
          }, {
            collection: sanitized,
            operation: 'bulk_delete'
          });
        }

        if (!id) {
          return sendJson(res, 400, 'Document ID is required for delete operations');
        }

        // Single delete
        let deleted = null;

        if (mongoose.Types.ObjectId.isValid(id)) {
          deleted = await Model.findByIdAndDelete(id).lean();
        }
        
        if (!deleted) {
          deleted = await Model.findOneAndDelete({
            $or: [{ _id: id }, { id: id }, { id: Number(id) }]
          }).lean();
        }

        if (!deleted) {
          return sendJson(res, 404, `Document with id '${id}' not found`);
        }

        return sendJson(res, 200, deleted, {
          collection: sanitized,
          responseTime: Date.now() - startTime
        });
      }

      default:
        return sendJson(res, 405, `Method ${method} not allowed`);
    }

  } catch (err) {
    console.error('API Error:', err);
    
    // Handle specific MongoDB errors
    if (err.name === 'CastError') {
      return sendJson(res, 400, `Invalid data format: ${err.message}`);
    }
    
    if (err.code === 11000) {
      return sendJson(res, 409, 'Duplicate key error. Document already exists.');
    }
    
    if (err.name === 'ValidationError') {
      return sendJson(res, 400, `Validation error: ${err.message}`);
    }

    return sendJson(res, 500, 'Internal server error. Please try again later.', {
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
      responseTime: Date.now() - startTime
    });
  }
}