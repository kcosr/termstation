# Mobile (Android) – Capacitor Build

This directory contains the Capacitor scaffolding to build the TermStation web app (`frontend/public`) as a native mobile application.

Layout:
- `mobile/` – Capacitor project root, shared across platforms
- `mobile/android/` – Generated Android native project (not committed)
- `mobile/ios/` – (future) iOS native project (not yet generated)

## Prerequisites

- Node.js 18+ and npm
- Android Studio + Android SDK (SDK Platform + Build-Tools)
- Java JDK 17
- ANDROID_HOME configured and `platform-tools` on PATH (for `adb`)

## Initial Setup

```
cd mobile
npm install
npm run android:add   # generates `mobile/android/` (one-time)
```

If you ever change web assets in `frontend/public`, sync them:

```
npm run android:sync
```

## Build and Run

Debug APK:

```
npm run android:build
```

Install debug build on a connected device/emulator:

```
npm run android:run
```

Open the project in Android Studio for advanced configuration:

```
npm run android:open
```

Release build (signed configuration should be set up in Android Studio/Gradle):

```
npm run android:build:release
```

Doctor (environment diagnostics):

```
npm run android:doctor
```

## Notes

- Web assets are pulled from `../frontend/public` as configured in `capacitor.config.json`.
- The generated `android/` and `node_modules/` directories are intentionally ignored from version control.
- If `android/` is missing, run `npm run android:add` before other Android commands.

## Self-signed certificates (Android)

- The Android project is patched automatically on `npm run android:add` to trust system and user-installed CAs via Android Network Security Config.
  - File: `app/src/main/res/xml/network_security_config.xml`
  - Manifest: `app/src/main/AndroidManifest.xml` annotated with `android:networkSecurityConfig`.
- If you do NOT want to install a CA on the device, the app can route API calls through a native HTTP client that bypasses TLS verification (for development only):
  - We include `cordova-plugin-advanced-http` and the client is auto-detected at runtime under Capacitor.
  - The client is configured to `nocheck` server trust mode for API calls, bypassing TLS errors (self-signed OK). Use only in trusted environments.
  - This bypass affects only in-app API traffic; it does not change WebView page loading.

## Default API URL for mobile

- The build uses `frontend/public/config.js` directly.
- Default API base is `https://termstation` in that config. You can override it later via in-app settings if needed.

## Debugging on Android

- View WebView console logs in `adb`:
  - `adb logcat | grep -i "ApiService\|GlobalError\|UnhandledRejection\|Console"`
- Remote inspect the WebView console:
  - Enable USB debugging on the device/emulator
  - Open Chrome on your dev machine → `chrome://inspect` → inspect your app
- Force extra API logs (optional):
  - In the app’s console: `localStorage.setItem('tm_api_debug','1'); location.reload();`
  - Or append `?apiDebug=1` to the app URL if serving over HTTP for tests
- Confirm transport in logs:
  - Look for `[ApiService] Transport=native` vs `Transport=fetch`
  - Each request logs method, URL, headers (Authorization redacted), and response/error info
