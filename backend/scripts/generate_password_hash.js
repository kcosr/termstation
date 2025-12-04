#!/usr/bin/env node
// Generate PBKDF2 password hash (and/or random salt) for users.json
// Output format: pbkdf2$<iterations>$<salt_hex>$<hash_hex>

import crypto from 'crypto';

function parseArgs(argv) {
  const args = { iter: 150000, saltlen: 16, digest: 'sha256', password: null, saltOnly: false };
  for (const a of argv.slice(2)) {
    if (a === '--salt-only') args.saltOnly = true;
    else if (a.startsWith('--iter=')) args.iter = parseInt(a.split('=')[1], 10) || 150000;
    else if (a.startsWith('--saltlen=')) args.saltlen = parseInt(a.split('=')[1], 10) || 16;
    else if (a.startsWith('--digest=')) args.digest = a.split('=')[1] || 'sha256';
    else if (a.startsWith('--password=')) args.password = a.split('=')[1];
    else if (!a.startsWith('--') && !args.password) args.password = a; // positional password
  }
  return args;
}

function generateSalt(bytes) {
  return crypto.randomBytes(Math.max(8, bytes | 0)).toString('hex');
}

function generateHash(password, saltHex, iter, digest) {
  const salt = Buffer.from(saltHex, 'hex');
  const keylen = 32; // 256-bit
  const derived = crypto.pbkdf2Sync(String(password), salt, iter, keylen, digest);
  return derived.toString('hex');
}

function main() {
  const args = parseArgs(process.argv);

  if (args.saltOnly) {
    const salt = generateSalt(args.saltlen);
    process.stdout.write(salt + '\n');
    return;
  }

  if (!args.password) {
    process.stderr.write('Usage: generate_password_hash.js [--password=secret] [--iter=150000] [--saltlen=16] [--digest=sha256]\n');
    process.stderr.write('       generate_password_hash.js --salt-only [--saltlen=16]\n');
    process.exit(2);
  }

  const salt = generateSalt(args.saltlen);
  const hash = generateHash(args.password, salt, args.iter, args.digest);
  const line = `pbkdf2$${args.iter}$${salt}$${hash}`;

  process.stdout.write('Salt (hex): ' + salt + '\n');
  process.stdout.write('password_hash: ' + line + '\n');
}

main();

