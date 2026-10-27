// Booking flow
//   GET  /booking          step-by-step form (optionally ?service=retirement)
//   POST /booking          validate, then show the summary
//   POST /booking/edit     back from the summary to the form, keeping the answers
//   POST /booking/confirm  validate again, save as "Pending" and send the client to Stripe Checkout
//   GET  /booking-success  check the payment with Stripe; "Booked" only if Stripe says it is paid
// Storage goes through services/consultationService.js; Stripe through services/paymentService.js.

const express = require('express');
const { firm, services, advisors, meetingTypes, deposit } = require('../lib/site-data');
const {
  SLOTS, MIN_NOTICE_MINUTES, nowInFirmTime, availableDates, validateBooking, firstErrorStep,
} = require('../lib/booking');
const { describeConsultation } = require('../lib/consultation-view');
const consultationService = require('../services/consultationService');
const paymentService = require('../services/paymentService');
const emailService = require('../services/emailService');

const router = express.Router();

// Only these fields are ever read from the request.
const FIELDS = ['service', 'advisor', 'meeting', 'date', 'time', 'name', 'phone', 'email', 'goal'];
// A logged-in client always books under their account email, so the booking
// shows up on their My Consultations page.
const pick = (req) => {
  const values = Object.fromEntries(FIELDS.map((f) => [f, typeof req.body[f] === 'string' ? req.body[f] : '']));
  if (req.user) values.email = req.user.email;
  return values;
};

function renderForm(res, { values = {}, errors = {}, step = 1, status = 200, notice = null } = {}) {
  const clock = nowInFirmTime();
  const dates = availableDates(clock);
  res.status(status).render('booking', {
    title: `Book a consultation | ${firm.name}`,
    mode: 'form',
    services,
    advisors,
    meetingTypes,
    dates,
    slots: SLOTS,
    // Lets the page grey out today's slots that are too soon (the server checks again).
    today: { date: clock.date, earliestStart: clock.minutes + MIN_NOTICE_MINUTES },
    values,
    errors,
    step,
    notice,
    deposit,
  });
}

const renderMessage = (res, mode, data = {}, status = 200) => res.status(status).render('booking', {
  title: `Booking | ${firm.name}`, mode, deposit, ...data,
});

// The form values a stored consultation was made with (to pre-fill the form again).
const valuesFrom = (c) => ({
  service: c.service,
  advisor: c.advisor,
  meeting: c.meetingType,
  date: c.consultationDateTime.slice(0, 10),
  time: c.consultationDateTime.slice(11, 16),
  name: c.clientName,
  phone: c.clientPhone,
  email: c.clientEmail,
  goal: c.goal || '',
});

router.get('/', async (req, res, next) => {
  try {
    // Back from Stripe without paying: release the slot and keep the client's answers.
    if (req.query.payment === 'cancelled' && req.session.pendingConsultationId) {
      const pending = consultationService.getConsultationById(req.session.pendingConsultationId);
      delete req.session.pendingConsultationId;
      if (pending && pending.status === 'Pending') {
        if (pending.stripeSessionId) await paymentService.expireCheckout(pending.stripeSessionId);
        consultationService.expirePending(pending.id);
        const values = valuesFrom(pending);
        if (req.user) values.email = req.user.email;
        return renderForm(res, {
          values,
          step: 3,
          notice: 'Your payment was not completed, so the consultation has not been booked. Your details are saved below. Choose a time and try again.',
        });
      }
    }

    const service = services.find((s) => s.id === req.query.service);
    // Pre-fill the logged-in client's details.
    const values = req.user ? { email: req.user.email, name: req.user.fullName } : {};
    if (service) {
      values.service = service.id;
      const matches = advisors.filter((a) => a.services.includes(service.id));
      if (matches.length === 1) values.advisor = matches[0].id;
    }
    renderForm(res, { values, step: service ? 2 : 1 });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res) => {
  const { errors, values, booking } = validateBooking(pick(req));
  if (!booking) return renderForm(res, { values, errors, step: firstErrorStep(errors), status: 422 });
  res.render('booking', { title: `Check your booking | ${firm.name}`, mode: 'summary', booking, deposit });
});

router.post('/edit', (req, res) => {
  const values = pick(req);
  renderForm(res, { values, step: 1 });
});

router.post('/confirm', async (req, res, next) => {
  const { errors, values, booking } = validateBooking(pick(req));
  // The chosen slot may have become too soon while the summary was open.
  if (!booking) return renderForm(res, { values, errors, step: firstErrorStep(errors), status: 422 });

  try {
    paymentService.assertConfigured();
  } catch (err) {
    if (!(err instanceof paymentService.PaymentsNotConfiguredError)) return next(err);
    console.error('[payments]', err.message);
    return renderMessage(res, 'payment-unavailable', {}, 503);
  }

  try {
    // Release slots held by checkouts that were never paid.
    await paymentService.reconcileStalePending();

    let consultation;
    try {
      // 1. Save first, as Pending (this also holds the slot).
      consultation = consultationService.createConsultation(booking, { status: 'Pending' });
    } catch (err) {
      if (!(err instanceof consultationService.SlotTakenError)) throw err;
      // The same client re-sending this booking (e.g. pressing Back from Stripe and confirming again)?
      const when = consultationService.toDateTime(booking.date, booking.time);
      const mine = consultationService.getConsultationsByEmail(booking.email)
        .find((c) => c.advisor === booking.advisor && c.consultationDateTime === when
          && c.clientPhone === booking.phone && ['Pending', 'Booked'].includes(c.status));
      if (mine && mine.stripeSessionId) {
        const session = await paymentService.retrieveCheckout(mine.stripeSessionId);
        if (session.status === 'open') return res.redirect(303, session.url);
        return res.redirect(303, `/booking-success?session_id=${encodeURIComponent(mine.stripeSessionId)}`);
      }
      return renderForm(res, {
        values,
        errors: { time: `Sorry, ${booking.advisorName} has just been booked at that time. Please choose another time.` },
        step: 3,
        status: 409,
      });
    }

    // 2. Create the Stripe Checkout Session on the server and send the client to Stripe.
    let checkoutUrl;
    try {
      checkoutUrl = await paymentService.createDepositCheckout(consultation, booking);
    } catch (err) {
      consultationService.expirePending(consultation.id); // release the slot; nothing was charged
      console.error('[payments] could not start checkout:', err.message);
      return renderMessage(res, 'payment-error', {}, 502);
    }
    req.session.pendingConsultationId = consultation.id;
    res.redirect(303, checkoutUrl);
  } catch (err) {
    next(err);
  }
});

// Saving failed for an unexpected reason (e.g. the database file is unavailable).
router.use((err, req, res, next) => {
  console.error('[booking]', err);
  renderMessage(res, 'error', {}, 500);
});

// ---------------------------------------------------------------------------
// GET /booking-success?session_id=cs_test_...
// Stripe sends the client here after checkout. The redirect proves nothing by
// itself: the payment status is always read from Stripe on the server.
// ---------------------------------------------------------------------------
async function bookingSuccess(req, res) {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  const consultation = /^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)
    ? consultationService.getConsultationByStripeSessionId(sessionId)
    : null;
  if (!consultation) return renderMessage(res, 'payment-unknown', {}, 404);

  let session;
  try {
    session = await paymentService.retrieveCheckout(sessionId);
  } catch (err) {
    console.error('[payments] could not retrieve checkout:', err.message);
    return renderMessage(res, 'payment-check-failed', { booking: describeConsultation(consultation) }, 502);
  }

  if (!paymentService.isDepositPaid(session, consultation)) {
    // Not paid (yet): the consultation stays Pending.
    return renderMessage(res, 'payment-incomplete', {
      booking: describeConsultation(consultation),
      checkoutUrl: session.status === 'open' ? session.url : null,
    });
  }

  // Paid: this checkout is finished, so "back from Stripe" no longer applies to it.
  if (req.session.pendingConsultationId === consultation.id) delete req.session.pendingConsultationId;

  let paid;
  try {
    paid = consultationService.markPaid(consultation.id);
  } catch (err) {
    if (!(err instanceof consultationService.SlotTakenError)) throw err;
    // Paid after the hold had expired and someone else took the slot.
    console.error(`[payments] paid consultation ${consultation.id} lost its slot; needs a rebooking or refund`);
    return renderMessage(res, 'paid-slot-taken', { booking: describeConsultation(consultation) }, 409);
  }

  // Confirmation email, sent once per consultation. Runs in the background and never
  // blocks or breaks this page: if it fails, the error is logged and the booking stays confirmed.
  if (paid.status === 'Booked' && !paid.confirmationEmailSentAt) {
    emailService.sendBookingConfirmation(paid);
  }

  const booking = describeConsultation(paid);
  res.render('booking', {
    title: `Booking confirmed | ${firm.name}`,
    mode: 'confirmed',
    booking: { ...booking, name: paid.clientName, phone: paid.clientPhone, email: paid.clientEmail },
    consultation: paid,
    reference: booking.reference,
    deposit,
  });
}

module.exports = router;
module.exports.bookingSuccess = (req, res, next) => bookingSuccess(req, res).catch(next);
