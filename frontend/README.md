Terminal Manager Frontend (Node.js)

Overview
- Serves the static UI from `./public`.
- Injects configuration at `/config.js` from a config directory.
- No external dependencies; uses Node’s built-in `http/fs/path`.

Usage
- Single command: `node server.js`
- Configuration directory:
  - Set `TERMSTATION_FRONTEND_CONFIG_DIR` to an absolute directory that contains `config.js`
  - If unset, defaults to the current working directory (expects `./config.js`)

NPM Scripts
- From `frontend/` directory:
  - `npm start` -> `node server.js`

Config
- Set `TERMSTATION_FRONTEND_CONFIG_DIR=/abs/path/to/frontend/public` (or another directory containing `config.js`)
- The server reads `/config.js` from that directory (by default it uses the bundled `frontend/public/config.js`)
- Port comes **only** from env `TERMSTATION_FRONTEND_PORT` when set; if unset or invalid, the server binds to an ephemeral port (0) and logs the actual port after startup.
- Bind address (host) comes **only** from env `TERMSTATION_FRONTEND_BIND_ADDRESS` when set; if unset or empty, Node’s default bind address is used (typically all interfaces).

Notes
- Legacy server and assets have been removed after migration.
- Dev convenience: test pages under `/tests/*` are served from `frontend/tests`.
- The nginx API path prefix is still supplied by the config files and used by the UI code.
