export async function readFromStdin() {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => {
        resolve(data.replace(/\r/g, ''));
      });
      process.stdin.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

export async function getMessageArgOrStdin(arg) {
  if (typeof arg === 'string' && arg.length > 0) return arg;
  if (!process.stdin.isTTY) {
    const s = await readFromStdin();
    return s;
  }
  return '';
}

export function prefixMessage(sessionId, message) {
  return `Message from peer agent ${sessionId}: ${message}`;
}

