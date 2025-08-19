import mongoose from 'mongoose';

const schema = new mongoose.Schema({}, { strict: false });

const Home = mongoose.models.Home || mongoose.model('Home', schema, 'home');
const Footer = mongoose.models.Footer || mongoose.model('Footer', schema, 'footer');
const AboutUs = mongoose.models.AboutUs || mongoose.model('AboutUs', schema, 'aboutus');
const Contact = mongoose.models.Contact || mongoose.model('Contact', schema, 'contact');
const Location = mongoose.models.Location || mongoose.model('Location', schema, 'location');
const Menu = mongoose.models.Menu || mongoose.model('Menu', schema, 'menu');
const Navbar = mongoose.models.Navbar || mongoose.model('Navbar', schema, 'navbar');

const collections = { home: Home, footer: Footer, aboutus: AboutUs, contact: Contact, location: Location, menu: Menu, navbar: Navbar };

let isConnected = false;

export default function handler(req, res) {
  const connectPromise = isConnected
    ? Promise.resolve()
    : mongoose.connect(process.env.MONGO_URI).then(() => {
        isConnected = true;
      });

  connectPromise
    .then(() => {
      const { method, query, body } = req;
      const { collection, id } = query; // استخدم query لتحديد الـ Collection و ID لو حبيت
      
      const Model = collections[collection?.toLowerCase()];
      if (!Model) return Promise.reject(new Error('Collection not found'));

      switch (method) {
        case 'GET':
          if (id) return Model.findById(id); // جلب عنصر واحد
          return Model.find({}); // جلب كل العناصر
        case 'POST':
          return Model.create(body); // إضافة عنصر جديد
        case 'PUT':
          if (!id) return Promise.reject(new Error('ID is required for PUT'));
          return Model.findByIdAndUpdate(id, body, { new: true });
        case 'DELETE':
          if (!id) return Promise.reject(new Error('ID is required for DELETE'));
          return Model.findByIdAndDelete(id);
        default:
          return Promise.reject(new Error('Method not allowed'));
      }
    })
    .then((data) => {
      res.status(200).json(data);
    })
    .catch((err) => {
      res.status(500).json({ error: err.message });
    });
}
