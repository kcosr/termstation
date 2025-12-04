import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

let configDir;
let serializeSessionForHistoryList;
let serializeSessionForPaginatedHistory;
let serializeSessionForSearch;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  const mod = await import('../utils/session-serializer.js');
  ({
    serializeSessionForHistoryList,
    serializeSessionForPaginatedHistory,
    serializeSessionForSearch
  } = mod);
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

const baseSession = {
  session_id: 'sess-123',
  command: 'echo "hello world"',
  working_directory: '/tmp',
  created_at: '2024-01-01T00:00:00.000Z',
  last_activity: '2024-01-01T00:05:00.000Z',
  is_active: false,
  ended_at: '2024-01-01T00:05:00.000Z',
  exit_code: 0,
  created_by: 'jsmith',
  visibility: 'private',
  title: 'Sample',
  dynamic_title: 'Sample',
  interactive: false,
  load_history: true,
  save_session_history: true,
  links: [{ url: 'https://pc:8443', name: 'Home' }],
  template_id: null,
  template_name: null,
  template_parameters: {},
  workspace: 'Default',
  note: 'Hello from note',
  note_version: 2,
  note_updated_at: '2024-01-01T00:06:00.000Z',
  note_updated_by: 'jsmith'
};

describe('session serializer note metadata', () => {
  it('serializeSessionForHistoryList includes note metadata and normalized links', () => {
    const payload = serializeSessionForHistoryList(baseSession);
    expect(payload.note).toBe(baseSession.note);
    expect(payload.note_version).toBe(baseSession.note_version);
    expect(payload.note_updated_at).toBe(baseSession.note_updated_at);
    expect(payload.note_updated_by).toBe(baseSession.note_updated_by);
    expect(payload.created_by).toBe(baseSession.created_by);
    expect(payload.visibility).toBe(baseSession.visibility);
    expect(payload.last_activity).toBe(baseSession.last_activity);
    expect(payload.load_history).toBe(baseSession.load_history);
    expect(payload.save_session_history).toBe(baseSession.save_session_history);
    expect(Array.isArray(payload.links)).toBe(true);
    expect(payload.links.length).toBe(1);
    expect(payload.links[0].url).toBe(baseSession.links[0].url);
    expect(payload.links[0].name).toBe(baseSession.links[0].name);
  });

  it('serializeSessionForPaginatedHistory omits links and last_activity but keeps note metadata', () => {
    const payload = serializeSessionForPaginatedHistory(baseSession);
    expect(payload.note).toBe(baseSession.note);
    expect(payload.note_version).toBe(baseSession.note_version);
    expect(payload.note_updated_at).toBe(baseSession.note_updated_at);
    expect(payload.note_updated_by).toBe(baseSession.note_updated_by);
    expect(payload.created_by).toBe(baseSession.created_by);
    expect(payload.visibility).toBe(baseSession.visibility);
    expect(payload.last_activity).toBeUndefined();
    expect(payload.links).toBeUndefined();
    expect(payload.load_history).toBeUndefined();
    expect(payload.save_session_history).toBeUndefined();
  });

  it('serializeSessionForSearch includes history flags and note metadata', () => {
    const payload = serializeSessionForSearch(baseSession);
    expect(payload.note).toBe(baseSession.note);
    expect(payload.note_version).toBe(baseSession.note_version);
    expect(payload.note_updated_at).toBe(baseSession.note_updated_at);
    expect(payload.note_updated_by).toBe(baseSession.note_updated_by);
    expect(payload.created_by).toBe(baseSession.created_by);
    expect(payload.visibility).toBe(baseSession.visibility);
    expect(payload.last_activity).toBe(baseSession.last_activity);
    expect(payload.load_history).toBe(baseSession.load_history);
    expect(payload.save_session_history).toBe(baseSession.save_session_history);
    expect(payload.links).toBeUndefined();
  });

  it('serializeSessionForHistoryList normalizes missing note data', () => {
    const payload = serializeSessionForHistoryList({
      ...baseSession,
      note: undefined,
      note_version: undefined,
      note_updated_at: undefined,
      note_updated_by: undefined
    });
    expect(payload.note).toBe('');
    expect(payload.note_version).toBe(0);
    expect(payload.note_updated_at).toBeNull();
    expect(payload.note_updated_by).toBeNull();
  });
});
