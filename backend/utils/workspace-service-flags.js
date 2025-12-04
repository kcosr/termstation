export function isWorkspaceServiceEnabledForSession({ template, isolationMode, globalConfig } = {}) {
  try {
    const cfg = globalConfig;
    const globalEnabled = cfg && cfg.WORKSPACE_SERVICE_ENABLED === true;
    if (!globalEnabled) return false;

    const tplEnabled = template && template.workspace_service_enabled === true;
    if (!tplEnabled) return false;

    const iso = String(isolationMode || '').toLowerCase();
    if (iso !== 'container' && iso !== 'directory') return false;

    return true;
  } catch (_) {
    return false;
  }
}

export function computeWorkspaceServicePort(sessionId) {
  const BASE_PORT = 41000;
  const PORT_RANGE = 20000;
  const input = String(sessionId ?? '');

  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    hash = (hash * 31 + code) | 0;
  }

  const positive = Math.abs(hash);
  const port = BASE_PORT + (positive % PORT_RANGE);

  // Sanity check to guard against misconfiguration or overflow
  if (port < BASE_PORT || port >= BASE_PORT + PORT_RANGE) {
    throw new Error(`Computed workspace service port out of range: ${port}`);
  }

  return port;
}
