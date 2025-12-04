// Simple validator to ensure generated sandbox commands are syntactically valid
// Usage: node backend/tests/validate-template-commands.mjs

import { execSync } from 'child_process';
import { templateLoader } from '../template-loader.js';

function extractBashCmd(fullCmd) {
  // Expect pattern: ... bash -lc "<BASHCMD>"
  const marker = ' bash -lc "';
  const idx = fullCmd.indexOf(marker);
  if (idx === -1) return null;
  let i = idx + marker.length;
  let out = '';
  let escaped = false;
  for (; i < fullCmd.length; i++) {
    const ch = fullCmd[i];
    if (escaped) {
      out += ch; // keep escaped char as-is
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') break; // reached terminating quote
    out += ch;
  }
  return out;
}

function bashSyntaxOk(bashCmd) {
  try {
    // Use bash -n to check syntax without executing commands
    execSync(`bash -n -c "${bashCmd}"`, { stdio: 'ignore', maxBuffer: 10 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function testTemplate(id, variables) {
  const tpl = templateLoader.getTemplate(id);
  if (!tpl) {
    console.error(`Template not found: ${id}`);
    return { id, ok: false, reason: 'missing template' };
  }
  const processed = tpl.processTemplate(variables || {});
  const full = processed.command;
  if (!tpl.sandbox) {
    // Non-sandbox templates do not wrap in bash -lc here; best-effort syntax check only
    try {
      execSync(`bash -n -c ${JSON.stringify(full)}`, { stdio: 'ignore', maxBuffer: 10 * 1024 * 1024 });
      return { id, ok: true };
    } catch (e) {
      return { id, ok: false, reason: 'non-sandbox command failed bash -n' };
    }
  }
  const bashCmd = extractBashCmd(full);
  if (!bashCmd) {
    return { id, ok: false, reason: 'failed to extract bash -lc payload' };
  }
  const ok = bashSyntaxOk(bashCmd);
  return { id, ok, bashCmd };
}

const tests = [
  { id: 'codex', vars: { issue_id: '678', prompt: 'complete issue 678' } },
  { id: 'sandbox', vars: { repo: '', branch: '' } },
  { id: 'claude', vars: { prompt: 'noop' } }
];

let failures = 0;
for (const t of tests) {
  const res = testTemplate(t.id, t.vars);
  if (res.ok) {
    console.log(`[OK] ${t.id}`);
  } else {
    failures++;
    console.log(`[FAIL] ${t.id}: ${res.reason || 'syntax error'}`);
    if (res.bashCmd) console.log(res.bashCmd);
  }
}

if (failures > 0) {
  console.log(`Failures: ${failures}`);
  try { templateLoader.cleanup(); } catch {}
  process.exit(1);
} else {
  console.log('All tests passed');
  try { templateLoader.cleanup(); } catch {}
  process.exit(0);
}
