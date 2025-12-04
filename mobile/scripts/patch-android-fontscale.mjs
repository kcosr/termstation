#!/usr/bin/env node
/**
 * Patch Android MainActivity to set WebView text zoom to 85% (font scale 0.85).
 *
 * - Reads appId from capacitor.config.json to locate MainActivity.java
 * - Ensures imports for Bundle/WebView are present
 * - Ensures onCreate(Bundle) exists and sets getBridge().getWebView().getSettings().setTextZoom(85)
 *
 * Safe to run repeatedly; operation is idempotent.
 */
import fs from 'fs';
import path from 'path';

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

const mobileDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const repoRoot = path.resolve(mobileDir, '..');

const capConfigPath = path.join(mobileDir, 'capacitor.config.json');
if (!fs.existsSync(capConfigPath)) {
  console.error('[patch-android-fontscale] capacitor.config.json not found');
  process.exit(0);
}

const cap = readJSON(capConfigPath);
const appId = String(cap.appId || '').trim();
if (!appId) {
  console.error('[patch-android-fontscale] appId missing in capacitor.config.json');
  process.exit(0);
}

const javaPkgPath = appId.replace(/\./g, '/');
const mainActivityPath = path.join(mobileDir, 'android', 'app', 'src', 'main', 'java', javaPkgPath, 'MainActivity.java');

if (!fs.existsSync(mainActivityPath)) {
  console.log('[patch-android-fontscale] MainActivity.java not found. Generate Android project first (npm run android:add).');
  process.exit(0);
}

let src = fs.readFileSync(mainActivityPath, 'utf8');

// Ensure required imports
if (!/import\s+android\.os\.Bundle;/.test(src)) {
  src = src.replace(/(package\s+[^;]+;\s*)/m, `$1\nimport android.os.Bundle;\n`);
}
if (!/import\s+android\.webkit\.WebView;/.test(src)) {
  src = src.replace(/(package\s+[^;]+;\s*(?:\n.*?)*?)(import\s+android\.os\.Bundle;[^]*?;)/m, `$1$2\nimport android.webkit.WebView;\n`);
}

// Ensure onCreate override that sets text zoom
if (!/void\s+onCreate\s*\(\s*Bundle\s+savedInstanceState\s*\)/.test(src)) {
  // Insert onCreate before class closing bracket
  src = src.replace(/(public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{)/, `$1\n    @Override\n    protected void onCreate(Bundle savedInstanceState) {\n        super.onCreate(savedInstanceState);\n        try {\n            WebView wv = getBridge().getWebView();\n            if (wv != null && wv.getSettings() != null) {\n                wv.getSettings().setTextZoom(85); // 85% font scale\n            }\n        } catch (Throwable t) { /* ignore */ }\n    }\n\n`);
} else {
  // Update existing onCreate to ensure text zoom is set
  if (!/getWebView\(\)\.getSettings\(\)\.setTextZoom\(85\)/.test(src)) {
    src = src.replace(/(protected\s+void\s+onCreate\s*\(\s*Bundle\s+savedInstanceState\s*\)\s*\{[^]*?super\.onCreate\([^\)]*\);)/, `$1\n        try {\n            WebView wv = getBridge().getWebView();\n            if (wv != null && wv.getSettings() != null) {\n                wv.getSettings().setTextZoom(85);\n            }\n        } catch (Throwable t) { /* ignore */ }`);
  }
}

fs.writeFileSync(mainActivityPath, src, 'utf8');
console.log('[patch-android-fontscale] Ensured WebView text zoom set to 85% in MainActivity.java');

