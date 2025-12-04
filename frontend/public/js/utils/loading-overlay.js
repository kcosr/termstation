/**
 * Simple helper to create and manage a loading overlay within a container.
 */
export function showLoadingOverlay(container, initialText = 'Loading...') {
  if (!container) return null;
  try {
    const inlinePosition = container.style?.position || '';
    const computedPosition = (typeof window !== 'undefined' && window.getComputedStyle)
      ? window.getComputedStyle(container)?.position
      : null;
    if ((!inlinePosition || inlinePosition === '') && computedPosition === 'static') {
      container.style.position = 'relative';
    }
  } catch (_) {}
  const overlay = document.createElement('div');
  overlay.className = 'terminal-loading-overlay';

  const placeholder = document.createElement('div');
  placeholder.className = 'terminal-placeholder';

  const p = document.createElement('p');
  p.className = 'overlay-text';
  p.textContent = initialText;

  placeholder.appendChild(p);
  overlay.appendChild(placeholder);
  container.appendChild(overlay);

  const setText = (text) => { try { p.textContent = text; } catch (_) {} };
  const remove = () => { try { overlay.remove(); } catch (_) {} };
  return { element: overlay, setText, remove };
}
