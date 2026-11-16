const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { PGlite } = require('@electric-sql/pglite');
const { createDatabase } = require('../src/database');
const { createStorage } = require('../src/storage');
const {
  migrateUploads,
  validateFileInventory,
  withinDirectory
} = require('../scripts/migrate-uploads-to-supabase');

let temporaryDirectory;
let localTemporaryDirectory;
let sqlite;
let pg;
let localDatabase;

function createTestDatabase(client) {
  return {
    query: (sql, params = []) => client.query(sql, params),
    transaction: (work) => client.transaction((tx) => work({
      query: (sql, params = []) => tx.query(sql, params)
    }))
  };
}

after(async () => {
  if (sqlite) await new Promise((resolve, reject) => sqlite.close((error) => error ? reject(error) : resolve()));
  if (pg) await pg.close();
  if (localDatabase) await localDatabase.close();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  if (localTemporaryDirectory) await fs.rm(localTemporaryDirectory, { recursive: true, force: true });
});

test('legacy documents and audio migrate idempotently and verify uploaded bytes', async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd-upload-migration-'));
  const sourcePath = path.join(temporaryDirectory, 'database.db');
  await fs.mkdir(path.join(temporaryDirectory, 'uploads', 'audios'), { recursive: true });
  const documentBytes = Buffer.from('legacy document bytes');
  const audioBytes = Buffer.from('legacy audio bytes');
  await fs.writeFile(path.join(temporaryDirectory, 'uploads', 'document-1'), documentBytes);
  await fs.writeFile(path.join(temporaryDirectory, 'uploads', 'audios', 'audio-1'), audioBytes);

  sqlite = new sqlite3.Database(sourcePath);
  await new Promise((resolve, reject) => sqlite.exec(`
    CREATE TABLE arquivos (id INTEGER PRIMARY KEY, nome_original TEXT, nome_armazenado TEXT, tipo TEXT);
    CREATE TABLE audios (id INTEGER PRIMARY KEY, nome_original TEXT, nome_armazenado TEXT, tipo TEXT);
    INSERT INTO arquivos VALUES (1, 'ata.pdf', 'document-1', 'application/pdf');
    INSERT INTO audios VALUES (1, 'programa.mp3', 'audio-1', 'audio/mpeg');
  `, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => sqlite.close((error) => error ? reject(error) : resolve()));
  sqlite = null;

  const sourceHash = crypto.createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');
  pg = new PGlite();
  const migrationDirectory = path.join(__dirname, '..', 'migrations');
  for (const name of ['001_initial_schema.sql', '002_storage_migration_runs.sql']) {
    await pg.exec(await fs.readFile(path.join(migrationDirectory, name), 'utf8'));
  }
  await pg.query(
    `INSERT INTO arquivos (id, nome_original, nome_armazenado, tipo, storage_bucket, object_key)
     VALUES (1, 'ata.pdf', 'document-1', 'application/pdf', 'gsd-documents', 'document-1')`
  );
  await pg.query(
    `INSERT INTO audios (id, nome_original, nome_armazenado, tipo, storage_bucket, object_key)
     VALUES (1, 'programa.mp3', 'audio-1', 'audio/mpeg', 'gsd-audios', 'audio-1')`
  );
  await pg.query(
    'INSERT INTO migration_runs (source_sha256, table_counts) VALUES ($1, $2)',
    [sourceHash, JSON.stringify({ arquivos: 1, audios: 1 })]
  );

  const objects = new Map();
  let uploadedCount = 0;
  const storage = {
    async upload(kind, file) {
      uploadedCount += 1;
      const bucket = kind === 'document' ? 'gsd-documents' : 'gsd-audios';
      const key = `new-${uploadedCount}`;
      objects.set(`${bucket}/${key}`, Buffer.from(file.buffer));
      return { bucket, key };
    },
    async download(bucket, key) {
      const value = objects.get(`${bucket}/${key}`);
      if (!value) throw new Error('Stored object not found.');
      return value;
    },
    async remove(bucket, key) {
      objects.delete(`${bucket}/${key}`);
    }
  };

  await fs.writeFile(path.join(temporaryDirectory, 'uploads', 'unreferenced-document'), 'not in SQLite');
  await assert.rejects(migrateUploads({
    database: createTestDatabase(pg),
    storage,
    sourcePath
  }), /1 unreferenced file\(s\) found; no files were migrated/);
  assert.equal(uploadedCount, 0);
  await fs.unlink(path.join(temporaryDirectory, 'uploads', 'unreferenced-document'));

  const result = await migrateUploads({
    database: createTestDatabase(pg),
    storage,
    sourcePath
  });
  assert.deepEqual(result, { status: 'complete', files: { arquivos: 1, audios: 1 } });
  assert.equal(uploadedCount, 2);
  assert.deepEqual(objects.get('gsd-documents/new-1'), documentBytes);
  assert.deepEqual(objects.get('gsd-audios/new-2'), audioBytes);
  const storedRows = await pg.query(
    'SELECT storage_bucket, object_key FROM arquivos WHERE id = 1'
  );
  assert.deepEqual(storedRows.rows[0], { storage_bucket: 'gsd-documents', object_key: 'new-1' });

  const rerun = await migrateUploads({
    database: createTestDatabase(pg),
    storage,
    sourcePath
  });
  assert.deepEqual(rerun, { status: 'already-complete', files: { arquivos: 1, audios: 1 } });
  assert.equal(uploadedCount, 2);
});

test('legacy uploads can be copied to persistent local storage without Supabase', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd-local-upload-migration-'));
  localTemporaryDirectory = directory;
  const sourcePath = path.join(directory, 'database.db');
  const documentsDirectory = path.join(directory, 'uploads');
  const audioDirectory = path.join(documentsDirectory, 'audios');
  const localUploadPath = path.join(directory, 'uploads-local');
  await fs.mkdir(audioDirectory, { recursive: true });
  const documentBytes = Buffer.from('local document bytes');
  const audioBytes = Buffer.from('local audio bytes');
  await fs.writeFile(path.join(documentsDirectory, 'doc-1'), documentBytes);
  await fs.writeFile(path.join(audioDirectory, 'audio-1'), audioBytes);

  sqlite = new sqlite3.Database(sourcePath);
  await new Promise((resolve, reject) => sqlite.exec(`
    CREATE TABLE arquivos (id INTEGER PRIMARY KEY, nome_original TEXT, nome_armazenado TEXT, tipo TEXT);
    CREATE TABLE audios (id INTEGER PRIMARY KEY, nome_original TEXT, nome_armazenado TEXT, tipo TEXT);
    INSERT INTO arquivos VALUES (1, 'ata.pdf', 'doc-1', 'application/pdf');
    INSERT INTO audios VALUES (1, 'programa.mp3', 'audio-1', 'audio/mpeg');
  `, (error) => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => sqlite.close((error) => error ? reject(error) : resolve()));
  sqlite = null;
  const sourceHash = crypto.createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');

  const config = {
    databaseUrl: '',
    databasePath: path.join(directory, 'database.local.db'),
    databasePoolSize: 1,
    localUploadPath,
    storageBuckets: {
      document: 'gsd-documents',
      audio: 'gsd-audios',
      profile: 'gsd-profile-photos'
    }
  };
  localDatabase = createDatabase(config);
  await localDatabase.connect();
  await localDatabase.migrate();
  await localDatabase.query(
    `INSERT INTO arquivos (id, nome_original, nome_armazenado, tipo, storage_bucket, object_key)
     VALUES (1, 'ata.pdf', 'doc-1', 'application/pdf', 'gsd-documents', 'doc-1')`
  );
  await localDatabase.query(
    `INSERT INTO audios (id, nome_original, nome_armazenado, tipo, storage_bucket, object_key)
     VALUES (1, 'programa.mp3', 'audio-1', 'audio/mpeg', 'gsd-audios', 'audio-1')`
  );
  await localDatabase.query(
    'INSERT INTO migration_runs (source_sha256, table_counts) VALUES ($1, $2)',
    [sourceHash, JSON.stringify({ arquivos: 1, audios: 1 })]
  );
  const result = await migrateUploads({
    database: localDatabase,
    storage: createStorage(config),
    sourcePath
  });
  assert.equal(result.status, 'complete');
  const migrated = await localDatabase.query('SELECT storage_bucket, object_key FROM audios WHERE id = 1');
  assert.equal(migrated.rows[0].storage_bucket, 'gsd-audios');
  assert.deepEqual(
    await fs.readFile(path.join(localUploadPath, migrated.rows[0].storage_bucket, migrated.rows[0].object_key)),
    audioBytes
  );
  await localDatabase.close();
  localDatabase = null;
  await fs.rm(directory, { recursive: true, force: true });
  localTemporaryDirectory = null;
});

test('upload migration rejects filenames that escape the source directory', () => {
  assert.throws(() => withinDirectory(path.join(os.tmpdir(), 'gsd-uploads'), '..\\outside.db'));
});

test('upload inventory check ignores placeholders but rejects nested unexpected files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsd-upload-inventory-'));
  try {
    await fs.writeFile(path.join(directory, '.gitkeep'), 'placeholder');
    await fs.mkdir(path.join(directory, 'audios'));
    await fs.writeFile(path.join(directory, 'audios', 'audio.mp3'), 'audio');
    await validateFileInventory(directory, { table: 'arquivos', directory: '.' }, []);
    await assert.rejects(
      validateFileInventory(directory, { table: 'audios', directory: 'audios' }, []),
      /1 unreferenced file\(s\) found; no files were migrated/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
