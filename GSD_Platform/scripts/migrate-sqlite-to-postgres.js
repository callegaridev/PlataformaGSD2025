const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sqlite3 = require('sqlite3').verbose();
const { createDatabase } = require('../src/database');
const { hashPassword } = require('../src/auth');

const TABLES = [
  'users',
  'reunioes',
  'presencas',
  'relatorios',
  'comissoes',
  'membros_comissao',
  'tarefas',
  'arquivos',
  'eventos',
  'produtos',
  'vendas',
  'audios',
  'comunicados',
  'eventos_radio'
];

const IDENTITY_TABLES = [
  'users', 'reunioes', 'presencas', 'relatorios', 'comissoes', 'membros_comissao',
  'tarefas', 'arquivos', 'eventos', 'produtos', 'vendas', 'itens_venda',
  'audios', 'comunicados', 'eventos_radio'
];

function all(source, sql, params = []) {
  return new Promise((resolve, reject) => {
    source.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function countRows(rows) {
  return Object.fromEntries(TABLES.map((table) => [table, rows[table].length]));
}

function failForDuplicates(rows) {
  const seen = new Set();
  for (const user of rows.users) {
    const key = String(user.email || '').trim().toLowerCase();
    if (!key || seen.has(key)) {
      throw new Error('Duplicate or empty user e-mail detected. No data was imported.');
    }
    seen.add(key);
  }
}

function timestamp(value, table, rowId, field) {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'string' ? value.trim() : value;
  const normalized = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field} in ${table} row ${rowId}. No data was imported.`);
  }
  return parsed.toISOString();
}

function currency(value, table, rowId, field) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    throw new Error(`Missing ${field} in ${table} row ${rowId}. No data was imported.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field} in ${table} row ${rowId}. No data was imported.`);
  const cents = Math.round(parsed * 100);
  if (Math.abs(parsed * 100 - cents) > 0.000001) {
    throw new Error(`More than two decimal places in ${field} at ${table} row ${rowId}. No data was imported.`);
  }
  return (cents / 100).toFixed(2);
}

function parseProducts(value, rowId) {
  try {
    const products = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(products)) throw new TypeError('Expected an array.');
    return products;
  } catch {
    throw new Error(`Invalid product JSON in sales row ${rowId}. No data was imported.`);
  }
}

function normalizeSaleItems(row, productsById) {
  const products = parseProducts(row.produtos, row.id);
  const items = products.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid product ${index + 1} in sales row ${row.id}. No data was imported.`);
    }
    const productId = Number(item.id ?? item.produto_id);
    const quantity = Number(item.quantidade ?? item.quantity);
    const product = productsById.get(productId);
    if (!Number.isSafeInteger(productId) || productId <= 0 || !product) {
      throw new Error(`Unknown product in sales row ${row.id}. No data was imported.`);
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`Invalid quantity in sales row ${row.id}. No data was imported.`);
    }
    const name = item.nome ?? item.name ?? product.nome;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`Invalid product name in sales row ${row.id}. No data was imported.`);
    }
    return {
      productId,
      quantity,
      name,
      price: currency(item.preco ?? item.preco_unitario ?? product.preco, 'vendas', row.id, 'preco do item')
    };
  });

  const subtotalCents = items.reduce((total, item) => total + Math.round(Number(item.price) * 100) * item.quantity, 0);
  const totalCents = Math.round(Number(currency(row.total, 'vendas', row.id, 'total')) * 100);
  const receivedCents = Math.round(Number(currency(row.valorRecebido, 'vendas', row.id, 'valorRecebido')) * 100);
  const changeCents = Math.round(Number(currency(row.troco, 'vendas', row.id, 'troco')) * 100);
  if (subtotalCents !== totalCents || receivedCents < totalCents || receivedCents - totalCents !== changeCents) {
    throw new Error(`Inconsistent sale totals in row ${row.id}. No data was imported.`);
  }
  return items;
}

function buildSaleItemsMap(rows) {
  const productsById = new Map(rows.produtos.map((product) => [Number(product.id), product]));
  return new Map(rows.vendas.map((sale) => [
    String(sale.id),
    normalizeSaleItems(sale, productsById)
  ]));
}

function buildUserIdMap(rows) {
  return new Map(rows.users.map((user) => [String(user.email).trim().toLowerCase(), user.id]));
}

function validateRowIds(rows) {
  for (const table of TABLES) {
    const ids = new Set();
    for (const row of rows[table]) {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) {
        throw new Error(`Invalid or duplicate ID detected in ${table}. No data was imported.`);
      }
      ids.add(id);
    }
  }
}

function validateReferences(rows) {
  validateRowIds(rows);
  const userIds = new Set(rows.users.map((row) => row.id));
  const meetingIds = new Set(rows.reunioes.map((row) => row.id));
  const commissionIds = new Set(rows.comissoes.map((row) => row.id));
  const productIds = new Set(rows.produtos.map((row) => row.id));
  const invalid = [];
  for (const row of rows.presencas) {
    if (!meetingIds.has(row.reuniao_id) || !userIds.has(row.usuario_id)) invalid.push(`presencas:${row.id}`);
  }
  for (const row of rows.comissoes) {
    if (row.coordenador_id && !userIds.has(row.coordenador_id)) invalid.push(`comissoes:${row.id}`);
  }
  for (const row of rows.membros_comissao) {
    if (!commissionIds.has(row.comissao_id) || (row.usuario_id && !userIds.has(row.usuario_id))) {
      invalid.push(`membros_comissao:${row.id}`);
    }
  }
  for (const row of rows.tarefas) {
    const type = row.tipo_destinatario;
    if (type === 'usuario' && !userIds.has(row.destinatario_id)) invalid.push(`tarefas:${row.id}`);
    else if (type === 'comissao' && !commissionIds.has(row.destinatario_id)) invalid.push(`tarefas:${row.id}`);
    else if (row.destinatario_id && !['usuario', 'comissao'].includes(type)) invalid.push(`tarefas:${row.id}`);
  }
  buildSaleItemsMap(rows);
  if (invalid.length) {
    throw new Error(`Foreign-key/reference problems detected in ${invalid.length} rows (${invalid.slice(0, 20).join(', ')}). No data was imported.`);
  }
}

async function insert(tx, sql, values) {
  await tx.query(sql, values);
}

async function migrateRows(tx, rows, userIdByEmail) {
  const saleItemsById = buildSaleItemsMap(rows);
  for (const row of rows.users) {
    const normalizedEmail = String(row.email).trim().toLowerCase();
    const passwordHash = await hashPassword(crypto.randomBytes(32).toString('base64url'));
    await insert(tx,
      `INSERT INTO users (id, name, email, role, sector, password_hash, password_reset_required)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [row.id, row.name, normalizedEmail, row.role, row.sector, passwordHash]);
  }

  for (const row of rows.reunioes) {
    await insert(tx, 'INSERT INTO reunioes (id, nome, descricao, data_criacao) VALUES ($1, $2, $3, $4)',
      [row.id, row.nome, row.descricao, timestamp(row.data_criacao, 'reunioes', row.id, 'data_criacao')]);
  }
  for (const row of rows.presencas) {
    await insert(tx, 'INSERT INTO presencas (id, reuniao_id, usuario_id, status) VALUES ($1, $2, $3, $4)',
      [row.id, row.reuniao_id, row.usuario_id, row.status]);
  }
  for (const row of rows.relatorios) {
    await insert(tx,
      `INSERT INTO relatorios
       (id, tipo, projeto, coordenador, status, data_envio, conteudo, observacao, usuario_email, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.id, row.tipo, row.projeto, row.coordenador, row.status,
        timestamp(row.data_envio, 'relatorios', row.id, 'data_envio'),
        row.conteudo, row.observacao, row.usuario_email,
        row.usuario_email ? userIdByEmail.get(String(row.usuario_email).trim().toLowerCase()) || null : null
      ]);
  }
  for (const row of rows.comissoes) {
    await insert(tx,
      'INSERT INTO comissoes (id, nome, tipo, coordenador_id, coordenador_nome, data_criacao) VALUES ($1, $2, $3, $4, $5, $6)',
      [row.id, row.nome, row.tipo, row.coordenador_id, row.coordenador_nome,
        timestamp(row.data_criacao, 'comissoes', row.id, 'data_criacao')]);
  }
  for (const row of rows.membros_comissao) {
    await insert(tx,
      'INSERT INTO membros_comissao (id, comissao_id, usuario_id, nome, email, funcao) VALUES ($1, $2, $3, $4, $5, $6)',
      [row.id, row.comissao_id, row.usuario_id, row.nome, row.email, row.funcao]);
  }
  for (const row of rows.tarefas) {
    const userId = row.tipo_destinatario === 'usuario' ? row.destinatario_id : null;
    const commissionId = row.tipo_destinatario === 'comissao' ? row.destinatario_id : null;
    await insert(tx,
      `INSERT INTO tarefas
       (id, titulo, descricao, data_limite, status, tipo_destinatario,
        destinatario_usuario_id, destinatario_comissao_id, data_criacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.id, row.titulo, row.descricao, timestamp(row.data_limite, 'tarefas', row.id, 'data_limite'),
        row.status || 'Pendente', row.tipo_destinatario, userId, commissionId,
        timestamp(row.data_criacao, 'tarefas', row.id, 'data_criacao')
      ]);
  }
  for (const row of rows.arquivos) {
    await insert(tx,
      `INSERT INTO arquivos
       (id, nome_original, nome_armazenado, tipo, categoria, storage_bucket, object_key, data_upload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id, row.nome_original || 'arquivo', row.nome_armazenado || `legacy-${row.id}`,
        row.tipo, row.categoria, 'gsd-documents', row.nome_armazenado,
        timestamp(row.data_upload, 'arquivos', row.id, 'data_upload')
      ]);
  }
  for (const row of rows.eventos) {
    await insert(tx,
      'INSERT INTO eventos (id, titulo, descricao, inicio, fim, tipo, criado_por, data_criacao) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [row.id, row.titulo, row.descricao, timestamp(row.inicio, 'eventos', row.id, 'inicio'),
        timestamp(row.fim, 'eventos', row.id, 'fim'), row.tipo, row.criado_por,
        timestamp(row.data_criacao, 'eventos', row.id, 'data_criacao')]);
  }
  for (const row of rows.produtos) {
    await insert(tx,
      'INSERT INTO produtos (id, nome, preco, quantidade) VALUES ($1, $2, $3, $4)',
      [row.id, row.nome, currency(row.preco, 'produtos', row.id, 'preco'), row.quantidade]);
  }
  for (const row of rows.vendas) {
    const products = parseProducts(row.produtos, row.id);
    await insert(tx,
      'INSERT INTO vendas (id, produtos, total, valor_recebido, troco, data_venda) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        row.id, JSON.stringify(products), currency(row.total, 'vendas', row.id, 'total'),
        currency(row.valorRecebido, 'vendas', row.id, 'valorRecebido'),
        currency(row.troco, 'vendas', row.id, 'troco'),
        timestamp(row.data_venda, 'vendas', row.id, 'data_venda')
      ]);
    for (const item of saleItemsById.get(String(row.id))) {
      await insert(tx,
        `INSERT INTO itens_venda
         (venda_id, produto_id, nome_produto, quantidade, preco_unitario)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.id, item.productId, item.name, item.quantity, item.price]);
    }
  }
  for (const row of rows.audios) {
    await insert(tx,
      `INSERT INTO audios
       (id, nome_original, nome_armazenado, tipo, descricao, storage_bucket, object_key, data_upload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id, row.nome_original || 'audio', row.nome_armazenado || `legacy-${row.id}`,
        row.tipo, row.descricao, 'gsd-audios', row.nome_armazenado,
        timestamp(row.data_upload, 'audios', row.id, 'data_upload')
      ]);
  }
  for (const row of rows.comunicados) {
    await insert(tx, 'INSERT INTO comunicados (id, mensagem, data_envio) VALUES ($1, $2, $3)',
      [row.id, row.mensagem, timestamp(row.data_envio, 'comunicados', row.id, 'data_envio')]);
  }
  for (const row of rows.eventos_radio) {
    await insert(tx, 'INSERT INTO eventos_radio (id, titulo, inicio, fim, descricao) VALUES ($1, $2, $3, $4, $5)',
      [row.id, row.titulo, timestamp(row.inicio, 'eventos_radio', row.id, 'inicio'),
        timestamp(row.fim, 'eventos_radio', row.id, 'fim'), row.descricao]);
  }
}

async function importRows(database, rows, digest) {
  failForDuplicates(rows);
  validateReferences(rows);
  const counts = {
    ...countRows(rows),
    itens_venda: [...buildSaleItemsMap(rows).values()].reduce((total, items) => total + items.length, 0)
  };
  return database.transaction(async (tx) => {
    const already = await tx.query('SELECT table_counts FROM migration_runs WHERE source_sha256 = $1', [digest]);
    if (already.rows.length) {
      await validateTarget(tx, counts);
      return { status: 'already-complete', counts };
    }

    for (const table of [...TABLES, 'itens_venda']) {
      const result = await tx.query(`SELECT COUNT(*) AS count FROM "${table}"`);
      if (Number(result.rows[0].count) > 0) {
        throw new Error(`Target table ${table} is not empty. Refusing to merge or overwrite data.`);
      }
    }

    await migrateRows(tx, rows, buildUserIdMap(rows));
    await validateTarget(tx, counts);

    if (database.dialect !== 'sqlite') {
      for (const table of IDENTITY_TABLES) {
        await tx.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM "${table}"`,
          [table]
        );
      }
    }
    await tx.query(
      'INSERT INTO migration_runs (source_sha256, table_counts) VALUES ($1, $2)',
      [digest, JSON.stringify(counts)]
    );
    return { status: 'complete', counts };
  });
}

async function validateTarget(tx, counts) {
  for (const table of [...TABLES, 'itens_venda']) {
    const result = await tx.query(`SELECT COUNT(*) AS count FROM "${table}"`);
    if (Number(result.rows[0].count) !== counts[table]) {
      throw new Error(`Row count mismatch for ${table}. The transaction will be rolled back.`);
    }
  }
  const checks = await tx.query(
    `SELECT
      (SELECT COUNT(*) FROM presencas p LEFT JOIN reunioes r ON r.id = p.reuniao_id WHERE r.id IS NULL) +
      (SELECT COUNT(*) FROM presencas p LEFT JOIN users u ON u.id = p.usuario_id WHERE u.id IS NULL) +
      (SELECT COUNT(*) FROM membros_comissao m LEFT JOIN comissoes c ON c.id = m.comissao_id WHERE c.id IS NULL) +
      (SELECT COUNT(*) FROM tarefas t WHERE
        (t.destinatario_usuario_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.destinatario_usuario_id)) OR
        (t.destinatario_comissao_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comissoes c WHERE c.id = t.destinatario_comissao_id))
      ) +
      (SELECT COUNT(*) FROM itens_venda i
        LEFT JOIN vendas v ON v.id = i.venda_id
        LEFT JOIN produtos p ON p.id = i.produto_id
        WHERE v.id IS NULL OR p.id IS NULL
      ) AS violations`
  );
  if (Number(checks.rows[0].violations) !== 0) throw new Error('Target reference validation failed.');
}

async function main({ target = 'postgres' } = {}) {
  if (!['postgres', 'sqlite'].includes(target)) throw new Error('Unsupported migration target.');
  if (target === 'postgres' && !process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL to the intended PostgreSQL target.');
  }
  const sourcePath = path.resolve(process.env.SOURCE_SQLITE_PATH || path.join(__dirname, '..', 'database.db'));
  const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', 'database.local.db'));
  if (target === 'sqlite' && sourcePath === databasePath) {
    throw new Error('The SQLite migration source and target must be different files.');
  }
  const source = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY);
  const database = createDatabase(target === 'postgres'
    ? {
      production: true,
      databaseUrl: process.env.DATABASE_URL,
      databasePoolSize: Number(process.env.DB_POOL_SIZE || 2)
    }
    : {
      databaseUrl: '',
      databasePath,
      databasePoolSize: 1
    });

  try {
    const integrity = await all(source, 'PRAGMA integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('SQLite integrity check failed. No data was imported.');
    }
    const tableRows = await all(source, "SELECT name FROM sqlite_master WHERE type='table'");
    const existing = new Set(tableRows.map((row) => row.name));
    const missing = TABLES.filter((table) => !existing.has(table));
    if (missing.length) throw new Error(`Missing SQLite tables: ${missing.join(', ')}. No data was imported.`);

    const rows = {};
    for (const table of TABLES) rows[table] = await all(source, `SELECT * FROM "${table}" ORDER BY id`);
    failForDuplicates(rows);
    validateReferences(rows);
    const digest = crypto.createHash('sha256').update(await fs.readFile(sourcePath)).digest('hex');
    await database.connect();
    await database.migrate();

    const result = await importRows(database, rows, digest);
    console.log(JSON.stringify({ ...result, target, source_sha256: digest }));
    console.log('All migrated passwords require secure reset before sign-in.');
    console.log('Local upload bytes are not copied by this database migration; run the storage migration before deployment.');
  } finally {
    await new Promise((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('SQLite migration failed.', {
      name: error.name,
      code: error.code || 'MIGRATION_ERROR',
      message: error.code ? 'Database migration failed; inspect the database configuration and constraints.' : error.message
    });
    process.exitCode = 1;
  });
}

module.exports = {
  TABLES,
  buildSaleItemsMap,
  currency,
  failForDuplicates,
  importRows,
  main,
  normalizeSaleItems,
  timestamp,
  validateReferences
};
