# TermStation Installation

## Requirements

### Backend
- **Operating System**: Ubuntu 22.04+ or Rocky Linux 10+ (other Linux distributions may work but are untested)
- **Node.js**: Version 22 or later (required)
- **Container Runtime**: Docker (Ubuntu) or Podman (Rocky)

### Frontend
The frontend can be accessed via web browser or native apps:
- **Web**: Any modern browser
- **Desktop**: Windows, macOS, Linux (Electron)
- **Mobile**: Android (Capacitor)

## Before You Begin

These instructions assume a fresh OS installation, but that is not required. If installing on an existing system, review the installation scripts and instructions carefully before running them.

**Run at your own risk.** The installer modifies system packages, optionally creates users, and configures services. Review `install.sh` to understand what changes will be made to your system.

## Quick Install

The interactive installer handles all dependencies and configuration:

```bash
git clone https://github.com/kcosr/termstation
cd termstation
./install.sh
```

The installer will:
- Install required system packages (git, container runtime, etc.)
- Check that Node.js 22+ is installed (and provide upgrade instructions if not)
- Create a service user (optional, recommended)
- Configure SSH keys for code forge access
- Build the container image
- Set up configuration files

**Note**: The installer does not install Node.js automatically. Rocky Linux 10 ships with Node.js 22. On Ubuntu, you may need to install it first (see below).

## Pre-Installation

### Node.js 22 (Ubuntu only)

Rocky Linux 10 includes Node.js 22 by default. On Ubuntu, install Node.js 22 before running the installer:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### SSH Keys and Code Forge Access

Before running the installer, ensure you have SSH keys and credentials for accessing your code forges (GitHub, GitLab, Gitea). These are used by the backend to list repos and branches.

```
# Files typically needed:
~/.ssh/config
~/.ssh/<keys>
~/.gitconfig
~/.config/gh/*      # GitHub CLI
~/.config/glab-cli/* # GitLab CLI (optional)
~/.config/tea/*     # Gitea CLI (optional)
```

### AI CLI Authentication

If you plan to use AI tools (Claude Code, Codex, Cursor), authenticate them before or after installation. On headless servers, you may need to authenticate on a machine with a browser and copy the credential files:

```
# Claude CLI
~/.claude/.credentials.json
~/.claude.json

# Codex CLI
~/.codex/auth.json
~/.codex/config.toml

# Cursor CLI
~/.config/cursor/auth.json
~/.cursor/cli-config.json
```

## Manual Installation

If you prefer not to use the interactive installer, follow these steps.

### 1. Install Dependencies

**Ubuntu/Debian:**
```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Other dependencies
sudo apt-get install -y git gcc g++ make

# Docker
sudo apt-get install -y docker-ce docker-ce-cli containerd.io
```

**Rocky/RHEL/CentOS:**
```bash
# Node.js 22
sudo dnf module reset nodejs
sudo dnf module enable nodejs:22
sudo dnf install -y nodejs

# Other dependencies
sudo dnf install -y git gcc-c++ podman
```

### 2. Clone and Build

```bash
git clone https://github.com/kcosr/termstation
cd termstation

# Backend
cd backend && npm install && npm run build && cd ..

# Frontend
cd frontend && npm install && cd ..
```

**Note**: The backend build step requires [Bun](https://bun.sh) to be installed. It builds the bundled tools that are copied into container workspaces.

### 3. Configure

Create config and data directories:
```bash
mkdir -p ~/.termstation/config ~/.termstation/data ~/.termstation/data/files
cp backend/config/*.json ~/.termstation/config/
```

Update the configuration files in `~/.termstation/config/`:
- `config.json` - Main configuration (ports, bind address, forges)
- `users.json` - User accounts
- `groups.json` - User groups
- `templates.json` - Session templates
- `links.json` - Quick links for the UI

Replace "termstation" with your username in all config files:
```bash
cd ~/.termstation/config
sed -i 's/"termstation"/"your-username"/g' *.json
```

### 4. Build Container Image

Create a Dockerfile in your config directory, then build:

**Podman:**
```bash
podman build -f ~/.termstation/config/Dockerfile -t termstation ~/.termstation/config
```

**Docker:**
```bash
docker build -f ~/.termstation/config/Dockerfile -t termstation ~/.termstation/config
```

### 5. SELinux (Rocky/RHEL only)

If using SELinux, you may need to install one or both of the provided policy modules depending on your configuration:

**Policy 1: Socket access** (allows containers to connect to the API socket)
```bash
cd /tmp
cp /path/to/termstation/backend/scripts/install-templates/selinux/termstation_socket.te .
checkmodule -M -m -o termstation_socket.mod termstation_socket.te
semodule_package -o termstation_socket.pp -m termstation_socket.mod
sudo semodule -i termstation_socket.pp
```
*Alternative:* Instead of installing this policy, you can bind the API to a non-loopback address and disable the socket adapter. In `config.json`, set `listeners.http` to a routable address (e.g., `"0.0.0.0:6624"`) and set `container_use_socket_adapter` to `false`.

**Policy 2: Container file access** (allows containers to read/write bind-mounted config files)
```bash
cd /tmp
cp /path/to/termstation/backend/scripts/install-templates/selinux/termstation_container_file.te .
checkmodule -M -m -o termstation_container_file.mod termstation_container_file.te
semodule_package -o termstation_container_file.pp -m termstation_container_file.mod
sudo semodule -i termstation_container_file.pp
```
This policy is needed for AI CLI config files (like `~/.claude.json`) that are bind-mounted into containers but may have MCS category labels that don't match the container's context.

*Alternative:* Instead of installing this policy, you can use `write_files` in your template configuration to copy file contents into the container rather than using bind mounts.

## Starting TermStation

### Backend
```bash
# Using start script (recommended)
/opt/termstation/backend/start.sh

# Or manually
TERMSTATION_CONFIG_DIR=~/.termstation/config npm start
```

**Note for Docker users**: If you're using Docker and were recently added to the `docker` group, you may need to log out and back in, or use `newgrp docker` before starting the backend. The generated start script (`/opt/termstation/backend/start.sh`) automatically handles this by checking if Docker is being used and activating the docker group if needed.

### Frontend
```bash
# Using start script (recommended)
/opt/termstation/frontend/start.sh

# Or manually
BACKEND_PUBLIC_BASE_URL=http://127.0.0.1:6624 \
TERMSTATION_FRONTEND_BIND_ADDRESS=127.0.0.1 \
TERMSTATION_FRONTEND_PORT=6625 \
npm start
```

## Accessing TermStation

1. Navigate to the frontend URL (default: http://localhost:6625)
2. Login with your username and password "fixme"
3. You will be prompted to change your password. **Note**: If you are accessing TermStation over HTTP (rather than HTTPS), be aware that your password will be transmitted in plain text during login. Passwords are not stored in plain text—they are hashed and authentication uses secure cookies—but transmission over HTTP is not encrypted. For production deployments or remote access, consider using HTTPS (see the Nginx TLS Reverse Proxy section below).
4. Click "+ Session" then "Create" to create your first session

## Remote Access

**Warning**: Exposing TermStation directly to the public internet is not recommended. Authentication has not been hardened for untrusted networks.

### Recommended: VPN/Tunnel Services

For secure remote access, use a VPN or tunnel service that keeps TermStation off the public internet:

- **[Tailscale](https://tailscale.com/)** - Zero-config mesh VPN, easy setup
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)** - Secure tunnels without opening ports
- **[WireGuard](https://www.wireguard.com/)** - Fast, modern VPN protocol

These services allow you to access TermStation securely without exposing ports to the internet.

### SSH Tunnel

For quick access without additional software, use an SSH tunnel:
```bash
# Default ports: backend=6624, frontend=6625
ssh -L 6624:localhost:6624 -L 6625:localhost:6625 your-server
```

Then access http://localhost:6625 on your local machine.

### Nginx TLS Reverse Proxy (Recommended)

For production and multi-user deployments, it is strongly recommended to run TermStation behind a TLS-terminating reverse proxy such as Nginx. This lets you serve the frontend and API over HTTPS on a single origin (for example, `https://termstation`) while the backend and frontend processes listen on local HTTP ports.

#### Generate a local CA and server certificate (development)

For non-public deployments (lab, home network, etc.), you can generate a local Certificate Authority (CA) and a server certificate for `termstation`:

```bash
mkdir -p ~/certs/termstation
cd ~/certs/termstation

# 1) Create a local CA key and certificate (self-signed)
openssl genrsa -out local-ca.key 4096
openssl req -x509 -new -nodes -key local-ca.key -sha256 -days 3650 \
  -subj "/CN=Local TermStation CA" \
  -out local-ca.crt

# 2) Create a key and CSR for the TermStation server
openssl genrsa -out termstation.key 2048
openssl req -new -key termstation.key \
  -subj "/CN=termstation" \
  -out termstation.csr

# 3) Sign the server certificate with the local CA
openssl x509 -req -in termstation.csr -CA local-ca.crt -CAkey local-ca.key -CAcreateserial \
  -out termstation.crt -days 825 -sha256
```

Copy `termstation.crt` and `termstation.key` to the Nginx TLS directories on your server (paths in the example below assume Rocky/EL-style locations):

```bash
sudo cp termstation.crt /etc/pki/tls/certs/termstation.crt
sudo cp termstation.key /etc/pki/tls/private/termstation.key
```

To avoid \"Not secure\" warnings in browsers, import `local-ca.crt` into the trusted certificate authorities store on your client machine (OS/browser trust store).

#### Example Nginx configuration

The following example assumes:

- Backend API is listening on `http://localhost:6624`
- Frontend is listening on `http://localhost:6625`
- You want to expose `https://termstation` on port 443
- Access is restricted to the local subnet `192.168.0.0/24` and localhost (`127.0.0.1`)

`/etc/nginx/nginx.conf`:

```nginx
# For more information on configuration, see:
#   * Official English Documentation: http://nginx.org/en/docs/
#   * Official Russian Documentation: http://nginx.org/ru/docs/

user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;

# Load dynamic modules. See /usr/share/nginx/README.dynamic.
include /usr/share/nginx/modules/*.conf;

events {
    worker_connections 1024;
}

http {
    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile            on;
    tcp_nopush          on;
    keepalive_timeout   65;
    types_hash_max_size 4096;

    include             /etc/nginx/mime.types;
    default_type        application/octet-stream;

    # WebSocket upgrade mapping
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    # Include server configurations
    include /etc/nginx/conf.d/*.conf;
}
```

`/etc/nginx/conf.d/termstation.conf`:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name termstation;

    ssl_certificate /etc/pki/tls/certs/termstation.crt;
    ssl_certificate_key /etc/pki/tls/private/termstation.key;
    ssl_session_cache shared:SSL:1m;
    ssl_session_timeout 10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 0;

    # Restrict access to local subnet and localhost
    allow 192.168.0.0/24;
    allow 127.0.0.1;
    deny all;

    # Main frontend
    location / {
        proxy_pass http://localhost:6625/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_redirect off;
    }

    # API and WebSocket subpaths
    location = /api {
        return 301 /api/;
    }

    location = /ws {
        return 301 /ws/;
    }

    location ~ ^/(api|ws)/ {
        proxy_pass http://localhost:6624;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        client_max_body_size 140m;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_redirect off;
    }
}
```

After editing the configuration:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

With this setup, the TermStation frontend and API are available at `https://termstation/` and `https://termstation/api/…` over TLS, and browsers see a single HTTPS origin for both the UI and API, which keeps cookie and WebSocket behavior straightforward.

## Firewall

If you bind to a non-localhost address and have a firewall enabled, allow the backend and frontend ports (default: 6624 and 6625).

## Troubleshooting

### Node.js Version Error

If you see ESM/CommonJS module errors, ensure you're running Node.js 22+:
```bash
node --version
```

To upgrade:

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Rocky/RHEL/CentOS:**
```bash
sudo dnf module reset nodejs
sudo dnf module enable nodejs:22
sudo dnf install -y nodejs
```

### Native Module Errors (node-pty)

If you see errors about `pty.node` or `libnode.so` after upgrading Node.js, rebuild native modules:
```bash
cd /opt/termstation/backend
npm rebuild
```

Or reinstall:
```bash
cd /opt/termstation/backend
rm -rf node_modules && npm install
```

## Optional Dependencies

### chat-to-html

Required for the Chat Log tab (renders CLI conversation logs):
```bash
git clone https://github.com/kcosr/chat-to-html
cd chat-to-html
npm install && npm run build && npm run build:bun
cp dist/chat-to-html.js ~/.termstation/data/files/
```

### pty-to-html

Required for HTML terminal history rendering (uses libghostty):
```bash
git clone https://github.com/kcosr/pty-to-html
cd pty-to-html
./setup.sh
cp zig-out/bin/pty-to-html ~/.termstation/data/files/
```

## Desktop App (Electron)

Build native desktop apps for Windows, macOS, or Linux.

```bash
cd desktop
npm ci
npm run build:<platform>
```

### Supported Platforms

| Platform | Command | Output |
|----------|---------|--------|
| Windows | `npm run build:win` | `dist/TermStation Setup*.exe` (installer), `dist/TermStation*.exe` (portable) |
| macOS | `npm run build:mac` | `dist/TermStation*.dmg` (x64 and arm64) |
| Linux | `npm run build:linux` | `dist/TermStation*.AppImage` |
| All | `npm run build:all` | All platforms |

The built installers/executables will be in the `desktop/dist/` directory.

When running the desktop app against a backend on a **different host** over **HTTP** (for example, frontend at `http://localhost` and backend at `http://ubuntu:6624`), cookies may not be sent reliably across origins in modern browsers. In that scenario, use the built-in local proxy mode in the Login modal:

- Open the desktop app and expand **API Settings** in the Login dialog.
- Set **API URL** to your backend (e.g. `http://ubuntu:6624`).
- When the frontend is served from the local desktop server (`FRONTEND_URL=local`), enable the checkbox **“Route API via local proxy (HTTP compatibility)”**.

With this option enabled, the desktop app serves the frontend from `http://localhost:<port>` and forwards `/api/*` requests to the configured backend. This keeps the authentication cookie bound to the local origin so it is included on API requests even when the backend host is different and only available over HTTP.

## Mobile App
### Android

*Instructions coming soon for the full build/publish pipeline.*

TLS is required for the native Capacitor-based Android build (TermStation mobile app) so that the embedded WebView can access the UI and API without \"Not secure\" warnings or blocked cookies. The recommended approach is to expose TermStation over HTTPS using Nginx as documented in the **Nginx TLS Reverse Proxy (Recommended)** section above.

When using a locally generated CA (for example, from the OpenSSL steps in the Nginx section), Android expects a DER-encoded CA certificate:

```bash
openssl x509 -in local-ca.crt -outform DER -out local-ca-android.cer
```

Then on the device:

1. Transfer `local-ca-android.cer` to the Android device.
2. Open **Settings → Security (or Security & privacy) → Encryption & credentials → Install a certificate → CA certificate**.
3. Select `local-ca-android.cer` to install the CA.

After importing the CA, the Android WebView (and Chrome) will trust `https://termstation` (or whichever hostname you configured in Nginx) and the mobile app can use the same HTTPS origin as desktop/web without additional certificate warnings.
