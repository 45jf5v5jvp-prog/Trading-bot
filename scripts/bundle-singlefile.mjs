/*
 * Builds a single self-contained sideaction.html from the Vite production build.
 * Inlines the JS bundle, the manifest, and the icons (as data URIs) so the whole
 * app is one portable file with no external files to host alongside it.
 * Run `npm run build` first, then `node scripts/bundle-singlefile.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pub = path.join(root, 'public');

// Find the built JS bundle
const assetsDir = path.join(dist, 'assets');
const jsName = fs.readdirSync(assetsDir).find((f) => f.endsWith('.js'));
if (!jsName) throw new Error('No JS bundle found in dist/assets — run `npm run build` first.');
const bundle = fs.readFileSync(path.join(assetsDir, jsName), 'utf8');

const dataUri = (file, mime) =>
  `data:${mime};base64,${fs.readFileSync(path.join(pub, file)).toString('base64')}`;

const appleIcon = dataUri('apple-touch-icon.png', 'image/png');
const icon192 = dataUri('icon-192.png', 'image/png');
const icon512 = dataUri('icon-512.png', 'image/png');
const favicon = dataUri('favicon-32.png', 'image/png');

// Manifest with inlined icons, itself inlined as a data URI
const manifest = {
  name: 'Side Action',
  short_name: 'Side Action',
  description: 'A golf betting tracker. Made by Scratch Certified.',
  start_url: '.',
  scope: '.',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#F1F5EC',
  theme_color: '#F1F5EC',
  icons: [
    { src: icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: icon512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
const manifestUri =
  'data:application/manifest+json;base64,' +
  Buffer.from(JSON.stringify(manifest)).toString('base64');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />

    <title>Side Action</title>
    <meta name="description" content="Side Action — a golf betting tracker. Made by Scratch Certified." />

    <!-- Theme + web app manifest (inlined) -->
    <meta name="theme-color" content="#F1F5EC" />
    <link rel="manifest" href="${manifestUri}" />

    <!-- iOS home-screen install: full screen, no browser chrome -->
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Side Action" />

    <!-- Icons (inlined) -->
    <link rel="apple-touch-icon" href="${appleIcon}" />
    <link rel="icon" type="image/png" sizes="32x32" href="${favicon}" />
    <link rel="icon" type="image/png" sizes="192x192" href="${icon192}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
${bundle}
    </script>
  </body>
</html>
`;

const out = path.join(root, 'sideaction.html');
fs.writeFileSync(out, html);
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`wrote sideaction.html (${kb} KB, one self-contained file)`);
