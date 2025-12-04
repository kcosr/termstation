#!/usr/bin/env node
// Print resolved template tree with effective values and simple origin hints
// Usage examples:
//   node backend/scripts/print-templates-tree.mjs --env test
//   node backend/scripts/print-templates-tree.mjs --config-dir devtools/terminals/backend/config/production
//   node backend/scripts/print-templates-tree.mjs --id codex

import { resolve, isAbsolute, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKEND_ROOT = dirname(__dirname);

function parseArgs(argv) {
  const args = { env: '', configDir: '', id: '', json: false, fields: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--env') args.env = String(next() || '').trim();
    else if (a === '--config-dir') args.configDir = String(next() || '').trim();
    else if (a === '--id') args.id = String(next() || '').trim();
    else if (a === '--json') args.json = true;
    else if (a === '--fields') args.fields = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') {
      printHelp(); process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp(); process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Print resolved templates tree with effective values\n\n` +
    `Options:\n` +
    `  --env <name>         Environment directory under backend/config (test|production|development)\n` +
    `  --config-dir <path>  Absolute or relative path to a config dir containing config.json + templates.json\n` +
    `  --id <template-id>   Start at a specific template id (otherwise prints all roots)\n` +
    `  --fields a,b,c       Extra fields to display (default shows common ones)\n` +
    `  --json               Output JSON instead of a text tree\n`);
}

function resolveConfigDir({ env, configDir }) {
  if (configDir) {
    const abs = isAbsolute(configDir) ? configDir : resolve(process.cwd(), configDir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`config dir not found: ${abs}`);
    return abs;
  }
  const envName = env || 'test';
  const dir = resolve(BACKEND_ROOT, 'config', envName);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`env config dir not found: ${dir}`);
  return dir;
}

function toArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

function buildGraph(rawTemplates) {
  const parents = new Map(); // id -> [parents]
  const children = new Map(); // id -> [children]
  for (const [id, node] of rawTemplates.entries()) {
    const p = toArray(node.extends);
    parents.set(id, p);
    if (!children.has(id)) children.set(id, []);
    for (const par of p) {
      if (!children.has(par)) children.set(par, []);
      children.get(par).push(id);
    }
  }
  return { parents, children };
}

function originForField(id, field, rawTemplates, orderResolver) {
  // If child sets it explicitly, origin is self. Otherwise, walk parents in effective order.
  const node = rawTemplates.get(id) || {};
  if (Object.prototype.hasOwnProperty.call(node, field)) return { origin: 'self', from: id };
  const chain = orderResolver(id); // parents flattened in left->right base order
  for (let i = chain.length - 1; i >= 0; i--) {
    const pid = chain[i];
    const pnode = rawTemplates.get(pid) || {};
    if (Object.prototype.hasOwnProperty.call(pnode, field)) return { origin: 'parent', from: pid };
  }
  return { origin: 'inherited', from: '' };
}

function diffInfo(id, rawTemplates, resolveOrder) {
  const interesting = ['sandbox','working_directory','container_working_dir','command','env_vars','parameters','pre_commands','post_commands','write_files','expand_file_includes','links'];
  const info = {};
  for (const k of interesting) {
    info[k] = originForField(id, k, rawTemplates, resolveOrder);
  }
  // Merge flags if present
  const node = rawTemplates.get(id) || {};
  ['merge_pre_commands','merge_post_commands','merge_fork_pre_commands','merge_fork_post_commands','merge_write_files','merge_expand_file_includes','merge_expand_include_files']
    .forEach(f => { if (Object.prototype.hasOwnProperty.call(node, f)) info[f] = { value: !!node[f], origin: 'self' }; });
  return info;
}

function buildResolveOrder(rawTemplates) {
  // Returns a function that yields the flattened parent chain (left->right bases) for any id
  const cache = new Map();
  const resolving = new Set();
  const resolveChain = (id) => {
    if (cache.has(id)) return cache.get(id);
    if (resolving.has(id)) return []; // cycle guard
    resolving.add(id);
    const node = rawTemplates.get(id) || {};
    const bases = toArray(node.extends);
    let out = [];
    for (const b of bases) {
      out = out.concat(resolveChain(b)).concat([b]);
    }
    cache.set(id, out);
    resolving.delete(id);
    return out;
  };
  return resolveChain;
}

function summarizeEffective(template) {
  const t = template.toDict ? template.toDict() : template;
  const params = Array.isArray(t.parameters) ? t.parameters.map(p => p && p.name).filter(Boolean) : [];
  const env = t && t.env_vars ? Object.keys(t.env_vars) : [];
  const links = Array.isArray(t.links) ? t.links.length : 0;
  const preN = Array.isArray(template.pre_commands) ? template.pre_commands.length : 0;
  const postN = Array.isArray(template.post_commands) ? template.post_commands.length : 0;
  const wfN = Array.isArray(template.write_files) ? template.write_files.length : 0;
  const efiN = Array.isArray(template.expand_file_includes) ? template.expand_file_includes.length : 0;
  return {
    id: t.id,
    name: t.name,
    sandbox: !!t.sandbox,
    working_directory: t.working_directory,
    container_working_dir: t.container_working_dir,
    group: t.group,
    parameters: params,
    env_vars: env,
    pre_commands_count: preN,
    post_commands_count: postN,
    write_files_count: wfN,
    expand_file_includes_count: efiN,
    links_count: links,
    command_preview: (t.command || '').slice(0, 120)
  };
}

function printTree(rootIds, ctx) {
  const { raw, loader, parents, children, resolveOrder } = ctx;
  const seen = new Set();
  const fieldsExtra = ctx.fields && ctx.fields.length ? ctx.fields : [];

  function line(prefix, text) { console.log(prefix + text); }
  function fmtNode(id) {
    const tpl = loader.getTemplate(id);
    if (!tpl) return `${id} (ERROR: not resolved)`;
    const eff = summarizeEffective(tpl);
    return `${eff.id} — ${eff.name} [sandbox=${eff.sandbox}] (wd=${eff.working_directory || ''} cw=${eff.container_working_dir || ''}) params=${eff.parameters.length} pre=${eff.pre_commands_count} post=${eff.post_commands_count} wf=${eff.write_files_count} efi=${eff.expand_file_includes_count}`;
  }
  function printDetails(id, indent) {
    const tpl = loader.getTemplate(id);
    if (!tpl) return;
    const eff = summarizeEffective(tpl);
    const info = diffInfo(id, raw, resolveOrder);
    const add = (k, v) => line(indent + '  ', `${k}: ${v}`);
    add('command', eff.command_preview);
    add('parameters', eff.parameters.join(', '));
    add('env_vars', eff.env_vars.join(', '));
    add('origins', JSON.stringify(info));
    for (const f of fieldsExtra) {
      try { add(f, JSON.stringify(tpl[f] ?? tpl.toDict?.()[f] ?? null)); } catch (_) {}
    }
  }
  function dfs(id, prefix, isLast) {
    const branch = prefix + (isLast ? '└─ ' : '├─ ');
    line(branch, fmtNode(id));
    printDetails(id, prefix + (isLast ? '   ' : '│  '));
    if (seen.has(id)) { line(prefix + (isLast ? '   ' : '│  '), '(seen)'); return; }
    seen.add(id);
    const kids = (children.get(id) || []).slice().sort();
    for (let i = 0; i < kids.length; i++) {
      dfs(kids[i], prefix + (isLast ? '   ' : '│  '), i === kids.length - 1);
    }
  }

  for (const rid of rootIds) {
    dfs(rid, '', true);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configDir = resolveConfigDir({ env: args.env, configDir: args.configDir });
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  const mod = await import('../template-loader.js');
  const loader = mod.templateLoader;
  const raw = loader.rawTemplates; // Map
  const { parents, children } = buildGraph(raw);
  const resolveOrder = buildResolveOrder(raw);

  // Determine roots (no parents)
  const roots = Array.from(raw.keys()).filter(id => (parents.get(id) || []).length === 0).sort();
  // Or start from a specific id
  const start = args.id ? [args.id] : roots;

  try {
    if (args.json) {
      const out = [];
      for (const id of Array.from(loader.templates.keys()).sort()) {
        const tpl = loader.getTemplate(id);
        out.push({ id, parents: parents.get(id) || [], children: (children.get(id) || []).slice().sort(), effective: summarizeEffective(tpl), origins: diffInfo(id, raw, resolveOrder) });
      }
      console.log(JSON.stringify({ configDir, templates: out }, null, 2));
    } else {
      printTree(start, { raw, loader, parents, children, resolveOrder, fields: args.fields });
    }
  } finally {
    try { loader.cleanup(); } catch {}
  }
}

main().catch(err => { console.error(err?.stack || err?.message || String(err)); process.exit(1); });
