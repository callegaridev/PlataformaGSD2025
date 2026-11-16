require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { createDatabase } = require('../src/database');
const { hashPassword } = require('../src/auth');
const { loadConfig } = require('../src/config');
const { email } = require('../src/validation');
const { readHidden } = require('./password-prompt');

async function main() {
  const config = loadConfig(process.env, { requireServerConfig: false });
  const database = createDatabase(config);
  await database.connect();
  try {
    await database.migrate();
    const prompt = readline.createInterface({ input: stdin, output: stdout });
    const userEmail = email(process.argv[2] || await prompt.question('Account e-mail: '));
    prompt.close();
    const password = await readHidden('New password (minimum 12 characters): ');
    if (password.length < 12 || password.length > 128) {
      throw new Error('Password must contain 12 to 128 characters.');
    }
    const hash = await hashPassword(password);
    const { rowCount } = await database.query(
      `UPDATE users SET password_hash = $1, password_reset_required = FALSE
       WHERE email = $2`,
      [hash, userEmail]
    );
    if (!rowCount) throw new Error('Account not found.');
    await database.query('DELETE FROM sessions');
    console.log('Password reset completed; all active sessions were revoked.');
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Password reset failed.', {
      name: error.name,
      code: error.code || 'RESET_ERROR',
      message: error.code ? 'Database operation failed; verify configuration and account constraints.' : error.message
    });
    process.exitCode = 1;
  });
}

module.exports = { main };
