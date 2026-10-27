// express-session store backed by the same SQLite database, so logins survive
// server restarts (the default in-memory store loses them and isn't meant for production).
const session = require('express-session');
const { db } = require('../data/db');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const statements = {
  get: db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?'),
  set: db.prepare(`
    INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
    ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
  `),
  touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
  destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
};

const expiryOf = (sess) => (sess.cookie && sess.cookie.expires
  ? new Date(sess.cookie.expires).getTime()
  : Date.now() + DEFAULT_TTL_MS);

class SQLiteSessionStore extends session.Store {
  constructor() {
    super();
    // Remove expired sessions once an hour.
    this.pruneTimer = setInterval(() => statements.prune.run(Date.now()), 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  get(sid, done) {
    try {
      const row = statements.get.get(sid, Date.now());
      done(null, row ? JSON.parse(row.data) : null);
    } catch (err) { done(err); }
  }

  set(sid, sess, done) {
    try {
      statements.set.run(sid, JSON.stringify(sess), expiryOf(sess));
      done && done(null);
    } catch (err) { done && done(err); }
  }

  touch(sid, sess, done) {
    try {
      statements.touch.run(expiryOf(sess), sid);
      done && done(null);
    } catch (err) { done && done(err); }
  }

  destroy(sid, done) {
    try {
      statements.destroy.run(sid);
      done && done(null);
    } catch (err) { done && done(err); }
  }
}

module.exports = { SQLiteSessionStore };
