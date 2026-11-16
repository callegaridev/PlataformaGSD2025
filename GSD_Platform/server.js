require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');
const { createDatabase } = require('./src/database');
const { createStorage } = require('./src/storage');

async function start() {
  const config = loadConfig();
  if (config.production && (!config.supabaseUrl || !config.supabaseServiceRoleKey)) {
    throw new Error('Production requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for persistent files.');
  }
  const database = createDatabase(config);
  await database.connect();
  await database.migrate();

  const storage = createStorage(config);
  const { app, sessionStore } = createApp({ config, database, storage });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`GSD server listening on port ${config.port}`);
  });

  const pruneInterval = setInterval(() => {
    sessionStore.pruneExpired().catch(() => {
      console.error('Session cleanup failed.');
    });
  }, 6 * 60 * 60 * 1000);
  pruneInterval.unref();

  const shutdown = () => {
    clearInterval(pruneInterval);
    server.close(async () => {
      try {
        await database.close();
        process.exit(0);
      } catch (error) {
        console.error('GSD shutdown failed.', { name: error.name, code: error.code || 'SHUTDOWN_ERROR' });
        process.exit(1);
      }
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { app, server, database };
}

if (require.main === module) {
  start().catch((error) => {
    console.error('GSD startup failed.', {
      name: error.name,
      code: error.code || 'STARTUP_ERROR',
      message: error.message
    });
    process.exitCode = 1;
  });
}

module.exports = { start };
