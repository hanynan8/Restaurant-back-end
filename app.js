import express from 'express';
import mongoose from 'mongoose';
import morgan from 'morgan';

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ====== Schemas & Models ======
const schema = new mongoose.Schema({}, { strict: false });

const Home = mongoose.model('Home', schema, 'home');
const Footer = mongoose.model('Footer', schema, 'footer');
const AboutUs = mongoose.model('AboutUs', schema, 'aboutus');
const Contact = mongoose.model('Contact', schema, 'contact');
const Location = mongoose.model('Location', schema, 'location');
const Menu = mongoose.model('Menu', schema, 'menu');
const Navbar = mongoose.model('Navbar', schema, 'navbar');

// ====== MongoDB Connection ======
const dbURI = process.env.DB_URI;

mongoose
  .connect(dbURI)
  .then(() => {
    const port = process.env.PORT || 3001;
    app.listen(port, () => console.log(`Connected to DB and listening on port ${port}`));
  })
  .catch(err => console.error('Error connecting to DB:', err.message));

// ====== Route API واحد لكل البيانات ======
app.get('/api/data', (req, res) => {
  Promise.all([
    Home.find({}),
    Footer.find({}),
    AboutUs.find({}),
    Contact.find({}),
    Location.find({}),
    Menu.find({}),
    Navbar.find({})
  ])
    .then(([homeData, footerData, aboutData, contactData, locationData, menuData, navbarData]) => {
      res.json({
        home: homeData,
        footer: footerData,
        about: aboutData,
        contact: contactData,
        location: locationData,
        menu: menuData,
        navbar: navbarData
      });
    })
    .catch(err => res.status(500).json({ error: err.message }));
});
