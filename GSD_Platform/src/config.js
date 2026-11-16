const crypto = require('node:crypto');
const path = require('node:path');

function loadConfig(env = process.env, { requireServerConfig = true } = {}) {
  const production = env.NODE_ENV === 'production';
  const sessionSecret = env.SESSION_SECRET
    || (production ? '' : crypto.randomBytes(48).toString('base64url'));
  if (production && requireServerConfig && sessionSecret.length < 32) {
    throw new Error('Production requires SESSION_SECRET with at least 32 characters.');
  }
  if (production && requireServerConfig && !env.DATABASE_URL) {
    throw new Error('Production requires DATABASE_URL for PostgreSQL.');
  }
  const parseLimit = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
    return value;
  };

  return {
    port: parseLimit('PORT', 3000),
    production,
    sessionSecret,
    databaseUrl: env.DATABASE_URL || '',
    databasePath: path.isAbsolute(env.DATABASE_PATH || '')
      ? env.DATABASE_PATH
      : path.resolve(__dirname, '..', env.DATABASE_PATH || 'database.local.db'),
    databasePoolSize: parseLimit('DB_POOL_SIZE', 5),
    allowedOrigins: (env.APP_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
    storageBuckets: {
      document: env.SUPABASE_DOCUMENTS_BUCKET || 'gsd-documents',
      audio: env.SUPABASE_AUDIOS_BUCKET || 'gsd-audios',
      profile: env.SUPABASE_PROFILE_BUCKET || 'gsd-profile-photos'
    },
    localUploadPath: path.isAbsolute(env.LOCAL_UPLOAD_PATH || '')
      ? env.LOCAL_UPLOAD_PATH
      : path.resolve(__dirname, '..', env.LOCAL_UPLOAD_PATH || 'uploads-local'),
    maxDocumentBytes: parseLimit('MAX_DOCUMENT_BYTES', 25 * 1024 * 1024),
    maxAudioBytes: parseLimit('MAX_AUDIO_BYTES', 50 * 1024 * 1024),
    maxProfileBytes: parseLimit('MAX_PROFILE_BYTES', 5 * 1024 * 1024)
  };
}

module.exports = { loadConfig };
