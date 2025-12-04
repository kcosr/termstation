import { describe, it, expect } from 'vitest';
import { isWorkspaceServiceEnabledForSession } from '../utils/workspace-service-flags.js';

describe('isWorkspaceServiceEnabledForSession helper', () => {
  const templateEnabled = { workspace_service_enabled: true };
  const templateDisabled = { workspace_service_enabled: false };

  it('returns false when global flag is disabled', () => {
    const result = isWorkspaceServiceEnabledForSession({
      template: templateEnabled,
      isolationMode: 'container',
      globalConfig: { WORKSPACE_SERVICE_ENABLED: false }
    });
    expect(result).toBe(false);
  });

  it('returns false when template flag is disabled', () => {
    const result = isWorkspaceServiceEnabledForSession({
      template: templateDisabled,
      isolationMode: 'container',
      globalConfig: { WORKSPACE_SERVICE_ENABLED: true }
    });
    expect(result).toBe(false);
  });

  it('returns false when isolation mode is none', () => {
    const result = isWorkspaceServiceEnabledForSession({
      template: templateEnabled,
      isolationMode: 'none',
      globalConfig: { WORKSPACE_SERVICE_ENABLED: true }
    });
    expect(result).toBe(false);
  });

  it('returns true only for container and directory isolation when flags enabled', () => {
    const cfg = { WORKSPACE_SERVICE_ENABLED: true };
    const enabledContainer = isWorkspaceServiceEnabledForSession({
      template: templateEnabled,
      isolationMode: 'container',
      globalConfig: cfg
    });
    const enabledDirectory = isWorkspaceServiceEnabledForSession({
      template: templateEnabled,
      isolationMode: 'directory',
      globalConfig: cfg
    });
    expect(enabledContainer).toBe(true);
    expect(enabledDirectory).toBe(true);
  });
});

