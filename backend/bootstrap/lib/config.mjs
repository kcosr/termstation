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
  const REPO = env.REPO || '';
  const ISSUE_ID = env.ISSUE_ID || '';
  let BRANCH = env.BRANCH || '';
  // SESSION_TITLE support removed. Prefer CLI flags for title shaping.

  if (!SESSION_ID) throw new CliError('SESSION_ID is required but not set', 2);
  if (!SESSIONS_API_BASE_URL) throw new CliError('SESSIONS_API_BASE_URL is required but not set', 2);

  // Derive default branch if ISSUE_ID present and BRANCH not provided
  if (!BRANCH && ISSUE_ID) BRANCH = `issue/${ISSUE_ID}`;

  const DEBUG = env.AGENTS_DEBUG === '1' || env.AGENTS_DEBUG === 'true';

  return {
    SESSION_ID,
    SESSIONS_API_BASE_URL,
    TERMSTATION_USER,
    REPO,
    ISSUE_ID,
    BRANCH,
    DEBUG,
  };
}

export const BASIC_AUTH = 'Basic ' + Buffer.from('webhooks:webhooks').toString('base64');
