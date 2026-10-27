// Client accounts: /register, /login and /logout.
const express = require('express');
const { firm } = require('../lib/site-data');
const userService = require('../services/userService');
const { loginLimiter, safeNext } = require('../middleware/auth');

const router = express.Router();

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

function validateRegistration(body) {
  const errors = {};
  const values = { fullName: clean(body.fullName).replace(/\s+/g, ' '), email: clean(body.email).toLowerCase() };
  const password = typeof body.password === 'string' ? body.password : '';
  const confirm = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

  if (!values.fullName) errors.fullName = 'Please enter your full name.';
  else if (values.fullName.length < 2 || values.fullName.length > 80 || !/^[\p{L}][\p{L}\p{M}\s'.-]*$/u.test(values.fullName)) {
    errors.fullName = 'Please enter your name using letters only.';
  }
  if (!values.email) errors.email = 'Please enter your email address.';
  else if (values.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) {
    errors.email = 'Please enter a valid email address.';
  }
  if (password.length < 8) errors.password = 'Use at least 8 characters.';
  else if (Buffer.byteLength(password) > 72) errors.password = 'Use 72 characters or fewer.';
  else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) errors.password = 'Include at least one letter and one number.';
  if (!errors.password && confirm !== password) errors.confirmPassword = 'The passwords do not match.';
  return { errors, values, password };
}

// Starts a fresh session for the user (a new session id prevents session fixation).
function logIn(req, user, done) {
  req.session.regenerate((err) => {
    if (err) return done(err);
    req.session.userId = user.id;
    req.session.save(done);
  });
}

const renderAuth = (res, view, data, status = 200) => res.status(status).render(view, {
  title: `${view === 'register' ? 'Create an account' : 'Log in'} | ${firm.name}`,
  errors: {},
  values: {},
  next: '',
  ...data,
});

// ---------- Register ----------
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/my-consultations');
  renderAuth(res, 'register', { next: safeNext(req.query.next, '') });
});

router.post('/register', async (req, res, next) => {
  const { errors, values, password } = validateRegistration(req.body);
  const nextUrl = safeNext(req.body.next);
  if (Object.keys(errors).length) return renderAuth(res, 'register', { errors, values, next: req.body.next }, 422);
  try {
    const user = await userService.createUser({ email: values.email, password, fullName: values.fullName });
    logIn(req, user, (err) => (err ? next(err) : res.redirect(nextUrl)));
  } catch (err) {
    if (err instanceof userService.EmailTakenError) {
      return renderAuth(res, 'register', {
        errors: { email: 'An account with this email already exists. Please log in instead.' },
        values,
        next: req.body.next,
      }, 409);
    }
    next(err);
  }
});

// ---------- Log in ----------
router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  renderAuth(res, 'login', { next: safeNext(req.query.next, '') });
});

router.post('/login', async (req, res, next) => {
  const email = clean(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const values = { email };
  const key = loginLimiter.key(req, email);

  if (loginLimiter.isBlocked(key)) {
    return renderAuth(res, 'login', {
      errors: { form: 'Too many attempts. Please wait 15 minutes and try again.' }, values, next: req.body.next,
    }, 429);
  }
  if (!email || !password) {
    return renderAuth(res, 'login', {
      errors: { form: 'Please enter your email and password.' }, values, next: req.body.next,
    }, 422);
  }

  try {
    const user = await userService.verifyCredentials(email, password);
    if (!user) {
      loginLimiter.recordFailure(key);
      return renderAuth(res, 'login', {
        errors: { form: 'Incorrect email or password.' }, values, next: req.body.next,
      }, 401);
    }
    loginLimiter.reset(key);
    logIn(req, user, (err) => (err ? next(err) : res.redirect(safeNext(req.body.next))));
  } catch (err) {
    next(err);
  }
});

// ---------- Log out (POST, so a link on another site can't log people out) ----------
router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('nb.sid');
    res.redirect('/');
  });
});

module.exports = router;
