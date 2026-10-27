// All database access for consultations lives here. Routes call these functions
// and never touch the database directly, so the storage can be swapped later
// (for example to Postgres) by rewriting only this file.
const { db } = require('../data/db');

// Pending: saved, deposit not paid yet. Expired: deposit never paid, slot released.
const STATUSES = ['Pending', 'Booked', 'Confirmed', 'Completed', 'Cancelled', 'Expired', 'No-show'];
const UAE_OFFSET = '+04:00';

class SlotTakenError extends Error {
  constructor() {
    super('That advisor already has a consultation at this time.');
    this.name = 'SlotTakenError';
  }
}

const statements = {
  insert: db.prepare(`
    INSERT INTO consultations
      (service, advisor, meetingType, consultationDateTime, clientName, clientPhone, clientEmail, goal, status, createdAt)
    VALUES
      (:service, :advisor, :meetingType, :consultationDateTime, :clientName, :clientPhone, :clientEmail, :goal, :status, :createdAt)
  `),
  byId: db.prepare('SELECT * FROM consultations WHERE id = ?'),
  byStripeSession: db.prepare('SELECT * FROM consultations WHERE stripeSessionId = ?'),
  byEmail: db.prepare(`
    SELECT * FROM consultations WHERE clientEmail = ? ORDER BY consultationDateTime, id
  `),
  byDate: db.prepare(`
    SELECT * FROM consultations
    WHERE consultationDateTime >= ? AND consultationDateTime < ?
    ORDER BY consultationDateTime, advisor
  `),
  byStatus: db.prepare('SELECT * FROM consultations WHERE status = ? ORDER BY consultationDateTime, id'),
  setReminderSent: db.prepare('UPDATE consultations SET reminderSentAt = ? WHERE id = ?'),
  pendingCreatedBefore: db.prepare(`
    SELECT * FROM consultations WHERE status = 'Pending' AND createdAt < ? ORDER BY id
  `),
  updateStatus: db.prepare('UPDATE consultations SET status = ? WHERE id = ?'),
  setStripeSession: db.prepare('UPDATE consultations SET stripeSessionId = ? WHERE id = ? AND stripeSessionId IS NULL'),
  // Payment confirmed by Stripe: Pending (or an expired hold) becomes Booked.
  markPaid: db.prepare(`UPDATE consultations SET status = 'Booked' WHERE id = ? AND status IN ('Pending', 'Expired')`),
  // Confirmation email: claim the right to send it (only one caller can win), or undo after a failure.
  claimConfirmationEmail: db.prepare(`
    UPDATE consultations SET confirmationEmailSentAt = ?
    WHERE id = ? AND status = 'Booked' AND confirmationEmailSentAt IS NULL
  `),
  releaseConfirmationEmail: db.prepare('UPDATE consultations SET confirmationEmailSentAt = NULL WHERE id = ? AND confirmationEmailSentAt = ?'),
  // Releases an unpaid hold on the slot.
  expirePending: db.prepare(`UPDATE consultations SET status = 'Expired' WHERE id = ? AND status = 'Pending'`),
  // Cancels only if the consultation belongs to this email, is still active and hasn't started.
  cancelOwn: db.prepare(`
    UPDATE consultations SET status = 'Cancelled'
    WHERE id = ? AND clientEmail = ? AND status IN ('Booked', 'Confirmed') AND consultationDateTime > ?
  `),
};

// "2026-10-29" + "10:30" -> "2026-10-29T10:30:00+04:00" (UAE has no daylight saving).
function toDateTime(date, time) {
  return `${date}T${time}:00${UAE_OFFSET}`;
}

function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const plain = (row) => (row ? { ...row } : null);
const isUniqueError = (err) => /UNIQUE constraint failed/.test(err.message);

/**
 * Saves a new consultation and returns the stored record. Status defaults to "Booked";
 * pass { status: 'Pending' } while a deposit payment is outstanding.
 * `booking` is a validated booking: service, advisor, meeting, date, time, name, phone, email, goal.
 * Throws SlotTakenError if the advisor is already booked (or held) at that time.
 */
function createConsultation(booking, { status = 'Booked' } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}.`);
  try {
    const result = statements.insert.run({
      service: booking.service,
      advisor: booking.advisor,
      meetingType: booking.meeting,
      consultationDateTime: toDateTime(booking.date, booking.time),
      clientName: booking.name,
      clientPhone: booking.phone,
      clientEmail: booking.email.toLowerCase(),
      goal: booking.goal || null,
      status,
      createdAt: new Date().toISOString(),
    });
    return plain(statements.byId.get(result.lastInsertRowid));
  } catch (err) {
    if (isUniqueError(err)) throw new SlotTakenError();
    throw err;
  }
}

function getConsultationById(id) {
  return plain(statements.byId.get(Number(id)));
}

/** All consultations for an email address, earliest first (pass { newestFirst: true } to reverse). */
function getConsultationsByEmail(email, { newestFirst = false } = {}) {
  const rows = statements.byEmail.all(String(email).trim().toLowerCase()).map(plain);
  return newestFirst ? rows.reverse() : rows;
}

/** All consultations on a calendar day (YYYY-MM-DD, UAE time), in time order. */
function getConsultationsByDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must be YYYY-MM-DD.');
  return statements.byDate.all(`${date}T00:00`, `${nextDay(date)}T00:00`).map(plain);
}

/** All consultations with a given status, earliest appointment first. */
function getConsultationsByStatus(status) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}.`);
  return statements.byStatus.all(status).map(plain);
}

/** Records that a reminder email was just sent. Returns the updated record. */
function recordReminderSent(id) {
  statements.setReminderSent.run(new Date().toISOString(), Number(id));
  return plain(statements.byId.get(Number(id)));
}

/** Changes a consultation's status. Returns the updated record, or null if the id doesn't exist. */
function updateStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}.`);
  const result = statements.updateStatus.run(status, Number(id));
  return result.changes ? plain(statements.byId.get(Number(id))) : null;
}

// ---------------------------------------------------------------------------
// Deposit payments
// ---------------------------------------------------------------------------

/** Stores the Stripe Checkout Session id on a consultation (only once). */
function setStripeSessionId(id, stripeSessionId) {
  const result = statements.setStripeSession.run(stripeSessionId, Number(id));
  return result.changes ? plain(statements.byId.get(Number(id))) : null;
}

function getConsultationByStripeSessionId(stripeSessionId) {
  return plain(statements.byStripeSession.get(String(stripeSessionId)));
}

/**
 * Marks a consultation as Booked after Stripe has confirmed the payment.
 * Returns the updated record (unchanged if it was already Booked).
 * Throws SlotTakenError if the slot was given to someone else in the meantime.
 */
function markPaid(id) {
  try {
    statements.markPaid.run(Number(id));
  } catch (err) {
    if (isUniqueError(err)) throw new SlotTakenError();
    throw err;
  }
  return plain(statements.byId.get(Number(id)));
}

/** Releases the slot held by an unpaid consultation. Returns true if it was Pending. */
function expirePending(id) {
  return statements.expirePending.run(Number(id)).changes > 0;
}

/**
 * Marks the confirmation email as sent, but only for a Booked consultation that hasn't had one.
 * Returns the timestamp written if this caller should send it, otherwise null.
 */
function claimConfirmationEmail(id) {
  const now = new Date().toISOString();
  return statements.claimConfirmationEmail.run(now, Number(id)).changes ? now : null;
}

/** Undoes a claim after the email failed to send, so it can be tried again later. */
function releaseConfirmationEmail(id, claimedAt) {
  statements.releaseConfirmationEmail.run(Number(id), claimedAt);
}

/** Pending consultations created before the given time (ISO string), oldest first. */
function getPendingCreatedBefore(isoTime) {
  return statements.pendingCreatedBefore.all(isoTime).map(plain);
}

// ---------------------------------------------------------------------------
// Client cancellations
// ---------------------------------------------------------------------------

// Current UAE time in the stored format, e.g. 2026-10-27T21:40:00+04:00 (comparable as text).
function nowAsDateTime(now = new Date()) {
  const uae = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  return `${uae.toISOString().slice(0, 19)}${UAE_OFFSET}`;
}

/** True if a client may still cancel this consultation (active and not yet started). */
function canCancel(consultation, now = new Date()) {
  return ['Booked', 'Confirmed'].includes(consultation.status) && consultation.consultationDateTime > nowAsDateTime(now);
}

/**
 * Cancels a consultation on behalf of a client. Only works for their own (matching email),
 * active, upcoming consultations. Returns the updated record, or null if not allowed.
 */
function cancelConsultation(id, clientEmail) {
  const result = statements.cancelOwn.run(Number(id), String(clientEmail).trim().toLowerCase(), nowAsDateTime());
  return result.changes ? plain(statements.byId.get(Number(id))) : null;
}

module.exports = {
  createConsultation,
  getConsultationById,
  getConsultationsByEmail,
  getConsultationsByDate,
  getConsultationsByStatus,
  recordReminderSent,
  updateStatus,
  setStripeSessionId,
  getConsultationByStripeSessionId,
  markPaid,
  expirePending,
  getPendingCreatedBefore,
  claimConfirmationEmail,
  releaseConfirmationEmail,
  cancelConsultation,
  canCancel,
  toDateTime,
  STATUSES,
  SlotTakenError,
};
