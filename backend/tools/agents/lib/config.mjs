import { CliError } from './errors.mjs';

function normalizeBaseUrl(u) {
  if (!u) return u;
  return u.endsWith('/') ? u : u + '/';
}

export function loadConfig() {
  const env = process.env;

  const SESSION_ID = env.SESSION_ID;
  const SESSIONS_API_BASE_URL = normalizeBaseUrl(env.SESSIONS_API_BASE_URL);
  const TERMSTATION_USER = env.TERMSTATION_USER;
  const SESSION_TOK = env.SESSION_TOK || '';
  const REPO = env.REPO || '';
  const ISSUE_ID = env.ISSUE_ID || '';
  const FORGE = env.FORGE || '';
  let BRANCH = env.BRANCH || '';
  // SESSION_TITLE was previously supported to fully override the title.
  // It has been removed in favor of explicit CLI options (e.g., --description).

  if (!SESSION_ID) throw new CliError('SESSION_ID is required but not set', 2);
  if (!SESSIONS_API_BASE_URL) throw new CliError('SESSIONS_API_BASE_URL is required but not set', 2);

  if (!BRANCH && ISSUE_ID) BRANCH = `issue/${ISSUE_ID}`;

  const DEBUG = env.AGENTS_DEBUG === '1' || env.AGENTS_DEBUG === 'true';

  return {
    SESSION_ID,
    SESSIONS_API_BASE_URL,
    TERMSTATION_USER,
    SESSION_TOK,
    REPO,
    ISSUE_ID,
    FORGE,
    BRANCH,
    DEBUG,
  };
}
