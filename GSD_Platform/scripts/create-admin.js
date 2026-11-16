require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { createDatabase } = require('../src/database');
const { hashPassword } = require('../src/auth');
const { loadConfig } = require('../src/config');
const { email, text } = require('../src/validation');
const { readHidden } = require('./password-prompt');

async function main() {
  const config = loadConfig(process.env, { requireServerConfig: false });
  const database = createDatabase(config);
  await database.connect();
  try {
    await database.migrate();
    const { rows } = await database.query('SELECT COUNT(*) AS count FROM users');
    if (Number(rows[0].count) > 0) {
      throw new Error('Users already exist. Use scripts/reset-password.js for an existing account.');
    }
    const prompt = readline.createInterface({ input: stdin, output: stdout });
    const name = text(await prompt.question('Admin name: '), 'Nome', 120);
    const userEmail = email(await prompt.question('Admin e-mail: '));
    prompt.close();
    const password = await readHidden('New password (minimum 12 characters): ');
    if (password.length < 12 || password.length > 128) {
      throw new Error('Password must contain 12 to 128 characters.');
    }
    const hash = await hashPassword(password);
    await database.query(
      `INSERT INTO users (name, email, role, sector, password_hash, password_reset_required)
       VALUES ($1, $2, 'presidente', 'Diretoria Geral', $3, FALSE)`,
      [name, userEmail, hash]
    );
    console.log('Initial administrator created.');
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Admin bootstrap failed.', {
      name: error.name,
      code: error.code || 'BOOTSTRAP_ERROR',
      message: error.code ? 'Database operation failed; verify configuration and account constraints.' : error.message
    });
    process.exitCode = 1;
  });
}

module.exports = { main };
