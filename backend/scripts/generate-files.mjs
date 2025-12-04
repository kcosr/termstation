// Generate files from template sources using the shared templating engine.
// Supports either a single source/target or a JSON map of write_files entries.
//
// Usage examples:
//   Single file:
//     node scripts/generate-files.mjs \
//       --source files/AGENTS.md \
//       --target /tmp/AGENTS.out.md \
//       --var session_id=DEV-123 \
//       --var code_review=true
//
//   Batch via map (array of { source, target }):
//     node scripts/generate-files.mjs \
//       --map tests/fixtures/write-files.json \
//       --vars-json tests/fixtures/vars.json
//
// Notes:
// - Includes ({file:...}) are resolved against:
//   1) backend root, 2) the directory of the current source file, 3) any --base-dir values provided.
// - Unknown macros are substituted as empty strings.
// - Targets’ parent directories are created as needed.

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import { dirname, resolve, isAbsolute, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { processText } from '../utils/template-text.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKEND_ROOT = dirname(__dirname);

function printUsage() {
  console.log(`Generate files from templates using the shared templating engine\n\n` +
    `Single file:\n` +
    `  node scripts/generate-files.mjs --source <path> --target <path> [--var k=v ...] [--vars-json path] [--base-dir dir ...]\n\n` +
    `Batch (map file with write_files):\n` +
    `  node scripts/generate-files.mjs --map <path> [--var k=v ...] [--vars-json path] [--base-dir dir ...]\n\n` +
    `Options:\n` +
    `  --source <path>     Source template file path\n` +
    `  --target <path>     Target output file path\n` +
    `  --map <path>        JSON file with { write_files: [ {source, target}, ... ] } or [ {source, target}, ... ]\n` +
    `  --var k=v           Set a variable (repeatable). Example: --var session_id=TEST-1\n` +
    `  --vars-json <path>  Load variables from JSON object file\n` +
    `  --base-dir <dir>    Add a base directory for {file:...} includes (repeatable)\n`);
}

function parseArgs(argv) {
  const args = { vars: {}, baseDirs: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--source') args.source = next();
    else if (a === '--target') args.target = next();
    else if (a === '--map') args.map = next();
    else if (a === '--vars-json') args.varsJson = next();
    else if (a === '--base-dir') args.baseDirs.push(next());
    else if (a === '--var') {
      const kv = String(next() || '');
      const eq = kv.indexOf('=');
      if (eq === -1) { console.error(`Invalid --var '${kv}', expected k=v`); process.exit(2); }
      const k = kv.slice(0, eq).trim();
      const v = kv.slice(eq + 1);
      args.vars[k] = v;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function loadJson(path) {
  const p = isAbsolute(path) ? path : resolve(process.cwd(), path);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function ensureDirFor(filePath) {
  const dir = dirname(filePath);
  try { statSync(dir); } catch {
    mkdirSync(dir, { recursive: true });
  }
}

function processOne(sourcePath, targetPath, vars, extraBaseDirs = [], interpolate = false) {
  // Resolve source relative to CWD, with a fallback to backend root
  let srcAbs = isAbsolute(sourcePath) ? sourcePath : resolve(process.cwd(), sourcePath);
  if (!existsSync(srcAbs)) srcAbs = resolve(BACKEND_ROOT, sourcePath);

  // Resolve target relative to CWD, with a fallback to backend root dir when parent doesn't exist
  const baseDirs = [BACKEND_ROOT, dirname(srcAbs), ...extraBaseDirs];
  // Allow simple templating in target paths as well (e.g., {HOME}/...)
  const processedTarget = interpolate
    ? processText(String(targetPath || ''), { HOME: process.env.HOME || homedir(), ...(vars || {}) }, { baseDirs })
    : String(targetPath || '');
  // Expand leading '~/' to the user's home directory
  const expandTilde = (p) => (p && p.startsWith('~/')) ? join(homedir(), p.slice(2)) : p;
  const targetEvaluated = expandTilde(processedTarget);
  let tgtAbs = isAbsolute(targetEvaluated) ? targetEvaluated : resolve(process.cwd(), targetEvaluated);
  if (!existsSync(dirname(tgtAbs))) tgtAbs = resolve(BACKEND_ROOT, targetEvaluated);
  const srcDir = dirname(srcAbs);

  const tpl = readFileSync(srcAbs, 'utf8');
  const out = interpolate ? processText(tpl, vars, { baseDirs }) : tpl;
  ensureDirFor(tgtAbs);
  writeFileSync(tgtAbs, out, 'utf8');
  return { source: srcAbs, target: tgtAbs };
}

function normalizeMap(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.write_files)) return raw.write_files;
  throw new Error('Map JSON must be an array of { source, target } or { write_files: [...] }');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.map && !(args.source && args.target)) {
    printUsage();
    process.exit(2);
  }

  let vars = { ...args.vars };
  if (args.varsJson) {
    const fromFile = loadJson(args.varsJson);
    if (fromFile && typeof fromFile === 'object') vars = { ...vars, ...fromFile };
  }

  const extraBaseDirs = (args.baseDirs || []).map(d => (isAbsolute(d) ? d : resolve(process.cwd(), d)));

  const results = [];
  if (args.map) {
    const raw = loadJson(args.map);
    const items = normalizeMap(raw);
    for (const it of items) {
      if (!it || !it.source || !it.target) {
        console.error('Skipping invalid item (requires source and target):', it);
        continue;
      }
      const interpolate = it && it.interpolate === true; // default false
      results.push(processOne(String(it.source), String(it.target), vars, extraBaseDirs, interpolate));
    }
  } else {
    results.push(processOne(args.source, args.target, vars, extraBaseDirs));
  }

  // Summary
  for (const r of results) {
    console.log(`Wrote: ${r.target}  (from ${r.source})`);
  }
}

main().catch(err => {
  console.error('Generation failed:', err?.stack || err?.message || String(err));
  process.exit(1);
});
