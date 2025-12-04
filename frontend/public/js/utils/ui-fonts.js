/**
 * UI Font Options
 * Provides a curated set of common UI font stacks for the application chrome.
 */

class UiFonts {
  /**
   * Return available UI font stacks.
   * Each item has a human-friendly name and a CSS font-family value.
   */
  getAvailable() {
    return [
      // Sans-serif stacks
      {
        name: 'System UI (Default)',
        value:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      },
      { name: 'System UI (generic)', value: 'system-ui, sans-serif' },
      { name: 'Inter', value: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Open Sans', value: "'Open Sans', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Source Sans 3', value: "'Source Sans 3', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Lato', value: "Lato, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Noto Sans', value: "'Noto Sans', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Ubuntu', value: "Ubuntu, 'Noto Sans', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Cantarell', value: "Cantarell, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Trebuchet MS', value: "'Trebuchet MS', Tahoma, Verdana, Arial, sans-serif" },
      { name: 'Tahoma', value: "Tahoma, 'Segoe UI', Verdana, Arial, sans-serif" },
      { name: 'Verdana', value: "Verdana, Tahoma, 'Segoe UI', Arial, sans-serif" },
      { name: 'Segoe UI', value: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif" },
      { name: 'Roboto', value: "Roboto, 'Helvetica Neue', Arial, sans-serif" },
      { name: 'Helvetica Neue', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
      { name: 'Arial', value: 'Arial, sans-serif' },

      // Monospace stacks for UI (optional per user request)
      { name: 'System Monospace', value: 'monospace' },
      { name: 'UI Monospace', value: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { name: 'SF Mono', value: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { name: 'Menlo', value: "Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { name: 'Consolas', value: "Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { name: 'JetBrains Mono', value: "'JetBrains Mono', 'Fira Code', 'Fira Mono', Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { name: 'Fira Code', value: "'Fira Code', 'Fira Mono', Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { name: 'Source Code Pro', value: "'Source Code Pro', Consolas, 'Liberation Mono', 'Courier New', monospace" },
      { name: 'Courier New (Monospace)', value: "'Courier New', monospace" },
    ];
  }

  /** Default UI font-family value (matches CSS body default). */
  getDefault() {
    return "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  }
}

export const uiFonts = new UiFonts();
