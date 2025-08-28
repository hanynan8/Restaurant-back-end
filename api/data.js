import mongoose from 'mongoose';

// Improved MongoDB API handler for Next.js/Express
// - Enhanced security and error handling
// - Better routing with multiple parameter support
// - Advanced query capabilities with filtering, sorting, and pagination
// - Optimized performance with connection pooling and caching

let isConnected = false;
const modelCache = {};
const MAX_LIMIT = 1000; // Maximum documents to return in a single query

// Utility function to standardize responses
function sendJson(res, status, payload, message = '') {
  const response = {
    success: status >= 200 && status < 300,
    message,
    data: payload
  };
  
  if (status >= 400) {
    response.error = payload;
    delete response.data;
  }
  
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(response);
}

// Enhanced collection name validation
function sanitizeCollectionName(name) {
  if (!name || typeof name !== 'string') return null;
  
  // Prevent access to system collections and allow only alphanumeric, hyphen, underscore
  if (name.startsWith('system.') || name.includes('$')) return null;
  
  const match = name.match(/^[a-zA-Z0-9-_]+$/);
  return match ? name : null;
}

// Get or create model for collection with caching
function getModelForCollection(collectionName) {
  const sanitizedName = sanitizeCollectionName(collectionName);
  if (!sanitizedName) throw new Error('Invalid collection name');
  
  if (modelCache[sanitizedName]) return modelCache[sanitizedName];
  
  const schema = new mongoose.Schema({}, { 
    strict: false, 
    timestamps: false,
    versionKey: false
  });
  
  const modelName = `Dynamic__${sanitizedName}`;
  const model = mongoose.models[modelName] || mongoose.model(modelName, schema, sanitizedName);
  modelCache[sanitizedName] = model;
  return model;
}

// Enhanced parameter extraction from URL
function extractRequestParams(req) {
  const { query, method } = req;
  
  // Handle different routing patterns
  if (query.slug && Array.isArray(query.slug)) {
    const [collection, id, action] = query.slug;
    return { collection, id, action };
  }
  
  if (query.collection) {
    return {
      collection: query.collection,
      id: query.id,
      action: query.action
    };
  }
  
  // Extract from path if using dynamic routing
  const urlParts = req.url.split('/').filter(part => part && part !== 'api' && part !== 'collections');
  if (urlParts.length > 0) {
    return {
      collection: urlParts[0],
      id: urlParts[1],
      action: urlParts[2]
    };
  }
  
  return { collection: null, id: null, action: null };
}

// Flexible document finder by ID
async function findDocumentById(model, idValue) {
  if (!idValue) return null;
  
  // Try as ObjectId first
  if (mongoose.Types.ObjectId.isValid(idValue)) {
    const doc = await model.findById(idValue).lean();
    if (doc) return doc;
  }
  
  // Try other possible ID fields
  const idFields = ['_id', 'id', 'slug', 'uuid', 'email', 'username'];
  for (const field of idFields) {
    const doc = await model.findOne({ [field]: idValue }).lean();
    if (doc) return doc;
  }
  
  return null;
}

// Build filter from query parameters
function buildFilterFromQuery(query) {
  const filter = {};
  const excludedParams = ['collection', 'id', 'action', 'limit', 'skip', 'sort', 'fields', 'populate'];
  
  Object.keys(query).forEach(key => {
    if (!excludedParams.includes(key)) {
      // Handle special query operators
      if (key.startsWith('$')) {
        // Support for advanced operators like $gt, $lt, etc.
        const operator = key;
        const fieldValuePairs = query[key];
        
        if (typeof fieldValuePairs === 'object') {
          Object.keys(fieldValuePairs).forEach(field => {
            if (!filter[field]) filter[field] = {};
            filter[field][operator] = fieldValuePairs[field];
          });
        }
      } else {
        // Regular equality filter
        filter[key] = query[key];
      }
    }
  });
  
  return filter;
}

// Apply sorting to query
function applySorting(query, sortParam) {
  if (!sortParam) return query;
  
  const sortOptions = {};
  const sortFields = sortParam.split(',');
  
  sortFields.forEach(field => {
    if (field.startsWith('-')) {
      sortOptions[field.substring(1)] = -1; // Descending
    } else {
      sortOptions[field] = 1; // Ascending
    }
  });
  
  return query.sort(sortOptions);
}

// Apply field selection to query
function applyFieldSelection(query, fieldsParam) {
  if (!fieldsParam) return query;
  
  const projection = {};
  const fields = fieldsParam.split(',');
  
  fields.forEach(field => {
    projection[field] = 1;
  });
  
  return query.select(projection);
}

// Main API handler
export default async function handler(req, res) {
  // Enhanced CORS handling
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGINS || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Connect to MongoDB if not already connected
  if (!isConnected) {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      isConnected = true;
      console.log('MongoDB connected successfully');
    } catch (err) {
      return sendJson(res, 500, { 
        error: 'Database connection failed', 
        details: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
      });
    }
  }
  
  try {
    const { method, body, query } = req;
    const { collection, id, action } = extractRequestParams(req);
    
    // Handle requests without collection specified
    if (!collection) {
      if (method !== 'GET') {
        return sendJson(res, 400, null, 'Collection name is required');
      }
      
      // List available collections
      const collections = await mongoose.connection.db.listCollections().toArray();
      const collectionNames = collections
        .map(c => c.name)
        .filter(n => !n.startsWith('system.'))
        .sort();
      
      return sendJson(res, 200, collectionNames, 'Available collections');
    }
    
    // Validate collection name
    const sanitizedCollection = sanitizeCollectionName(collection);
    if (!sanitizedCollection) {
      return sendJson(res, 400, null, 'Invalid collection name');
    }
    
    const Model = getModelForCollection(sanitizedCollection);
    
    // Handle different HTTP methods
    switch (method) {
      case 'GET': {
        if (id) {
          // Get specific document by ID
          const doc = await findDocumentById(Model, id);
          if (!doc) {
            return sendJson(res, 404, null, 'Document not found');
          }
          
          // Handle specific actions on documents
          if (action === 'count') {
            return sendJson(res, 200, { count: 1 }, 'Document count');
          }
          
          return sendJson(res, 200, doc, 'Document retrieved successfully');
        } else {
          // Get multiple documents with filtering, sorting, and pagination
          const limit = Math.min(parseInt(query.limit) || 50, MAX_LIMIT);
          const skip = parseInt(query.skip) || 0;
          const filter = buildFilterFromQuery(query);
          
          let dbQuery = Model.find(filter);
          
          // Apply sorting if specified
          if (query.sort) {
            dbQuery = applySorting(dbQuery, query.sort);
          }
          
          // Apply field selection if specified
          if (query.fields) {
            dbQuery = applyFieldSelection(dbQuery, query.fields);
          }
          
          // Execute query with pagination
          const [docs, total] = await Promise.all([
            dbQuery.skip(skip).limit(limit).lean(),
            Model.countDocuments(filter)
          ]);
          
          return sendJson(res, 200, {
            documents: docs,
            pagination: {
              total,
              limit,
              skip,
              hasMore: skip + docs.length < total
            }
          }, 'Documents retrieved successfully');
        }
      }
      
      case 'POST': {
        if (id && action === 'bulk') {
          // Bulk operations on specific documents
          if (!Array.isArray(body)) {
            return sendJson(res, 400, null, 'Array of operations required for bulk update');
          }
          
          const results = await Model.bulkWrite(body);
          return sendJson(res, 200, results, 'Bulk operation completed');
        }
        
        if (!body) {
          return sendJson(res, 400, null, 'Request body is required');
        }
        
        // Create single or multiple documents
        if (Array.isArray(body)) {
          const created = await Model.insertMany(body, { ordered: false });
          return sendJson(res, 201, created, 'Documents created successfully');
        }
        
        const created = await Model.create(body);
        return sendJson(res, 201, created, 'Document created successfully');
      }
      
      case 'PUT':
      case 'PATCH': {
        if (!id) {
          return sendJson(res, 400, null, 'Document ID is required for update');
        }
        
        if (!body || typeof body !== 'object') {
          return sendJson(res, 400, null, 'Valid update data is required');
        }
        
        const options = { new: true, runValidators: false };
        let updatedDoc;
        
        // Try different approaches to find and update the document
        if (mongoose.Types.ObjectId.isValid(id)) {
          updatedDoc = await Model.findByIdAndUpdate(id, body, options);
        }
        
        if (!updatedDoc) {
          updatedDoc = await Model.findOneAndUpdate({ _id: id }, body, options);
        }
        
        if (!updatedDoc) {
          // Try other possible ID fields
          const idFields = ['id', 'slug', 'uuid', 'email', 'username'];
          for (const field of idFields) {
            updatedDoc = await Model.findOneAndUpdate({ [field]: id }, body, options);
            if (updatedDoc) break;
          }
        }
        
        if (!updatedDoc) {
          return sendJson(res, 404, null, 'Document not found');
        }
        
        return sendJson(res, 200, updatedDoc, 'Document updated successfully');
      }
      
      case 'DELETE': {
        if (!id) {
          return sendJson(res, 400, null, 'Document ID is required for deletion');
        }
        
        let deletedDoc;
        
        if (mongoose.Types.ObjectId.isValid(id)) {
          deletedDoc = await Model.findByIdAndDelete(id);
        }
        
        if (!deletedDoc) {
          deletedDoc = await Model.findOneAndDelete({ _id: id });
        }
        
        if (!deletedDoc) {
          // Try other possible ID fields
          const idFields = ['id', 'slug', 'uuid', 'email', 'username'];
          for (const field of idFields) {
            deletedDoc = await Model.findOneAndDelete({ [field]: id });
            if (deletedDoc) break;
          }
        }
        
        if (!deletedDoc) {
          return sendJson(res, 404, null, 'Document not found');
        }
        
        return sendJson(res, 200, deletedDoc, 'Document deleted successfully');
      }
      
      default:
        return sendJson(res, 405, null, 'Method not allowed');
    }
  } catch (err) {
    console.error('API Error:', err);
    
    // Handle specific error types
    if (err.name === 'ValidationError') {
      return sendJson(res, 400, err.errors, 'Validation error');
    }
    
    if (err.code === 11000) {
      return sendJson(res, 409, null, 'Duplicate key error');
    }
    
    return sendJson(res, 500, 
      process.env.NODE_ENV === 'development' ? err.message : 'Internal server error', 
      'An error occurred'
    );
  }
}