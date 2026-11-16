const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

function extensionFor(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

function createStorage(config) {
  if (config.supabaseUrl || config.supabaseServiceRoleKey) {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured together.');
    }
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    return {
      async upload(kind, file) {
        const bucket = config.storageBuckets[kind];
        const key = `${randomUUID()}${extensionFor(file)}`;
        const { error } = await supabase.storage.from(bucket).upload(key, file.buffer, {
          contentType: file.mimetype,
          upsert: false
        });
        if (error) throw new Error(`Storage upload failed: ${error.message}`);
        return { bucket, key };
      },
      async download(bucket, key) {
        const { data, error } = await supabase.storage.from(bucket).download(key);
        if (error) throw new Error(`Storage download failed: ${error.message}`);
        return Buffer.from(await data.arrayBuffer());
      },
      async remove(bucket, key) {
        const { error } = await supabase.storage.from(bucket).remove([key]);
        if (error) throw new Error(`Storage delete failed: ${error.message}`);
      }
    };
  }

  const root = path.resolve(config.localUploadPath);
  return {
    async upload(kind, file) {
      const bucket = config.storageBuckets[kind];
      const key = `${randomUUID()}${extensionFor(file)}`;
      const directory = path.resolve(root, bucket);
      const target = path.resolve(directory, key);
      if (!target.startsWith(`${directory}${path.sep}`)) throw new Error('Invalid storage key.');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(target, file.buffer, { flag: 'wx' });
      return { bucket, key };
    },
    async download(bucket, key) {
      const directory = path.resolve(root, bucket);
      const target = path.resolve(directory, key);
      if (!target.startsWith(`${directory}${path.sep}`)) throw new Error('Invalid storage key.');
      return fs.readFile(target);
    },
    async remove(bucket, key) {
      const directory = path.resolve(root, bucket);
      const target = path.resolve(directory, key);
      if (!target.startsWith(`${directory}${path.sep}`)) throw new Error('Invalid storage key.');
      await fs.unlink(target);
    }
  };
}

module.exports = { createStorage };
