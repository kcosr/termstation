#!/bin/bash

# Build Windows executable from Linux (requires Wine)

echo "🍷 Installing Wine (if not already installed)..."
if ! command -v wine &> /dev/null; then
    echo "Installing Wine..."
    sudo apt update
    sudo apt install -y wine wine32 wine64
    
    # Configure Wine
    winecfg &
    echo "Please configure Wine and close the configuration window when done."
    wait
fi

echo "🔧 Setting up Windows build environment..."
export WINEARCH=win64
export WINEPREFIX=$HOME/.wine-electron

# Initialize Wine prefix if it doesn't exist
if [ ! -d "$WINEPREFIX" ]; then
    echo "Initializing Wine prefix..."
    wineboot --init
fi

echo "🔨 Building Windows executable..."
npm run build:win

if [ $? -eq 0 ]; then
    echo "✅ Windows build completed successfully!"
    echo "📁 Executables created in: dist/"
    ls -la dist/*.exe 2>/dev/null || echo "No .exe files found in dist/"
else
    echo "❌ Windows build failed. Try building on a Windows machine instead."
    echo ""
    echo "Alternative options:"
    echo "1. Use a Windows machine or VM"
    echo "2. Use GitHub Actions with Windows runner"
    echo "3. Ask someone with Windows to build it"
fi