/**
 * App Context - lightweight dependency container
 * Allows modules to access shared instances without relying on window globals.
 */

const _context = {
  app: null,
  appStore: null,
  apiService: null,
  websocketService: null,
  eventBus: null,
};

export function setContext(partial) {
  Object.assign(_context, partial || {});
}

export function getContext() {
  return _context;
}

export function requireContext(key) {
  if (!_context[key]) {
    throw new Error(`AppContext missing '${key}'`);
  }
  return _context[key];
}

