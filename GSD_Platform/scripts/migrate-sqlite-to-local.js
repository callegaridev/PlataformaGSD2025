require('./migrate-sqlite-to-postgres').main({ target: 'sqlite' }).catch((error) => {
  console.error('Local SQLite migration failed.', {
    name: error.name,
    code: error.code || 'LOCAL_MIGRATION_ERROR',
    message: error.code ? 'Local database operation failed; verify the destination file.' : error.message
  });
  process.exitCode = 1;
});
