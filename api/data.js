import mongoose from 'mongoose';

const schema = new mongoose.Schema({}, { strict: false });

const Home = mongoose.models.Home || mongoose.model('Home', schema, 'home');
const Footer = mongoose.models.Footer || mongoose.model('Footer', schema, 'footer');
const AboutUs = mongoose.models.AboutUs || mongoose.model('AboutUs', schema, 'aboutus');
const Contact = mongoose.models.Contact || mongoose.model('Contact', schema, 'contact');
const Location = mongoose.models.Location || mongoose.model('Location', schema, 'location');
const Menu = mongoose.models.Menu || mongoose.model('Menu', schema, 'menu');
const Navbar = mongoose.models.Navbar || mongoose.model('Navbar', schema, 'navbar');

const collections = { 
  home: Home, 
  footer: Footer, 
  aboutus: AboutUs, 
  contact: Contact, 
  location: Location, 
  menu: Menu, 
  navbar: Navbar 
};

let isConnected = false;

function sendJson(res, status, payload) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  // Basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isConnected) {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      isConnected = true;
    } catch (err) {
      return sendJson(res, 500, { error: 'Database connection failed' });
    }
  }

  try {
    const { method, query, body } = req;
    const { collection, id } = query;

    // لو مافيش collection، رجع كل الـ collections
    if (!collection) {
      const results = await Promise.all(
        Object.keys(collections).map(key => collections[key].find({}))
      );
      const payload = Object.keys(collections).reduce((acc, key, idx) => {
        acc[key] = results[idx];
        return acc;
      }, {});
      return sendJson(res, 200, payload);
    }

    const key = collection.toLowerCase();
    const Model = collections[key];
    if (!Model) return sendJson(res, 404, { error: 'Collection not found' });

    // validate id when required
    const needsId = (method === 'GET' && id) || method === 'PUT' || method === 'DELETE';
    if (needsId && id && !mongoose.Types.ObjectId.isValid(id)) {
      return sendJson(res, 400, { error: 'Invalid id format' });
    }

    switch (method) {
      case 'GET':
        if (id) {
          const doc = await Model.findById(id);
          if (!doc) return sendJson(res, 404, { error: 'Document not found' });
          return sendJson(res, 200, doc);
        }
        return sendJson(res, 200, await Model.find({}));

      case 'POST':
        if (Array.isArray(body)) {
          const created = await Model.insertMany(body);
          return sendJson(res, 201, created);
        } else {
          const created = await Model.create(body);
          return sendJson(res, 201, created);
        }

      case 'PUT':
        if (!id) return sendJson(res, 400, { error: 'ID is required for PUT' });
        const updated = await Model.findByIdAndUpdate(id, body, { new: true, runValidators: false });
        if (!updated) return sendJson(res, 404, { error: 'Document not found' });
        return sendJson(res, 200, updated);

      case 'DELETE':
        if (!id) return sendJson(res, 400, { error: 'ID is required for DELETE' });
        const deleted = await Model.findByIdAndDelete(id);
        if (!deleted) return sendJson(res, 404, { error: 'Document not found' });
        return sendJson(res, 200, deleted);

      default:
        return sendJson(res, 405, { error: 'Method not allowed' });
    }
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
}
