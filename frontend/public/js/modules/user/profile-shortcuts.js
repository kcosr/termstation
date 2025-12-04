import { keyboardShortcuts } from '../shortcuts/keyboard-shortcuts.js';
import { profileManager } from '../../utils/profile-manager.js';
import { authOrchestrator } from '../../core/auth-orchestrator.js';

class ProfileShortcuts {
  constructor() {
    this._registered = false;
    this._dispose = null;
  }

  init() {
    if (this._registered) return;
    const combos = ['Shift+Meta+code:KeyP', 'Shift+Alt+code:KeyP'];
    try {
      this._dispose = keyboardShortcuts.registerShortcut({
        id: 'user.shortcut.switch-previous-profile',
        description: 'Switch to previous profile',
        keys: combos,
        preventDefault: true,
        // Keep default allowInInputs=false so typing in inputs won’t trigger switches
        handler: () => {
          // Perform async work without blocking shortcut handling
          (async () => {
            try {
              const [prevId, activeId] = await Promise.all([
                profileManager.getPreviousId(),
                profileManager.getActiveId()
              ]);
              if (!prevId || prevId === activeId) return;
              try { await authOrchestrator.switchProfile(prevId); } catch (err) {
                console.warn('[ProfileShortcuts] switchProfile failed:', err);
              }
            } catch (e) {
              console.warn('[ProfileShortcuts] handler error:', e);
            }
          })();
          return true;
        }
      });
      this._registered = true;
    } catch (e) {
      console.warn('[ProfileShortcuts] Failed to register shortcut:', e);
    }
  }

  dispose() {
    if (typeof this._dispose === 'function') {
      try { this._dispose(); } catch (_) {}
      this._dispose = null;
      this._registered = false;
    }
  }
}

export const profileShortcuts = new ProfileShortcuts();

