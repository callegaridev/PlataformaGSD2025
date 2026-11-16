const fs = require('node:fs/promises');
const path = require('node:path');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const { PGlite } = require('@electric-sql/pglite');
const request = require('supertest');
const { createApp } = require('../src/app');

let pg;
let database;
let storage;
let app;
let president;
let financeCoordinator;
let radioCoordinator;
let member;
const objects = new Map();

function createTestDatabase(client) {
  const query = (sql, params = []) => client.query(sql, params);
  return {
    query,
    transaction: (work) => client.transaction((tx) => work({
      query: (sql, params = []) => tx.query(sql, params)
    })),
    lockClause: ' FOR UPDATE'
  };
}

function createTestApp() {
  return createApp({
    config: {
      production: false,
      sessionSecret: 'test-session-secret-with-more-than-32-characters',
      allowedOrigins: [],
      storageBuckets: {
        document: 'gsd-documents',
        audio: 'gsd-audios',
        profile: 'gsd-profile-photos'
      },
      maxDocumentBytes: 1024 * 1024,
      maxAudioBytes: 1024 * 1024,
      maxProfileBytes: 1024 * 1024
    },
    database,
    storage
  }).app;
}

async function login(email) {
  const agent = request.agent(app);
  const response = await agent.post('/api/login').send({ email, password: 'Test-password-123!' });
  assert.equal(response.status, 200);
  return agent;
}

before(async () => {
  pg = new PGlite();
  const schema = await fs.readFile(path.join(__dirname, '..', 'migrations', '001_initial_schema.sql'), 'utf8');
  await pg.exec(schema);
  const visibilityMigration = await fs.readFile(
    path.join(__dirname, '..', 'migrations', '003_document_visibility.sql'),
    'utf8'
  );
  await pg.exec(visibilityMigration);
  database = createTestDatabase(pg);
  storage = {
    async upload(kind, file) {
      const key = `${kind}-${objects.size + 1}`;
      const bucket = `gsd-${kind === 'document' ? 'documents' : kind === 'profile' ? 'profile-photos' : 'audios'}`;
      objects.set(`${bucket}/${key}`, Buffer.from(file.buffer));
      return { bucket, key };
    },
    async download(bucket, key) {
      const value = objects.get(`${bucket}/${key}`);
      if (!value) throw new Error('Object not found.');
      return value;
    },
    async remove(bucket, key) {
      objects.delete(`${bucket}/${key}`);
    }
  };
  app = createTestApp();
  const hash = await argon2.hash('Test-password-123!', { type: argon2.argon2id });
  const accounts = [
    ['Presidente', 'presidente@example.test', 'presidente', 'Diretoria Geral'],
    ['Vice-presidente', 'vice@example.test', 'vice-presidente', 'Diretoria Geral'],
    ['Financeiro', 'financeiro@example.test', 'coordenador', 'Finanças'],
    ['Rádio', 'radio@example.test', 'coordenador', 'Rádio GSD Mix'],
    ['Membro', 'membro@example.test', 'membro', 'Cultura']
  ];
  for (const [name, email, role, sector] of accounts) {
    const result = await pg.query(
      `INSERT INTO users (name, email, role, sector, password_hash, password_reset_required)
       VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id`,
      [name, email, role, sector, hash]
    );
    if (role === 'presidente') president = result.rows[0].id;
    if (sector === 'Finanças') financeCoordinator = result.rows[0].id;
    if (sector === 'Rádio GSD Mix') radioCoordinator = result.rows[0].id;
    if (role === 'membro') member = result.rows[0].id;
  }
});

after(async () => {
  if (pg) await pg.close();
});

test('authenticated workflows persist with role-specific access', async () => {
  assert.equal((await request(app).get('/healthz')).status, 200);
  assert.equal((await request(app).get('/readyz')).status, 200);
  assert.equal((await request(app).get('/api/me')).status, 401);
  assert.equal((await request(app).get('/api/arquivos')).status, 401);
  assert.equal((await request(app).post('/api/login')
    .set('Origin', 'https://untrusted.example')
    .send({ email: 'presidente@example.test', password: 'Test-password-123!' })).status, 403);
  assert.equal((await request(app).post('/api/login').send({
    email: 'presidente@example.test',
    password: 'wrong-password'
  })).status, 401);

  const admin = await login('presidente@example.test');
  const loginResponse = await admin.get('/api/me');
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.id, president);
  assert.equal(Object.prototype.hasOwnProperty.call(loginResponse.body, 'password_hash'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(loginResponse.body, 'photo_path'), false);

  const viceAgent = await login('vice@example.test');
  assert.equal((await viceAgent.post('/api/comissoes').send({
    nome: 'Comissão da vice',
    tipo: 'Fixa'
  })).status, 201);

  const forbiddenMeeting = await request.agent(app).post('/api/reunioes').send({
    nome: 'Reunião não autorizada',
    descricao: '',
    presencas: []
  });
  assert.equal(forbiddenMeeting.status, 401);

  const newUser = await admin.post('/api/usuarios').send({
    name: 'Novo membro',
    email: 'novo@example.test',
    role: 'membro',
    sector: 'Cultura'
  });
  assert.equal(newUser.status, 201);
  assert.match(newUser.body.reset_url, /^\/login\/index_login\.html#reset=/);
  assert.equal(JSON.stringify(newUser.body).includes('password'), false);
  assert.equal((await request(app).post('/api/login').send({
    email: 'novo@example.test',
    password: 'unavailable'
  })).status, 401);

  const memberAgent = await login('membro@example.test');
  assert.equal((await memberAgent.post('/api/reunioes').send({
    nome: 'Bloqueada',
    descricao: 'Sem autorização',
    presencas: []
  })).status, 403);

  const meeting = await admin.post('/api/reunioes').send({
    nome: 'Reunião de teste',
    descricao: 'Planejamento',
    presencas: [{ id: member, status: 'presente' }]
  });
  assert.equal(meeting.status, 201);
  const meetings = await admin.get('/api/reunioes');
  assert.equal(meetings.body[0].presencas[0].usuario_id, member);
  assert.equal((await admin.get('/api/reunioes/99999')).status, 404);

  const event = await admin.post('/api/eventos').send({
    titulo: 'Evento teste',
    inicio: '2027-01-15T12:00:00.000Z',
    fim: '2027-01-15T14:00:00.000Z',
    tipo: 'Escolar'
  });
  assert.equal(event.status, 201);
  assert.equal((await memberAgent.get('/api/eventos')).body.length, 1);

  const report = await memberAgent.post('/api/relatorios').send({
    tipo: 'Atividade',
    projeto: 'Feira escolar',
    conteudo: 'Concluído'
  });
  assert.equal(report.status, 201);
  assert.equal((await admin.get('/api/relatorios')).body.length, 1);
  assert.equal((await memberAgent.put(`/api/relatorios/${report.body.id}`).send({ status: 'Aprovado' })).status, 403);
  assert.equal((await admin.put(`/api/relatorios/${report.body.id}`).send({ status: 'Aprovado' })).status, 200);

  const commission = await admin.post('/api/comissoes').send({
    nome: 'Comissão teste',
    tipo: 'Temporária',
    coordenador_id: radioCoordinator,
    coordenador_nome: 'Rádio'
  });
  assert.equal(commission.status, 201);
  const commissionMember = await admin.post('/api/membros_comissao').send({
    comissao_id: commission.body.id,
    usuario_id: member,
    nome: 'Membro'
  });
  assert.equal(commissionMember.status, 201);
  assert.equal((await memberAgent.get(`/api/comissoes/${commission.body.id}/membros`)).status, 200);
  const memberCommissions = await memberAgent.get('/api/comissoes');
  assert.equal(memberCommissions.status, 200);
  assert.equal(memberCommissions.body.find((item) => item.id === commission.body.id).membros_count, 1);
  const coordinatorCommissions = await (await login('radio@example.test')).get('/api/comissoes');
  assert.equal(coordinatorCommissions.status, 200);
  assert.equal(coordinatorCommissions.body.find((item) => item.id === commission.body.id).membros_count, 1);

  const task = await admin.post('/api/tarefas').send({
    titulo: 'Tarefa teste',
    descricao: 'Atribuída ao membro',
    tipo_destinatario: 'usuario',
    destinatario_id: member
  });
  assert.equal(task.status, 201);
  assert.equal((await memberAgent.put(`/api/tarefas/${task.body.id}`).send({ status: 'Concluída' })).status, 200);
  assert.equal((await memberAgent.put(`/api/tarefas/${task.body.id}`).send({ titulo: 'Alteração indevida' })).status, 403);

  const pdf = Buffer.from('%PDF-1.7\nGSD test\n');
  const uploadedFile = await admin.post('/api/arquivos')
    .field('categoria', 'Ata')
    .attach('arquivo', pdf, { filename: 'ata.pdf', contentType: 'application/pdf' });
  assert.equal(uploadedFile.status, 201);
  const fileList = await memberAgent.get('/api/arquivos');
  assert.equal(fileList.body.length, 1);
  assert.deepEqual((await memberAgent.get(fileList.body[0].url)).body, pdf);
  const restrictedFile = await admin.post('/api/arquivos')
    .field('categoria', 'Ata')
    .field('visibilidade', 'gestao')
    .attach('arquivo', pdf, { filename: 'ata-restrita.pdf', contentType: 'application/pdf' });
  assert.equal(restrictedFile.status, 201);
  assert.equal((await memberAgent.get('/api/arquivos')).body.length, 1);
  assert.equal((await memberAgent.get(`/api/arquivos/${restrictedFile.body.id}/content`)).status, 404);
  assert.equal((await admin.post('/api/arquivos')
    .field('categoria', 'Ata')
    .field('visibilidade', 'publico')
    .attach('arquivo', pdf, { filename: 'invalid-visibility.pdf', contentType: 'application/pdf' })).status, 400);
  const coordinatorAgent = await login('financeiro@example.test');
  assert.equal((await coordinatorAgent.get('/api/arquivos')).body.length, 2);
  assert.deepEqual((await coordinatorAgent.get(`/api/arquivos/${restrictedFile.body.id}/content`)).body, pdf);
  assert.equal((await admin.post('/api/arquivos')
    .field('categoria', 'Ata')
    .attach('arquivo', Buffer.from('not a PDF'), { filename: 'invalid.pdf', contentType: 'application/pdf' })).status, 400);

  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const uploadedPhoto = await memberAgent.post('/api/usuarios/foto')
    .attach('foto', photo, { filename: 'profile.jpg', contentType: 'image/jpeg' });
  assert.equal(uploadedPhoto.status, 200);
  assert.deepEqual((await memberAgent.get(uploadedPhoto.body.foto_url)).body, photo);
  assert.equal((await memberAgent.get(`/api/usuarios/${president}/foto`)).status, 403);
  const memberSearch = await admin.get('/api/usuarios?email=membro%40example.test');
  assert.equal(memberSearch.body[0].foto_url, uploadedPhoto.body.foto_url);

  const unauthorizedProducts = await memberAgent.get('/api/produtos');
  assert.equal(unauthorizedProducts.status, 403);
  const financeAgent = coordinatorAgent;
  const product = await financeAgent.post('/api/produtos').send({
    nome: 'Suco',
    preco: '2.50',
    quantidade: 5
  });
  assert.equal(product.status, 201);
  const sale = await financeAgent.post('/api/vendas').send({
    produtos: [{ id: product.body.id, quantidade: 2 }],
    valorRecebido: '10.00'
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.body.total, '5.00');
  assert.equal(sale.body.troco, '5.00');
  assert.equal((await financeAgent.get('/api/produtos')).body[0].quantidade, 3);
  assert.equal((await financeAgent.post('/api/vendas').send({
    produtos: [{ id: product.body.id, quantidade: 4 }],
    valorRecebido: '10.00'
  })).status, 400);
  assert.equal((await pg.query('SELECT COUNT(*)::int AS count FROM vendas')).rows[0].count, 1);
  const raceResults = await Promise.all([
    financeAgent.post('/api/vendas').send({
      produtos: [{ id: product.body.id, quantidade: 2 }],
      valorRecebido: '10.00'
    }),
    financeAgent.post('/api/vendas').send({
      produtos: [{ id: product.body.id, quantidade: 2 }],
      valorRecebido: '10.00'
    })
  ]);
  assert.deepEqual(raceResults.map((result) => result.status).sort(), [201, 400]);
  assert.equal((await financeAgent.get('/api/produtos')).body[0].quantidade, 1);
  assert.equal((await pg.query('SELECT COUNT(*)::int AS count FROM vendas')).rows[0].count, 2);

  const radioAgent = await login('radio@example.test');
  assert.equal((await radioAgent.get(uploadedPhoto.body.foto_url)).status, 403);
  const mp3 = Buffer.from('ID3 test audio');
  const audio = await radioAgent.post('/api/audios')
    .field('tipo', 'Programa')
    .attach('audio', mp3, { filename: 'programa.mp3', contentType: 'audio/mpeg' });
  assert.equal(audio.status, 201);
  const audioList = await radioAgent.get('/api/audios');
  assert.equal(audioList.body.length, 1);
  assert.deepEqual((await radioAgent.get(audioList.body[0].url)).body, mp3);
  assert.equal((await radioAgent.post('/api/comunicados').send({ mensagem: 'Aviso' })).status, 201);
  assert.equal((await radioAgent.post('/api/eventos_radio').send({
    titulo: 'Programa ao vivo',
    inicio: '2027-01-15T12:00:00.000Z'
  })).status, 201);
  assert.equal((await radioAgent.get('/api/eventos_radio')).body.length, 1);

  const replacementApp = createTestApp();
  assert.equal((await admin.get('/api/me')).status, 200);
  app = replacementApp;
  assert.equal((await admin.get('/api/me')).status, 200);
  assert.equal((await admin.post('/api/logout')).status, 204);
  assert.equal((await admin.get('/api/me')).status, 401);

  const adminAfterRestart = await login('presidente@example.test');
  const userReset = await adminAfterRestart.post(`/api/usuarios/${member}/password-reset`);
  assert.equal(userReset.status, 200);
  assert.equal((await memberAgent.get('/api/me')).status, 401);
  assert.equal((await request(replacementApp).post('/api/login').send({
    email: 'membro@example.test',
    password: 'Test-password-123!'
  })).status, 403);

  const tokenFromUrl = (url) => new URLSearchParams(new URL(`http://localhost${url}`).hash.slice(1)).get('reset');
  const userResetToken = tokenFromUrl(userReset.body.reset_url);
  const userPasswordReset = await request(replacementApp).post('/api/password/reset').send({
    token: userResetToken,
    password: 'New-member-password-789!'
  });
  assert.equal(userPasswordReset.status, 200);
  assert.equal((await request(replacementApp).post('/api/password/reset').send({
    token: userResetToken,
    password: 'Another-password-789!'
  })).status, 400);
  const resetUser = await pg.query('SELECT password_hash, password_reset_required FROM users WHERE id = $1', [member]);
  assert.equal(resetUser.rows[0].password_reset_required, false);
  assert.equal(await argon2.verify(resetUser.rows[0].password_hash, 'New-member-password-789!'), true);
  const memberAfterReset = request.agent(replacementApp);
  assert.equal((await memberAfterReset.post('/api/login').send({
    email: 'membro@example.test',
    password: 'New-member-password-789!'
  })).status, 200);
  assert.equal((await memberAfterReset.get('/api/me')).status, 200);

  const newUserReset = await request(replacementApp).post('/api/password/reset').send({
    token: tokenFromUrl(newUser.body.reset_url),
    password: 'New-test-password-456!'
  });
  assert.equal(newUserReset.status, 200);
  const resetAgent = request.agent(replacementApp);
  const resetLogin = await resetAgent.post('/api/login').send({
    email: 'novo@example.test',
    password: 'New-test-password-456!'
  });
  assert.equal(resetLogin.status, 200);
});
