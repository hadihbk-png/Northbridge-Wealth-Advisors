// Opens the SQLite database (Node's built-in node:sqlite, no packages needed)
// and makes sure the tables exist. Only services/ should import this file.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, 'advisor.db'));

// Create the data folder if it is missing.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS consultations (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    service              TEXT NOT NULL,
    advisor              TEXT NOT NULL,
    meetingType          TEXT NOT NULL,
    consultationDateTime TEXT NOT NULL,  -- UAE local time, e.g. 2026-10-29T10:30:00+04:00
    clientName           TEXT NOT NULL,
    clientPhone          TEXT NOT NULL,
    clientEmail          TEXT NOT NULL,
    goal                 TEXT,
    status               TEXT NOT NULL DEFAULT 'Booked',
    createdAt            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_consultations_email ON consultations (clientEmail);
  CREATE INDEX IF NOT EXISTS idx_consultations_datetime ON consultations (consultationDateTime);


  -- Client accounts. Only a bcrypt hash of the password is stored, never the password.
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    fullName     TEXT NOT NULL,
    createdAt    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Login sessions (used by express-session), so logins survive a server restart.
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL  -- milliseconds since 1970
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires);
`);

// ---------------------------------------------------------------------------
// Changes to existing databases. Each step only runs if needed, so existing
// bookings are kept.
// ---------------------------------------------------------------------------
const consultationColumns = db.prepare('PRAGMA table_info(consultations)').all().map((c) => c.name);
if (!consultationColumns.includes('stripeSessionId')) {
  db.exec('ALTER TABLE consultations ADD COLUMN stripeSessionId TEXT');
}
// When the "Your consultation is confirmed" email was sent (so it is only sent once).
if (!consultationColumns.includes('confirmationEmailSentAt')) {
  db.exec('ALTER TABLE consultations ADD COLUMN confirmationEmailSentAt TEXT');
}
// When staff last sent a reminder email from /desk.
if (!consultationColumns.includes('reminderSentAt')) {
  db.exec('ALTER TABLE consultations ADD COLUMN reminderSentAt TEXT');
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_consultations_stripe_session
    ON consultations (stripeSessionId) WHERE stripeSessionId IS NOT NULL;

  -- An advisor can't have two active consultations at the same time. Unpaid bookings
  -- that expired or were cancelled free the slot again. (Recreated so that existing
  -- databases pick up the 'Expired' status.)
  DROP INDEX IF EXISTS ux_consultations_advisor_slot;
  CREATE UNIQUE INDEX ux_consultations_advisor_slot
    ON consultations (advisor, consultationDateTime)
    WHERE status NOT IN ('Cancelled', 'Expired');
`);

module.exports = { db, DB_PATH };
