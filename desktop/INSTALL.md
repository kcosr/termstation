# termstation Desktop - Installation Guide

## Quick Installation

### For Linux Users

**Download and Run:**
1. Download the AppImage: `termstation-1.0.0.AppImage`
2. Make it executable: `chmod +x "termstation-1.0.0.AppImage"`
3. Run it: `./termstation-1.0.0.AppImage`

**The AppImage is completely portable** - no installation required! Just download and run.

## Prerequisites

### Backend Server Required
The desktop app connects to the termstation backend server. You need to have the backend running first:

```bash
# Navigate to the backend directory
cd ../backend

# Install dependencies (first time only)
npm install

# Start the backend server (Node.js)
npm start
```

The backend will start on port 6620 (development) or 6624 (production).

## Step-by-Step Installation

### 1. Download the Executable

Download the appropriate file for your system:
- **Linux**: `termstation-1.0.0.AppImage` (100MB)

### 2. Make Executable (Linux)

```bash
chmod +x "termstation-1.0.0.AppImage"
```

### 3. Start Backend Server

Before running the desktop app, start the backend:

```bash
cd /path/to/terminal-manager/backend
npm start
```

You should see output like:
```
termstation Backend started on http://0.0.0.0:6620
```

### 4. Launch Desktop App

**Linux AppImage:**
```bash
./termstation-1.0.0.AppImage
```

The desktop app will:
1. Start its own internal web server
2. Connect to the backend on port 6620
3. Open the termstation interface in a native window

## Troubleshooting

### "Backend not available" Error

If you see connection errors:

1. **Check backend is running:**
   ```bash
   curl http://localhost:6620/api/sessions
   ```
   Should return `[]` (empty array)

2. **Check firewall settings** - ensure port 6620 is not blocked

3. **Check backend configuration** in `backend/config/dev.json`

### AppImage Won't Start (Linux)

1. **Install FUSE** (if not already installed):
   ```bash
   # Ubuntu/Debian:
   sudo apt install fuse
   
   # CentOS/RHEL:
   sudo yum install fuse
   ```

2. **Check permissions:**
   ```bash
   ls -la "termstation-1.0.0.AppImage"
   ```
   Should show `-rwxr-xr-x` (executable)

3. **Run from terminal** to see error messages:
   ```bash
   ./termstation-1.0.0.AppImage
   ```

### Missing Libraries Error

The AppImage should be self-contained, but if you get library errors:

1. **Check system requirements:**
   - Linux kernel 3.10+ (most modern distributions)
   - GLIBC 2.17+ (most modern distributions)

2. **Install basic dependencies:**
   ```bash
   # Ubuntu/Debian:
   sudo apt install libgtk-3-0 libnotify4 libnss3 libxss1
   
   # CentOS/RHEL:
   sudo yum install gtk3 libnotify nss libXScrnSaver
   ```

## Configuration

The desktop app uses the same configuration model as the web version:

- **Backend**: set `TERMSTATION_CONFIG_DIR` to a directory containing `config.json`, `templates.json`, and `links.json`. User and group definitions (`users.json`, `groups.json`) now live in the backend data directory (for example `backend/data/users.json` and `backend/data/groups.json`) and are treated as runtime state.
- **Frontend**: set `TERMSTATION_FRONTEND_CONFIG_DIR` to a directory containing `config.js`.

If these environment variables are not set, each service defaults to the current working directory (expects the files listed above). The packaged desktop app defaults its frontend config dir to the bundled `frontend/public` directory (which contains `config.js`).

## Features

### What Works
✅ Full terminal session management  
✅ Multiple concurrent sessions  
✅ Session persistence and history  
✅ Native window controls and menus  
✅ Keyboard shortcuts (Ctrl+N for new terminal)  
✅ Cross-platform compatibility  

### Native Desktop Features
- **Menu Integration**: File > New Terminal, Edit commands, etc.
- **Keyboard Shortcuts**: Standard desktop shortcuts
- **Window Management**: Minimize, maximize, close
- **External Link Handling**: Opens links in default browser

## Uninstalling

### AppImage
Simply delete the AppImage file - no system installation, no cleanup needed.

## Building from Source

If you want to build the desktop app yourself:

```bash
# Install dependencies
npm install

# Build for your platform
npm run build:linux    # Creates AppImage

# Development mode
npm run dev            # Opens with DevTools
```

## Support

For issues and questions:
1. Check the troubleshooting section above
2. Ensure backend is running and accessible
3. Check browser console for errors (F12 in the app)
4. Report issues with system details and error messages
