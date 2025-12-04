/**
 * Logger utility for termstation Backend
 */

import { config } from '../config-loader.js';

export const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  debug: (msg) => config.LOG_LEVEL === 'DEBUG' && console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`),
  warning: (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`)
};