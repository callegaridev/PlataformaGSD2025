const session = require('express-session');

class DatabaseSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
  }

  get(sid, callback) {
    this.database.query(
      'SELECT sess FROM sessions WHERE sid = $1 AND expire > $2',
      [sid, new Date()]
    ).then(({ rows }) => {
      if (!rows.length) return callback(null, null);
      const value = rows[0].sess;
      callback(null, typeof value === 'string' ? JSON.parse(value) : value);
    }).catch(callback);
  }

  set(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.database.query(
      `INSERT INTO sessions (sid, sess, expire)
       VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, JSON.stringify(value), expires]
    ).then(() => callback(null)).catch(callback);
  }

  touch(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires
      ? new Date(value.cookie.expires)
      : new Date(Date.now() + 8 * 60 * 60 * 1000);
    this.database.query('UPDATE sessions SET expire = $1 WHERE sid = $2', [expires, sid])
      .then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.database.query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => callback(null)).catch(callback);
  }

  async pruneExpired() {
    await this.database.query('DELETE FROM sessions WHERE expire <= $1', [new Date()]);
  }
}

module.exports = { DatabaseSessionStore };
