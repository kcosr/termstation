/**
 * Links Loader
 * Loads global link groups from backend/config/links.json
 */

import { logger } from './utils/logger.js';
import { linksConfigCache } from './utils/json-config-cache.js';

class LinksLoader {
  constructor() {
    // Config path and watching are handled by linksConfigCache.
  }

  /**
   * Read and parse the links.json file. Returns an object:
   * { groups: [ { name: string, links: [ { name: string, url: string } ] } ] }
   */
  getLinks() {
    try {
      const data = linksConfigCache.get() || {};
      // Normalize shape
      const groups = Array.isArray(data?.groups) ? data.groups : Array.isArray(data?.link_groups) ? data.link_groups : [];
      // Validate entries minimally
      const normalized = groups.map((g) => {
        const name = typeof g?.name === 'string' ? g.name : (typeof g?.group === 'string' ? g.group : '');
        const links = Array.isArray(g?.links) ? g.links : [];
        const safeLinks = links
          .filter(l => l && (typeof l.url === 'string') && l.url.trim())
          .map(l => ({ name: typeof l.name === 'string' ? l.name : l.url, url: l.url, refresh: l.refresh === true }));
        return { name, links: safeLinks };
      }).filter(g => g.name && g.links.length > 0);
      return { groups: normalized };
    } catch (e) {
      logger.error(`[LinksLoader] Failed to load links.json: ${e.message}`);
      return { groups: [] };
    }
  }
}

export const linksLoader = new LinksLoader();
