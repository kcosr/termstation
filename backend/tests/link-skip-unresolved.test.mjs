// Tests for link skip_if_unresolved, whitespace-only values, and non-string values.
// Uses a dedicated test templates.json so behavior is isolated from real config.

import { beforeAll, afterAll, test } from 'vitest';
import { createTestConfig, writeTestTemplates, cleanupTestConfig } from './helpers/test-utils.mjs';

function assert(condition, label) {
  if (!condition) {
    throw new Error(label || 'Assertion failed');
  }
}

function getLink(processed, name) {
  return (processed.links || []).find(l => l && l.name === name);
}

let configDir;
let templateLoader;
let tpl;
let processText;

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;

  // Minimal test-only templates file mirroring backend/config/development/templates.json:test-links
  writeTestTemplates(configDir, [
    {
      id: 'test-links',
      name: 'Test Links',
      description: 'Test-only template for link/macro behavior',
      command: '/usr/bin/true',
      working_directory: '~',
      group: 'Tests',
      display: false,
      links: [
        {
          url: 'https://example.com/{a}/{b}',
          name: 'Multi Vars',
          skip_if_unresolved: true,
          show_active: false,
          show_inactive: false
        },
        {
          url: 'https://example.com/static',
          name: 'No Placeholders Skip',
          skip_if_unresolved: true,
          show_active: false,
          show_inactive: false
        },
        {
          url: 'https://example.com/{w}',
          name: 'W={w}',
          show_active: false,
          show_inactive: false
        },
        {
          url: 'https://example.com/static',
          name: 'N={x}',
          skip_if_unresolved: true,
          show_active: false,
          show_inactive: false
        },
        {
          url: 'https://example.com/{y}',
          name: 'Static Name',
          skip_if_unresolved: true,
          show_active: false,
          show_inactive: false
        },
        {
          url: 'https://example.com/{b}/end',
          name: 'B={b}',
          skip_if_unresolved: true,
          show_active: false,
          show_inactive: false
        },
        {
          url: 'https://example.com/{zero}',
          name: 'Z={zero}',
          skip_if_unresolved: true,
          show_active: false,
          show_inactive: false
        }
      ]
    }
  ]);

  ({ templateLoader } = await import('../template-loader.js'));
  ({ processText } = await import('../utils/template-text.js'));
  tpl = templateLoader.getTemplate('test-links');
});

afterAll(() => {
  try { templateLoader.cleanup?.(); } catch {}
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

test('link skip_if_unresolved, whitespace behavior, and non-string values', () => {
  if (!tpl) {
    throw new Error('Test template test-links not found');
  }

  // 1) Link with multiple vars (one resolved, one unresolved)
  {
    const out1 = tpl.processTemplate({ a: 'A' }); // b missing
    assert(!getLink(out1, 'Multi Vars'), 'multi-var link skipped when a or b unresolved');

    const out2 = tpl.processTemplate({ a: 'A', b: 'B' });
    const l2 = getLink(out2, 'Multi Vars');
    assert(l2 && l2.url.endsWith('/A/B'), 'multi-var link present when all resolved');
  }

  // 2) Link with skip_if_unresolved: true but no placeholders
  {
    const out = tpl.processTemplate({});
    const l = getLink(out, 'No Placeholders Skip');
    assert(!!l, 'no-placeholder link preserved even with skip_if_unresolved');
  }

  // 3) Whitespace-only values collapse to empty during substitution
  {
    const text = 'ID="{issue_id}"';
    const rendered = processText(text, { issue_id: '   ' });
    assert(rendered === 'ID=""', 'whitespace-only variable renders as empty string');

    const out = tpl.processTemplate({ w: '   ' });
    const l = getLink(out, 'W=');
    assert(l && l.url === 'https://example.com/' && l.name === 'W=', 'whitespace-only macro renders empty in links');
  }

  // 4) Non-string values: numbers vs booleans/objects
  {
    // number 0 should render and not be treated as unresolved
    const out0 = tpl.processTemplate({ zero: 0 });
    const l0 = getLink(out0, 'Z=0');
    assert(l0 && l0.url.endsWith('/0') && l0.name.endsWith('0'), 'number 0 retained in substitution and not skipped');

    // booleans should be treated as unresolved for links and render as empty in macros
    const outFalse = tpl.processTemplate({ b: false });
    assert(!getLink(outFalse, 'B={b}'), 'boolean false treated as unresolved for links');
    const outTrue = tpl.processTemplate({ b: true });
    assert(!getLink(outTrue, 'B={b}'), 'boolean true treated as unresolved for links');
  }

  // 5) Link name with unresolved var, url without (and vice versa)
  {
    const outNameOnly = tpl.processTemplate({});
    assert(!getLink(outNameOnly, 'N={x}'), 'unresolved var in name triggers skip');

    const outUrlOnly = tpl.processTemplate({});
    assert(!getLink(outUrlOnly, 'Static Name'), 'unresolved var in url triggers skip');
  }

  console.log('All link/unresolved tests passed');
});
