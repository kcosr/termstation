#!/usr/bin/env node
/**
 * Build script for backend tools
 * Builds bundled JS files from source using Bun
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bootstrapBinDir = join(rootDir, 'bootstrap', 'bin');

// Tools to build: { name, source, output, cwd }
// cwd is the directory to run bun from (for resolving dependencies)
const tools = [
  {
    name: 'agents',
    source: 'agents.mjs',
    output: join(bootstrapBinDir, 'agents.js'),
    cwd: join(rootDir, 'tools', 'agents')
  },
  {
    name: 'ts-tunnel',
    source: 'bin/ts-tunnel.js',
    output: join(bootstrapBinDir, 'ts-tunnel.js'),
    cwd: join(rootDir, 'tools', 'ts-tunnel')
  },
  {
    name: 'workspace-web-server',
    source: 'bin/workspace-web-server.js',
    output: join(bootstrapBinDir, 'workspace-web-server.js'),
    cwd: join(rootDir, 'tools', 'workspace-web-server')
  }
];

function checkBun() {
  try {
    execSync('bun --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function build() {
  console.log('Building backend tools...\n');

  // Check for bun
  if (!checkBun()) {
    console.error('Error: bun is not installed.');
    console.error('Install Bun and re-run. See https://bun.sh');
    process.exit(1);
  }

  // Ensure output directory exists
  if (!existsSync(bootstrapBinDir)) {
    mkdirSync(bootstrapBinDir, { recursive: true });
  }

  let failed = false;

  for (const tool of tools) {
    console.log(`Building ${tool.name}...`);

    const sourcePath = join(tool.cwd, tool.source);
    if (!existsSync(sourcePath)) {
      console.error(`  Error: Source file not found: ${sourcePath}`);
      failed = true;
      continue;
    }

    try {
      // Install dependencies if package.json exists
      const pkgJson = join(tool.cwd, 'package.json');
      if (existsSync(pkgJson)) {
        console.log(`  Installing dependencies...`);
        execSync('bun install', { stdio: 'pipe', cwd: tool.cwd });
      }

      // Run bun from the tool's directory so it can resolve dependencies
      // Use --packages=bundle to include dependencies in the output
      execSync(`bun build "${tool.source}" --target=node --minify --packages=bundle --outfile="${tool.output}"`, {
        stdio: 'inherit',
        cwd: tool.cwd
      });

      // Make executable
      execSync(`chmod +x "${tool.output}"`, { stdio: 'pipe' });

      console.log(`  Built: ${tool.output}\n`);
    } catch (err) {
      console.error(`  Error building ${tool.name}: ${err.message}`);
      failed = true;
    }
  }

  if (failed) {
    console.error('\nBuild completed with errors.');
    process.exit(1);
  }

  console.log('All tools built successfully.');
}

build();
