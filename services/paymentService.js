// Stripe deposit payments. Runs on the server only: the secret key comes from
// process.env.STRIPE_SECRET_KEY (.env locally, environment variables on a server)
// and is never sent to the browser.
const Stripe = require('stripe');
const { deposit } = require('../lib/site-data');
const consultationService = require('./consultationService');

const CHECKOUT_MINUTES = 30; // Stripe's minimum; an unpaid checkout expires after this
const STALE_PENDING_MINUTES = CHECKOUT_MINUTES + 5;

class PaymentsNotConfiguredError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'PaymentsNotConfiguredError';
  }
}

let client = null;

function stripe() {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new PaymentsNotConfiguredError('STRIPE_SECRET_KEY is not set.');
  // This integration is for test mode only: refuse live keys.
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new PaymentsNotConfiguredError('STRIPE_SECRET_KEY must be a Stripe test key (sk_test_...).');
  }
  const options = { maxNetworkRetries: 2, timeout: 20000 };
  // Local testing only: point at stripe-mock or another Stripe-compatible test server.
  if (process.env.STRIPE_API_BASE && process.env.NODE_ENV !== 'production') {
    const base = new URL(process.env.STRIPE_API_BASE);
    Object.assign(options, { host: base.hostname, port: base.port, protocol: base.protocol.replace(':', '') });
  }
  client = new Stripe(key, options);
  return client;
}

function baseUrl() {
  // On Render, RENDER_EXTERNAL_URL is provided automatically (e.g. https://name.onrender.com).
  const value = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!value) throw new PaymentsNotConfiguredError('BASE_URL is not set.');
  return value.replace(/\/+$/, '');
}

/** Checks the payment settings are present (used to fail early, before saving a booking). */
function assertConfigured() {
  stripe();
  baseUrl();
}

/**
 * Creates a Stripe Checkout Session for the deposit on a saved (Pending) consultation
 * and stores its id on the consultation. Returns the Stripe-hosted checkout URL.
 */
async function createDepositCheckout(consultation, booking) {
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: consultation.clientEmail,
    client_reference_id: String(consultation.id),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: deposit.currency,
        unit_amount: deposit.amount,
        product_data: {
          name: `${deposit.name}: ${booking.serviceTitle}`,
          description: `${deposit.description} ${booking.advisorName}, ${booking.dateLabel}, ${booking.timeLabel} (UAE time).`,
        },
      },
    }],
    metadata: { consultationId: String(consultation.id) },
    payment_intent_data: {
      description: `Consultation deposit NB-${String(consultation.id).padStart(6, '0')}`,
      metadata: { consultationId: String(consultation.id) },
    },
    success_url: `${baseUrl()}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl()}/booking?payment=cancelled`,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
  }, {
    // Stripe returns the same session if this exact request is retried. Includes the
    // creation time so a reused id (e.g. after a database reset) never clashes.
    idempotencyKey: `deposit-checkout-${consultation.id}-${consultation.createdAt}`,
  });

  consultationService.setStripeSessionId(consultation.id, session.id);
  return session.url;
}

/** Fetches a Checkout Session from Stripe (the only trusted source of payment status). */
function retrieveCheckout(sessionId) {
  return stripe().checkout.sessions.retrieve(sessionId);
}

/**
 * True only if Stripe says this session was paid in full for this consultation's deposit.
 * The redirect back to our site is never trusted on its own.
 */
function isDepositPaid(session, consultation) {
  return session.payment_status === 'paid'
    && session.mode === 'payment'
    && session.metadata && session.metadata.consultationId === String(consultation.id)
    && session.currency === deposit.currency
    && session.amount_total === deposit.amount;
}

/** Stops an unpaid checkout from being completed later (ignores sessions that are no longer open). */
async function expireCheckout(sessionId) {
  try {
    await stripe().checkout.sessions.expire(sessionId);
  } catch (err) {
    if (err && err.type === 'StripeInvalidRequestError') return; // already complete or expired
    throw err;
  }
}

/**
 * Settles Pending consultations whose checkout has had time to finish: Booked if Stripe
 * says the deposit was paid (e.g. the client closed the tab before returning), otherwise
 * Expired so the slot is released.
 */
async function reconcileStalePending() {
  const cutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60 * 1000).toISOString();
  for (const consultation of consultationService.getPendingCreatedBefore(cutoff)) {
    try {
      if (!consultation.stripeSessionId) {
        consultationService.expirePending(consultation.id);
        continue;
      }
      const session = await retrieveCheckout(consultation.stripeSessionId);
      if (isDepositPaid(session, consultation)) {
        const paid = consultationService.markPaid(consultation.id);
        // Lazy require: emailService is only needed here, and this avoids a load-order loop.
        if (paid.status === 'Booked') await require('./emailService').sendBookingConfirmation(paid);
      } else if (session.status !== 'open') {
        consultationService.expirePending(consultation.id);
      }
    } catch (err) {
      if (err instanceof PaymentsNotConfiguredError) return;
      console.error(`[payments] could not check consultation ${consultation.id}:`, err.message);
    }
  }
}

module.exports = {
  assertConfigured,
  createDepositCheckout,
  retrieveCheckout,
  isDepositPaid,
  expireCheckout,
  reconcileStalePending,
  PaymentsNotConfiguredError,
  CHECKOUT_MINUTES,
};
