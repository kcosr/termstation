import { test } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  createTestConfig,
  writeTestTemplates,
  cleanupTestConfig
} from './helpers/test-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_TEMPLATES_FIXTURE = join(
  __dirname,
  'config',
  'workspace-templates.json'
);

test('workspace templates stop_inputs wiring', () => {
  const fixturePath = WORKSPACE_TEMPLATES_FIXTURE;
  let fixtureRaw;
  try {
    fixtureRaw = readFileSync(fixturePath, 'utf8');
  } catch (e) {
    throw new Error(
      `Failed to read workspace templates fixture at ${fixturePath}: ${
        e?.message || e
      }`
    );
  }

  let fixture;
  try {
    fixture = JSON.parse(fixtureRaw);
  } catch (e) {
    throw new Error(
      `Failed to parse workspace templates fixture at ${fixturePath} as JSON: ${
        e?.message || e
      }`
    );
  }

  if (!fixture || !Array.isArray(fixture.templates)) {
    throw new Error(
      `${fixturePath} does not have a top-level "templates" array`
    );
  }

  const configDir = createTestConfig();
  try {
    writeTestTemplates(configDir, fixture.templates);
    const path = join(configDir, 'templates.json');

    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(`Failed to read ${path}: ${e?.message || e}`);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse ${path} as JSON: ${e?.message || e}`);
    }

    if (!data || !Array.isArray(data.templates)) {
      throw new Error(`${path} does not have a top-level "templates" array`);
    }

    const findTpl = (id) => data.templates.find((t) => t && t.id === id) || null;

    const base = findTpl('ai-assistant-base');
    if (!base) {
      throw new Error(`Template "ai-assistant-base" not found in ${path}`);
    }

    const basePrompts = Array.isArray(base.stop_inputs) ? base.stop_inputs : [];

    // Log base stop_inputs for debugging
    // eslint-disable-next-line no-console
    console.log(
      '[workspace-templates] ai-assistant-base.stop_inputs =',
      JSON.stringify(basePrompts)
    );

    const childIds = ['claude', 'opencode', 'codex', 'codex-termstation'];
    for (const id of childIds) {
      const tpl = findTpl(id);
      if (!tpl) continue;
      const prompts = Array.isArray(tpl.stop_inputs) ? tpl.stop_inputs : [];
      // eslint-disable-next-line no-console
      console.log(
        `[workspace-templates] ${id}.stop_inputs =`,
        JSON.stringify(prompts)
      );
      if (tpl.stop_inputs === null) {
        throw new Error(
          `Template "${id}" has stop_inputs: null in ${path}`
        );
      }
    }
  } finally {
    cleanupTestConfig(configDir);
  }
});
