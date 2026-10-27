const fs = require('fs');
const path = require('path');

// Load settings from .env when the file exists. On a server, set real
// environment variables instead and leave .env out.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { firm, services } = require('./lib/site-data');
const { SQLiteSessionStore } = require('./services/sessionStore');
const { loadUser, sameOriginOnly } = require('./middleware/auth');
const bookingRoutes = require('./routes/booking');
const paymentService = require('./services/paymentService');
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const deskRoutes = require('./routes/desk');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProduction) throw new Error('SESSION_SECRET must be set in production.');
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set: using a temporary one (everyone is logged out on restart).');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProduction) app.set('trust proxy', 1); // HTTPS is usually handled by a proxy in front of the app

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(session({
  name: 'nb.sid',
  secret: sessionSecret,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false, // no cookie until someone logs in
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days of inactivity
  },
}));
app.use(sameOriginOnly);
app.use(loadUser);

app.locals.firm = firm;
app.locals.year = new Date().getFullYear();

app.get('/', (req, res) => {
  res.render('index', { title: `${firm.name} | ${firm.tagline}`, services });
});

app.use('/', authRoutes);
app.use('/booking', bookingRoutes);
app.get('/booking-success', bookingRoutes.bookingSuccess);
app.use('/my-consultations', accountRoutes);
app.use('/desk', deskRoutes);

app.use((req, res) => {
  res.status(404).send('Page not found. <a href="/">Back to home</a>');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again, or call us. <a href="/">Back to home</a>');
});

app.listen(PORT, () => {
  console.log(`${firm.name} is running at http://localhost:${PORT}`);
});

// Every 5 minutes, settle unpaid checkouts: Booked if Stripe says they were paid
// (e.g. the client closed the tab before returning), otherwise release the slot.
const reconcile = () => paymentService.reconcileStalePending().catch((err) => console.error('[payments]', err.message));
setInterval(reconcile, 5 * 60 * 1000).unref();
reconcile();
