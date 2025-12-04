import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBindMountClassifier } from '../utils/workspace-mountinfo.js';

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

