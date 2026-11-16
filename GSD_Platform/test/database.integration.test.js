const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/database');

let temporaryDirectory;
let activeDatabase;

after(async () => {
  if (activeDatabase) await activeDatabase.close();
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('local SQLite schema and records persist after reopening the database', async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd-database-test-'));
  const config = {
    databaseUrl: '',
    databasePath: path.join(temporaryDirectory, 'nested', 'application.db'),
    databasePoolSize: 1
  };
  let database = createDatabase(config);
  activeDatabase = database;
  await database.connect();
  await database.migrate();
  assert.deepEqual(
    (await database.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((row) => row.version),
    ['001_initial_schema', '002_storage_migration_runs', '003_document_visibility']
  );

  const inserted = await database.query(
    `INSERT INTO users (name, email, role, sector, password_hash, password_reset_required)
     VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING id`,
    ['Local user', 'local@example.test', 'membro', 'Cultura', 'not-a-real-password']
  );
  const userId = inserted.rows[0].id;
  assert.equal(inserted.rowCount, 1);
  await database.transaction(async (tx) => {
    const meeting = await tx.query(
      'INSERT INTO reunioes (nome, descricao) VALUES ($1, $2) RETURNING id',
      ['Persistência', 'Teste local']
    );
    await tx.query(
      'INSERT INTO presencas (reuniao_id, usuario_id, status) VALUES ($1, $2, $3)',
      [meeting.rows[0].id, userId, 'presente']
    );
  });
  await database.close();
  activeDatabase = null;

  database = createDatabase(config);
  activeDatabase = database;
  await database.connect();
  await database.migrate();
  assert.equal((await database.query('SELECT COUNT(*) AS count FROM schema_migrations')).rows[0].count, 3);
  const persisted = await database.query(
    `SELECT u.email, p.status
     FROM users u
     JOIN presencas p ON p.usuario_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  assert.deepEqual(persisted.rows, [{ email: 'local@example.test', status: 'presente' }]);

  const updated = await database.query('UPDATE users SET sector = $1 WHERE id = $2', ['Projetos', userId]);
  assert.equal(updated.rowCount, 1);
  await database.close();
  activeDatabase = null;
});

test('production PostgreSQL rejects a URL without an explicit TLS mode', async () => {
  const database = createDatabase({
    production: true,
    databaseUrl: 'postgresql://example.test/database?sslmode=disable',
    databasePoolSize: 1
  });
  await assert.rejects(database.connect(), /sslmode=require/);
  await database.close();
});
