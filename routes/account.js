// Logged-in client pages: /my-consultations
const express = require('express');
const { firm } = require('../lib/site-data');
const { describeConsultation, reference } = require('../lib/consultation-view');
const consultationService = require('../services/consultationService');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const consultations = consultationService
    .getConsultationsByEmail(req.user.email, { newestFirst: true })
    // Expired = the deposit was never paid, so it was never a booking.
    .filter((c) => c.status !== 'Expired')
    .map((c) => ({ ...describeConsultation(c), canCancel: consultationService.canCancel(c) }));
  const notice = req.session.notice;
  delete req.session.notice;
  res.render('my-consultations', { title: `My Consultations | ${firm.name}`, consultations, notice });
});

router.post('/:id/cancel', requireLogin, (req, res) => {
  // Matches on the logged-in client's email, so nobody can cancel someone else's consultation.
  const cancelled = consultationService.cancelConsultation(req.params.id, req.user.email);
  req.session.notice = cancelled
    ? { type: 'success', text: `Consultation ${reference(cancelled.id)} has been cancelled.` }
    : { type: 'error', text: 'That consultation could not be cancelled. It may already be cancelled or in the past.' };
  res.redirect('/my-consultations');
});

module.exports = router;
