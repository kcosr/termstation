/**
 * Template access resolution utilities
 *
 * Implements per-user and per-group allow/deny with optional '*' wildcard.
 * Ordering rules for display:
 *  - Append in group order (per-group order, dedupe)
 *  - Then append user allows (dedupe)
 *  - Then apply denies (remove entries; remaining order preserved)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { templateLoader } from '../template-loader.js';
import { logger } from './logger.js';
import { usersConfigCache, groupsConfigCache } from './json-config-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeReadJson(filePath, fallback) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return fallback;
  }
}

function getKnownTemplateIds() {
  try {
    return templateLoader.getAllTemplates().map((t) => t.id);
  } catch (e) {
    logger.warning(`Failed to load known template IDs: ${e.message}`);
    return [];
  }
}

function dedupeAppend(base, items) {
  const seen = new Set(base);
  for (const it of items) {
    if (!seen.has(it)) {
      base.push(it);
      seen.add(it);
    }
  }
  return base;
}

function normalizeList(v) {
  if (v === '*' || v === ' * ') return '*';
  if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean);
  return [];
}

/**
 * Core resolver (pure): compute ordered allowed template IDs.
 * @param {string[]} knownIds - Known template IDs (universe & default order)
 * @param {object|null} userDef - User object from users.json (may be null)
 * @param {object[]} groupDefs - Array of group objects from groups.json
 * @param {string[]} userGroupsOrder - Ordered group names for the user
 * @returns {string[]} ordered list of allowed template IDs
 */
export function resolveAllowedTemplatesFromConfig(knownIds, userDef, groupDefs, userGroupsOrder = []) {
  const known = new Set(knownIds);

  // Groups resolution
  let groupAllowAll = false;
  let groupDenyAll = false;
  let groupAllowOrdered = [];
  let groupDeny = new Set();

  for (const gname of userGroupsOrder) {
    const g = (groupDefs || []).find((gg) => gg && String(gg.name) === String(gname));
    if (!g) continue;
    const gAllow = normalizeList(g.allow_templates);
    const gDeny = normalizeList(g.deny_templates);

    if (gAllow === '*') {
      groupAllowAll = true;
    } else if (Array.isArray(gAllow)) {
      const valid = [];
      for (const id of gAllow) {
        if (known.has(id)) valid.push(id);
        else logger.debug(`Ignoring unknown template ID in group.allow_templates: '${id}'`);
      }
      groupAllowOrdered = dedupeAppend(groupAllowOrdered, valid);
    }

    if (gDeny === '*') {
      groupDenyAll = true;
    } else if (Array.isArray(gDeny)) {
      for (const id of gDeny) {
        if (known.has(id)) groupDeny.add(id);
        else logger.debug(`Ignoring unknown template ID in group.deny_templates: '${id}'`);
      }
    }
  }

  // Start from group allows
  let allowed = [];
  if (groupAllowAll) {
    allowed = [...knownIds];
  } else {
    allowed = [...groupAllowOrdered];
  }

  // Apply group denies
  if (groupDenyAll) {
    allowed = [];
  } else if (groupDeny.size > 0 && allowed.length > 0) {
    allowed = allowed.filter((id) => !groupDeny.has(id));
  }

  // User overrides
  const uAllowRaw = normalizeList(userDef?.allow_templates);
  const uDenyRaw = normalizeList(userDef?.deny_templates);

  if (uAllowRaw === '*') {
    allowed = dedupeAppend(allowed, knownIds);
  } else if (Array.isArray(uAllowRaw) && uAllowRaw.length > 0) {
    const valid = [];
    for (const id of uAllowRaw) {
      if (known.has(id)) valid.push(id);
      else logger.debug(`Ignoring unknown template ID in user.allow_templates: '${id}'`);
    }
    allowed = dedupeAppend(allowed, valid);
  }

  if (uDenyRaw === '*') {
    return [];
  } else if (Array.isArray(uDenyRaw) && uDenyRaw.length > 0) {
    const toDeny = new Set();
    for (const id of uDenyRaw) {
      if (known.has(id)) toDeny.add(id);
      else logger.debug(`Ignoring unknown template ID in user.deny_templates: '${id}'`);
    }
    if (toDeny.size > 0) {
      allowed = allowed.filter((id) => !toDeny.has(id));
    }
  }

  // Default deny: if no allows configured anywhere, allowed stays empty
  return allowed;
}

/**
 * Resolve allowed templates for a request user by reading config files.
 * @param {{username:string, groups:string[]}} userProfile
 * @returns {string[]} ordered list of allowed template IDs
 */
export function resolveAllowedTemplatesForUser(userProfile) {
  const knownIds = getKnownTemplateIds();
  const usersRaw = usersConfigCache.get();
  const groupsRaw = groupsConfigCache.get();
  const users = Array.isArray(usersRaw) ? usersRaw : [];
  const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
  const username = String(userProfile?.username || '').trim();
  const userDef = users.find((u) => u && String(u.username) === username) || null;
  // Treat an empty array of groups on the request profile as 'unset' so we can fall back to users.json
  const reqGroups = Array.isArray(userProfile?.groups) ? userProfile.groups.filter(Boolean) : [];
  const userGroupsOrder = (reqGroups && reqGroups.length > 0)
    ? reqGroups
    : (Array.isArray(userDef?.groups) ? userDef.groups : []);
  return resolveAllowedTemplatesFromConfig(knownIds, userDef, groups, userGroupsOrder);
}

/**
 * Convenience predicate for enforcement: is template allowed?
 */
export function isTemplateAllowedForUser(userProfile, templateId) {
  const allowed = new Set(resolveAllowedTemplatesForUser(userProfile));
  return allowed.has(templateId);
}
