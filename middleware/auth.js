// Login helpers shared by the routes.
const userService = require('../services/userService');

// Makes the logged-in client available to every page as `currentUser`.
function loadUser(req, res, next) {
  const user = req.session && req.session.userId ? userService.findUserById(req.session.userId) : null;
  if (req.session && req.session.userId && !user) delete req.session.userId; // account no longer exists
  req.user = user;
  res.locals.currentUser = user;
  res.locals.currentPath = req.path;
  next();
}

// Pages that need a logged-in client send everyone else to the login page.
function requireLogin(req, res, next) {
  if (req.user) return next();
  const nextUrl = req.method === 'GET' ? req.originalUrl : '/my-consultations';
  res.redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
}

// Refuses form posts sent from other websites (cross-site request forgery).
function sameOriginOnly(req, res, next) {
  if (req.method !== 'POST') return next();
  const source = req.get('origin') || req.get('referer');
  if (source) {
    let host;
    try { host = new URL(source).host; } catch { host = null; }
    if (host !== req.get('host')) return res.status(403).send('This form must be sent from this website.');
  }
  next();
}

// Slows down password guessing: 5 failed logins per email + address in 15 minutes.
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

const loginLimiter = {
  key: (req, email) => `${req.ip}|${String(email || '').trim().toLowerCase()}`,
  isBlocked(key) {
    const entry = failures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.first > FAIL_WINDOW_MS) { failures.delete(key); return false; }
    return entry.count >= FAIL_LIMIT;
  },
  recordFailure(key) {
    const entry = failures.get(key);
    if (!entry || Date.now() - entry.first > FAIL_WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
    else entry.count += 1;
  },
  reset(key) { failures.delete(key); },
};

// Only allow redirects to pages on this site after logging in.
function safeNext(value, fallback = '/my-consultations') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    ? value
    : fallback;
}

module.exports = { loadUser, requireLogin, sameOriginOnly, loginLimiter, safeNext };
