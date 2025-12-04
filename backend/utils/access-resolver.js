/**
 * Access resolver utilities for boolean domains (features, permissions).
 *
 * Semantics:
 * - Inputs can be an object map of booleans or the string "*".
 * - Groups are merged in the provided order; later groups override earlier ones.
 * - User overrides are applied last and override any group values.
 * - Wildcard means: set all known keys to true unless explicitly set to false.
 * - Final result is a map of { key: boolean } for every key in `keys`.
 */

function coalesceObject(o) {
  return (o && typeof o === 'object') ? o : {};
}

/**
 * Resolve a boolean domain from groups and user inputs.
 * @param {Object} params
 * @param {Set<string>|Array<string>} params.keys - Canonical set/list of keys
 * @param {Array<Object|string>} [params.groupInputs] - Each item is an object map or "*"
 * @param {Object|string|null|undefined} [params.userInput] - Object map or "*"
 * @returns {Object<string, boolean>} Final resolved map for all keys in `keys`
 */
export function resolveBooleanDomain({ keys, groupInputs = [], userInput = null, defaults = {} }) {
  const allKeys = Array.isArray(keys) ? new Set(keys) : (keys instanceof Set ? keys : new Set());
  let wildcard = false;
  let merged = {};

  const applyInput = (input) => {
    if (typeof input === 'string' && input.trim() === '*') {
      wildcard = true;
      return;
    }
    const obj = coalesceObject(input);
    // Merge: later values override earlier
    merged = { ...merged, ...obj };
  };

  for (const gi of (Array.isArray(groupInputs) ? groupInputs : [])) applyInput(gi);
  applyInput(userInput);

  const result = {};
  for (const key of allKeys) {
    const hasExplicit = Object.prototype.hasOwnProperty.call(merged, key);
    if (hasExplicit) {
      result[key] = merged[key] === true;
      continue;
    }
    if (wildcard) {
      // not explicitly false, so enable via wildcard
      result[key] = true;
    } else {
      // apply domain default (fallback to false)
      const dv = (defaults && Object.prototype.hasOwnProperty.call(defaults, key)) ? defaults[key] === true : false;
      result[key] = dv;
    }
  }
  // Enforce explicit false overrides against wildcard expansion
  for (const [k, v] of Object.entries(merged)) {
    if (allKeys.has(k) && v === false) {
      result[k] = false;
    }
  }
  return result;
}
