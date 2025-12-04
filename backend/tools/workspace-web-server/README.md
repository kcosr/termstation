Workspace Web Server Helper
===========================

This helper provides a small JSON/HTTP API over a workspace directory and can be used as a standalone developer utility (for example, to inspect a workspace tree locally).

Basic usage
-----------

From the `backend/tools/workspace-web-server` directory:

```bash
node bin/workspace-web-server.js --port 41000 --dir /workspace
```

CLI options
-----------

- `--port <n>`  
  TCP port to bind. Defaults to `8000` when not specified or invalid.

- `--dir <path>` / `--root <path>`  
  Root directory to serve. Defaults to `/workspace`.

The TermStation frontend owns all visual theming for the Workspace tab; the
helper does not emit any HTML UI or color styling.

HTTP API
--------

All paths are resolved relative to the configured `--dir` and are guarded
against traversal outside that root. Responses are JSON unless otherwise
noted.

- `GET /`  
  Returns a small info document:

  ```json
  {
    "ok": true,
    "service": "workspace-web-server",
    "root": "/workspace",
    "api": {
      "list": "/api/list?path=/",
      "file": "/api/file?path=/path/to/file"
    }
  }
  ```

- `GET /api/list?path=<relative-or-absolute>`  
  List entries under the requested directory.

  - `path`: optional. Defaults to `/`. May be given as `/subdir` or
    `subdir`.
  - 200 response:

    ```json
    {
      "ok": true,
      "path": "/subdir",
      "entries": [
        { "name": "file.txt", "type": "file", "path": "/subdir/file.txt", "hidden": false },
        { "name": ".env", "type": "file", "path": "/subdir/.env", "hidden": true },
        { "name": "child", "type": "directory", "path": "/subdir/child", "hidden": false }
      ]
    }
    ```

- `GET /api/file?path=<relative-or-absolute>[&download=1]`  
  Stream a file from the workspace.

  - Returns the file contents with a best-effort `Content-Type` based on
    extension.
  - When `download=1` is present, a `Content-Disposition: attachment`
    header is added so browsers download instead of preview.

- `PUT /api/file?path=<relative-or-absolute>`  
  Upload or overwrite a file.

  - Body is treated as raw bytes; a `Content-Type` header is not required
    for correctness.
  - Parent directories are created automatically.
  - 201 response:

    ```json
    {
      "ok": true,
      "path": "/subdir/file.txt",
      "bytes": 1234
    }
    ```

- `DELETE /api/file?path=<relative-or-absolute>`  
  Delete a file (best-effort).

  - Refuses to delete directories and returns an error when `path` points
    to a directory.
  - 200 response:

    ```json
    {
      "ok": true,
      "path": "/subdir/file.txt"
    }
    ```

Errors
------

Errors are returned as JSON:

```json
{
  "ok": false,
  "error": "ERROR_CODE",
  "message": "Human-readable message"
}
```
