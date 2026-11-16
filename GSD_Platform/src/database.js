const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

function sqlitePlaceholders(sql, params) {
  const values = [];
  const text = sql.replace(/\$(\d+)/g, (_, position) => {
    values.push(params[Number(position) - 1]);
    return '?';
  });
  return { text, values };
}

function createDatabase(config) {
  let pool;
  let sqlite;
  let sqliteQueue = Promise.resolve();
  const isPostgres = Boolean(config.databaseUrl);

  function withSqliteLock(work) {
    const previous = sqliteQueue;
    let release;
    sqliteQueue = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(work).finally(release);
  }

  function sqliteQuery(connection, sql, params) {
    const { text, values } = sqlitePlaceholders(sql, params);
    const sqliteValues = values.map((value) => value instanceof Date ? value.toISOString() : value);
    if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text) && !/\bRETURNING\b/i.test(text)) {
      return new Promise((resolve, reject) => {
        connection.run(text, sqliteValues, function (error) {
          if (error) return reject(error);
          resolve({ rows: [], rowCount: this.changes });
        });
      });
    }
    return new Promise((resolve, reject) => {
      connection.all(text, sqliteValues, function (error, rows) {
        if (error) return reject(error);
        resolve({ rows, rowCount: this.changes || rows.length });
      });
    });
  }

  async function connect() {
    if (isPostgres) {
      if (config.production) {
        let sslMode;
        try {
          sslMode = new URL(config.databaseUrl).searchParams.get('sslmode');
        } catch {
          throw new Error('Production DATABASE_URL must be a valid PostgreSQL URL with SSL enabled.');
        }
        if (!['require', 'verify-ca', 'verify-full'].includes((sslMode || '').toLowerCase())) {
          throw new Error('Production DATABASE_URL must set sslmode=require (or a stricter mode).');
        }
      }
      pool = new Pool({
        connectionString: config.databaseUrl,
        max: config.databasePoolSize,
        application_name: 'gsd-platform',
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000
      });
      await pool.query('SELECT 1');
      return;
    }

    const dbPath = path.resolve(config.databasePath);
    const legacyPath = path.resolve(__dirname, '..', 'database.db');
    if (dbPath === legacyPath) {
      throw new Error('DATABASE_PATH cannot point at the preserved legacy database.db. Use the SQLite migration script first.');
    }

    const sqlite3 = require('sqlite3').verbose();
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    sqlite = new sqlite3.Database(dbPath);
    await new Promise((resolve, reject) => {
      sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;', (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const columns = await sqliteQuery(sqlite, "PRAGMA table_info('users')", []);
    if (columns.rows.some((column) => column.name === 'password')) {
      throw new Error('Legacy SQLite database detected. Preserve it and run the versioned SQLite migration before starting the application.');
    }
    await sqliteQuery(sqlite, 'SELECT 1', []);
  }

  async function query(sql, params = []) {
    if (isPostgres) return pool.query(sql, params);
    return withSqliteLock(() => sqliteQuery(sqlite, sql, params));
  }

  async function exec(sql) {
    if (isPostgres) return pool.query(sql);
    return withSqliteLock(() => new Promise((resolve, reject) => {
      sqlite.exec(sql, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }));
  }

  async function transaction(work) {
    if (isPostgres) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({
          query: (sql, params = []) => client.query(sql, params),
          exec: (sql) => client.query(sql)
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    return withSqliteLock(async () => {
      await sqliteQuery(sqlite, 'BEGIN IMMEDIATE', []);
      try {
        const result = await work({
          query: (sql, params = []) => sqliteQuery(sqlite, sql, params),
          exec: (sql) => new Promise((resolve, reject) => {
            sqlite.exec(sql, (error) => error ? reject(error) : resolve());
          })
        });
        await sqliteQuery(sqlite, 'COMMIT', []);
        return result;
      } catch (error) {
        await sqliteQuery(sqlite, 'ROLLBACK', []);
        throw error;
      }
    });
  }

  async function migrate() {
    const migrationsPath = path.join(__dirname, '..', 'migrations');
    const files = (await fs.readdir(migrationsPath))
      .filter((name) => /^\d+_[a-z0-9_]+(?:\.sqlite)?\.sql$/.test(name))
      .filter((name) => isPostgres ? !name.endsWith('.sqlite.sql') : name.endsWith('.sqlite.sql'))
      .sort();
    const migrationTable = isPostgres
      ? await query("SELECT to_regclass('public.schema_migrations') AS table_name")
      : await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
    const hasMigrationTable = isPostgres
      ? Boolean(migrationTable.rows[0].table_name)
      : migrationTable.rows.length > 0;
    const applied = new Set(hasMigrationTable
      ? (await query('SELECT version FROM schema_migrations')).rows.map((row) => row.version)
      : []);

    for (const filename of files) {
      const version = filename.replace(/(?:\.sqlite)?\.sql$/, '');
      if (applied.has(version)) continue;
      const schema = await fs.readFile(path.join(migrationsPath, filename), 'utf8');
      await transaction(async (tx) => {
        await tx.exec(schema);
        await tx.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [version]
        );
      });
      applied.add(version);
    }
  }

  async function close() {
    if (pool) await pool.end();
    if (sqlite) {
      await new Promise((resolve, reject) => {
        sqlite.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }

  return {
    connect,
    query,
    exec,
    transaction,
    migrate,
    close,
    get dialect() {
      return isPostgres ? 'postgres' : 'sqlite';
    },
    get lockClause() {
      return isPostgres ? ' FOR UPDATE' : '';
    }
  };
}

module.exports = { createDatabase };
