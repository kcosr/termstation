#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { loadConfig } from './lib/config.mjs';
import { ApiClient } from './lib/apiClient.mjs';
import { CliError } from './lib/errors.mjs';
import { getMessageArgOrStdin, prefixMessage } from './lib/io.mjs';

async function main() {
  const program = new Command();
  program
    .name('agents')
    .description('Unified CLI for TermStation peer agent bootstrap operations')
    .option('--debug', 'Enable debug logging')
    .option('--forge <forge>', 'Override FORGE env var for new sessions');

  program
    .command('list')
    .description('List active peer agent sessions (excluding your own)')
    .action(async () => {
      const opts = program.opts();
      const cfg = loadConfig();
      const api = new ApiClient(cfg.SESSIONS_API_BASE_URL, { debug: opts.debug || cfg.DEBUG, token: cfg.SESSION_TOK });

      const useSearch = (cfg.REPO && cfg.REPO.length) || (cfg.ISSUE_ID && cfg.ISSUE_ID.length);
      const sessions = useSearch
        ? await api.searchSessions({ repo: cfg.REPO, issueId: cfg.ISSUE_ID })
        : await api.listSessions();

      const filtered = Array.isArray(sessions)
        ? sessions.filter(s => (s.session_id || s.id) !== cfg.SESSION_ID)
        : [];

      filtered.sort((a, b) => {
        const ta = Date.parse(a.created_at || '') || 0;
        const tb = Date.parse(b.created_at || '') || 0;
        return ta - tb;
      });

      for (const s of filtered) {
        const id = s.session_id || s.id || '';
        if (id) process.stdout.write(id + '\n');
      }
    });

  program
    .command('send')
    .argument('<peer_id>', 'Peer agent session ID')
    .argument('[message]', 'Message to send (or read from stdin)')
    .description('Send a message to a peer agent session')
    .action(async (peerId, messageArg) => {
      const opts = program.opts();
      const cfg = loadConfig();
      const api = new ApiClient(cfg.SESSIONS_API_BASE_URL, { debug: opts.debug || cfg.DEBUG, token: cfg.SESSION_TOK });

      const message = await getMessageArgOrStdin(messageArg);
      if (!message || message.length === 0) {
        throw new CliError('No message provided');
      }
      const full = prefixMessage(cfg.SESSION_ID, message);
      await api.sendInput(peerId, full);
      process.stdout.write(`Sent message to peer agent ${peerId}:\n`);
      process.stdout.write(message.endsWith('\n') ? message : message + '\n');
    });

  program
    .command('stop')
    .argument('<peer_id>', 'Peer agent session ID')
    .option('--force', 'Allow stopping your own session')
    .description('Stop a peer agent session')
    .action(async (peerId, cmd) => {
      const opts = program.opts();
      const cfg = loadConfig();
      const api = new ApiClient(cfg.SESSIONS_API_BASE_URL, { debug: opts.debug || cfg.DEBUG, token: cfg.SESSION_TOK });

      if (peerId === cfg.SESSION_ID && !cmd.force) {
        throw new CliError(`Refusing to stop current session (${cfg.SESSION_ID}). Pass --force to override.`);
      }
      const res = await api.deleteSession(peerId);
      if (res.status === 200 || res.status === 202 || res.status === 204) {
        process.stdout.write(`Termination requested for peer agent ${peerId}\n`);
      } else {
        process.stderr.write(`Unexpected response stopping ${peerId}: ${res.status}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('create')
    .argument('<agent>', 'Agent template ID (e.g., claude, codex)')
    .argument('[message]', 'Optional prompt (or read from stdin)')
    .option('--post-create-delay <seconds>', 'Seconds to wait after successful creation (default: 10)')
    .option('--description <description>', 'Short description to append to the session title')
    .description('Create a new peer agent session')
    .action(async (agent, messageArg, cmd) => {
      const opts = program.opts();
      const cfg = loadConfig();
      if (!cfg.TERMSTATION_USER) throw new CliError('TERMSTATION_USER environment variable is required but not set', 2);
      const api = new ApiClient(cfg.SESSIONS_API_BASE_URL, { debug: opts.debug || cfg.DEBUG });

      const msg = await getMessageArgOrStdin(messageArg);
      const fullPrompt = msg && msg.length ? prefixMessage(cfg.SESSION_ID, msg) : '';

      // Title policy: manual only, no glab
      let title = 'Session for ' + agent;
      if (cfg.REPO && cfg.ISSUE_ID) title = `${cfg.REPO} #${cfg.ISSUE_ID}`;
      else if (cfg.REPO) title = cfg.REPO;
      // Optionally append a brief description to the computed title
      const desc = cmd.description || '';
      if (desc) title = `${title}: ${desc}`;

      const template_parameters = {};
      if (fullPrompt) template_parameters.prompt = fullPrompt;
      if (cfg.REPO) template_parameters.repo = cfg.REPO;
      if (cfg.BRANCH) template_parameters.branch = cfg.BRANCH;
      if (cfg.ISSUE_ID) template_parameters.issue_id = isNaN(Number(cfg.ISSUE_ID)) ? cfg.ISSUE_ID : Number(cfg.ISSUE_ID);
      const forge = opts.forge || cfg.FORGE;
      if (forge) template_parameters.forge = forge;

      const payload = {
        template_id: agent,
        template_parameters,
        interactive: true,
        workspace: 'Agents',
        cols: 187,
        rows: 58,
        visibility: 'private',
        title,
        code_review: true,
        as_user: cfg.TERMSTATION_USER,
      };

      const resp = await api.createSession(payload);
      const id = resp?.session_id || resp?.id;
      if (!id) throw new CliError('Failed to create session (no id returned)');
      process.stdout.write(`Peer agent ${id} is available\n`);

      // Optional post-create delay
      let delaySec = 10;
      if (cmd && typeof cmd.postCreateDelay !== 'undefined') {
        const n = Number(cmd.postCreateDelay);
        if (!Number.isNaN(n) && Number.isFinite(n)) delaySec = n;
      }
      const delayMs = Math.max(0, Math.floor(delaySec * 1000));
      if (delayMs > 0) {
        const debug = opts.debug || cfg.DEBUG;
        if (debug) process.stderr.write(`Waiting ${delaySec}s before exiting...\n`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    });

  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(e.message + '\n');
      process.exit(e.exitCode || 1);
    } else {
      process.stderr.write((e?.stack || e?.message || String(e)) + '\n');
      process.exit(1);
    }
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] && resolve(process.argv[1]);
if (invoked && thisFile === invoked) {
  main();
}
