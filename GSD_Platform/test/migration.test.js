const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { createDatabase } = require('../src/database');
const { verifyPassword } = require('../src/auth');
const {
  importRows,
  normalizeSaleItems,
  timestamp,
  validateReferences
} = require('../scripts/migrate-sqlite-to-postgres');

let pg;
let temporaryDirectory;
let localDatabase;

function createTestDatabase(client) {
  return {
    query: (sql, params = []) => client.query(sql, params),
    transaction: (work) => client.transaction((tx) => work({
      query: (sql, params = []) => tx.query(sql, params)
    }))
  };
}

function snapshot() {
  return {
    users: [{ id: 1, name: 'Presidente', email: 'admin@example.test', role: 'presidente', sector: 'Diretoria', password: 'legacy-password' }],
    reunioes: [{ id: 1, nome: 'Reunião', descricao: 'Ata', data_criacao: '2025-01-02 03:04:05' }],
    presencas: [{ id: 1, reuniao_id: 1, usuario_id: 1, status: 'presente' }],
    relatorios: [{ id: 1, tipo: 'Atividade', projeto: 'Projeto', coordenador: 'Presidente', status: 'Pendente', data_envio: '2025-01-02 03:04:05', conteudo: 'Concluído', observacao: null, usuario_email: 'admin@example.test' }],
    comissoes: [{ id: 1, nome: 'Comissão', tipo: 'Fixa', coordenador_id: 1, coordenador_nome: 'Presidente', data_criacao: '2025-01-02 03:04:05' }],
    membros_comissao: [{ id: 1, comissao_id: 1, usuario_id: 1, nome: 'Presidente', email: 'admin@example.test', funcao: 'Coordenador' }],
    tarefas: [{ id: 1, titulo: 'Tarefa', descricao: null, data_limite: null, status: 'Pendente', tipo_destinatario: 'usuario', destinatario_id: 1, data_criacao: '2025-01-02 03:04:05' }],
    arquivos: [{ id: 1, nome_original: 'ata.pdf', nome_armazenado: 'legacy-document', tipo: 'application/pdf', categoria: 'Ata', data_upload: '2025-01-02 03:04:05' }],
    eventos: [{ id: 1, titulo: 'Evento', descricao: null, inicio: '2025-01-02 03:04:05', fim: null, tipo: 'Escolar', criado_por: 'Presidente', data_criacao: '2025-01-02 03:04:05' }],
    produtos: [{ id: 1, nome: 'Suco', preco: 2.5, quantidade: 8 }],
    vendas: [{ id: 1, produtos: JSON.stringify([{ id: 1, nome: 'Suco', quantidade: 1, preco: '2.50' }]), total: 2.5, valorRecebido: 5, troco: 2.5, data_venda: '2025-01-02 03:04:05' }],
    audios: [{ id: 1, nome_original: 'programa.mp3', nome_armazenado: 'legacy-audio', tipo: 'audio/mpeg', descricao: 'Programa', data_upload: '2025-01-02 03:04:05' }],
    comunicados: [{ id: 1, mensagem: 'Aviso', data_envio: '2025-01-02 03:04:05' }],
    eventos_radio: [{ id: 1, titulo: 'Rádio', inicio: '2025-01-02 03:04:05', fim: null, descricao: 'Programa' }]
  };
}

after(async () => {
  if (pg) await pg.close();
  if (localDatabase) await localDatabase.close();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('SQLite snapshot imports every legacy table once with relationships and reset-required passwords', async () => {
  pg = new PGlite();
  const schema = await fs.readFile(path.join(__dirname, '..', 'migrations', '001_initial_schema.sql'), 'utf8');
  await pg.exec(schema);
  const database = createTestDatabase(pg);
  const rows = snapshot();
  validateReferences(rows);

  const result = await importRows(database, rows, 'a'.repeat(64));
  assert.equal(result.status, 'complete');
  assert.equal(result.counts.users, 1);
  assert.equal(result.counts.vendas, 1);
  assert.equal(result.counts.itens_venda, 1);
  assert.equal(result.counts.eventos_radio, 1);

  const importedUser = await pg.query('SELECT password_hash, password_reset_required FROM users WHERE id = 1');
  assert.match(importedUser.rows[0].password_hash, /^\$argon2id\$/);
  assert.equal(importedUser.rows[0].password_reset_required, true);
  assert.equal(await verifyPassword(importedUser.rows[0].password_hash, 'legacy-password'), false);
  const importedSale = await pg.query(
    'SELECT i.nome_produto, i.quantidade, i.preco_unitario FROM itens_venda i WHERE i.venda_id = 1'
  );
  assert.deepEqual(importedSale.rows[0], {
    nome_produto: 'Suco',
    quantidade: 1,
    preco_unitario: '2.50'
  });
  assert.equal((await pg.query('SELECT data_criacao FROM reunioes WHERE id = 1')).rows[0].data_criacao.toISOString(),
    '2025-01-02T03:04:05.000Z');

  const repeated = await importRows(database, rows, 'a'.repeat(64));
  assert.equal(repeated.status, 'already-complete');
  assert.equal((await pg.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count, 1);
  await pg.query(
    `INSERT INTO users (name, email, role, sector, password_hash, password_reset_required)
     VALUES ('Extra', 'extra@example.test', 'membro', 'Cultura', 'hash', TRUE)`
  );
  await assert.rejects(importRows(database, rows, 'a'.repeat(64)), /Row count mismatch for users/);
});

test('legacy snapshot also imports into a separate persistent local SQLite database', async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd-local-migration-'));
  const config = {
    databaseUrl: '',
    databasePath: path.join(temporaryDirectory, 'database.local.db'),
    databasePoolSize: 1
  };
  let database = createDatabase(config);
  localDatabase = database;
  await database.connect();
  await database.migrate();
  const first = await importRows(database, snapshot(), 'c'.repeat(64));
  assert.equal(first.status, 'complete');
  await database.close();
  localDatabase = null;

  database = createDatabase(config);
  localDatabase = database;
  await database.connect();
  await database.migrate();
  const second = await importRows(database, snapshot(), 'c'.repeat(64));
  assert.equal(second.status, 'already-complete');
  assert.equal((await database.query('SELECT COUNT(*) AS count FROM users')).rows[0].count, 1);
  assert.equal((await database.query('SELECT COUNT(*) AS count FROM itens_venda')).rows[0].count, 1);
  assert.equal((await database.query('SELECT visibilidade FROM arquivos')).rows[0].visibilidade, 'geral');
  await database.close();
  localDatabase = null;
});

test('SQLite timestamps without a timezone are interpreted as UTC', () => {
  assert.equal(timestamp('2025-01-02 03:04:05', 'reunioes', 1, 'data_criacao'), '2025-01-02T03:04:05.000Z');
  assert.equal(timestamp('2025-01-02T03:04:05-03:00', 'reunioes', 1, 'data_criacao'), '2025-01-02T06:04:05.000Z');
});

test('sale import rejects inconsistent totals and unknown product references', () => {
  const rows = snapshot();
  const productsById = new Map(rows.produtos.map((product) => [product.id, product]));

  assert.throws(() => normalizeSaleItems({
    ...rows.vendas[0],
    total: 3
  }, productsById), /Inconsistent sale totals/);
  assert.throws(() => normalizeSaleItems({
    ...rows.vendas[0],
    produtos: JSON.stringify([{ id: 999, nome: 'Unknown', quantidade: 1, preco: '2.50' }])
  }, productsById), /Unknown product/);
  assert.throws(() => normalizeSaleItems({
    ...rows.vendas[0],
    produtos: JSON.stringify([{ id: 1, nome: 'Suco', quantidade: 0, preco: '2.50' }])
  }, productsById), /Invalid quantity/);
});
