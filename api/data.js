import mongoose from 'mongoose';

const schema = new mongoose.Schema({}, { strict: false });

const Home = mongoose.models.Home || mongoose.model('Home', schema, 'home');
const Footer = mongoose.models.Footer || mongoose.model('Footer', schema, 'footer');
const AboutUs = mongoose.models.AboutUs || mongoose.model('AboutUs', schema, 'aboutus');
const Contact = mongoose.models.Contact || mongoose.model('Contact', schema, 'contact');
const Location = mongoose.models.Location || mongoose.model('Location', schema, 'location');
const Menu = mongoose.models.Menu || mongoose.model('Menu', schema, 'menu');
const Navbar = mongoose.models.Navbar || mongoose.model('Navbar', schema, 'navbar');

let isConnected = false;

// ضع هنا الـ API Key الخاص بك
const API_KEY = process.env.API_KEY;

export default function handler(req, res) {
  // التحقق من الـ API Key
  const clientKey = req.headers['x-api-key'];
  if (!clientKey || clientKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }

  // الاتصال بـ MongoDB
  const connectPromise = isConnected
    ? Promise.resolve()
    : mongoose.connect(process.env.MONGO_URI).then(() => { isConnected = true });

  connectPromise
    .then(() => {
      // تحديد الـ Collection اللي هنتعامل معها (مثال: home)
      const collectionMap = {
        home: Home,
        footer: Footer,
        about: AboutUs,
        contact: Contact,
        location: Location,
        menu: Menu,
        navbar: Navbar
      };

      const collectionName = req.query.collection; // ?collection=home
      const Model = collectionMap[collectionName];

      if (!Model) return res.status(400).json({ error: 'Invalid collection name' });

      // التعامل مع كل Method
      if (req.method === 'GET') {
        return Model.find({});
      } else if (req.method === 'POST') {
        return Model.create(req.body);
      } else if (req.method === 'PUT') {
        return Model.findByIdAndUpdate(req.body.id, req.body, { new: true });
      } else if (req.method === 'DELETE') {
        return Model.findByIdAndDelete(req.body.id);
      } else {
        return Promise.reject(new Error('Method not allowed'));
      }
    })
    .then(data => res.status(200).json(data))
    .catch(err => res.status(500).json({ error: err.message }));
}
