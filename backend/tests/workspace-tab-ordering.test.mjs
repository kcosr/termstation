import { describe, it, beforeAll, afterAll, expect } from 'vitest';

let orderUrlTabsWithWorkspaceFirst;
let orderTabsWithWorkspaceAfterShellAndCommand;

beforeAll(async () => {
  ({
    orderUrlTabsWithWorkspaceFirst,
    orderTabsWithWorkspaceAfterShellAndCommand
  } = await import('../../frontend/public/js/modules/terminal/tab-ordering-helper.js'));
});

afterAll(() => {
  // no-op
});

describe('Workspace / Files tab ordering helpers', () => {
  it('keeps workspace-style URL tabs (Files) ahead of other URL tabs', () => {
    const filesUrlTab = { id: 'link-files', type: 'url', title: 'Files' };
    const otherUrlTab = { id: 'link-other', type: 'url', title: 'Docs' };

    const orderedUrlTabs = orderUrlTabsWithWorkspaceFirst([otherUrlTab, filesUrlTab]);
    const ids = orderedUrlTabs.map((t) => t.id);

    expect(ids[0]).toBe('link-files');
    expect(ids.indexOf('link-files')).toBeLessThan(ids.indexOf('link-other'));
  });

  it('places the Files workspace tab after any shell or command tabs but before generic URL tabs', () => {
    const terminalTab = { id: 'terminal', type: 'terminal', title: 'Terminal' };
    const containerTab = { id: 'container-1', type: 'container', title: 'Shell', childSessionId: 'child-1' };
    const commandTab = { id: 'cmd-1', type: 'command', title: 'Cmd1' };
    const workspaceTab = { id: 'workspace', type: 'workspace', title: 'Files' };
    const urlTab = { id: 'link-other', type: 'url', title: 'Docs' };

    const tabs = [urlTab, commandTab, workspaceTab, terminalTab, containerTab];
    const childSessions = [{ session_id: 'child-1' }];

    const ordered = orderTabsWithWorkspaceAfterShellAndCommand(tabs, childSessions);
    const ids = ordered.map((t) => t.id);

    expect(ids[0]).toBe('terminal');
    expect(ids.indexOf('container-1')).toBeLessThan(ids.indexOf('workspace'));
    expect(ids.indexOf('cmd-1')).toBeLessThan(ids.indexOf('workspace'));
    expect(ids.indexOf('workspace')).toBeLessThan(ids.indexOf('link-other'));
  });
});
