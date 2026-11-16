function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      return reject(new Error('Run this command from an interactive terminal so the password is not echoed.'));
    }

    let value = '';
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
        } else if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
        }
      }
    };
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
    };
    input.on('data', onData);
  });
}

module.exports = { readHidden };
