# Building termstation Desktop for All Platforms

## Overview

Building for different platforms requires running the build on the target platform or using cross-compilation. Here's how to create executables for Windows, macOS, and Linux.

## Build Commands

### Single Platform Builds
```bash
npm run build:linux   # Linux AppImage
npm run build:win     # Windows NSIS installer + portable
npm run build:mac     # macOS DMG + ZIP
```

### Cross-Platform Build (Limited)
```bash
npm run build:all     # Attempts all platforms (may not work from Linux)
```

## Platform-Specific Requirements

### 🐧 Linux (Current Environment)
**What you can build:**
- ✅ Linux AppImage (works - already built)
- ⚠️ Windows executables (possible with Wine)
- ❌ macOS executables (not possible from Linux)

**To build Windows from Linux:**
```bash
# Install Wine (if not already installed)
sudo apt update
sudo apt install wine

# Build Windows executable
npm run build:win
```

### 🪟 Windows 
**What you can build:**
- ✅ Windows NSIS installer (.exe)
- ✅ Windows portable executable (.exe)  
- ✅ Windows ZIP archive
- ⚠️ Linux AppImage (possible)
- ❌ macOS executables (not possible)

**Setup on Windows:**
```cmd
# Install Node.js and npm
# Download from: https://nodejs.org/

# Clone repository and install
git clone <repository-url>
cd desktop
npm install

# Build Windows executables
npm run build:win
```

### 🍎 macOS
**What you can build:**
- ✅ macOS DMG installer (.dmg)
- ✅ macOS ZIP archive (.zip)
- ✅ Universal binary (Intel + Apple Silicon)
- ⚠️ Linux AppImage (possible)
- ⚠️ Windows executables (possible with Wine)

**Setup on macOS:**
```bash
# Install Xcode command line tools
xcode-select --install

# Install Node.js and npm
# Download from: https://nodejs.org/

# Clone repository and install  
git clone <repository-url>
cd desktop
npm install

# Build macOS executables
npm run build:mac
```

## Recommended Build Strategy

### Option 1: Platform-Specific Builds (Recommended)
Build on each target platform for best compatibility:

1. **Linux**: Build on Linux system (current)
2. **Windows**: Build on Windows system  
3. **macOS**: Build on macOS system

### Option 2: Cross-Compilation (Limited)
Try cross-compilation from Linux (may have issues):

```bash
# Install additional tools
sudo apt install wine mono-devel

# Attempt cross-platform build
npm run build:all
```

### Option 3: CI/CD Pipeline (Best for Teams)
Use GitHub Actions or GitLab CI to build on multiple platforms automatically.

## Expected Build Outputs

### Linux Build
```
dist/
├── termstation-1.0.0.AppImage           # 100MB - Portable executable
├── linux-unpacked/                           # Unpacked application files
└── builder-debug.yml                         # Build metadata
```

### Windows Build  
```
dist/
├── termstation Setup 1.0.0.exe          # NSIS installer
├── termstation 1.0.0.exe                # Portable executable
├── termstation-1.0.0-win.zip           # ZIP archive
├── win-unpacked/                             # Unpacked application files
└── builder-debug.yml                        # Build metadata
```

### macOS Build
```
dist/
├── termstation-1.0.0.dmg               # DMG installer
├── termstation-1.0.0-mac.zip           # ZIP archive  
├── mac/                                      # Application bundle
└── builder-debug.yml                        # Build metadata
```

## Build Troubleshooting

### Native modules (node-pty)
This app uses `node-pty` for local terminals. When upgrading Electron or after a fresh clone:
1) Run `npm install` in `desktop/` (this triggers `electron-builder install-app-deps` to rebuild native modules).
2) If you still see load errors for `node-pty`, run:
```bash
npx electron-rebuild
```

### Linux → Windows Cross-Build Issues
If Wine cross-compilation fails:
1. Use a Windows machine/VM
2. Use GitHub Actions with Windows runner
3. Consider Docker with Windows base image

### macOS Code Signing Issues
macOS builds may require:
```bash
# Set environment variables
export CSC_IDENTITY_AUTO_DISCOVERY=false

# Build without code signing
npm run build:mac
```

### Missing Dependencies
If builds fail with missing dependencies:
```bash
# Clear and reinstall
rm -rf node_modules package-lock.json
npm install

# Install electron rebuild
npm install --save-dev electron-rebuild
npx electron-rebuild
```

## Distribution

### File Sizes (Approximate)
- **Linux AppImage**: ~100MB
- **Windows Portable**: ~120MB  
- **Windows Installer**: ~125MB
- **macOS DMG**: ~110MB

### Distribution Checklist
- [ ] Test executable on clean target system
- [ ] Verify backend connectivity
- [ ] Check antivirus compatibility (Windows)
- [ ] Test installation/uninstallation process
- [ ] Validate on different OS versions

## GitHub Actions Example

Create `.github/workflows/build.yml` for automated builds:

```yaml
name: Build Desktop App

on: [push, pull_request]

jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    
    runs-on: ${{ matrix.os }}
    
    steps:
    - uses: actions/checkout@v3
    - uses: actions/setup-node@v3
      with:
        node-version: '18'
    
    - name: Install dependencies
      run: |
        cd desktop
        npm install
    
    - name: Build
      run: |
        cd desktop
        npm run build
    
    - name: Upload artifacts
      uses: actions/upload-artifact@v3
      with:
        name: desktop-${{ matrix.os }}
        path: desktop/dist/
```

This allows building for all platforms automatically on every commit.
