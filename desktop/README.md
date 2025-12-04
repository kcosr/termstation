# termstation Desktop

Desktop application for termstation - a native Electron wrapper for the web-based terminal session manager.

## Features

- Native desktop application with system integration
- Serves the existing termstation web interface
- Cross-platform support (Windows, macOS, Linux)
- Native menus and keyboard shortcuts
- Secure file serving with no code duplication

## Download and Installation

### Ready-to-Use Executable ⬇️

**Linux AppImage** (recommended - no installation required):
1. Download: `dist/termstation-1.0.0.AppImage` (100MB)
2. Make executable: `chmod +x "termstation-1.0.0.AppImage"`  
3. Run: `./termstation-1.0.0.AppImage`

**Prerequisites:**
- Backend server must be running first: `cd ../backend && npm start`
- Linux with standard libraries (works on most distributions)

📖 **See [INSTALL.md](INSTALL.md) for detailed installation instructions and troubleshooting.**

## Development Setup

### Prerequisites
- Node.js 16+ and npm
- Running Session Manager backend server (see ../backend/README.md)

### Installation

1. Install dependencies:
```bash
npm install
```

## Development

1. Start in development mode:
```bash
npm run dev
```

This will open the Electron app with developer tools enabled.

### Local Frontend Packaging

By default (when `FRONTEND_URL` is unset or set to `local`), the desktop app hosts the packaged frontend on an ephemeral `http://localhost:<port>` HTTP server and loads that URL in the Electron window. The `config.js` file is served from `TERMSTATION_FRONTEND_CONFIG_DIR` via `/config.js` on this local server. To load a remote web UI instead, set `FRONTEND_URL` to a full URL (e.g., `https://termstation`).

On macOS and Linux you can also force file URL loading (no HTTP server) by setting `FRONTEND_URL=file`. In this mode the app loads `index.html` via `file://` and uses an internal protocol bridge to serve `config.js` from `TERMSTATION_FRONTEND_CONFIG_DIR`. On Windows, `FRONTEND_URL=file` is not supported and falls back to the local HTTP server.

Examples:

```bash
# Load packaged frontend via local HTTP (default)
FRONTEND_URL=local npm start

# Load packaged frontend via file:// (macOS/Linux only)
FRONTEND_URL=file npm start

# Load remote frontend URL
FRONTEND_URL="https://termstation" npm start
```

## Building

Build for current platform:
```bash
npm run build
```

Available build commands:
```bash
npm run build:win    # Windows
npm run build:mac    # macOS  
npm run build:linux  # Linux
```

📖 **See [BUILD.md](BUILD.md) for complete cross-platform build instructions.**

## Usage

1. **Start the backend server** first (set config dir or run from it):
```bash
# Example (production):
TERMSTATION_CONFIG_DIR=/srv/devtools/termstation/backend/config/production \
  node ../backend/start.js
```

2. **Launch the desktop app**:
```bash
npm start
```

The desktop app serves `/config.js` from a config directory. Set `TERMSTATION_FRONTEND_CONFIG_DIR` to select it:

```bash
# Example (using repo frontend config):
TERMSTATION_FRONTEND_CONFIG_DIR=$PWD/../frontend/public \
  npm start
```

If unset, the app defaults to the packaged `frontend/public` directory (which contains `config.js`).

## Architecture

The desktop app is a minimal Electron wrapper that:

- Serves static files from `../frontend/` directory (no code duplication)
- Creates a native window container for the web application
- Provides desktop integration (menus, shortcuts, etc.)
- Maintains the same codebase as the web version

## Build Output

Built applications are placed in the `dist/` directory:

- **Windows**: `.exe` installer and portable `.exe`
- **macOS**: `.dmg` installer and `.app` bundle
- **Linux**: `.AppImage` portable application

## Configuration

- **Backend**: set `TERMSTATION_CONFIG_DIR` to a directory containing `config.json`, `templates.json`, and `links.json`. User and group definitions (`users.json`, `groups.json`) now live in the backend data directory (for example `backend/data/users.json` and `backend/data/groups.json`) and are treated as runtime state.
- **Frontend (desktop)**: set `TERMSTATION_FRONTEND_CONFIG_DIR` to a directory containing `config.js`.

## Security

The Electron app includes security best practices:

- Disabled Node.js integration in renderer
- Context isolation enabled
- Web security enabled
- External link handling
- Navigation protection

### UDS API Bridge (socket://, unix://, pipe://)

The desktop app supports connecting to a backend over a local Unix domain socket (Linux/macOS) or Windows named pipe using a custom `socket://` URL in the API settings. For convenience, `unix://` and `pipe://` are also accepted and treated equivalently to `socket://` across all platforms; the bridge resolves to the OS‑appropriate transport at runtime. This is only available in the desktop app and not in browsers.

- API base (POSIX): `socket:///run/user/<uid>/termstation.sock`
- API base (Windows): `socket://\\.\pipe\termstation`
- WS base is derived automatically; the app bridges both HTTP and WebSocket over the same local socket/pipe.

Notes:
- Cookies are managed by the desktop bridge; Basic Auth on the first `/api/info` call seeds a session cookie which is persisted in the desktop cookie jar.
- When using `socket://` the app never opens a TCP listener.

### Local HTTP API Proxy (HTTP-only backends)

When the desktop app is running with the built-in local frontend (`FRONTEND_URL=local`, served from `http://localhost:<port>`), you can route API and WebSocket traffic through the local app to reach an HTTP-only backend on a different host. This avoids cross-site cookie limitations when the backend does not use HTTPS.

- Enable this per profile from the Login modal under **API Settings** by checking **“Route API via local proxy (HTTP compatibility)”** while the API URL points at an `http://` backend (for example `http://ubuntu:6624`).
- In this mode, the frontend talks to `http://localhost:<port>/api/...` and `ws://localhost:<port>/ws/<clientId>`, and the desktop app transparently proxies those calls to the configured API URL, including cookies and headers.
- The proxy is only used when:
  - Running inside the desktop app with the local HTTP frontend.
  - The profile’s API URL is `http://` (not `https://`).
  - The profile has the proxy checkbox enabled.
- For production deployments, HTTPS endpoints are still recommended; the proxy exists primarily to support HTTP-only environments where cross-origin cookies from `localhost` would otherwise fail.

To debug proxy behavior (for example, to see which `/api/*` paths are being forwarded), you can enable verbose proxy logs in the desktop main process by setting:

```bash
DESKTOP_API_PROXY_DEBUG=1 npm run dev
```

When this flag is set, the desktop will log detailed proxy configuration and per-request information to the Electron console; by default, these logs are suppressed.

## Troubleshooting

### Backend Connection Issues

Ensure the backend is running:
```bash
cd ../backend && npm start
```

### Build Issues

Clear node_modules and reinstall:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Platform-Specific Issues

Check electron-builder documentation for platform requirements:
- Windows: Windows SDK for code signing
- macOS: Xcode for notarization
- Linux: Standard build tools
