Keep Bash for “system bootstrap + sudo + package install + SELinux + users”

Use Node/TS only for “TermStation config generation / mutation” (where you already have configure-install.mjs)

Aggressively shrink install.sh by:

extracting templates to files,

consolidating command/logging helpers,

moving more of the JSON/text‑generation into the Node side.

Then, if you still hate Bash after that, you can replace the interactive menus with a Node CLI later.

Let me walk through a concrete clean‑up plan.

1. Responsibilities: draw a cleaner line

Right now:

install.sh does everything:

collects answers (menus),

installs OS deps (dnf, podman/docker, SELinux policy),

installs tools (gh, glab, tea, bun, AI CLIs),

manages users, SSH keys, sudoers,

writes Dockerfile, entrypoint, start scripts, ssh-config, gitconfig,

then calls configure-install.mjs.

configure-install.mjs only:

edits JSON config: config.json, users.json, templates.json.

That’s a decent separation, but the “config writer” responsibilities are scattered between Bash (heredocs) and Node (JSON mutation). I’d shift towards:

Bash does OS + file copy + calling Node.
Node/TS does “TermStation configuration as data”.

Concretely:

Let Bash keep:

create_service_user

install_system_packages, install_selinux_policy

install_forge_clis, install_bun, install_ai_tools

setup_ssh_key, configure_user_shell_access

create_directories

install_termstation (copy repo into /opt/termstation)

Move to Node (either expanding configure-install.mjs or adding siblings):

create_config_files
(ssh-config + gitconfig content can be produced from a config object, not giant heredocs)

generate_dockerfile

create_start_scripts

maybe even “optional deps” config (e.g. path to pty-to-html) but keep the actual build in Bash.

Then install.sh becomes:

# pseudocode
collect_answers()      # menus, prompts
install_os_bits()      # dnf, podman, users, selinux
copy_repo_to_opt()
run_node_configurator  # writes JSON, start scripts, Dockerfile, config files
maybe_build_container
print_completion


That alone will make both files easier to reason about: Bash = side effects on the system; Node = config templates.

2. mjs vs TypeScript vs “leave it”
For configure-install.mjs

I’d evolve this into:

Internal TS module with a small CLI wrapper:

backend/scripts/configure-install.ts → compiled to configure-install.mjs

Export reusable pieces:

export interface InstallArgs { /* all these flags, typed */ }
export function updateConfigFiles(args: InstallArgs): void;
export function generateStartScripts(args: InstallArgs): void;
export function generateDockerfile(args: InstallArgs): void;


Keep the runtime dependency the same: you still ship the compiled .mjs so the installer only requires Node, not ts-node or anything fancy.

Benefits:

Types for config.forges.GitHub, config.session_history, etc.

Easier to extend while avoiding “oops, undefined path” bugs.

You get to reuse the same code later for a “reconfigure” CLI (e.g. node configure-install.mjs --config-dir ... --frontend-port 1234 without re-running the whole installer).

For install.sh itself

Personally, I would not try to move the OS bootstrap steps (dnf, SELinux, useradd, sudoers) into Node as v1:

You’d have to handle:

running under sudo vs calling sudo from Node,

TTY/interactive prompts through Node (doable, but more moving parts),

bootstrapping Node itself (catch-22: you need Node to install Node).

A better incremental path if you really want a Node installer eventually:

Keep install.sh as the “bootstrapper”:

Ensure Node is installed (dnf install nodejs).

Then exec a Node CLI for the interactive wizard and configuration:

node backend/scripts/install.mjs


Let that Node CLI:

handle prompts (using enquirer/prompts),

write an install-plan.json,

and either:

call out to Bash scripts for rooty stuff (e.g. install-os.sh), or

run commands via child_process.spawn('sudo', ...) with the same logging story.

But that’s definitely “version 2” work, not a small cleanup.

tl;dr:
Short term: TS only for the config writer, compiled to .mjs.
Long term: optional full Node CLI if this becomes a productized installer.

3. Consolidate command + logging in Bash

You already have:

log_cmd

log_output

run_cmd

run_sudo

run_as_service_user

run_as_service_user_interactive

These all do basically the same thing with small permutations. I’d replace them with a single generic runner, so every step logs uniformly.

Example pattern:

run() {
    local use_sudo=0 as_user="" interactive=0
    # simple flag parser
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --sudo)       use_sudo=1; shift ;;
            --user)       as_user="$2"; shift 2 ;;
            --interactive)interactive=1; shift ;;
            --) shift; break ;;
            *)  break ;;
        esac
    done

    local cmd=( "$@" )
    local prefix=""
    if [[ -n "$as_user" ]]; then
        prefix=(sudo -u "$as_user" -i)
    elif [[ $use_sudo -eq 1 ]]; then
        prefix=(sudo)
    fi

    # Logging
    log_cmd "${prefix[@]} ${cmd[*]}"

    if [[ $interactive -eq 1 ]]; then
        "${prefix[@]}" "${cmd[@]}"
        local rc=$?
        [[ -n "$INSTALL_LOG" ]] && \
          echo "[$(date '+%F %T')] EXIT: $rc" >> "$INSTALL_LOG"
        return $rc
    else
        local out rc=0
        out=$("${prefix[@]}" "${cmd[@]}" 2>&1) || rc=$?
        [[ -n "$out" ]] && echo "$out" | log_output && echo "$out"
        [[ -n "$INSTALL_LOG" ]] && \
          echo "[$(date '+%F %T')] EXIT: $rc" >> "$INSTALL_LOG"
        return $rc
    fi
}


Then the rest of the script becomes much cleaner:

run --sudo dnf install -y git zip gcc-c++ nodejs ...
run --sudo --user "$SERVICE_USER" loginctl enable-linger "$(id -u "$SERVICE_USER")"
run --interactive --user "$SERVICE_USER" gh auth login


And your “die on failure” policy can either be:

global set -e (you already do), or

a tiny wrapper: run_or_die ....

This removes a lot of boilerplate and makes it obvious which commands run as root / service user / interactive.

4. Externalize templates instead of giant heredocs

Big win with low risk: move your huge heredocs out of install.sh and into template files:

install/templates/dockerfile.template

install/templates/entrypoint.sh.template

install/templates/ssh-config.template

install/templates/gitconfig.template

install/templates/selinux/termstation_socket.te

install/templates/backend-start.sh.template

install/templates/frontend-start.sh.template

Then in Bash or Node you just:

# Bash example using envsubst
envsubst < install/templates/backend-start.sh.template \
  | sudo tee "$INSTALL_DIR/backend/start.sh" > /dev/null
sudo chmod +x "$INSTALL_DIR/backend/start.sh"


Template snippets:

# backend-start.sh.template
#!/bin/bash
# TermStation Backend Start Script
# Generated by installer

export TERMSTATION_CONFIG_DIR="${CONFIG_DIR}"
export TERMSTATION_BACKEND_BIND_ADDRESS="${BIND_ADDRESS}"
export TERMSTATION_BACKEND_PORT="${BACKEND_PORT}"

cd "$(dirname "$0")"
exec npm start


That:

Shrinks install.sh drastically.

Makes it trivial to tweak the Dockerfile/entrypoint without touching the installer logic.

Plays nicely with a TS/Node config-writer: TS can also load these template files and perform variable substitution.

Later, if the TS side owns this, you can have:

const template = await fs.promises.readFile('templates/Dockerfile.template', 'utf8');
const rendered = template
  .replace(/@@FORGE_GITHUB@@/g, forgeGithubBlock)
  .replace(/@@TERM@@/g, 'xterm-256color');
// ...

5. Clean up configure-install.mjs itself

Even if you don’t jump to TS right away, some structural cleanup helps:

Split into modules:

config-files.js

updateConfig()

users.js

updateUsers()

templates.js

updateTemplates()

cli.js

arg parsing + printing summary + calling functions.

Replace manual arg parsing with a tiny helper or a micro‑lib (if you’re ok with one dependency):

// still no deps example
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unknown arg: ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[++i];
    args[name] = value;
  }
  return args;
}


or with yargs/commander if you prefer.

Wrap console.log logging similarly to Bash:

const log = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
};


If you move Dockerfile/start-script generation into this script, put them into pure functions that take a typed config object:

export function makeBackendStartScript(cfg: InstallArgs): string { ... }
export function makeDockerfile(cfg: InstallArgs): string { ... }


That makes the Node side easy to unit test, and simplifies future refactors (e.g. if you want a “reconfigure-only” command).

6. If you do eventually go full Node CLI

If you decide “Bash must die” later, here’s the shape I’d aim for:

backend/scripts/install/

types.ts – shared InstallConfig interface

questions.ts – interactive prompts

plan.ts – derive all file paths & actions from answers

os.ts – functions like ensurePackagesInstalled, createUser, installSelinuxPolicy using child_process.spawn

files.ts – config writers (JSON, Dockerfile, scripts)

cli.ts – main entrypoint, prints steps with the same log_step style.

You’d still probably ship a tiny install.sh wrapper that:

#!/bin/bash
set -euo pipefail

# minimal bootstrap: ensure node + podman packages
if ! command -v node >/dev/null; then
  sudo dnf install -y nodejs
fi

node backend/scripts/install/cli.mjs "$@"


So the outward UX doesn’t change, but the core logic is all typed JS/TS.

Summary / concrete recommendation

If I were refactoring this in stages, I’d:

Right now

Consolidate all the command/logging helpers into a single run function.

Move Dockerfile, entrypoint, start scripts, SELinux policy file, ssh-config/gitconfig out into templates.

Keep configure-install.mjs but clean up its structure a bit.

Next

Upgrade configure-install.mjs into a TS module + compiled JS, and let it also generate the start scripts / Dockerfile / config files instead of Bash doing that.

Later / optional

Add a Node-based interactive installer that replaces the Bash menus, while Bash is only a thin bootstrap wrapper that ensures Node exists and delegates.

That path gives you a cleaner, testable configuration layer (in TS), a much shorter and more maintainable shell installer, and a migration route to “all in Node” if you eventually want that—without a giant risky rewrite right now.

