## Building xterm.js Browser Artifacts

This documents how to build the browser-ready xterm.js bundles from the `../xterm.js` checkout and where to find the outputs.

### 1. Install dependencies (once)

From the xterm.js repo:

```bash
cd ../xterm.js
npm install   # or: npm ci
```

### 2. Build the library and addons

Recommended full build (includes the classic UMD `xterm.js` bundle plus ESM bundles):

```bash
cd ../xterm.js
npm run package
```

This pipeline:

- Runs the TypeScript build into `out/`
- Uses webpack to produce `lib/xterm.js` (UMD) + sourcemap
- Uses esbuild to produce ESM bundles for the core library and addons

If you only need the ESM bundles and don’t care about the UMD `xterm.js`, you can run:

```bash
cd ../xterm.js
npm run esbuild-package
```

### 3. Where artifacts end up

After `npm run package` (or `npm run esbuild-package`), the key files are:

- Core terminal:
  - `lib/xterm.js` – UMD bundle, usable via `<script src="...">` with a global `Terminal`
  - `lib/xterm.mjs` – ESM bundle
  - `css/xterm.css` – stylesheet (already present in the repo)

- Addons (ESM):
  - `addons/addon-fit/lib/addon-fit.mjs`
  - `addons/addon-web-links/lib/addon-web-links.mjs`
  - Similar `lib/addon-*.mjs` for all other addons

### 4. Using artifacts in TermStation

For the existing “vendor” layout under `frontend/public/js/vendor/xterm/`:

- Copy the core artifacts from `../xterm.js` into the frontend:

  - `lib/xterm.js` → `frontend/public/js/vendor/xterm/xterm.js`
  - `css/xterm.css` → `frontend/public/js/vendor/xterm/xterm.css`

- For addons, you have two options:

  1. **ESM usage** (recommended for new code)  
     Import the addon ESM bundles directly from wherever you place them in the frontend, e.g.:

     ```js
     import { WebLinksAddon } from './vendor/xterm/addon-web-links.mjs';
     ```

  2. **Classic global-style addons** (to match older usage)  
     Wrap the addon source into IIFE/UMD bundles that attach themselves to globals, then copy those:

     ```bash
     cd ../xterm.js

     # Fit addon
     npx esbuild addons/addon-fit/src/FitAddon.ts \
       --bundle --format=iife --global-name=FitAddon \
       --outfile=addons/addon-fit/lib/addon-fit.js

     # Web links addon
     npx esbuild addons/addon-web-links/src/WebLinksAddon.ts \
       --bundle --format=iife --global-name=WebLinksAddon \
       --outfile=addons/addon-web-links/lib/addon-web-links.js
     ```

     Then copy the resulting `.js` files into `frontend/public/js/vendor/xterm/` and load them via `<script>` tags (as with the old vendor layout).

