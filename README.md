# TermStation

![TermStation interface](https://github.com/kcosr/termstation-web/blob/main/docs/assets/termstation-interface.png)

## Pre-Alpha Warning

This is a pre-alpha release. Use at your own risk! Review this README and the following documents before proceeding with installation.

- https://termstation.dev/faq
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [INSTALL.md](INSTALL.md)
- [docs/README.md](docs/README.md) (legacy, needs updates)
- [docs/keyboard_shortcuts.md](docs/keyboard_shortcuts.md)

## Overview

TermStation is, at its core, a web-based terminal session manager that provides an API. It was created primarily to allow the developer access to his terminal sessions on multiple machines and to organize them in his preferred layout. Used regularly to manage agent CLIs, it does not have any knowledge of AI tools themselves. Integrations are built around templates where CLI commands and arguments are configured. It includes some features that extend further than basic terminal session management, including but not limited to:

- Template driven command definitions to drive GUI session creation forms
- Session and workspace-specific scratch pads
- Configurable code forges
- Launching commands in containers (e.g. agent CLIs)
- Generic PTY input API, used to provide agent-to-agent communication driven by prompting
- API for adding links to sessions and displaying them in the UI
- File generation with macros and includes, often used for .md file generation
- Reverse tunnel HTTP proxy for accessing web servers running in containers
- Multi-user support with RBAC and session sharing

## Requirements

### Backend
- **Operating System**: Ubuntu 22.04+ or Rocky Linux 10+ (other Linux distributions may work but are untested)
- **Node.js**: Version 22 or later
- **Container Runtime**: Docker (Ubuntu) or Podman (Rocky)

### Frontend
- **Web**: Any modern browser
- **Desktop**: Windows, macOS, Linux (Electron)
- **Mobile**: Android (Capacitor)

## Initial Installation

[INSTALL.md](INSTALL.md) provides instructions for running scripts to install on Rocky 10 and Ubuntu 24.04. The installation includes an opinionated configuration that is probably not a good fit for you. It is mostly configurable, primarily in templates.json, but you will need to ask Claude, Codex or the developer for help as documentation is not ready. The initial installation provides a basic demonstration of launching Claude, Codex and Cursor in a container, with wiring and prompting (AGENTS.md) in place to support agent-to-agent messaging.

## Configuration

Sample templates, Dockerfile, and markdown files installed by the installer are for demonstration purposes only. These are meant to be owned and maintained by you.

Configuration files are stored in `~/.termstation/config/` (or a custom location):

| File | Description |
|------|-------------|
| `config.json` | Main configuration (ports, bind address, forges) |
| `templates.json` | Session templates |
| `links.json` | Quick links for the UI |

User and group files are copied to the data directory (`~/.termstation/data/`) on first run and may be modified by TermStation at runtime:

| File | Description |
|------|-------------|
| `users.json` | User accounts |
| `groups.json` | User groups |

### Key Settings in config.json

| Key | Default | Description |
|-----|---------|-------------|
| `listeners.http.address` | 127.0.0.1 | HTTP bind address. Use 0.0.0.0 to expose externally. |
| `listeners.http.port` | 6624 | Backend HTTP port |
| `sessions.base_url` | http://localhost:6625 | Frontend URL |
| `containers.runtime` | podman | Container runtime (podman or docker) |

Enable code forges in the `forges` section. GitHub is enabled by default.

## Security

Exposing the frontend and backend services publicly is not recommended. While authentication is supported, it has not been hardened for exposure to untrusted networks. If you're running on a VPS, bind the service to localhost and access it through an SSH tunnel:

```
# default ports: backend=6624, frontend=6625
ssh -L 6624:localhost:6624 -L 6625:localhost:6625 <your-vps-ip>
```

## Known Issues

These are issues you're likely to encounter that may impact usability:

### Terminal Display
The terminal display can be janky and sometimes requires refreshing the app/page or clearing the terminal to reset, especially when switching between devices with different screen sizes (e.g., desktop to mobile).

### Container Cleanup
Containers are sometimes not shut down or cleaned up properly and may need to be pruned periodically:

```bash
# Podman
podman container prune
podman image prune

# Docker
docker container prune
docker image prune
```

### Container Startup Errors
If a container doesn't start, error messages may not be visible in the UI. Copy the container command from the backend log or session history and run it manually in a terminal to see the actual error message.

### Keyboard Shortcuts
Opinionated keyboard shortcuts are built-in, many of which conflict with browser defaults. These were designed for the desktop app and will be made configurable in a future release.

### Session Data Accumulation
Session data is persisted and will accumulate over time. Until automatic cleanup is implemented, you'll need to manually delete old session data.

Session data is stored in `~/.termstation/data/sessions/` (or your configured `data_dir`). Each session creates a directory containing:

```
sessions/
└── <session-id>/
    ├── <session-id>.json      # Session metadata
    ├── <session-id>.log       # Raw PTY output log
    └── workspace/             # Session workspace (cloned repos, generated files, etc.)
```

### Backend Shutdown
The backend may not terminate cleanly if stopped while containers are running. If the process hangs on shutdown, you may need to force kill it with `kill -9`.

### Docker Support
Docker container support (vs Podman) has received very little testing. The primary development environment uses Podman on Rocky Linux. If you encounter Docker-specific issues, please report them.

### Local Terminals
Local terminals can be spawned directly from the Electron desktop app. Sorting of these sessions with backend sessions doesn't work propertly, and history is not preserved across reloads.

## Project Structure

```
termstation/
├── backend/      # Node.js API server
├── frontend/     # Web UI (vanilla JS/HTML/CSS)
├── desktop/      # Electron app
├── mobile/       # Capacitor app (Android)
├── shared/       # Shared utilities
├── scripts/      # Build and utility scripts
└── docs/         # Documentation
```

## Release Status

TermStation was not built with distribution in mind, so there is much work remaining to get it ready for general use. At this time, it's being made available so that those who are interested or following can try it out. In these first few days (as of 12/3/2025), please do not open issues or PRs as the developer will be using them to document known issues. Feel free to use Discussions to ask questions, or reach out to the developer @kcosr on X. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for information about how you can help the developer to get things in order.

TermStation started as a vibe-coding project and evolved into a vibe-engineering project. Much cleanup work remains, including a planned rewrite from Javascript to Typescript. The developer's background is in C++ and did not know any better. That said, be aware that 100% of the code was generated by Claude and Codex.
