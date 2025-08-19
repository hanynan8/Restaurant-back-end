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

export default async function handler(req, res) {
  if (!isConnected) {
    await mongoose.connect(process.env.MONGO_URI);
    isConnected = true;
  }

  try {
    const [homeData, footerData, aboutData, contactData, locationData, menuData, navbarData] =
      await Promise.all([
        Home.find({}),
        Footer.find({}),
        AboutUs.find({}),
        Contact.find({}),
        Location.find({}),
        Menu.find({}),
        Navbar.find({})
      ]);

    res.status(200).json({
      home: homeData,
      footer: footerData,
      about: aboutData,
      contact: contactData,
      location: locationData,
      menu: menuData,
      navbar: navbarData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
