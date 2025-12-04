#!/usr/bin/env node
/**
 * Quick helper to fetch a session or history endpoint and summarize ANSI/OSC presence.
 * Usage: node tools/peek-history.js <url>
 */

const { URL } = require('node:url');

function summarize(text) {
  const m = (re) => (text.match(re) || []).length;
  const escCount = m(/\x1b/g);
  const belCount = m(/\x07/g);
  const stCount = m(/\x1b\\/g);
  const rgbCount = m(/rgb:[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}/g);
  const oscCount = m(/\x1b\](?:4|10|11|12|104|110|111|112);[^\x07\x1b]*(?:\x07|\x1b\\)/g);
  return { escCount, belCount, stCount, rgbCount, oscCount };
}

function hexPreview(text, max = 256) {
  const slice = text.slice(0, max);
  const bytes = Array.from(slice, ch => ch.charCodeAt(0));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
}

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('Usage: node tools/peek-history.js <url>');
    process.exit(1);
  }

  try {
    // Build request with optional basic auth from URL credentials
    const u = new URL(url);
    // Prefer raw text but accept JSON; backend may return either
    const headers = { 'Accept': 'text/plain, application/json;q=0.9, */*;q=0.8' };
    if (u.username || u.password) {
      const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      const token = Buffer.from(creds).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
      // Strip credentials from URL for the actual request
      u.username = '';
      u.password = '';
    }
    const res = await fetch(String(u), { headers });
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    let body;
    if (ctype.includes('application/json')) {
      body = await res.json();
    } else {
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
    }

    let text = '';
    if (typeof body?.output_history === 'string') {
      text = body.output_history;
    } else if (typeof body?.raw === 'string') {
      text = body.raw;
    } else if (typeof body === 'string') {
      text = body;
    }

    if (!text) {
      console.log('No text content found. Keys:', Object.keys(body || {}));
      process.exit(0);
    }

    const summary = summarize(text);
    console.log('Summary:', summary);
    console.log('Head hex:', hexPreview(text, 192));

    // Show first few rgb contexts
    const re = /rgb:[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}\/[0-9a-fA-F]{4}/g;
    let m, shown = 0;
    while ((m = re.exec(text)) && shown < 3) {
      const s = Math.max(0, m.index - 48);
      const e = Math.min(text.length, m.index + m[0].length + 48);
      console.log('Context', shown + 1, JSON.stringify(text.slice(s, e)));
      shown++;
    }
  } catch (e) {
    console.error('Fetch or parse failed:', e.message);
    process.exit(2);
  }
}

main();
