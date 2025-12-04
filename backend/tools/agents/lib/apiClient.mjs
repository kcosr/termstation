import { CliError } from './errors.mjs';
import { loadConfig } from './config.mjs';

function joinUrl(base, path) {
  if (!base.endsWith('/')) base += '/';
  return base + (path.startsWith('/') ? path.slice(1) : path);
}

async function parseMaybeJson(res) {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

export class ApiClient {
  constructor(baseUrl, { debug = false, token } = {}) {
    this.baseUrl = baseUrl;
    this.debug = debug;
    this.token = token || loadConfig().SESSION_TOK || '';
    if (!this.token) {
      throw new CliError('SESSION_TOK is required but not set', 2);
    }
  }

  async request(method, path, { json, headers } = {}) {
    const url = joinUrl(this.baseUrl, path);
    const init = {
      method,
      headers: {
        'x-session-token': this.token,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...(headers || {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    };
    if (this.debug) {
      console.error(`[agents][debug] ${method} ${url}`);
      if (json) console.error(`[agents][debug] payload: ${JSON.stringify(json)}`);
    }
    const res = await fetch(url, init);
    const { data, raw } = await parseMaybeJson(res);
    if (!res.ok) {
      const snippet = raw?.slice(0, 300) || '';
      throw new CliError(`HTTP ${res.status} ${res.statusText} for ${method} ${path}${snippet ? `\n${snippet}` : ''}`);
    }
    return data ?? raw;
  }

  // Sessions API methods
  createSession(payload) {
    return this.request('POST', '/sessions', { json: payload });
  }
  listSessions() {
    return this.request('GET', '/sessions');
  }
  searchSessions({ repo, issueId }) {
    const params = new URLSearchParams();
    params.set('scope', 'active');
    params.set('ids_only', 'false');
    if (repo) params.set('param.repo', repo);
    if (issueId) params.set('param.issue_id', issueId);
    return this.request('GET', `/sessions/search?${params.toString()}`);
  }
  getSession(sessionId) {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }
  sendInput(sessionId, data) {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/input`, { json: { data } });
  }
  updateParameters(sessionId, templateParameters) {
    return this.request('PUT', `/sessions/${encodeURIComponent(sessionId)}/parameters`, { json: { template_parameters: templateParameters } });
  }
  addLinks(sessionId, links) {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/links`, { json: { links } });
  }
  setTitle(sessionId, title) {
    return this.request('PUT', `/sessions/${encodeURIComponent(sessionId)}/title`, { json: { title } });
  }
  async deleteSession(sessionId) {
    const url = joinUrl(this.baseUrl, `/sessions/${encodeURIComponent(sessionId)}`);
    if (this.debug) console.error(`[agents][debug] DELETE ${url}`);
    const res = await fetch(url, { method: 'DELETE', headers: { 'x-session-token': this.token } });
    if (res.ok) return { status: res.status };
    const text = await res.text().catch(() => '');
    throw new CliError(`HTTP ${res.status} ${res.statusText} for DELETE /sessions/${sessionId}${text ? `\n${text.slice(0,300)}` : ''}`);
  }
}
