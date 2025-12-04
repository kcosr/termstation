// Validate merge_bind_mounts behavior for bind_mounts in inheritance and overlays

import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ts-bind-merge-'));
  const config = {
    environment: 'test',
    host: '127.0.0.1',
    port: 6622,
    log_level: 'INFO',
    auth_enabled: false,
    default_username: 'tester',
    username_aliases: {},
    cors_origins: ['*'],
    cors_credentials: true,
    websocket: { ping_interval_ms: 30000, ping_timeout_ms: 10000 },
    terminal: {
      default_shell: '/bin/bash',
      default_working_dir: '~',
      default_cols: 80,
      default_rows: 24,
      max_sessions: 10,
      session_timeout_seconds: 60,
      cleanup_interval_seconds: 30,
      max_buffer_size: 10000,
      output_chunk_size: 4096
    },
    logging: { level: 'INFO', format: '' },
    data_dir: join(dir, 'data'),
    sessions_base_url: 'http://localhost',
    sessions_api_base_url: 'http://localhost/api/',
    template_vars: {},
    containers: {},
    ntfy: { enabled: false },
    stdin_injection: {},
    scheduled_input: {},
    session_activity: {}
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

test('merge_bind_mounts controls bind_mount inheritance and overlays', async () => {
  const dir = makeTempConfigDir();
  try {
    const templatesConfig = {
      templates: [
        {
          id: 'base',
          name: 'Base',
          sandbox: true,
          command: 'echo base',
          bind_mounts: [
            { host_path: '/base', container_path: '/mnt/base' }
          ]
        },
        {
          id: 'child-default',
          extends: 'base',
          sandbox: true,
          // With default merge_bind_mounts behavior, child bind_mounts should be merged with base bind_mounts
          bind_mounts: [
            { host_path: '/child', container_path: '/mnt/child' }
          ]
        },
        {
          id: 'child-replace',
          extends: 'base',
          sandbox: true,
          merge_bind_mounts: false,
          bind_mounts: [
            { host_path: '/child-only', container_path: '/mnt/child-only' }
          ]
        },
        {
          id: 'overlay-base',
          name: 'Overlay Base',
          sandbox: true,
          sandbox_overrides: {
            bind_mounts: [
              { host_path: '/obase', container_path: '/mnt/obase' }
            ]
          }
        },
        {
          id: 'overlay-child',
          extends: 'overlay-base',
          sandbox: true,
          sandbox_overrides: {
            merge_bind_mounts: true,
            bind_mounts: [
              { host_path: '/ochild', container_path: '/mnt/ochild' }
            ]
          }
        }
      ]
    };

    writeFileSync(join(dir, 'templates.json'), JSON.stringify(templatesConfig, null, 2));

    process.env.TERMSTATION_CONFIG_DIR = dir;
    const mod = await import('../template-loader.js');
    const loader = mod.templateLoader;

    const childDefault = loader.getTemplate('child-default');
    expect(childDefault).toBeTruthy();
    expect(childDefault.bind_mounts).toEqual([
      { host_path: '/base', container_path: '/mnt/base' },
      { host_path: '/child', container_path: '/mnt/child' }
    ]);

    const childReplace = loader.getTemplate('child-replace');
    expect(childReplace).toBeTruthy();
    expect(childReplace.bind_mounts).toEqual([
      { host_path: '/child-only', container_path: '/mnt/child-only' }
    ]);

    const overlayChild = loader.getTemplate('overlay-child');
    expect(overlayChild).toBeTruthy();
    expect(overlayChild.bind_mounts).toEqual([
      { host_path: '/obase', container_path: '/mnt/obase' },
      { host_path: '/ochild', container_path: '/mnt/ochild' }
    ]);
  } finally {
    try { (await import('../template-loader.js')).templateLoader?.cleanup?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    delete process.env.TERMSTATION_CONFIG_DIR;
  }
});
