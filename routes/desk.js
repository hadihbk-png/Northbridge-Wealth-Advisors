// Staff desk: /desk
//   GET  /desk/login            staff password form
//   POST /desk/login            check DESK_PASSWORD
//   POST /desk/logout
//   GET  /desk                  all "Booked" consultations
//   POST /desk/:id/remind       email the client a reminder
// Protected by its own password (DESK_PASSWORD in .env), separate from client accounts,
// because client accounts can be registered with any email address.

const crypto = require('crypto');
const express = require('express');
const { firm } = require('../lib/site-data');
const { describeConsultation } = require('../lib/consultation-view');
const consultationService = require('../services/consultationService');
const emailService = require('../services/emailService');
const { loginLimiter } = require('../middleware/auth');

const router = express.Router();

// Staff pages should never be indexed or cached.
router.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Cache-Control', 'no-store');
  next();
});

const deskPassword = () => process.env.DESK_PASSWORD || '';

// Compares hashes so the check takes the same time however much of the password matches.
function passwordMatches(attempt) {
  const expected = deskPassword();
  if (expected.length < 12) return false; // desk disabled until a proper password is set
  const a = crypto.createHash('sha256').update(String(attempt)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireStaff(req, res, next) {
  if (req.session && req.session.isStaff) return next();
  res.redirect('/desk/login');
}

const render = (res, view, data = {}, status = 200) => res.status(status).render(view, {
  title: `Staff desk | ${firm.name}`, ...data,
});

// ---------- Staff login ----------
router.get('/login', (req, res) => {
  if (req.session && req.session.isStaff) return res.redirect('/desk');
  render(res, 'desk-login', { error: deskPassword().length < 12 ? 'The staff desk is not set up yet (DESK_PASSWORD is missing in .env).' : null });
});

router.post('/login', (req, res, next) => {
  const key = loginLimiter.key(req, 'staff-desk');
  if (loginLimiter.isBlocked(key)) {
    return render(res, 'desk-login', { error: 'Too many attempts. Please wait 15 minutes and try again.' }, 429);
  }
  if (!passwordMatches(typeof req.body.password === 'string' ? req.body.password : '')) {
    loginLimiter.recordFailure(key);
    return render(res, 'desk-login', { error: 'Incorrect staff password.' }, 401);
  }
  loginLimiter.reset(key);
  // Fresh session id at login; keep a logged-in client (if any) logged in.
  const userId = req.session.userId;
  req.session.regenerate((err) => {
    if (err) return next(err);
    if (userId) req.session.userId = userId;
    req.session.isStaff = true;
    req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/desk')));
  });
});

router.post('/logout', (req, res) => {
  delete req.session.isStaff;
  res.redirect('/desk/login');
});

// ---------- Booked consultations ----------
router.get('/', requireStaff, (req, res) => {
  const nowIso = new Date().toISOString();
  const consultations = consultationService.getConsultationsByStatus('Booked').map((c) => ({
    ...describeConsultation(c),
    isPast: new Date(c.consultationDateTime).toISOString() < nowIso,
  }));
  const notice = req.session.deskNotice;
  delete req.session.deskNotice;
  render(res, 'desk', { consultations, notice });
});

router.post('/:id/remind', requireStaff, async (req, res, next) => {
  try {
    const consultation = consultationService.getConsultationById(req.params.id);
    const ref = consultation ? describeConsultation(consultation).reference : `#${req.params.id}`;
    const result = await emailService.sendReminder(consultation);
    const messages = {
      'not-booked': `${ref} is not a booked consultation, so no reminder was sent.`,
      'not-configured': 'Email is not set up yet: fill in the SMTP settings in .env and restart the app. No reminder was sent.',
      failed: `The reminder for ${ref} could not be sent (${result.error}). Please try again.`,
    };
    req.session.deskNotice = result.ok
      ? { type: 'success', text: `Reminder sent to ${consultation.clientName} (${consultation.clientEmail}) for ${ref}.` }
      : { type: 'error', text: messages[result.reason] };
    res.redirect('/desk');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
