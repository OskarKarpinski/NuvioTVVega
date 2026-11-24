import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vegaRoot = path.resolve(__dirname, "..");
const smartDist = path.resolve(vegaRoot, "../NuvioTVSmart/dist");
const targetWebDir = path.join(vegaRoot, "assets", "web");

await rm(targetWebDir, { recursive: true, force: true });
await mkdir(targetWebDir, { recursive: true });
await cp(smartDist, targetWebDir, { recursive: true });

try {
  const officialEnv = await readFile(path.join(vegaRoot, "nuvio.env.official.js"), "utf8");
  await writeFile(path.join(targetWebDir, "nuvio.env.js"), officialEnv, "utf8");
} catch (_) {
  // Keep nuvio.env.js from NuvioTVSmart/dist if no official override exists.
}

// Bundle precompiled i18n JSON files into nuvio.i18n.js so file:// WebView on Vega OS
// does not fail with Chromium file:// XHR CORS restrictions.
const i18nDir = path.join(targetWebDir, "res", "i18n");
const bundles = {};
try {
  const entries = await readdir(i18nDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const locale = entry.slice(0, -5);
    const raw = await readFile(path.join(i18nDir, entry), "utf8");
    bundles[locale] = JSON.parse(raw);
  }
} catch (error) {
  console.warn("Warning: could not inline i18n bundles:", error?.message || error);
}

await writeFile(
  path.join(targetWebDir, "nuvio.i18n.js"),
  `window.__NUVIO_I18N_BUNDLES__ = ${JSON.stringify(bundles)};\n`,
  "utf8"
);

const indexPath = path.join(targetWebDir, "index.html");
let indexHtml = await readFile(indexPath, "utf8");
if (!indexHtml.includes("nuvio.i18n.js")) {
  indexHtml = indexHtml.replace(
    '<script defer src="nuvio.env.js"></script>',
    '<script defer src="nuvio.env.js"></script>\n    <script defer src="nuvio.i18n.js"></script>'
  );
  await writeFile(indexPath, indexHtml, "utf8");
}

console.log(
  `Synced NuvioTVSmart/dist -> ${targetWebDir} (inlined ${Object.keys(bundles).length} i18n locales)`
);
