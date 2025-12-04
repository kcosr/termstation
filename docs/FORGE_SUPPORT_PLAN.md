# Forge Support Plan

## Overview

Add first-class support for multiple code forges (GitHub, GitLab, Gitea, etc.) to the template system. This allows templates to use forge-agnostic variables like `{FORGE_CLONE_URL}` instead of hardcoding URLs, while centralizing forge configuration in `config.json`.

## Goals

1. Support multiple forges simultaneously (gitea, github, gitlab, etc.)
2. Support SSH and HTTPS clone protocols per forge
3. Allow users to type full URLs or org/repo format in repo input
4. Auto-normalize repo URLs to org/repo format
5. Maintain backward compatibility with existing templates
6. Keep existing pre_commands/merge logic unchanged

---

## Configuration Schema

### New `forges` section in config.json

```json
{
  "forges": {
    "gitea": {
      "type": "gitea",
      "host": "gitea",
      "ssh_url": "git@gitea:{repo}",
      "https_url": "https://gitea/{repo}",
      "default_protocol": "https",
      "repo_pattern": "^(?:https?://gitea/|git@gitea:|)([^/]+/[^/\\.]+?)(?:\\.git)?$",
      "list_repos": "tea repo ls --login tsagent --output simple | awk '{print $1\"/\"$2}'",
      "list_branches": "tea branches --repo {repo} --output simple --login tsagent | egrep -v 'name.*protected' | awk '{print $1}'",
      "issue_url": "https://gitea/{repo}/issues/{issue_id}",
      "repo_url": "https://gitea/{repo}"
    },
    "github": {
      "type": "github",
      "host": "github.com",
      "ssh_url": "git@github.com:{repo}",
      "https_url": "https://github.com/{repo}",
      "default_protocol": "ssh",
      "repo_pattern": "^(?:https?://github\\.com/|git@github\\.com:|)([^/]+/[^/\\.]+?)(?:\\.git)?$",
      "list_repos": null,
      "list_branches": "gh api repos/{repo}/branches --jq '.[].name'",
      "issue_url": "https://github.com/{repo}/issues/{issue_id}",
      "repo_url": "https://github.com/{repo}"
    },
    "gitlab": {
      "type": "gitlab",
      "host": "gitlab",
      "ssh_url": "git@gitlab:{repo}",
      "https_url": "https://gitlab/{repo}",
      "default_protocol": "ssh",
      "repo_pattern": "^(?:https?://gitlab/|git@gitlab:|)(.+?)(?:\\.git)?$",
      "list_repos": "glab repo list --all | awk '{print $1}' | sort",
      "list_branches": "glab api projects/$(echo '{repo}' | sed 's/\\//%2F/g')/repository/branches --jq '.[].name'",
      "issue_url": "https://gitlab/{repo}/-/issues/{issue_id}",
      "repo_url": "https://gitlab/{repo}"
    }
  },
  "default_forge": "gitea"
}
```

### Forge Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Forge type identifier (gitea, github, gitlab, forgejo) |
| `host` | string | Yes | Hostname for the forge |
| `ssh_url` | string | Yes | SSH clone URL template with `{repo}` placeholder |
| `https_url` | string | Yes | HTTPS clone URL template with `{repo}` placeholder |
| `default_protocol` | string | Yes | Default protocol: "ssh" or "https" |
| `ssh_identity_file` | string | No | Optional SSH identity file path used by daemon-run forge commands (e.g. list_repos/list_branches) |
| `repo_pattern` | string | No | Regex to extract org/repo from full URLs. Capture group 1 = normalized repo |
| `list_repos` | string | No | Command to list repositories. If null/missing, repo is free-text input |
| `list_branches` | string | No | Command to list branches. `{repo}` is substituted before execution |
| `issue_url` | string | No | URL template for issues with `{repo}` and `{issue_id}` placeholders |
| `repo_url` | string | No | URL template for repo web view with `{repo}` placeholder |

---

## Template Variables

When a template is processed with a forge selected, these variables are injected:

| Variable | Description | Example (gitlab, ssh, repo=devtools/termstation) |
|----------|-------------|--------------------------------------------------|
| `{FORGE}` | Selected forge name | `gitlab` |
| `{FORGE_TYPE}` | Forge type | `gitlab` |
| `{FORGE_HOST}` | Forge hostname | `gitlab` |
| `{FORGE_CLONE_URL}` | Resolved clone URL | `git@gitlab:devtools/termstation` |
| `{FORGE_REPO_URL}` | Web URL to repo | `https://gitlab/devtools/termstation` |
| `{FORGE_ISSUE_URL}` | Issue URL (if issue_id provided) | `https://gitlab/devtools/termstation/-/issues/123` |
| `{DEFAULT_FORGE}` | Config's default_forge value | `gitea` |

---

## Parameter Changes

### New parameter options_source: "forges"

Lists all configured forge names for selection:

```json
{
  "name": "forge",
  "label": "Forge",
  "type": "select",
  "options_source": "forges",
  "required": false,
  "display": false
}
```

**Note:** No `default` is specified here. Parameter defaults are not macro-expanded, so we cannot use `"{DEFAULT_FORGE}"`. Instead, the backend logic uses `variables.forge || config.DEFAULT_FORGE` to fall back to the configured default.

### New parameter options_source: "forge"

Executes a command from the selected forge's config:

```json
{
  "name": "repo",
  "label": "Repository",
  "type": "select",
  "options_source": "forge",
  "options_forge_key": "list_repos",
  "depends_on": ["forge"],
  "strict_options": false
}
```

- `options_forge_key`: Which forge config field contains the command
- `strict_options: false`: Allows typing custom values even when dropdown has options

### Behavior when list_repos is null/missing

- Backend returns empty options array
- Frontend renders as text input (existing behavior for empty options with strict_options: false)
- User types org/repo or full URL

---

## Repo Normalization

### Input normalization flow

1. User enters repo value (dropdown selection or typed)
2. Before template processing, normalize the value:

```javascript
function normalizeRepo(repoInput, forgeConfig) {
  if (!repoInput) return '';

  // If forge has a pattern, try to extract org/repo
  if (forgeConfig.repo_pattern) {
    const match = repoInput.match(new RegExp(forgeConfig.repo_pattern));
    if (match && match[1]) {
      return match[1];
    }
  }

  // Return as-is if no pattern or no match
  return repoInput;
}
```

### Example normalizations

| Input | Forge | Normalized |
|-------|-------|------------|
| `https://github.com/anthropics/claude-code` | github | `anthropics/claude-code` |
| `git@github.com:anthropics/claude-code.git` | github | `anthropics/claude-code` |
| `anthropics/claude-code` | github | `anthropics/claude-code` |
| `https://gitlab/devtools/termstation` | gitlab | `devtools/termstation` |
| `git@gitlab:group/subgroup/repo.git` | gitlab | `group/subgroup/repo` |

---

## Template Example

### Before (hardcoded gitea)

```json
{
  "id": "ai-assistant-base",
  "pre_commands": [
    "if [ -n \"{repo}\" ]; then echo Cloning {repo}; mkdir -p \"$(dirname \"{repo}\")\"; git clone https://gitea/{repo} \"{repo}\"; fi",
    "if [ -n \"{branch}\" ] && [ -n \"{repo}\" ]; then git -C \"{repo}\" fetch origin {branch} || true; git -C \"{repo}\" checkout -B {branch} origin/{branch} 2>/dev/null || git -C \"{repo}\" checkout {branch} || true; fi",
    "if [ -n \"{repo}\" ]; then echo \"cd {repo}\"; cd \"{repo}\"; fi"
  ],
  "parameters": [
    {
      "name": "repo",
      "type": "select",
      "options_source": "command",
      "command": "tea repo ls --login tsagent --output simple | awk '{print $1\"/\"$2}'"
    }
  ],
  "links": [
    { "url": "https://gitea/{repo}/issues/{issue_id}", "name": "#{issue_id}" }
  ]
}
```

### After (forge-agnostic)

```json
{
  "id": "ai-assistant-base",
  "pre_commands": [
    "if [ -n \"{repo}\" ]; then echo Cloning {repo}; mkdir -p \"$(dirname \"{repo}\")\"; git clone {FORGE_CLONE_URL} \"{repo}\"; fi",
    "if [ -n \"{branch}\" ] && [ -n \"{repo}\" ]; then git -C \"{repo}\" fetch origin {branch} || true; git -C \"{repo}\" checkout -B {branch} origin/{branch} 2>/dev/null || git -C \"{repo}\" checkout {branch} || true; fi",
    "if [ -n \"{repo}\" ]; then echo \"cd {repo}\"; cd \"{repo}\"; fi"
  ],
  "fork_pre_commands": [
    "if [ -n \"$SESSION_WORKSPACE_DIR\" ]; then cd \"$SESSION_WORKSPACE_DIR\"; elif [ -n \"{session_workspace_dir}\" ]; then cd \"{session_workspace_dir}\"; fi",
    "if [ -n \"{repo}\" ]; then cd \"{repo}\"; fi"
  ],
  "parameters": [
    {
      "name": "forge",
      "label": "Forge",
      "type": "select",
      "options_source": "forges",
      "display": false
    },
    {
      "name": "clone_protocol",
      "label": "Protocol",
      "type": "select",
      "options": [
        {"value": "", "label": "Default"},
        {"value": "ssh", "label": "SSH"},
        {"value": "https", "label": "HTTPS"}
      ],
      "default": "",
      "display": false
    },
    {
      "name": "repo",
      "label": "Repository",
      "type": "select",
      "options_source": "forge",
      "options_forge_key": "list_repos",
      "depends_on": ["forge"],
      "strict_options": false
    },
    {
      "name": "branch",
      "label": "Branch",
      "type": "select",
      "options_source": "forge",
      "options_forge_key": "list_branches",
      "depends_on": ["forge", "repo"]
    }
  ],
  "links": [
    { "url": "{FORGE_ISSUE_URL}", "name": "#{issue_id}", "skip_if_unresolved": true }
  ],
  "env_vars": {
    "REPO": "{repo}",
    "BRANCH": "{branch}",
    "FORGE": "{FORGE}",
    "FORGE_HOST": "{FORGE_HOST}"
  }
}
```

---

## Implementation Changes

### 1. Config loading (backend/config-loader.js)

In the `Config` class constructor:

```javascript
// Parse forge configuration
this.FORGES = configData.forges || {};
this.DEFAULT_FORGE = configData.default_forge || '';

// Validate: default_forge must exist in FORGES if specified
if (this.DEFAULT_FORGE && !this.FORGES[this.DEFAULT_FORGE]) {
  console.warn(`[Config] default_forge "${this.DEFAULT_FORGE}" not found in forges`);
}

// Validate each forge has required fields
for (const [name, forge] of Object.entries(this.FORGES)) {
  const required = ['type', 'host', 'ssh_url', 'https_url', 'default_protocol'];
  for (const field of required) {
    if (!forge[field]) {
      console.warn(`[Config] forge "${name}" missing required field: ${field}`);
    }
  }
}

// Inject DEFAULT_FORGE into TEMPLATE_VARS for use in links/env_vars
this.TEMPLATE_VARS = {
  ...(configData.template_vars || {}),
  DEFAULT_FORGE: this.DEFAULT_FORGE
};
```

### 2. Config schema (backend/config/*.json)

- Add `forges` object to config files
- Add `default_forge` string

### 3. Template loader (backend/template-loader.js)

In `processTemplate()`, before text processing:

```javascript
// Resolve forge configuration
const forgeName = variables.forge || config.default_forge;
const forgeConfig = config.forges?.[forgeName];

if (forgeConfig) {
  // Normalize repo input
  const normalizedRepo = this._normalizeRepo(variables.repo, forgeConfig);
  variables.repo = normalizedRepo;

  // Determine protocol
  const protocol = variables.clone_protocol || forgeConfig.default_protocol || 'https';
  const cloneUrlTemplate = protocol === 'ssh' ? forgeConfig.ssh_url : forgeConfig.https_url;

  // Inject forge variables
  mergedVars.FORGE = forgeName;
  mergedVars.FORGE_TYPE = forgeConfig.type;
  mergedVars.FORGE_HOST = forgeConfig.host;
  mergedVars.FORGE_CLONE_URL = cloneUrlTemplate.replace('{repo}', normalizedRepo);
  mergedVars.FORGE_REPO_URL = forgeConfig.repo_url?.replace('{repo}', normalizedRepo) || '';
  mergedVars.FORGE_ISSUE_URL = forgeConfig.issue_url
    ?.replace('{repo}', normalizedRepo)
    ?.replace('{issue_id}', variables.issue_id || '') || '';
}

// Also inject DEFAULT_FORGE for parameter defaults
mergedVars.DEFAULT_FORGE = config.default_forge || '';
```

### 4. Parameter options (backend/template-loader.js - getParameterOptions)

Handle new options sources. Note: `getParameterOptions` is synchronous (uses `execSync`), so we match that pattern:

```javascript
// In TemplateLoader.getParameterOptions, after computing `source`:

// options_source: "forges" - list forge names
if (source === 'forges') {
  const forgeNames = Object.keys(config.FORGES || {});
  const options = forgeNames.map(name => ({ value: name, label: name }));
  return { options };
}

// options_source: "forge" - run command from forge config
if (source === 'forge') {
  const mergedVars = { ...(config.TEMPLATE_VARS || {}), ...(variables || {}) };
  const forgeName = mergedVars.forge || config.DEFAULT_FORGE;
  const forgeConfig = (config.FORGES || {})[forgeName];
  const key = parameter.options_forge_key || 'list_repos';
  const cmdTemplate = forgeConfig?.[key];

  if (!cmdTemplate) {
    // No command configured -> empty options -> frontend falls back to free-text
    return { options: [] };
  }

  // Substitute {var} placeholders (same pattern as existing command options)
  let command = String(cmdTemplate);
  for (const [k, v] of Object.entries(mergedVars)) {
    command = command.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v || ''));
  }

  try {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(mergedVars)) {
      env[k] = String(v ?? '');
      env[k.toUpperCase()] = String(v ?? '');
    }
    const output = execSync(command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
      env
    });
    const lines = String(output || '').split('\n').filter(line => line.trim() !== '');
    const options = lines.map(line => ({ value: line.trim(), label: line.trim() }));
    return { options };
  } catch (e) {
    console.error(`[TemplateLoader] forge options command failed: ${e.message}`);
    return { options: [] };
  }
}
```

Also in `CommandTemplate.toDict`, mark forge-based parameters as having dynamic options:

```javascript
if (param.options_source === 'forges' || param.options_source === 'forge') {
  processedParam.has_dynamic_options = true;
}
```

### 5. API endpoint for forges list

New endpoint `GET /api/forges`:

```javascript
router.get('/forges', (req, res) => {
  const forges = Object.entries(config.forges || {}).map(([name, cfg]) => ({
    name,
    type: cfg.type,
    host: cfg.host,
    has_list_repos: !!cfg.list_repos
  }));
  res.json({ forges, default_forge: config.default_forge });
});
```

### 6. Tests

Add tests for:
- **Config validation**: Invalid/missing default_forge, missing required forge fields
- **Forge variable injection**: Correct FORGE_* variables populated in mergedVars
- **Repo normalization**: Various URL formats (https, ssh, raw org/repo, subgroups)
- **Protocol selection**: SSH vs HTTPS based on clone_protocol param or forge default
- **Parameter options**: `options_source: "forges"` and `"forge"` return expected values
- **Link resolution**: `{FORGE_ISSUE_URL}` with and without issue_id, verify skip_if_unresolved works
- **Backward compatibility**: Templates without forge variables unchanged

---

## Backward Compatibility

- Templates without `{forge}` parameter work unchanged
- Hardcoded URLs in pre_commands continue to work
- Existing `options_source: "command"` still works
- `strict_options` defaults to current behavior
- Can migrate templates incrementally

---

## Review Feedback Applied

Based on Codex review (2024-11-30):

1. **Fixed default forge handling**: Removed `"default": "{DEFAULT_FORGE}"` from forge parameter since parameter defaults aren't macro-expanded. Backend uses `variables.forge || config.DEFAULT_FORGE` fallback instead.

2. **Added config-loader.js changes**: Explicit parsing of `forges` and `default_forge` with validation.

3. **Synchronous parameter options**: Implementation uses `execSync` to match existing `getParameterOptions` pattern.

4. **Added comprehensive test list**: Config validation, protocol selection, link resolution with skip_if_unresolved, backward compatibility.

5. **Keep branch strict_options default**: Only `repo` uses `strict_options: false` for URL input flexibility.

---

## Future Enhancements (Not in scope)

- Auto-detect forge from pasted URL
- Per-user/group forge restrictions
- Credential configuration per forge
- First-class `repository` property that auto-generates pre_commands
