import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import { createTestConfig, writeTestTemplates, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let config;
let templateLoader;
let TerminalSession;
let serializeSessionForHistoryList;
let handleLinkPreViewGenerate;
let handleLinkPreViewHtml;
let handleLinkPreViewGenerateById;
let handleLinkPreViewHtmlById;

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end() { this._ended = true; return this; }
  };
}

function createStreamResponse() {
  const sink = new Writable({
    write(chunk, _enc, cb) {
      this.body = (this.body || '') + chunk.toString();
      cb();
    }
  });
  sink.statusCode = 200;
  sink.headers = {};
  sink.headersSent = false;
  sink.status = function (code) { this.statusCode = code; return this; };
  sink.setHeader = function (name, value) { this.headers[name] = value; this.headersSent = true; return this; };
  sink.json = function (payload) { this.body = payload; this.headersSent = true; return this; };
  return sink;
}

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  // Minimal test-only template with a single chat link
  writeTestTemplates(configDir, [
    {
      id: 'chat-links',
      name: 'Chat Links',
      description: 'Test template for chat link pre-view pipeline',
      command: '/usr/bin/true',
      working_directory: '~',
      group: 'Tests',
      display: false,
      links: [
        {
          url: 'https://example.com/chat',
          name: 'Chat',
          pre_view_command: 'printf "<html>%s|%s|%s|%s</html>" "BG={THEME_BG_PRIMARY}" "BORDER={THEME_BORDER_COLOR}" "UI={THEME_FONT_UI}" "CODE={THEME_FONT_CODE}" > "{OUTPUT_HTML}"',
          show_url_bar: false,
          pass_theme_colors: true,
          refresh_on_view_active: true,
          refresh_on_view_inactive: false,
          output_filename: 'chat-{session_id}.html'
        }
      ]
    }
  ]);

  ({ config } = await import('../config-loader.js'));
  ({ templateLoader } = await import('../template-loader.js'));
  ({ TerminalSession } = await import('../models/terminal-session.js'));
  ({ serializeSessionForHistoryList } = await import('../utils/session-serializer.js'));
  ({
    handleLinkPreViewGenerate,
    handleLinkPreViewHtml,
    handleLinkPreViewGenerateById,
    handleLinkPreViewHtmlById
  } = await import('../routes/sessions.js'));
});

afterAll(() => {
  try { templateLoader.cleanup?.(); } catch {}
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('template chat link processing and pre-view endpoints', () => {
  it('marks template links with internal pre_view metadata and hides it externally', () => {
    const tpl = templateLoader.getTemplate('chat-links');
    if (!tpl) throw new Error('chat-links template not found');

    const processed = tpl.processTemplate({ session_id: 'abc123' });
    expect(Array.isArray(processed.links)).toBe(true);
    expect(processed.links.length).toBe(1);

    const link = processed.links[0];
    // Internal metadata present on processed template links
    expect(link._template_link).toBe(true);
    expect(typeof link._pre_view_command).toBe('string');
    expect(link._pre_view_command.length > 0).toBe(true);
    // Raw config key is not carried forward
    expect(link.pre_view_command).toBeUndefined();
    // New flags preserved
    expect(link.show_url_bar).toBe(false);
    expect(link.pass_theme_colors).toBe(true);
    expect(link.refresh_on_view_active).toBe(true);
    expect(link.refresh_on_view_inactive).toBe(false);
    // output_filename templated with session_id
    expect(typeof link.output_filename).toBe('string');
    expect(link.output_filename.includes('abc123')).toBe(true);

    // Session-level storage keeps internal fields but response objects hide them
    const session = new TerminalSession({
      session_id: 'sess-chat-1',
      links: processed.links,
      save_session_history: false
    });

    expect(session.links[0]._template_link).toBe(true);
    expect(typeof session.links[0]._pre_view_command).toBe('string');
    expect(typeof session.links[0].link_id).toBe('string');
    expect(session.links[0].link_id.length > 0).toBe(true);

    const resp = session.toResponseObject();
    expect(resp.links.length).toBe(1);
    const publicLink = resp.links[0];
    expect(publicLink.url).toBe(link.url);
    expect(publicLink.name).toBe(link.name);
    // Internal fields hidden from API consumers
    expect(publicLink._pre_view_command).toBeUndefined();
    expect(publicLink.pre_view_command).toBeUndefined();
    expect(publicLink._template_link).toBeUndefined();
    // Public metadata exposed
    expect(publicLink.has_pre_view_command).toBe(true);
    expect(typeof publicLink.link_id).toBe('string');
    expect(publicLink.link_id.length > 0).toBe(true);
    expect(publicLink.show_url_bar).toBe(false);
    expect(publicLink.pass_theme_colors).toBe(true);
    expect(publicLink.refresh_on_view_active).toBe(true);
    expect(publicLink.refresh_on_view_inactive).toBe(false);
    expect(typeof publicLink.output_filename).toBe('string');

    const summary = serializeSessionForHistoryList(session);
    expect(summary.links.length).toBe(1);
    const summaryLink = summary.links[0];
    expect(summaryLink.has_pre_view_command).toBe(true);
    expect(typeof summaryLink.link_id).toBe('string');
    expect(summaryLink.link_id.length > 0).toBe(true);
    expect(summaryLink._pre_view_command).toBeUndefined();
  });

  it('POST /:id/links/:idx/generate enforces permissions and runs pre_view_command', async () => {
    const tpl = templateLoader.getTemplate('chat-links');
    const processed = tpl.processTemplate({ session_id: 'sess-chat-2' });
    const sessionId = 'sess-chat-2';
    const session = new TerminalSession({
      session_id: sessionId,
      links: processed.links,
      save_session_history: false,
      created_by: 'owner'
    });
    const linkId = session.links[0].link_id;
    expect(typeof linkId).toBe('string');

    // Stub session manager
    global.sessionManager = {
      getSession: (id) => (id === sessionId ? session : null),
      getSessionIncludingTerminated: async (id) => (id === sessionId ? session : null)
    };

    // 403 when user cannot view the session (index-based)
    {
      const req = {
        params: { sessionId, linkIndex: '0' },
        body: {},
        user: { username: 'someone-else', permissions: {} }
      };
      const res = createResponse();
      await handleLinkPreViewGenerate(req, res);
      expect(res.statusCode).toBe(403);
      expect(res.body && res.body.error).toBe('FORBIDDEN');
    }

    // Successful generation for owner with theme colors and fonts (index-based)
    {
      const req = {
        params: { sessionId, linkIndex: '0' },
        body: {
          theme: {
            bg_primary: '#112233',
            border_color: '#445566'
          },
          fonts: {
            ui: 'Inter \n',
            code: 'Fira Code\t'
          }
        },
        user: { username: 'owner', permissions: {} }
      };
      const res = createResponse();
      await handleLinkPreViewGenerate(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body && typeof res.body.html_url === 'string').toBe(true);

      // HTML file should exist under the session directory
      const base = path.isAbsolute(config.SESSIONS_DIR)
        ? config.SESSIONS_DIR
        : path.join(process.cwd(), config.SESSIONS_DIR);
      const sessionDir = path.join(base, sessionId);
      const linksDir = path.join(sessionDir, 'links');
      const files = fs.readdirSync(linksDir);
      expect(files.length).toBeGreaterThan(0);
      const htmlFile = files.find((f) => f.endsWith('.html'));
      expect(htmlFile).toBeDefined();
      const htmlContent = fs.readFileSync(path.join(linksDir, htmlFile), 'utf8');
      // THEME_BG_PRIMARY and THEME_BORDER_COLOR should have been substituted
      expect(htmlContent.includes('BG=#112233')).toBe(true);
      expect(htmlContent.includes('BORDER=#445566')).toBe(true);
      // Fonts should be exposed via THEME_FONT_* macros, sanitized and trimmed
      expect(htmlContent.includes('UI=Inter')).toBe(true);
      expect(htmlContent.includes('CODE=Fira Code')).toBe(true);
    }

    // 404 when link id is unknown
    {
      const req = {
        params: { sessionId, linkId: 'non-existent-link-id' },
        body: {},
        user: { username: 'owner', permissions: {} }
      };
      const res = createResponse();
      await handleLinkPreViewGenerateById(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body && res.body.error).toBe('LINK_NOT_FOUND');
    }

    // Successful generation for owner using link_id
    {
      const req = {
        params: { sessionId, linkId },
        body: {
          theme: {
            bg_primary: '#112233',
            border_color: '#445566'
          },
          fonts: {
            ui: 'Inter \n',
            code: 'Fira Code\t'
          }
        },
        user: { username: 'owner', permissions: {} }
      };
      const res = createResponse();
      await handleLinkPreViewGenerateById(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body && typeof res.body.html_url === 'string').toBe(true);
      expect(res.body.html_url.includes('/links/id/')).toBe(true);
    }
  });

  it('GET /:id/links/:idx/html streams the generated HTML and returns 404 when missing', async () => {
    const tpl = templateLoader.getTemplate('chat-links');
    const processed = tpl.processTemplate({ session_id: 'sess-chat-3' });
    const sessionId = 'sess-chat-3';
    const session = new TerminalSession({
      session_id: sessionId,
      links: processed.links,
      save_session_history: false,
      created_by: 'owner'
    });
    const linkId = session.links[0].link_id;
    expect(typeof linkId).toBe('string');

    // Ensure any prior artifacts for this session are removed so the first
    // fetch observes a missing HTML file.
    {
      const base = path.isAbsolute(config.SESSIONS_DIR)
        ? config.SESSIONS_DIR
        : path.join(process.cwd(), config.SESSIONS_DIR);
      const sessionDir = path.join(base, sessionId);
      const linksDir = path.join(sessionDir, 'links');
      try { fs.rmSync(linksDir, { recursive: true, force: true }); } catch {}
    }

    global.sessionManager = {
      getSession: (id) => (id === sessionId ? session : null),
      getSessionIncludingTerminated: async (id) => (id === sessionId ? session : null)
    };

    // Missing file => 404 (index-based)
    {
      const req = {
        params: { sessionId, linkIndex: '0' },
        user: { username: 'owner', permissions: {} }
      };
      const res = createResponse();
      await handleLinkPreViewHtml(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body && res.body.error).toBe('HTML_NOT_FOUND');
    }

    // Missing file => 404 (id-based)
    {
      const req = {
        params: { sessionId, linkId },
        user: { username: 'owner', permissions: {} }
      };
      const res = createResponse();
      await handleLinkPreViewHtmlById(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body && res.body.error).toBe('HTML_NOT_FOUND');
    }

    // Generate the file first (index-based)
    {
      const genReq = {
        params: { sessionId, linkIndex: '0' },
        body: {},
        user: { username: 'owner', permissions: {} }
      };
      const genRes = createResponse();
      await handleLinkPreViewGenerate(genReq, genRes);
      expect(genRes.statusCode).toBe(200);
    }

    // Then fetch it (index-based)
    {
      const req = {
        params: { sessionId, linkIndex: '0' },
        user: { username: 'owner', permissions: {} }
      };
      const res = createStreamResponse();
      await handleLinkPreViewHtml(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBeDefined();
    }

    // And fetch via id-based endpoint
    {
      const req = {
        params: { sessionId, linkId },
        user: { username: 'owner', permissions: {} }
      };
      const res = createStreamResponse();
      await handleLinkPreViewHtmlById(req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBeDefined();
    }
  });
});
