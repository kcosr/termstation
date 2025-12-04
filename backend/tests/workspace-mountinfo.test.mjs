import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBindMountClassifier, createBindMountClassifierFromTemplate } from '../utils/workspace-mountinfo.js';

describe('createBindMountClassifier', () => {
  const envKey = 'TERMSTATION_WORKSPACE_MOUNTINFO_OVERRIDE';
  let prevEnv;

  beforeEach(() => {
    prevEnv = process.env[envKey];
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = prevEnv;
    }
  });

  it('classifies sub-mounts under the workspace root as rw/ro and ignores the root mount', () => {
    process.env[envKey] = [
      '1683 1692 253:0 /srv/devtoolsd/prod/data/termstation/backend/sessions/ABC/workspace /workspace rw,relatime - xfs /dev/mapper/rl-root rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota',
      '1684 1683 253:0 /srv/devtoolsd/.rustup /workspace/.rustup ro,relatime - xfs /dev/mapper/rl-root ro,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota',
      '1685 1683 253:0 /srv/devtoolsd/.cargo /workspace/.cargo rw,relatime - xfs /dev/mapper/rl-root rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota'
    ].join('\n');

    const classify = createBindMountClassifier('/workspace');

    expect(classify('/workspace')).toBeNull();
    expect(classify('/workspace/file.txt')).toBeNull();

    expect(classify('/workspace/.rustup')).toBe('ro');
    expect(classify('/workspace/.rustup/config')).toBe('ro');

    expect(classify('/workspace/.cargo')).toBe('rw');
    expect(classify('/workspace/.cargo/bin/tool')).toBe('rw');

    expect(classify('/workspace/other')).toBeNull();
  });
});

describe('createBindMountClassifierFromTemplate', () => {
  it('classifies paths based on template bind_mounts array', () => {
    const bindMounts = [
      { container_path: '/workspace/.rustup', host_path: '/srv/.rustup', readonly: true },
      { container_path: '/workspace/.cargo', host_path: '/srv/.cargo', readonly: false },
      { containerPath: '/workspace/.npm', hostPath: '/srv/.npm' } // alternate key names, no readonly = rw
    ];

    const classify = createBindMountClassifierFromTemplate(bindMounts);

    // Paths under bind mounts should be classified
    expect(classify('/workspace/.rustup')).toBe('ro');
    expect(classify('/workspace/.rustup/toolchains/stable')).toBe('ro');

    expect(classify('/workspace/.cargo')).toBe('rw');
    expect(classify('/workspace/.cargo/bin/rustc')).toBe('rw');

    expect(classify('/workspace/.npm')).toBe('rw');
    expect(classify('/workspace/.npm/cache')).toBe('rw');

    // Paths not under bind mounts should return null
    expect(classify('/workspace')).toBeNull();
    expect(classify('/workspace/myproject')).toBeNull();
    expect(classify('/workspace/file.txt')).toBeNull();
  });

  it('returns null classifier when bind_mounts is empty or not an array', () => {
    expect(createBindMountClassifierFromTemplate(null)('/workspace/.cargo')).toBeNull();
    expect(createBindMountClassifierFromTemplate([])('/workspace/.cargo')).toBeNull();
    expect(createBindMountClassifierFromTemplate(undefined)('/workspace/.cargo')).toBeNull();
  });

  it('handles paths without leading slash', () => {
    const bindMounts = [
      { container_path: '/workspace/.cargo', host_path: '/srv/.cargo' }
    ];

    const classify = createBindMountClassifierFromTemplate(bindMounts);

    // Should normalize paths and match correctly
    expect(classify('workspace/.cargo')).toBe('rw');
    expect(classify('workspace/.cargo/bin')).toBe('rw');
  });

  it('most specific mount wins when paths overlap', () => {
    const bindMounts = [
      { container_path: '/workspace/.config', host_path: '/srv/.config', readonly: false },
      { container_path: '/workspace/.config/sensitive', host_path: '/srv/.config-ro', readonly: true }
    ];

    const classify = createBindMountClassifierFromTemplate(bindMounts);

    expect(classify('/workspace/.config')).toBe('rw');
    expect(classify('/workspace/.config/other')).toBe('rw');
    expect(classify('/workspace/.config/sensitive')).toBe('ro');
    expect(classify('/workspace/.config/sensitive/keys')).toBe('ro');
  });
});

