#!/usr/bin/env node
/**
 * Patches the generated Android project to trust user-installed CAs and
 * allow self-signed certificates via Android Network Security Config.
 *
 * - Adds android:networkSecurityConfig to AndroidManifest.xml
 * - Writes res/xml/network_security_config.xml trusting system + user CAs
 *
 * Note: For truly self-signed endpoints, install your CA on the device
 * or replace trust anchors with a pinned cert in res/raw and reference it.
 */
import fs from 'fs';
import path from 'path';

const mobileDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const androidMain = path.resolve(mobileDir, 'android', 'app', 'src', 'main');
const manifestPath = path.join(androidMain, 'AndroidManifest.xml');
const xmlDir = path.join(androidMain, 'res', 'xml');
const xmlPath = path.join(xmlDir, 'network_security_config.xml');

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

if (!exists(manifestPath)) {
  console.log('[patch-android-security] Android project not found. Run: npm run android:add');
  process.exit(0);
}

// Ensure res/xml directory exists
fs.mkdirSync(xmlDir, { recursive: true });

// Write the network_security_config.xml
const xml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Trust system and user-installed CAs -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
    <!-- Explicit domain config for 'pc' host used by API; allow cleartext HTTP if configured -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">pc</domain>
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </domain-config>
</network-security-config>
`;
fs.writeFileSync(xmlPath, xml, 'utf8');
console.log(`[patch-android-security] Wrote ${path.relative(process.cwd(), xmlPath)}`);

// Patch AndroidManifest.xml to reference the security config and allow cleartext
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!/android:networkSecurityConfig=/.test(manifest)) {
  manifest = manifest.replace(
    /(\<application\b)([^>]*)(\>)/,
    (m, a, b, c) => `${a}${b} android:networkSecurityConfig=\"@xml/network_security_config\"${c}`
  );
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log('[patch-android-security] Updated AndroidManifest.xml with networkSecurityConfig');
} else {
  console.log('[patch-android-security] AndroidManifest.xml already references networkSecurityConfig');
}

// Ensure usesCleartextTraffic is enabled globally (domain-specific allow also present)
manifest = fs.readFileSync(manifestPath, 'utf8');
if (!/android:usesCleartextTraffic=/.test(manifest)) {
  manifest = manifest.replace(
    /(\<application\b)([^>]*)(\>)/,
    (m, a, b, c) => `${a}${b} android:usesCleartextTraffic=\"true\"${c}`
  );
  fs.writeFileSync(manifestPath, manifest, 'utf8');
  console.log('[patch-android-security] Enabled android:usesCleartextTraffic=\"true\"');
}
