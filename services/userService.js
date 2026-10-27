// All database access for client accounts. Passwords are hashed with bcryptjs;
// the plain password is never stored or logged.
const bcrypt = require('bcryptjs');
const { db } = require('../data/db');

const BCRYPT_ROUNDS = 12;
// Compared against when an email isn't registered, so login takes the same time either way.
const DUMMY_HASH = bcrypt.hashSync('northbridge-timing-equaliser', BCRYPT_ROUNDS);

class EmailTakenError extends Error {
  constructor() {
    super('An account with this email already exists.');
    this.name = 'EmailTakenError';
  }
}

const statements = {
  insert: db.prepare('INSERT INTO users (email, passwordHash, fullName, createdAt) VALUES (?, ?, ?, ?)'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
};

// What the rest of the app sees: never the password hash.
const publicUser = (row) => (row ? { id: row.id, email: row.email, fullName: row.fullName, createdAt: row.createdAt } : null);

const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

/** Creates an account and returns it (without the hash). Throws EmailTakenError for a duplicate email. */
async function createUser({ email, password, fullName }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const result = statements.insert.run(normaliseEmail(email), passwordHash, fullName.trim(), new Date().toISOString());
    return publicUser(statements.byId.get(result.lastInsertRowid));
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err.message)) throw new EmailTakenError();
    throw err;
  }
}

/** Returns the user if the email and password match, otherwise null. */
async function verifyCredentials(email, password) {
  const row = statements.byEmail.get(normaliseEmail(email));
  const ok = await bcrypt.compare(String(password || ''), row ? row.passwordHash : DUMMY_HASH);
  return row && ok ? publicUser(row) : null;
}

function findUserById(id) {
  return publicUser(statements.byId.get(Number(id)));
}

module.exports = { createUser, verifyCredentials, findUserById, EmailTakenError };
