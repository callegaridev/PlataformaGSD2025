const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sqlite3 = require('sqlite3').verbose();
const { createDatabase } = require('../src/database');
const { loadConfig } = require('../src/config');
const { createStorage } = require('../src/storage');

const FILE_GROUPS = [
  { table: 'arquivos', kind: 'document', directory: 'uploads' },
  { table: 'audios', kind: 'audio', directory: path.join('uploads', 'audios') }
];

function all(source, sql, params = []) {
  return new Promise((resolve, reject) => {
    source.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function withinDirectory(directory, filename) {
  if (typeof filename !== 'string' || path.basename(filename) !== filename) {
    throw new Error('Invalid legacy upload path; no files were changed for this record.');
  }
  const resolvedDirectory = path.resolve(directory);
  const target = path.resolve(resolvedDirectory, filename);
  if (!target.startsWith(`${resolvedDirectory}${path.sep}`)) {
    throw new Error('Invalid legacy upload path; no files were changed for this record.');
  }
  return target;
}

async function validateFileInventory(root, group, rows) {
  const directory = path.resolve(root, group.directory);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' && rows.length === 0) return;
    throw error;
  }

  const actual = new Set();
  for (const entry of entries) {
    if (group.table === 'arquivos' && entry.isDirectory() && entry.name === 'audios') continue;
    if (!entry.isFile()) {
      throw new Error(`Unexpected entry in legacy ${group.table} upload directory; no files were migrated.`);
    }
    if (entry.name.toLowerCase() !== '.gitkeep') actual.add(entry.name);
  }

  const expected = new Set(rows.map((row) => {
    withinDirectory(directory, row.nome_armazenado);
    return row.nome_armazenado;
  }));
  const missing = [...expected].filter((filename) => !actual.has(filename));
  const unreferenced = [...actual].filter((filename) => !expected.has(filename));
  if (missing.length || unreferenced.length) {
    throw new Error(
      `Legacy ${group.table} upload inventory mismatch: ${missing.length} referenced file(s) missing and ` +
      `${unreferenced.length} unreferenced file(s) found; no files were migrated.`
    );
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function migrateOne({ database, storage, root, group, row }) {
  const target = await database.query(
    `SELECT storage_bucket, object_key FROM ${group.table} WHERE id = $1`,
    [row.id]
  );
  if (!target.rows.length) throw new Error(`Imported ${group.table} row ${row.id} is missing.`);

  const legacyKey = row.nome_armazenado;
  const sourcePath = withinDirectory(path.join(root, group.directory), legacyKey);
  const sourceBytes = await fs.readFile(sourcePath);
  const sourceHash = sha256(sourceBytes);
  const storedBucket = target.rows[0].storage_bucket;
  const storedKey = target.rows[0].object_key;

  if (storedKey && storedKey !== legacyKey) {
    const savedBytes = await storage.download(storedBucket, storedKey);
    if (sha256(savedBytes) !== sourceHash) {
      throw new Error(`Stored content mismatch for ${group.table} row ${row.id}.`);
    }
    return 'verified';
  }

  const upload = await storage.upload(group.kind, {
    buffer: sourceBytes,
    mimetype: row.tipo || 'application/octet-stream',
    originalname: row.nome_original || legacyKey
  });
  const uploadedBytes = await storage.download(upload.bucket, upload.key);
  if (sha256(uploadedBytes) !== sourceHash) {
    await storage.remove(upload.bucket, upload.key);
    throw new Error(`Uploaded content verification failed for ${group.table} row ${row.id}.`);
  }

  try {
    await database.transaction(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE ${group.table} SET storage_bucket = $1, object_key = $2, nome_armazenado = $2 WHERE id = $3`,
        [upload.bucket, upload.key, row.id]
      );
      if (rowCount !== 1) throw new Error(`Could not update ${group.table} row ${row.id}.`);
    });
  } catch (error) {
    await storage.remove(upload.bucket, upload.key);
    throw error;
  }
  return 'migrated';
}

async function migrateUploads({ database, storage, sourcePath }) {
  const source = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY);
  try {
    const integrity = await all(source, 'PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('SQLite integrity check failed; no uploads were changed.');
    }
    const sourceDigest = sha256(await fs.readFile(sourcePath));
    const completed = await database.query(
      'SELECT 1 FROM storage_migration_runs WHERE source_sha256 = $1',
      [sourceDigest]
    );
    const alreadyComplete = completed.rows.length > 0;

    const databaseMigration = await database.query(
      'SELECT 1 FROM migration_runs WHERE source_sha256 = $1',
      [sourceDigest]
    );
    if (!databaseMigration.rows.length) {
      throw new Error('The SQLite database migration for this source must complete first.');
    }

    const counts = { arquivos: 0, audios: 0 };
    const sourceRows = new Map();
    for (const group of FILE_GROUPS) {
      const rows = await all(source, `SELECT id, nome_original, nome_armazenado, tipo FROM "${group.table}" ORDER BY id`);
      const targetCount = await database.query(`SELECT COUNT(*) AS count FROM "${group.table}"`);
      if (Number(targetCount.rows[0].count) !== rows.length) {
        throw new Error(`Source and target counts differ for ${group.table}.`);
      }
      await validateFileInventory(path.dirname(sourcePath), group, rows);
      sourceRows.set(group.table, rows);
    }

    for (const group of FILE_GROUPS) {
      const rows = sourceRows.get(group.table);
      for (const row of rows) {
        counts[group.table] += 1;
        await migrateOne({
          database,
          storage,
          root: path.dirname(sourcePath),
          group,
          row
        });
      }
    }

    for (const group of FILE_GROUPS) {
      const result = await database.query(
        `SELECT COUNT(*) AS count FROM "${group.table}" WHERE storage_bucket IS NULL OR object_key IS NULL`
      );
      if (Number(result.rows[0].count) !== 0) {
        throw new Error(`Storage migration validation failed for ${group.table}.`);
      }
    }

    if (!alreadyComplete) {
      await database.query(
        'INSERT INTO storage_migration_runs (source_sha256, file_counts) VALUES ($1, $2)',
        [sourceDigest, JSON.stringify(counts)]
      );
    }
    return { status: alreadyComplete ? 'already-complete' : 'complete', files: counts };
  } finally {
    await new Promise((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
  }
}

async function main({ target = 'supabase' } = {}) {
  if (!['supabase', 'local'].includes(target)) throw new Error('Unsupported storage migration target.');
  const config = loadConfig(process.env, { requireServerConfig: false });
  if (target === 'supabase') {
    if (!config.databaseUrl) throw new Error('Set DATABASE_URL to the migrated PostgreSQL target.');
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for private Storage access.');
    }
  }
  const sourcePath = path.resolve(process.env.SOURCE_SQLITE_PATH || path.join(__dirname, '..', 'database.db'));
  const databasePath = path.resolve(config.databasePath);
  if (target === 'local' && sourcePath === databasePath) {
    throw new Error('The SQLite migration source and target must be different files.');
  }
  const runtimeConfig = target === 'local'
    ? {
      ...config,
      production: false,
      databaseUrl: '',
      supabaseUrl: '',
      supabaseServiceRoleKey: ''
    }
    : { ...config, production: true };
  const database = createDatabase(runtimeConfig);
  const storage = createStorage(runtimeConfig);
  try {
    await database.connect();
    await database.migrate();
    const result = await migrateUploads({ database, storage, sourcePath });
    console.log(JSON.stringify({ ...result, target }));
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Upload migration failed.', {
      name: error.name,
      code: error.code || 'UPLOAD_MIGRATION_ERROR',
      message: error.code ? 'Upload migration dependency failed; check database and Storage configuration.' : error.message
    });
    process.exitCode = 1;
  });
}

module.exports = { main, migrateUploads, migrateOne, validateFileInventory, withinDirectory };
