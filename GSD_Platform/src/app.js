const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const {
  VALID_ROLES,
  hashPassword,
  newResetToken,
  publicUser,
  requireAuth,
  requirePresident,
  requireRoles,
  verifyPassword
} = require('./auth');
const { DatabaseSessionStore } = require('./session-store');
const { ValidationError, date, email, integer, money, secret, text } = require('./validation');

const PRESIDENT = ['presidente', 'vice-presidente'];
const TASK_STATUSES = new Set(['Pendente', 'Em andamento', 'Concluída']);
const REPORT_STATUSES = new Set(['Pendente', 'Aprovado', 'Rejeitado']);
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/webm']);
const DOCUMENT_VISIBILITIES = new Set(['geral', 'gestao']);

function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function formatTask(row) {
  return {
    ...row,
    tipo_destinatario: row.destinatario_usuario_id ? 'usuario'
      : row.destinatario_comissao_id ? 'comissao' : null,
    destinatario_id: row.destinatario_usuario_id || row.destinatario_comissao_id || null
  };
}

function cents(value) {
  return Math.round(Number(value) * 100);
}

function toCurrency(value) {
  return (value / 100).toFixed(2);
}

function fileSignatureIsValid(file, kind) {
  const buffer = file.buffer;
  const mime = file.mimetype;
  if (kind === 'profile') {
    return (mime === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
      || (mime === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (mime === 'image/webp' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP');
  }
  if (kind === 'audio') {
    return (mime === 'audio/mpeg' && (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)))
      || (mime === 'audio/wav' && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE')
      || (mime === 'audio/ogg' && buffer.toString('ascii', 0, 4) === 'OggS')
      || (mime === 'audio/aac' && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0)
      || (mime === 'audio/mp4' && buffer.toString('ascii', 4, 8) === 'ftyp')
      || (mime === 'audio/webm' && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  }
  if (!DOCUMENT_TYPES.has(mime)) return false;
  if (mime === 'application/pdf') return buffer.toString('ascii', 0, 5) === '%PDF-';
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6));
  if (mime.startsWith('application/vnd.openxmlformats-officedocument.')) {
    return buffer[0] === 0x50 && buffer[1] === 0x4b;
  }
  return mime === 'text/plain' && !buffer.includes(0);
}

function createUpload(kind, maxBytes) {
  const allowed = kind === 'audio' ? AUDIO_TYPES : kind === 'profile'
    ? new Set(['image/jpeg', 'image/png', 'image/webp'])
    : DOCUMENT_TYPES;
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, parts: 12 },
    fileFilter(req, file, callback) {
      if (!allowed.has(file.mimetype)) {
        return callback(new ValidationError('Tipo de arquivo não permitido.'));
      }
      callback(null, true);
    }
  });
}

function ensureFile(file, kind) {
  if (!file || !fileSignatureIsValid(file, kind)) {
    throw new ValidationError('Arquivo ausente ou conteúdo incompatível com o tipo informado.');
  }
}

function issueResetToken(database, userId) {
  const token = newResetToken();
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return database.query(
    `INSERT INTO password_resets (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [tokenHash, userId, new Date(Date.now() + 30 * 60 * 1000)]
  ).then(() => token);
}

async function removeOrphanedUpload(storage, stored) {
  try {
    await storage.remove(stored.bucket, stored.key);
  } catch (error) {
    console.error('Upload cleanup failed.', { name: error.name, code: error.code || 'STORAGE_CLEANUP_ERROR' });
  }
}

function createApp({ config, database, storage }) {
  const app = express();
  const sessionStore = new DatabaseSessionStore(database);
  const auth = requireAuth(database);
  const uploadDocument = createUpload('document', config.maxDocumentBytes).single('arquivo');
  const uploadAudio = createUpload('audio', config.maxAudioBytes).single('audio');
  const uploadProfile = createUpload('profile', config.maxProfileBytes).single('foto');
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' }
  });
  const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false
  });

  if (config.production) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, Boolean(origin));
      return callback(null, false);
    }
  }));
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use(session({
    name: 'gsd.sid',
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.production,
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000
    }
  }));

  app.use((req, res, next) => {
    const origin = req.get('origin');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!unsafe || !origin) return next();
    const ownOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin === ownOrigin || config.allowedOrigins.includes(origin)) return next();
    return res.status(403).json({ error: 'Origem não autorizada.' });
  });

  app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/readyz', route(async (req, res) => {
    await database.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  }));

  const publicDir = path.join(__dirname, '..', 'public');
  app.get('/gsd-utils.js', (req, res) => res.sendFile(path.join(publicDir, 'gsd-utils.js')));
  app.use('/login', express.static(path.join(publicDir, 'login'), { index: 'index_login.html' }));

  function protectPage(...roles) {
    return route(async (req, res, next) => {
      if (!req.session.userId) return res.redirect('/login/index_login.html');
      const { rows } = await database.query(
        'SELECT id, role, password_reset_required FROM users WHERE id = $1',
        [req.session.userId]
      );
      if (!rows.length || rows[0].password_reset_required || !roles.includes(rows[0].role)) {
        return res.redirect('/login/index_login.html');
      }
      next();
    });
  }

  app.get('/presidente/index_presidente.html', protectPage(...PRESIDENT), (req, res) => {
    res.sendFile(path.join(publicDir, 'presidente', 'index_presidente.html'));
  });
  app.get('/coordenador/index_coordenador.html', protectPage('coordenador'), (req, res) => {
    res.sendFile(path.join(publicDir, 'coordenador', 'index_coordenador.html'));
  });
  app.get('/membro/index_membro.html', protectPage('membro'), (req, res) => {
    res.sendFile(path.join(publicDir, 'membro', 'index_membro.html'));
  });
  app.use('/presidente', express.static(path.join(publicDir, 'presidente')));
  app.use('/coordenador', express.static(path.join(publicDir, 'coordenador')));
  app.use('/membro', express.static(path.join(publicDir, 'membro')));
  app.get('/', (req, res) => res.redirect('/login/index_login.html'));

  app.post('/api/login', loginLimiter, route(async (req, res) => {
    const userEmail = email(req.body && req.body.email);
    const password = secret(req.body && req.body.password, 'Senha');
    const { rows } = await database.query(
      'SELECT id, name, email, role, sector, photo_path, password_hash, password_reset_required FROM users WHERE email = $1',
      [userEmail]
    );
    if (!rows.length || !(await verifyPassword(rows[0].password_hash, password))) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    if (rows[0].password_reset_required) {
      return res.status(403).json({
        error: 'A senha desta conta precisa ser redefinida por um administrador.',
        code: 'PASSWORD_RESET_REQUIRED'
      });
    }
    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => error ? reject(error) : resolve());
    });
    req.session.userId = rows[0].id;
    await new Promise((resolve, reject) => {
      req.session.save((error) => error ? reject(error) : resolve());
    });
    res.status(200).json({ message: 'Login realizado com sucesso!', user: publicUser(rows[0]) });
  }));

  app.post('/api/logout', route(async (req, res) => {
    if (req.session) {
      await new Promise((resolve, reject) => {
        req.session.destroy((error) => error ? reject(error) : resolve());
      });
    }
    res.clearCookie('gsd.sid', {
      httpOnly: true,
      secure: config.production,
      sameSite: 'lax'
    });
    res.status(204).end();
  }));

  app.post('/api/password/reset', resetLimiter, route(async (req, res) => {
    const token = text(req.body && req.body.token, 'Token', 200);
    const password = secret(req.body && req.body.password, 'Senha');
    if (password.length < 12) throw new ValidationError('A nova senha deve ter ao menos 12 caracteres.');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await database.transaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT user_id FROM password_resets
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2${database.lockClause}`,
        [tokenHash, new Date()]
      );
      if (!rows.length) throw new ValidationError('Token inválido ou expirado.');
      const passwordHash = await hashPassword(password);
      await tx.query(
        'UPDATE users SET password_hash = $1, password_reset_required = FALSE WHERE id = $2',
        [passwordHash, rows[0].user_id]
      );
      await tx.query('UPDATE password_resets SET used_at = $1 WHERE token_hash = $2', [new Date(), tokenHash]);
      await tx.query('DELETE FROM sessions');
    });
    res.status(200).json({ message: 'Senha atualizada. Entre novamente.' });
  }));

  app.use('/api', auth);

  app.get('/api/me', (req, res) => res.json(publicUser(req.user)));
  app.post('/api/password/change', route(async (req, res) => {
    const currentPassword = secret(req.body && req.body.currentPassword, 'Senha atual');
    const newPassword = secret(req.body && req.body.newPassword, 'Nova senha');
    if (newPassword.length < 12) throw new ValidationError('A nova senha deve ter ao menos 12 caracteres.');
    const { rows } = await database.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows.length || !(await verifyPassword(rows[0].password_hash, currentPassword))) {
      return res.status(401).json({ error: 'Senha atual inválida.' });
    }
    const passwordHash = await hashPassword(newPassword);
    await database.query(
      'UPDATE users SET password_hash = $1, password_reset_required = FALSE WHERE id = $2',
      [passwordHash, req.user.id]
    );
    await database.query('DELETE FROM sessions');
    res.status(200).json({ message: 'Senha atualizada. Entre novamente.' });
  }));

  app.get('/api/usuarios', route(async (req, res) => {
    const requestedEmail = req.query.email ? email(req.query.email) : null;
    if (requestedEmail && requestedEmail !== req.user.email && !PRESIDENT.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente.' });
    }
    const filter = requestedEmail ? 'WHERE email = $1' : '';
    const params = requestedEmail ? [requestedEmail] : [];
    const { rows } = await database.query(
      `SELECT id, name, email, role, sector, photo_path FROM users ${filter} ORDER BY name`,
      params
    );
    res.json(rows.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sector: user.sector,
      foto_url: user.photo_path ? `/api/usuarios/${user.id}/foto` : null
    })));
  }));

  app.post('/api/usuarios', requirePresident, route(async (req, res) => {
    const name = text(req.body && req.body.name, 'Nome', 120);
    const userEmail = email(req.body && req.body.email);
    const role = text(req.body && req.body.role, 'Papel', 40);
    const sector = text(req.body && req.body.sector, 'Setor', 120);
    if (!VALID_ROLES.has(role)) throw new ValidationError('Papel inválido.');
    const temporaryHash = await hashPassword(newResetToken());
    const { rows } = await database.query(
      `INSERT INTO users (name, email, role, sector, password_hash, password_reset_required)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, name, email, role, sector`,
      [name, userEmail, role, sector, temporaryHash]
    );
    const resetToken = await issueResetToken(database, rows[0].id);
    res.status(201).json({
      user: rows[0],
      reset_url: `/login/index_login.html#reset=${encodeURIComponent(resetToken)}`
    });
  }));

  app.post('/api/usuarios/:id/password-reset', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rows } = await database.query('SELECT id FROM users WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado.' });
    await database.query('UPDATE users SET password_reset_required = TRUE WHERE id = $1', [id]);
    const resetToken = await issueResetToken(database, id);
    await database.query('DELETE FROM sessions');
    res.json({ reset_url: `/login/index_login.html#reset=${encodeURIComponent(resetToken)}` });
  }));

  app.post('/api/usuarios/foto', uploadProfile, route(async (req, res) => {
    ensureFile(req.file, 'profile');
    const stored = await storage.upload('profile', req.file);
    const photoPath = `${stored.bucket}/${stored.key}`;
    try {
      await database.query(
        'UPDATE users SET photo_path = $1, photo_type = $2 WHERE id = $3',
        [photoPath, req.file.mimetype, req.user.id]
      );
    } catch (error) {
      await removeOrphanedUpload(storage, stored);
      throw error;
    }
    res.json({ foto_url: `/api/usuarios/${req.user.id}/foto` });
  }));

  app.get('/api/usuarios/:id/foto', route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    if (id !== req.user.id && !PRESIDENT.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente.' });
    }
    const { rows } = await database.query('SELECT photo_path, photo_type FROM users WHERE id = $1', [id]);
    if (!rows.length || !rows[0].photo_path) return res.status(404).json({ error: 'Foto não encontrada.' });
    const [bucket, ...keyParts] = rows[0].photo_path.split('/');
    const content = await storage.download(bucket, keyParts.join('/'));
    res.type(rows[0].photo_type || 'image/jpeg').set('Cache-Control', 'private, no-store').send(content);
  }));

  app.post('/api/reunioes', requirePresident, route(async (req, res) => {
    const name = text(req.body && req.body.nome, 'Nome', 160);
    const description = text(req.body && req.body.descricao, 'Descrição', 5000);
    const attendance = req.body && req.body.presencas;
    if (!Array.isArray(attendance) || attendance.length > 500) throw new ValidationError('Lista de presenças inválida.');
    const { id } = await database.transaction(async (tx) => {
      const meeting = await tx.query(
        'INSERT INTO reunioes (nome, descricao) VALUES ($1, $2) RETURNING id',
        [name, description]
      );
      for (const item of attendance) {
        const userId = integer(item.id, 'Usuário');
        if (!['presente', 'ausente'].includes(item.status)) throw new ValidationError('Status de presença inválido.');
        await tx.query(
          'INSERT INTO presencas (reuniao_id, usuario_id, status) VALUES ($1, $2, $3)',
          [meeting.rows[0].id, userId, item.status]
        );
      }
      return { id: meeting.rows[0].id };
    });
    res.status(201).json({ id, message: 'Reunião salva com sucesso!' });
  }));

  app.get('/api/reunioes', requireRoles(...PRESIDENT), route(async (req, res) => {
    const { rows } = await database.query(
      `SELECT r.id, r.nome, r.descricao, r.data_criacao,
              p.usuario_id, p.status, u.name AS usuario_nome
       FROM reunioes r
       LEFT JOIN presencas p ON p.reuniao_id = r.id
       LEFT JOIN users u ON u.id = p.usuario_id
       ORDER BY r.data_criacao DESC`
    );
    res.json(groupMeetings(rows));
  }));

  app.get('/api/reunioes/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rows } = await database.query(
      `SELECT r.id, r.nome, r.descricao, r.data_criacao,
              p.usuario_id, p.status, u.name AS usuario_nome
       FROM reunioes r
       LEFT JOIN presencas p ON p.reuniao_id = r.id
       LEFT JOIN users u ON u.id = p.usuario_id
       WHERE r.id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Reunião não encontrada.' });
    res.json(groupMeetings(rows)[0]);
  }));

  app.put('/api/reunioes/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const name = text(req.body && req.body.nome, 'Nome', 160);
    const description = text(req.body && req.body.descricao, 'Descrição', 5000);
    const attendance = req.body && req.body.presencas;
    if (!Array.isArray(attendance) || attendance.length > 500) throw new ValidationError('Lista de presenças inválida.');
    await database.transaction(async (tx) => {
      const { rowCount } = await tx.query('UPDATE reunioes SET nome = $1, descricao = $2 WHERE id = $3', [name, description, id]);
      if (!rowCount) throw Object.assign(new Error('Reunião não encontrada.'), { status: 404 });
      await tx.query('DELETE FROM presencas WHERE reuniao_id = $1', [id]);
      for (const item of attendance) {
        const userId = integer(item.id, 'Usuário');
        if (!['presente', 'ausente'].includes(item.status)) throw new ValidationError('Status de presença inválido.');
        await tx.query(
          'INSERT INTO presencas (reuniao_id, usuario_id, status) VALUES ($1, $2, $3)',
          [id, userId, item.status]
        );
      }
    });
    res.json({ message: 'Reunião atualizada com sucesso!' });
  }));

  app.delete('/api/reunioes/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rowCount } = await database.query('DELETE FROM reunioes WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Reunião não encontrada.' });
    res.status(204).end();
  }));

  app.get('/api/relatorios', route(async (req, res) => {
    const isPresident = PRESIDENT.includes(req.user.role);
    const filter = isPresident ? '' : 'WHERE r.usuario_id = $1';
    const params = isPresident ? [] : [req.user.id];
    const { rows } = await database.query(
      `SELECT r.id, r.tipo, r.projeto, r.coordenador, r.status, r.data_envio,
              r.conteudo, r.observacao, r.usuario_email
       FROM relatorios r ${filter} ORDER BY r.data_envio DESC`,
      params
    );
    res.json(rows);
  }));

  app.post('/api/relatorios', requireRoles('coordenador', 'membro', ...PRESIDENT), route(async (req, res) => {
    const tipo = text(req.body && req.body.tipo, 'Tipo', 100);
    const project = text(req.body && req.body.projeto, 'Projeto', 200);
    const content = text(req.body && req.body.conteudo, 'Conteúdo', 10000, true);
    const { rows } = await database.query(
      `INSERT INTO relatorios (tipo, projeto, coordenador, status, conteudo, observacao, usuario_email, usuario_id)
       VALUES ($1, $2, $3, 'Pendente', $4, NULL, $5, $6) RETURNING id`,
      [tipo, project, req.user.name, content, req.user.email, req.user.id]
    );
    res.status(201).json({ id: rows[0].id });
  }));

  app.put('/api/relatorios/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const status = text(req.body && req.body.status, 'Status', 30);
    const observation = text(req.body && req.body.observacao, 'Observação', 5000, true);
    if (!REPORT_STATUSES.has(status)) throw new ValidationError('Status de relatório inválido.');
    const { rowCount } = await database.query(
      'UPDATE relatorios SET status = $1, observacao = $2 WHERE id = $3',
      [status, observation, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Relatório não encontrado.' });
    res.json({ message: 'Relatório atualizado com sucesso!' });
  }));

  app.post('/api/comissoes', requirePresident, route(async (req, res) => {
    const name = text(req.body && req.body.nome, 'Nome', 160);
    const type = text(req.body && req.body.tipo, 'Tipo', 40);
    if (!['Fixa', 'Temporária'].includes(type)) throw new ValidationError('Tipo de comissão inválido.');
    const coordinatorId = req.body.coordenador_id ? integer(req.body.coordenador_id, 'Coordenador') : null;
    const coordinatorName = text(req.body.coordenador_nome, 'Coordenador', 120, true);
    const { rows } = await database.query(
      `INSERT INTO comissoes (nome, tipo, coordenador_id, coordenador_nome)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, type, coordinatorId, coordinatorName]
    );
    res.status(201).json({ id: rows[0].id });
  }));

  app.get('/api/comissoes', route(async (req, res) => {
    const isPresident = PRESIDENT.includes(req.user.role);
    const sql = isPresident
      ? `SELECT c.*, COUNT(DISTINCT m.id) AS membros_count
         FROM comissoes c LEFT JOIN membros_comissao m ON m.comissao_id = c.id
         GROUP BY c.id ORDER BY c.data_criacao DESC`
      : `SELECT c.*, COUNT(DISTINCT m.id) AS membros_count FROM comissoes c
         LEFT JOIN membros_comissao m ON m.comissao_id = c.id
         WHERE c.coordenador_id = $1 OR m.usuario_id = $1
         GROUP BY c.id ORDER BY c.data_criacao DESC`;
    const { rows } = await database.query(sql, isPresident ? [] : [req.user.id]);
    res.json(rows);
  }));

  app.post('/api/membros_comissao', requirePresident, route(async (req, res) => {
    const commissionId = integer(req.body && req.body.comissao_id, 'Comissão');
    const name = text(req.body && req.body.nome, 'Nome', 120);
    const userEmail = req.body.email ? email(req.body.email) : null;
    const functionName = text(req.body.funcao, 'Função', 120, true);
    let userId = req.body.usuario_id ? integer(req.body.usuario_id, 'Usuário') : null;
    let resetToken;
    const result = await database.transaction(async (tx) => {
      if (!userId && userEmail) {
        const temporaryHash = await hashPassword(newResetToken());
        const created = await tx.query(
          `INSERT INTO users (name, email, role, sector, password_hash, password_reset_required)
           VALUES ($1, $2, 'membro', 'Comissão', $3, TRUE) RETURNING id`,
          [name, userEmail, temporaryHash]
        );
        userId = created.rows[0].id;
      } else if (!userId) {
        throw new ValidationError('Selecione um usuário existente ou informe um e-mail para criar a conta.');
      }
      const member = await tx.query(
        `INSERT INTO membros_comissao (comissao_id, usuario_id, nome, email, funcao)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [commissionId, userId, name, userEmail, functionName]
      );
      return { id: member.rows[0].id, userId };
    });
    if (result.userId) {
      const { rows } = await database.query('SELECT password_reset_required FROM users WHERE id = $1', [result.userId]);
      if (rows[0] && rows[0].password_reset_required) resetToken = await issueResetToken(database, result.userId);
    }
    res.status(201).json({
      id: result.id,
      reset_url: resetToken ? `/login/index_login.html#reset=${encodeURIComponent(resetToken)}` : undefined
    });
  }));

  app.get('/api/comissoes/:id/membros', route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    if (!PRESIDENT.includes(req.user.role)) {
      const { rows } = await database.query(
        `SELECT 1 FROM comissoes c LEFT JOIN membros_comissao m ON m.comissao_id = c.id
         WHERE c.id = $1 AND (c.coordenador_id = $2 OR m.usuario_id = $2)`,
        [id, req.user.id]
      );
      if (!rows.length) return res.status(403).json({ error: 'Permissão insuficiente.' });
    }
    const { rows } = await database.query(
      `SELECT m.id, m.comissao_id, m.usuario_id, m.nome, m.email, m.funcao,
              u.name AS usuario_nome
       FROM membros_comissao m LEFT JOIN users u ON u.id = m.usuario_id
       WHERE m.comissao_id = $1 ORDER BY m.nome`,
      [id]
    );
    res.json(rows);
  }));

  app.put('/api/comissoes/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const name = text(req.body && req.body.nome, 'Nome', 160);
    const type = text(req.body && req.body.tipo, 'Tipo', 40);
    if (!['Fixa', 'Temporária'].includes(type)) throw new ValidationError('Tipo de comissão inválido.');
    const coordinatorId = req.body.coordenador_id ? integer(req.body.coordenador_id, 'Coordenador') : null;
    const coordinatorName = text(req.body.coordenador_nome, 'Coordenador', 120, true);
    const { rowCount } = await database.query(
      'UPDATE comissoes SET nome = $1, tipo = $2, coordenador_id = $3, coordenador_nome = $4 WHERE id = $5',
      [name, type, coordinatorId, coordinatorName, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Comissão não encontrada.' });
    res.json({ message: 'Comissão atualizada com sucesso!' });
  }));

  app.delete('/api/comissoes/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rowCount } = await database.query('DELETE FROM comissoes WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Comissão não encontrada.' });
    res.status(204).end();
  }));

  app.put('/api/membros_comissao/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const name = text(req.body && req.body.nome, 'Nome', 120);
    const memberEmail = req.body.email ? email(req.body.email) : null;
    const functionName = text(req.body.funcao, 'Função', 120, true);
    const { rowCount } = await database.query(
      'UPDATE membros_comissao SET nome = $1, email = $2, funcao = $3 WHERE id = $4',
      [name, memberEmail, functionName, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Membro não encontrado.' });
    res.json({ message: 'Membro atualizado com sucesso!' });
  }));

  app.delete('/api/membros_comissao/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rowCount } = await database.query('DELETE FROM membros_comissao WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Membro não encontrado.' });
    res.status(204).end();
  }));

  app.post('/api/tarefas', requirePresident, route(async (req, res) => {
    const title = text(req.body && req.body.titulo, 'Título', 200);
    const description = text(req.body.descricao, 'Descrição', 5000, true);
    const deadline = date(req.body.data_limite, 'Data limite', true);
    const type = req.body.tipo_destinatario;
    const recipientId = req.body.destinatario_id ? integer(req.body.destinatario_id, 'Destinatário') : null;
    if (type && !['usuario', 'comissao'].includes(type)) throw new ValidationError('Tipo de destinatário inválido.');
    const userId = type === 'usuario' ? recipientId : null;
    const commissionId = type === 'comissao' ? recipientId : null;
    const { rows } = await database.query(
      `INSERT INTO tarefas
       (titulo, descricao, data_limite, tipo_destinatario, destinatario_usuario_id, destinatario_comissao_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [title, description, deadline, type || null, userId, commissionId]
    );
    res.status(201).json({ id: rows[0].id });
  }));

  app.get('/api/tarefas', route(async (req, res) => {
    let filter = '';
    let params = [];
    if (!PRESIDENT.includes(req.user.role)) {
      filter = `WHERE t.destinatario_usuario_id = $1
        OR t.destinatario_comissao_id IN (
          SELECT comissao_id FROM membros_comissao WHERE usuario_id = $1
        )`;
      params = [req.user.id];
    }
    const { rows } = await database.query(
      `SELECT t.* FROM tarefas t ${filter} ORDER BY t.data_criacao DESC`,
      params
    );
    res.json(rows.map(formatTask));
  }));

  app.put('/api/tarefas/:id', route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rows } = await database.query('SELECT * FROM tarefas WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Tarefa não encontrada.' });
    const task = rows[0];
    const isPresident = PRESIDENT.includes(req.user.role);
    const assignedToUser = task.destinatario_usuario_id === req.user.id;
    const assignedToCommission = task.destinatario_comissao_id
      ? await database.query(
        'SELECT 1 FROM membros_comissao WHERE comissao_id = $1 AND usuario_id = $2',
        [task.destinatario_comissao_id, req.user.id]
      ).then((result) => result.rows.length > 0)
      : false;
    if (!isPresident && !assignedToUser && !assignedToCommission) {
      return res.status(403).json({ error: 'Permissão insuficiente.' });
    }
    const updates = [];
    const values = [];
    const add = (column, value) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };
    if (req.body.status !== undefined) {
      if (!TASK_STATUSES.has(req.body.status)) throw new ValidationError('Status de tarefa inválido.');
      add('status', req.body.status);
    }
    if (isPresident) {
      if (req.body.titulo !== undefined) add('titulo', text(req.body.titulo, 'Título', 200));
      if (req.body.descricao !== undefined) add('descricao', text(req.body.descricao, 'Descrição', 5000, true));
      if (req.body.data_limite !== undefined) add('data_limite', date(req.body.data_limite, 'Data limite', true));
      if (req.body.tipo_destinatario !== undefined || req.body.destinatario_id !== undefined) {
        const type = req.body.tipo_destinatario;
        if (type && !['usuario', 'comissao'].includes(type)) throw new ValidationError('Tipo de destinatário inválido.');
        const targetId = req.body.destinatario_id ? integer(req.body.destinatario_id, 'Destinatário') : null;
        add('tipo_destinatario', type || null);
        add('destinatario_usuario_id', type === 'usuario' ? targetId : null);
        add('destinatario_comissao_id', type === 'comissao' ? targetId : null);
      }
    } else if (Object.keys(req.body).some((key) => key !== 'status')) {
      return res.status(403).json({ error: 'Usuários atribuídos só podem atualizar o status.' });
    }
    if (!updates.length) throw new ValidationError('Nenhum campo para atualizar.');
    values.push(id);
    await database.query(`UPDATE tarefas SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
    res.json({ message: 'Tarefa atualizada com sucesso!' });
  }));

  app.delete('/api/tarefas/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rowCount } = await database.query('DELETE FROM tarefas WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Tarefa não encontrada.' });
    res.status(204).end();
  }));

  app.post('/api/arquivos', requirePresident, uploadDocument, route(async (req, res) => {
    ensureFile(req.file, 'document');
    const category = text(req.body.categoria, 'Categoria', 80, true);
    const visibility = req.body.visibilidade || 'geral';
    if (!DOCUMENT_VISIBILITIES.has(visibility)) throw new ValidationError('Visibilidade do arquivo inválida.');
    const stored = await storage.upload('document', req.file);
    let rows;
    try {
      ({ rows } = await database.query(
        `INSERT INTO arquivos
         (nome_original, nome_armazenado, tipo, categoria, visibilidade, storage_bucket, object_key, enviado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [req.file.originalname, stored.key, req.file.mimetype, category, visibility,
          stored.bucket, stored.key, req.user.id]
      ));
    } catch (error) {
      await removeOrphanedUpload(storage, stored);
      throw error;
    }
    res.status(201).json({ id: rows[0].id });
  }));

  app.get('/api/arquivos', route(async (req, res) => {
    const visibilityFilter = req.user.role === 'membro' ? "WHERE visibilidade = 'geral'" : '';
    const { rows } = await database.query(
      `SELECT id, nome_original, nome_armazenado, tipo, categoria, visibilidade, data_upload
       FROM arquivos ${visibilityFilter} ORDER BY data_upload DESC`
    );
    res.json(rows.map((row) => ({ ...row, url: `/api/arquivos/${row.id}/content` })));
  }));

  app.get('/api/arquivos/:id/content', route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const visibilityFilter = req.user.role === 'membro' ? " AND visibilidade = 'geral'" : '';
    const { rows } = await database.query(
      `SELECT nome_original, tipo, storage_bucket, object_key
       FROM arquivos WHERE id = $1${visibilityFilter}`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    const content = await storage.download(rows[0].storage_bucket, rows[0].object_key);
    res.type(rows[0].tipo || 'application/octet-stream')
      .attachment(rows[0].nome_original)
      .set('Cache-Control', 'private, no-store')
      .send(content);
  }));

  app.delete('/api/arquivos/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rows } = await database.query(
      'SELECT storage_bucket, object_key FROM arquivos WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    await storage.remove(rows[0].storage_bucket, rows[0].object_key);
    await database.query('DELETE FROM arquivos WHERE id = $1', [id]);
    res.status(204).end();
  }));

  app.post('/api/eventos', requirePresident, route(async (req, res) => {
    const title = text(req.body && req.body.titulo, 'Título', 200);
    const description = text(req.body.descricao, 'Descrição', 5000, true);
    const start = date(req.body.inicio, 'Início');
    const end = date(req.body.fim, 'Fim', true);
    const type = text(req.body.tipo, 'Tipo', 80, true);
    const { rows } = await database.query(
      `INSERT INTO eventos (titulo, descricao, inicio, fim, tipo, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [title, description, start, end, type, req.user.name]
    );
    res.status(201).json({ id: rows[0].id });
  }));

  app.get('/api/eventos', route(async (req, res) => {
    const { rows } = await database.query('SELECT * FROM eventos ORDER BY inicio ASC');
    res.json(rows);
  }));

  app.put('/api/eventos/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const title = text(req.body && req.body.titulo, 'Título', 200);
    const description = text(req.body.descricao, 'Descrição', 5000, true);
    const start = date(req.body.inicio, 'Início');
    const end = date(req.body.fim, 'Fim', true);
    const type = text(req.body.tipo, 'Tipo', 80, true);
    const { rowCount } = await database.query(
      'UPDATE eventos SET titulo = $1, descricao = $2, inicio = $3, fim = $4, tipo = $5 WHERE id = $6',
      [title, description, start, end, type, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Evento não encontrado.' });
    res.json({ message: 'Evento atualizado com sucesso!' });
  }));

  app.delete('/api/eventos/:id', requirePresident, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rowCount } = await database.query('DELETE FROM eventos WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Evento não encontrado.' });
    res.status(204).end();
  }));

  app.get('/api/ranking', route(async (req, res) => {
    const { rows } = await database.query(
      `SELECT u.id, u.name,
       (SELECT COUNT(*) FROM presencas p WHERE p.usuario_id = u.id AND p.status = 'presente') AS presencas,
       (SELECT COUNT(*) FROM tarefas t WHERE t.destinatario_usuario_id = u.id AND t.status = 'Concluída') AS tarefas_concluidas,
       ((SELECT COUNT(*) FROM presencas p WHERE p.usuario_id = u.id AND p.status = 'presente') +
        (SELECT COUNT(*) FROM tarefas t WHERE t.destinatario_usuario_id = u.id AND t.status = 'Concluída')) AS pontos
       FROM users u ORDER BY pontos DESC, u.name ASC`
    );
    res.json(rows);
  }));

  function canteen(req, res, next) {
    if (PRESIDENT.includes(req.user.role)
      || (req.user.role === 'coordenador' && req.user.sector.toLocaleLowerCase('pt-BR') === 'finanças')) {
      return next();
    }
    res.status(403).json({ error: 'Permissão insuficiente.' });
  }

  app.get('/api/produtos', canteen, route(async (req, res) => {
    const { rows } = await database.query('SELECT * FROM produtos ORDER BY id ASC');
    res.json(rows.map((row) => ({ ...row, preco: Number(row.preco) })));
  }));

  app.post('/api/produtos', canteen, route(async (req, res) => {
    const name = text(req.body && req.body.nome, 'Nome', 160);
    const price = money(req.body && req.body.preco, 'Preço');
    const quantity = integer(req.body && req.body.quantidade, 'Quantidade', 0);
    const { rows } = await database.query(
      'INSERT INTO produtos (nome, preco, quantidade) VALUES ($1, $2, $3) RETURNING id',
      [name, price, quantity]
    );
    res.status(201).json({ id: rows[0].id });
  }));

  app.put('/api/produtos/:id', canteen, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const name = text(req.body && req.body.nome, 'Nome', 160);
    const price = money(req.body && req.body.preco, 'Preço');
    const quantity = integer(req.body && req.body.quantidade, 'Quantidade', 0);
    const { rowCount } = await database.query(
      'UPDATE produtos SET nome = $1, preco = $2, quantidade = $3 WHERE id = $4',
      [name, price, quantity, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ message: 'Produto atualizado com sucesso!' });
  }));

  app.delete('/api/produtos/:id', canteen, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    try {
      const { rowCount } = await database.query('DELETE FROM produtos WHERE id = $1', [id]);
      if (!rowCount) return res.status(404).json({ error: 'Produto não encontrado.' });
      res.status(204).end();
    } catch (error) {
      if (error.code === '23503' || error.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ error: 'Produto já faz parte de uma venda e não pode ser removido.' });
      }
      throw error;
    }
  }));

  app.post('/api/vendas', canteen, route(async (req, res) => {
    const incoming = req.body && (req.body.produtos || req.body.items);
    if (!Array.isArray(incoming) || !incoming.length || incoming.length > 100) {
      throw new ValidationError('Itens da venda inválidos.');
    }
    const quantities = new Map();
    for (const item of incoming) {
      const id = integer(item.id || item.productId, 'Produto');
      const quantity = integer(item.quantidade || item.quantity, 'Quantidade');
      quantities.set(id, (quantities.get(id) || 0) + quantity);
    }
    const received = cents(money(req.body.valorRecebido ?? req.body.amountReceived, 'Valor recebido'));
    const sale = await database.transaction(async (tx) => {
      let totalCents = 0;
      const saleItems = [];
      for (const [productId, quantity] of quantities) {
        const { rows } = await tx.query(
          `SELECT id, nome, preco, quantidade FROM produtos WHERE id = $1${database.lockClause}`,
          [productId]
        );
        if (!rows.length) throw new ValidationError('Um ou mais produtos não existem.');
        const product = rows[0];
        if (product.quantidade < quantity) throw new ValidationError(`Estoque insuficiente para ${product.nome}.`);
        const priceCents = cents(product.preco);
        totalCents += priceCents * quantity;
        saleItems.push({ id: productId, nome: product.nome, quantidade: quantity, preco: toCurrency(priceCents) });
      }
      if (received < totalCents) throw new ValidationError('Valor recebido insuficiente.');
      const changeCents = received - totalCents;
      const { rows } = await tx.query(
        `INSERT INTO vendas (produtos, total, valor_recebido, troco, usuario_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [JSON.stringify(saleItems), toCurrency(totalCents), toCurrency(received), toCurrency(changeCents), req.user.id]
      );
      const saleId = rows[0].id;
      for (const item of saleItems) {
        await tx.query(
          `INSERT INTO itens_venda (venda_id, produto_id, nome_produto, quantidade, preco_unitario)
           VALUES ($1, $2, $3, $4, $5)`,
          [saleId, item.id, item.nome, item.quantidade, item.preco]
        );
        await tx.query('UPDATE produtos SET quantidade = quantidade - $1 WHERE id = $2', [item.quantidade, item.id]);
      }
      return { id: saleId, total: toCurrency(totalCents), troco: toCurrency(changeCents), items: saleItems };
    });
    res.status(201).json(sale);
  }));

  app.get('/api/vendas', canteen, route(async (req, res) => {
    const { rows } = await database.query(
      `SELECT id, produtos, total, valor_recebido, troco, data_venda
       FROM vendas ORDER BY data_venda DESC LIMIT 500`
    );
    res.json(rows.map((row) => ({
      ...row,
      produtos: typeof row.produtos === 'string' ? JSON.parse(row.produtos) : row.produtos,
      valorRecebido: row.valor_recebido,
      total: Number(row.total),
      troco: Number(row.troco)
    })));
  }));

  function radioAccess(req, res, next) {
    if (PRESIDENT.includes(req.user.role) || req.user.sector.toLocaleLowerCase('pt-BR') === 'rádio gsd mix') {
      return next();
    }
    res.status(403).json({ error: 'Permissão insuficiente.' });
  }

  app.post('/api/audios', radioAccess, uploadAudio, route(async (req, res) => {
    ensureFile(req.file, 'audio');
    const type = text(req.body.tipo, 'Tipo', 40);
    const description = text(req.body.descricao, 'Descrição', 1000, true);
    const stored = await storage.upload('audio', req.file);
    let rows;
    try {
      ({ rows } = await database.query(
        `INSERT INTO audios
         (nome_original, nome_armazenado, tipo, descricao, storage_bucket, object_key, enviado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.file.originalname, stored.key, type, description, stored.bucket, stored.key, req.user.id]
      ));
    } catch (error) {
      await removeOrphanedUpload(storage, stored);
      throw error;
    }
    res.status(201).json({ id: rows[0].id });
  }));

  app.get('/api/audios', radioAccess, route(async (req, res) => {
    const { rows } = await database.query(
      `SELECT id, nome_original, nome_armazenado, tipo, descricao, data_upload
       FROM audios ORDER BY data_upload DESC`
    );
    res.json(rows.map((row) => ({ ...row, url: `/api/audios/${row.id}/content` })));
  }));

  app.get('/api/audios/:id/content', radioAccess, route(async (req, res) => {
    const id = integer(req.params.id, 'ID');
    const { rows } = await database.query(
      'SELECT nome_original, tipo, storage_bucket, object_key FROM audios WHERE id = $1',
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Áudio não encontrado.' });
    const content = await storage.download(rows[0].storage_bucket, rows[0].object_key);
    res.type(rows[0].tipo || 'audio/mpeg')
      .attachment(rows[0].nome_original)
      .set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(rows[0].nome_original)}`)
      .set('Cache-Control', 'private, no-store')
      .send(content);
  }));

  app.post('/api/comunicados', radioAccess, route(async (req, res) => {
    const message = text(req.body && req.body.mensagem, 'Mensagem', 2000);
    const { rows } = await database.query(
      'INSERT INTO comunicados (mensagem, criado_por) VALUES ($1, $2) RETURNING id',
      [message, req.user.id]
    );
    res.status(201).json({ id: rows[0].id });
  }));

  app.get('/api/comunicados', radioAccess, route(async (req, res) => {
    const { rows } = await database.query('SELECT * FROM comunicados ORDER BY data_envio DESC');
    res.json(rows);
  }));

  app.post('/api/eventos_radio', radioAccess, route(async (req, res) => {
    const title = text(req.body && req.body.titulo, 'Título', 200);
    const start = date(req.body.inicio, 'Início');
    const end = date(req.body.fim, 'Fim', true);
    const description = text(req.body.descricao, 'Descrição', 2000, true);
    const { rows } = await database.query(
      `INSERT INTO eventos_radio (titulo, inicio, fim, descricao, criado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, start, end, description, req.user.id]
    );
    res.status(201).json({ id: rows[0].id });
  }));

  app.get('/api/eventos_radio', radioAccess, route(async (req, res) => {
    const { rows } = await database.query('SELECT * FROM eventos_radio ORDER BY inicio');
    res.json(rows);
  }));

  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof multer.MulterError) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Upload inválido.' });
    }
    if (error.code === '23505' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Registro duplicado.' });
    }
    if (error.status === 404) return res.status(404).json({ error: error.message });
    console.error('Request failed', { name: error.name, code: error.code || 'INTERNAL_ERROR' });
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });

  return { app, sessionStore };
}

function groupMeetings(rows) {
  const meetings = new Map();
  for (const row of rows) {
    if (!meetings.has(row.id)) {
      meetings.set(row.id, {
        id: row.id,
        nome: row.nome,
        descricao: row.descricao,
        data_criacao: row.data_criacao,
        presencas: []
      });
    }
    if (row.usuario_id) {
      meetings.get(row.id).presencas.push({
        usuario_id: row.usuario_id,
        usuario_nome: row.usuario_nome,
        status: row.status
      });
    }
  }
  return [...meetings.values()];
}

module.exports = { createApp, fileSignatureIsValid, groupMeetings };
