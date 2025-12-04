#!/usr/bin/env node
// Configure TermStation installation by updating config files based on installer settings.
//
// Usage:
//   node scripts/configure-install.mjs \
//     --config-dir ~/.config/termstation \
//     --data-dir ~/.local/share/termstation \
//     --bind-address 127.0.0.1 \
//     --backend-port 6624 \
//     --frontend-port 6625 \
//     --service-user termstation \
//     --ssh-key-name termstation \
//     --enable-github true \
//     --enable-gitlab false \
//     --enable-gitea false

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { hostname as osHostname } from 'os';

function printUsage() {
  console.log(`Configure TermStation installation

Usage:
  node scripts/configure-install.mjs [options]

Options:
  --config-dir <path>       Config directory (e.g., ~/.config/termstation)
  --data-dir <path>         Data directory (e.g., ~/.local/share/termstation)
  --bind-address <addr>     Bind address (127.0.0.1 or 0.0.0.0)
  --backend-port <port>     Backend port (default: 6624)
  --frontend-port <port>    Frontend port (default: 6625)
  --service-user <user>     Service user name
  --shell-user <user>       User who runs shells (for bash template)
  --termstation-login <user> Username for TermStation web UI login
  --ssh-key-path <path>     Path to SSH private key for forge authentication
  --ssh-key-name <name>     Name of the SSH key file (e.g., termstation, id_ed25519)
  --use-ssh-config <bool>   Whether to bind mount ~/.ssh/config (true/false)
  --bash-shell-mode <mode>  Bash template mode: "self", "service", or "none"
  --enable-github <bool>    Enable GitHub forge (true/false)
  --enable-gitlab <bool>    Enable GitLab forge (true/false)
  --enable-gitea <bool>     Enable Gitea forge (true/false)
  --mount-gh-config <bool>  Bind mount GitHub CLI config (~/.config/gh)
  --mount-glab-config <bool> Bind mount GitLab CLI config (~/.config/glab-cli)
  --mount-tea-config <bool> Bind mount Gitea CLI config (~/.config/tea)
  --container-runtime <rt>  Container runtime (podman or docker)
  --scripts-dir <path>      Path to scripts directory (for pty-to-html)
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--config-dir') args.configDir = next();
    else if (a === '--data-dir') args.dataDir = next();
    else if (a === '--bind-address') args.bindAddress = next();
    else if (a === '--backend-port') args.backendPort = parseInt(next(), 10);
    else if (a === '--frontend-port') args.frontendPort = parseInt(next(), 10);
    else if (a === '--service-user') args.serviceUser = next();
    else if (a === '--shell-user') args.shellUser = next();
    else if (a === '--termstation-login') args.termstationLogin = next();
    else if (a === '--ssh-key-path') args.sshKeyPath = next();
    else if (a === '--ssh-key-name') args.sshKeyName = next();
    else if (a === '--use-ssh-config') args.useSshConfig = next() === 'true';
    else if (a === '--bash-shell-mode') args.bashShellMode = next();
    else if (a === '--enable-github') args.enableGithub = next() === 'true';
    else if (a === '--enable-gitlab') args.enableGitlab = next() === 'true';
    else if (a === '--enable-gitea') args.enableGitea = next() === 'true';
    else if (a === '--mount-gh-config') args.mountGhConfig = next() === 'true';
    else if (a === '--mount-glab-config') args.mountGlabConfig = next() === 'true';
    else if (a === '--mount-tea-config') args.mountTeaConfig = next() === 'true';
    else if (a === '--container-runtime') args.containerRuntime = next();
    else if (a === '--scripts-dir') args.scriptsDir = next();
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function loadJson(path) {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Updated: ${path}`);
}

function resolvePublicHost(addr) {
  if (addr && addr !== '0.0.0.0') {
    return addr;
  }
  const envHost = process.env.TERMSTATION_PUBLIC_HOST;
  if (envHost && typeof envHost === 'string' && envHost.trim()) {
    return envHost.trim();
  }
  try {
    const hn = osHostname();
    if (hn && hn.trim()) {
      return hn.trim();
    }
  } catch {
    // ignore and fall through
  }
  return 'localhost';
}

function updateConfig(configPath, args) {
  const config = loadJson(configPath);

  // Update listener settings
  if (args.bindAddress !== undefined) {
    config.listeners.http.host = args.bindAddress;
  }
  if (args.backendPort !== undefined) {
    config.listeners.http.port = args.backendPort;
  }

  // Update default username
  if (args.serviceUser !== undefined) {
    config.default_username = args.serviceUser;
  }

  // Update data_dir to use XDG path
  if (args.dataDir !== undefined) {
    config.data_dir = args.dataDir;
  }

  // Update URLs based on bind address and ports
  if (args.bindAddress !== undefined || args.frontendPort !== undefined) {
    const addr = args.bindAddress || '127.0.0.1';
    const fePort = args.frontendPort || 6625;
    const host = resolvePublicHost(addr);
    config.sessions_base_url = `http://${host}:${fePort}`;
  }
  if (args.bindAddress !== undefined || args.backendPort !== undefined) {
    const addr = args.bindAddress || '127.0.0.1';
    const bePort = args.backendPort || 6624;
    const host = resolvePublicHost(addr);
    config.sessions_api_base_url = `http://${host}:${bePort}/api`;
  }

  // Update pty_to_html_path if scripts dir provided
  if (args.scriptsDir !== undefined) {
    config.session_history = config.session_history || {};
    config.session_history.pty_to_html_path = join(args.scriptsDir, 'pty-to-html');
  }

  // Update forge enabled status and SSH key path
  // sshKeyPath can be empty string to indicate "none" - remove the field
  if (config.forges) {
    if (config.forges.GitHub) {
      if (args.enableGithub !== undefined) {
        config.forges.GitHub.enabled = args.enableGithub;
      }
      if (args.sshKeyPath !== undefined) {
        if (args.sshKeyPath === '') {
          delete config.forges.GitHub.ssh_identity_file;
        } else {
          config.forges.GitHub.ssh_identity_file = args.sshKeyPath;
        }
      }
    }
    if (config.forges.GitLab) {
      if (args.enableGitlab !== undefined) {
        config.forges.GitLab.enabled = args.enableGitlab;
      }
      if (args.sshKeyPath !== undefined) {
        if (args.sshKeyPath === '') {
          delete config.forges.GitLab.ssh_identity_file;
        } else {
          config.forges.GitLab.ssh_identity_file = args.sshKeyPath;
        }
      }
    }
    if (config.forges.Gitea) {
      if (args.enableGitea !== undefined) {
        config.forges.Gitea.enabled = args.enableGitea;
      }
      if (args.sshKeyPath !== undefined) {
        if (args.sshKeyPath === '') {
          delete config.forges.Gitea.ssh_identity_file;
        } else {
          config.forges.Gitea.ssh_identity_file = args.sshKeyPath;
        }
      }
    }
  }

  // Update container runtime
  if (args.containerRuntime !== undefined) {
    config.containers = config.containers || {};
    config.containers.runtime = args.containerRuntime;
  }

  saveJson(configPath, config);
}

function updateUsers(usersPath, args) {
  if (!existsSync(usersPath)) {
    console.log(`Skipping users.json (not found): ${usersPath}`);
    return;
  }

  const users = loadJson(usersPath);

  if (args.termstationLogin === undefined) {
    saveJson(usersPath, users);
    return;
  }

  const login = args.termstationLogin;
  let updated = false;

  // Case 1: users.json is a plain array
  if (Array.isArray(users)) {
    const idx = users.findIndex(u => u && u.username === 'termstation');
    if (idx >= 0) {
      users[idx].username = login;
      updated = true;
    }
  }

  // Case 2: users.json is an object with a "users" array
  if (!updated && users && Array.isArray(users.users)) {
    const idx = users.users.findIndex(u => u && u.username === 'termstation');
    if (idx >= 0) {
      users.users[idx].username = login;
      updated = true;
    }
  }

  if (updated) {
    console.log(`Set TermStation login username to: ${login}`);
  } else {
    console.log('No termstation user entry found to update in users.json');
  }

  saveJson(usersPath, users);
}

function updateTemplates(templatesPath, args) {
  if (!existsSync(templatesPath)) {
    console.log(`Skipping templates.json (not found): ${templatesPath}`);
    return;
  }

  const templates = loadJson(templatesPath);

  // Find the ai-assistant-base template
  const baseTemplate = templates.templates?.find(t => t.id === 'ai-assistant-base');
  if (!baseTemplate) {
    console.log('Warning: ai-assistant-base template not found in templates.json');
    return;
  }

  // Update container_image based on runtime (podman needs localhost/ prefix)
  if (args.containerRuntime === 'podman') {
    // Add localhost/ prefix for podman if not already present
    if (baseTemplate.container_image && !baseTemplate.container_image.startsWith('localhost/')) {
      baseTemplate.container_image = `localhost/${baseTemplate.container_image}`;
      console.log(`Set container image to: ${baseTemplate.container_image} (podman requires localhost/ prefix)`);
    }
  } else if (args.containerRuntime === 'docker') {
    // Remove localhost/ prefix for docker if present
    if (baseTemplate.container_image && baseTemplate.container_image.startsWith('localhost/')) {
      baseTemplate.container_image = baseTemplate.container_image.replace('localhost/', '');
      console.log(`Set container image to: ${baseTemplate.container_image} (docker)`);
    }
  }

  // Ensure isolation_overrides and bind_mounts exist
  baseTemplate.isolation_overrides = baseTemplate.isolation_overrides || {};
  baseTemplate.isolation_overrides.bind_mounts = baseTemplate.isolation_overrides.bind_mounts || [];

  const bindMounts = baseTemplate.isolation_overrides.bind_mounts;

  // Remove any existing SSH key bind mounts (those pointing to .ssh/* with readonly, excluding config)
  for (let i = bindMounts.length - 1; i >= 0; i--) {
    const m = bindMounts[i];
    if (m.container_path?.includes('.ssh/') &&
        !m.container_path?.endsWith('/config') &&
        m.readonly === true) {
      bindMounts.splice(i, 1);
    }
  }

  // Remove any existing SSH config bind mount
  for (let i = bindMounts.length - 1; i >= 0; i--) {
    const m = bindMounts[i];
    if (m.container_path?.endsWith('.ssh/config') && m.readonly === true) {
      bindMounts.splice(i, 1);
    }
  }

  // Add SSH key bind mount if key name is provided (not empty)
  if (args.sshKeyName && args.sshKeyName !== '') {
    bindMounts.push({
      host_path: `$HOME/.ssh/${args.sshKeyName}`,
      container_path: `/workspace/.ssh/${args.sshKeyName}`,
      readonly: true
    });
    console.log(`Added SSH key bind mount for: ${args.sshKeyName}`);
  } else if (args.sshKeyName === '') {
    console.log('SSH key configuration skipped (none selected)');
  }

  // Add SSH config bind mount if enabled
  if (args.useSshConfig === true) {
    bindMounts.push({
      host_path: '$HOME/.ssh/config',
      container_path: '/workspace/.ssh/config',
      readonly: true
    });
    console.log('Added SSH config bind mount');
  } else if (args.useSshConfig === false) {
    console.log('SSH config bind mount skipped');
  }

  // Remove any existing forge CLI config bind mounts
  for (let i = bindMounts.length - 1; i >= 0; i--) {
    const m = bindMounts[i];
    if (m.host_path?.includes('.config/gh') ||
        m.host_path?.includes('.config/glab-cli') ||
        m.host_path?.includes('.config/tea')) {
      bindMounts.splice(i, 1);
    }
  }

  // Add GitHub CLI config bind mount if enabled
  if (args.mountGhConfig === true) {
    bindMounts.push({
      host_path: '$HOME/.config/gh',
      container_path: '/workspace/.config/gh',
      readonly: true
    });
    console.log('Added GitHub CLI config bind mount (~/.config/gh)');
  }

  // Add GitLab CLI config bind mount if enabled
  if (args.mountGlabConfig === true) {
    bindMounts.push({
      host_path: '$HOME/.config/glab-cli',
      container_path: '/workspace/.config/glab-cli',
      readonly: true
    });
    console.log('Added GitLab CLI config bind mount (~/.config/glab-cli)');
  }

  // Add Gitea CLI config bind mount if enabled
  if (args.mountTeaConfig === true) {
    bindMounts.push({
      host_path: '$HOME/.config/tea',
      container_path: '/workspace/.config/tea',
      readonly: true
    });
    console.log('Added Gitea CLI config bind mount (~/.config/tea)');
  }

  // Handle bash template based on mode
  if (args.bashShellMode) {
    const bashTemplate = templates.templates?.find(t => t.id === 'bash');

    if (args.bashShellMode === 'none') {
      // Remove the bash template entirely
      if (bashTemplate) {
        const idx = templates.templates.indexOf(bashTemplate);
        templates.templates.splice(idx, 1);
        console.log('Removed bash template');
      }
    } else if (bashTemplate) {
      // Update the user field based on mode
      if (args.bashShellMode === 'service') {
        bashTemplate.user = 'daemon_user';
        console.log('Set bash template user to daemon_user (service user)');
      } else if (args.bashShellMode === 'self' && args.shellUser) {
        bashTemplate.user = 'login_user';
        console.log(`Set bash template user to login_user (${args.shellUser})`);
      }
    }
  }

  saveJson(templatesPath, templates);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.configDir) {
    console.error('Error: --config-dir is required');
    printUsage();
    process.exit(2);
  }

  const configPath = join(args.configDir, 'config.json');
  const templatesPath = join(args.configDir, 'templates.json');
  // users.json is now in data_dir, not config_dir
  const usersPath = args.dataDir ? join(args.dataDir, 'users.json') : join(args.configDir, 'users.json');

  console.log('Configuring TermStation installation...');
  console.log(`  Config dir: ${args.configDir}`);
  if (args.dataDir) console.log(`  Data dir: ${args.dataDir}`);
  if (args.bindAddress) console.log(`  Bind address: ${args.bindAddress}`);
  if (args.backendPort) console.log(`  Backend port: ${args.backendPort}`);
  if (args.frontendPort) console.log(`  Frontend port: ${args.frontendPort}`);
  if (args.serviceUser) console.log(`  Service user: ${args.serviceUser}`);
  if (args.shellUser) console.log(`  Shell user: ${args.shellUser}`);
  if (args.termstationLogin) console.log(`  TermStation login: ${args.termstationLogin}`);
  if (args.sshKeyPath !== undefined) {
    console.log(`  SSH key path: ${args.sshKeyPath || '(none)'}`);
  }
  if (args.sshKeyName !== undefined) {
    console.log(`  SSH key name: ${args.sshKeyName || '(none)'}`);
  }
  if (args.useSshConfig !== undefined) {
    console.log(`  Use SSH config: ${args.useSshConfig}`);
  }
  if (args.bashShellMode) {
    console.log(`  Bash shell mode: ${args.bashShellMode}`);
  }
  if (args.containerRuntime) console.log(`  Container runtime: ${args.containerRuntime}`);
  if (args.scriptsDir) console.log(`  Scripts dir: ${args.scriptsDir}`);
  console.log(`  GitHub: ${args.enableGithub !== undefined ? args.enableGithub : 'unchanged'}`);
  console.log(`  GitLab: ${args.enableGitlab !== undefined ? args.enableGitlab : 'unchanged'}`);
  console.log(`  Gitea: ${args.enableGitea !== undefined ? args.enableGitea : 'unchanged'}`);
  if (args.mountGhConfig !== undefined) {
    console.log(`  Mount GitHub CLI config: ${args.mountGhConfig}`);
  }
  if (args.mountGlabConfig !== undefined) {
    console.log(`  Mount GitLab CLI config: ${args.mountGlabConfig}`);
  }
  if (args.mountTeaConfig !== undefined) {
    console.log(`  Mount Gitea CLI config: ${args.mountTeaConfig}`);
  }
  console.log('');

  updateConfig(configPath, args);
  updateUsers(usersPath, args);
  updateTemplates(templatesPath, args);

  console.log('\nConfiguration complete.');
}

main().catch(err => {
  console.error('Configuration failed:', err?.stack || err?.message || String(err));
  process.exit(1);
});
