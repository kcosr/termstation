// Simple tests for conditional templating + includes + macros

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTestConfig, cleanupTestConfig } from './helpers/test-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let configDir;
let processText;

function assertEq(actual, expected, label) {
  expect(actual, label).toBe(expected);
}

beforeAll(async () => {
  configDir = createTestConfig();
  process.env.TERMSTATION_CONFIG_DIR = configDir;
  ({ processText } = await import('../utils/template-text.js'));
});

afterAll(() => {
  cleanupTestConfig(configDir);
  delete process.env.TERMSTATION_CONFIG_DIR;
});

describe('conditional templating and includes', () => {
  it('handles inline optional flags', () => {
    const tpl = 'claude{% if model nonempty %} --model={model}{% endif %}{% if model_reasoning_effort nonempty %} --config model_reasoning_effort="{model_reasoning_effort}"{% endif %} "{prompt}"';
    const vars1 = { model: 'gpt-5', model_reasoning_effort: 'high', prompt: 'hello' };
    const out1 = processText(tpl, vars1);
    assertEq(out1, 'claude --model=gpt-5 --config model_reasoning_effort="high" "hello"', 'inline flags present');

    const vars2 = { model: '', model_reasoning_effort: '', prompt: 'hello' };
    const out2 = processText(tpl, vars2);
    assertEq(out2, 'claude "hello"', 'inline flags omitted with tidy spaces');
  });

  it('expands conditional includes with nested conditionals', () => {
    const baseDirs = [join(__dirname, 'fixtures')];
    const tpl = '{% if model eq "gpt-5" %}{file:include-a.txt}{% elif model eq "gpt-5-codex" %}{file:include-b.txt}{% else %}Default: {model}{% endif %}';

    const outA = processText(tpl, { model: 'gpt-5', variant: 'alpha' }, { baseDirs });
    const expectA = 'Common text A.\nAlpha branch\nTail A.\n\n';
    assertEq(outA, expectA, 'include-a with nested conditional');

    const outB = processText(tpl, { model: 'gpt-5-codex', nested: 'yes' }, { baseDirs });
    const expectB = 'Common text B.\nNested: Y\nTail B.\n\n';
    assertEq(outB, expectB, 'include-b with nested conditional');

    const outDefault = processText(tpl, { model: 'other' }, { baseDirs });
    assertEq(outDefault, 'Default: other', 'else branch without include');
  });
});
