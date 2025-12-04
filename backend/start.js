#!/usr/bin/env node

/**
 * Start script for termstation Node.js Backend
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverPath = path.join(__dirname, 'server.js');

console.log('Starting termstation Backend (Node.js)...');

const serverProcess = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production'
  }
});

serverProcess.on('exit', (code) => {
  console.log(`Server process exited with code ${code}`);
  process.exit(code);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, stopping server...');
  serverProcess.kill('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, stopping server...');
  serverProcess.kill('SIGINT');
});
