require('./migrate-uploads-to-supabase').main({ target: 'local' }).catch((error) => {
  console.error('Local upload migration failed.', {
    name: error.name,
    code: error.code || 'LOCAL_UPLOAD_MIGRATION_ERROR',
    message: error.code ? 'Local upload migration failed; verify database and file permissions.' : error.message
  });
  process.exitCode = 1;
});
