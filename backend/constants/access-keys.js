// Canonical lists for access control domains
// - Features: flags that toggle UI/backend functionality
// - Permissions: RBAC-style booleans that gate actions

export const FEATURE_DEFAULTS = {
  notes_enabled: false,
  // Gate image uploads (drag & drop and paste) API
  image_uploads_enabled: false,
  // Gate workspace file uploads in the Workspace tab file browser
  workspace_uploads_enabled: false,
  // Gate desktop local terminal (Electron local PTY) integration
  // Default OFF; admins group (features: "*") enables it automatically
  local_terminal_enabled: false,
  // Allow rotating the server session cookie signing secret via API
  // and show the Reset Token control in Settings. Dangerous; keep OFF by default.
  cookie_token_reset_enabled: false,
  // Allow administrators to trigger a manual reload of core JSON config (templates/users/groups/links)
  // via the backend API and Settings UI control.
  config_reload_enabled: false,
  // Allow logged in users to reset their own password when enabled
  password_reset_enabled: false
};

export const PERMISSION_DEFAULTS = {
  impersonate: false,
  manage_all_sessions: false,
  broadcast: false,
  sandbox_login: false,
  // Allow terminating all containers and pruning volumes from the Containers page
  terminate_containers: false,
  // Allow posting input to any active session's PTY via HTTP API
  // Disabled by default; grant to service users/admins via groups.json
  inject_session_input: false
};

export const FEATURE_KEYS = new Set(Object.keys(FEATURE_DEFAULTS));
export const PERMISSION_KEYS = new Set(Object.keys(PERMISSION_DEFAULTS));
