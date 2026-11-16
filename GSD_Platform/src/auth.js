const argon2 = require('argon2');
const crypto = require('node:crypto');

const PRESIDENT_ROLES = new Set(['presidente', 'vice-presidente']);
const VALID_ROLES = new Set(['presidente', 'vice-presidente', 'coordenador', 'membro']);

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sector: user.sector,
    foto_url: user.photo_path ? `/api/usuarios/${user.id}/foto` : null,
    password_reset_required: Boolean(user.password_reset_required)
  };
}

function requireAuth(database) {
  return async function authenticate(req, res, next) {
    try {
      const userId = req.session && req.session.userId;
      if (!userId) return res.status(401).json({ error: 'Autenticação necessária.' });
      const { rows } = await database.query(
        'SELECT id, name, email, role, sector, photo_path, password_reset_required FROM users WHERE id = $1',
        [userId]
      );
      if (!rows.length) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'Sessão inválida.' });
      }
      if (rows[0].password_reset_required) {
        return res.status(403).json({ error: 'A senha desta conta precisa ser redefinida.', code: 'PASSWORD_RESET_REQUIRED' });
      }
      req.user = rows[0];
      next();
    } catch (error) {
      next(error);
    }
  };
}

function requireRoles(...roles) {
  return function authorize(req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente.' });
    }
    next();
  };
}

function requirePresident(req, res, next) {
  if (!req.user || !PRESIDENT_ROLES.has(req.user.role)) {
    return res.status(403).json({ error: 'Permissão insuficiente.' });
  }
  next();
}

async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
}

async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password, { type: argon2.argon2id });
  } catch {
    return false;
  }
}

function newResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
  PRESIDENT_ROLES,
  VALID_ROLES,
  hashPassword,
  newResetToken,
  publicUser,
  requireAuth,
  requirePresident,
  requireRoles,
  verifyPassword
};
