/**
 * Event Delegation Helper
 * Attach a single listener to a root element and handle events for
 * descendants matching a CSS selector, using event bubbling.
 *
 * @param {Element} root - The element to attach the listener on
 * @param {string} selector - CSS selector to match descendants
 * @param {string} type - Event type (e.g., 'click')
 * @param {Function} handler - (event, matchedElement) => void
 * @param {AddEventListenerOptions|boolean} options - Optional listener options
 * @returns {Function} unsubscribe function
 */
export function delegate(root, selector, type, handler, options) {
  if (!root || typeof root.addEventListener !== 'function') {
    throw new Error('delegate: invalid root element');
  }

  const listener = (event) => {
    let node = event.target instanceof Element ? event.target : null;
    while (node && node !== root) {
      if (node.matches && node.matches(selector)) {
        handler.call(node, event, node);
        break;
      }
      node = node.parentElement;
    }
  };

  root.addEventListener(type, listener, options || false);
  return () => root.removeEventListener(type, listener, options || false);
}

