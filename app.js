import express from 'express';
import mongoose from 'mongoose';
import morgan from 'morgan';

const app = express();

// اتصال بالداتا بيز
const dbURI =
  "mongodb+srv://hanynan:hanynan@hanyscluster.xlpdssw.mongodb.net/Restaurant?retryWrites=true&w=majority&appName=HanysCluster";

mongoose
  .connect(dbURI)
  .then(() => {
    app.listen(3001, () => console.log('Connected to DB and listening on port 3001'));
  })
  .catch(err => console.log(err));

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
