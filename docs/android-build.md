# Building TermStation for Android

This guide covers building the TermStation mobile app for Android using Capacitor.

## Prerequisites

1. **Node.js 18+** and npm
2. **Android Studio** with Android SDK (SDK Platform + Build-Tools)
3. **Java JDK 17+**
4. **Environment variables** configured:

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export ANDROID_HOME=$HOME/Android
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin
export PATH=$PATH:$ANDROID_HOME/platform-tools
export PATH=$PATH:$ANDROID_HOME/emulator
```

You can source `mobile/.android_env` or add these to your shell profile.

## Build Steps

```bash
# 1. Navigate to the mobile directory
cd mobile

# 2. Install dependencies
npm install

# 3. Generate the Android project (first time only)
npm run android:add

# 4. Build a debug APK
npm run android:build
```

The debug APK will be output to:
```
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run android:add` | Generate Android project (first time setup) |
| `npm run android:sync` | Sync web assets after frontend changes |
| `npm run android:build` | Build debug APK |
| `npm run android:build:release` | Build signed release APK |
| `npm run android:run` | Build and install on connected device/emulator |
| `npm run android:open` | Open project in Android Studio |
| `npm run android:doctor` | Check environment setup |

## Configuration

- **Web assets**: Loaded from `frontend/public/` (configured in `capacitor.config.json`)
- **Default API URL**: `https://termstation` (configured in `frontend/public/config.js`)
- **App ID**: `devtools.terminals`
- **App Name**: `TermStation`

## TLS / Self-Signed Certificates

The Android app requires HTTPS to function properly. For self-signed certificate setups:

1. The build automatically patches Android to trust user-installed CA certificates via Network Security Config
2. Install your CA certificate on the Android device:
   - Convert to DER format: `openssl x509 -in local-ca.crt -outform DER -out local-ca-android.cer`
   - Transfer to device
   - **Settings → Security → Encryption & credentials → Install a certificate → CA certificate**

See [INSTALL.md](../INSTALL.md) for full TLS setup instructions.

## Debugging

### View WebView console logs
```bash
adb logcat | grep -i "ApiService\|GlobalError\|UnhandledRejection\|Console"
```

### Remote inspect in Chrome
1. Enable USB debugging on device/emulator
2. Open Chrome on dev machine → `chrome://inspect`
3. Select your app to inspect

### Enable extra API logging
In the app's console:
```javascript
localStorage.setItem('tm_api_debug','1');
location.reload();
```

## Troubleshooting

### Environment issues
Run `npm run android:doctor` to diagnose common setup problems.

### Missing android/ directory
If `mobile/android/` is missing, run:
```bash
npm run android:add
```

### Rebuild after frontend changes
```bash
npm run android:sync
npm run android:build
```
