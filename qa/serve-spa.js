#!/usr/bin/env node
/* VaultDex dev/QA static server with SPA fallback — NOT part of the app.
 *
 * `python3 -m http.server` can't serve the app's clean URLs (/set/<id>,
 * /browse, ...) because those only exist in vercel.json rewrites; this tiny
 * dependency-free Node server mirrors the rewrite table: any path that isn't
 * a real file (or is extensionless) falls back to /index.html, whose client
 * router then renders the right view. Port defaults to 8080.
 *
 * Usage: node qa/serve-spa.js [port]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2] || 8080);
const INDEX = path.join(ROOT, "index.html");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  let file = path.normalize(path.join(ROOT, clean));
  // Keep the server jailed to the repo root (path traversal guard).
  if (!file.startsWith(ROOT + path.sep)) return INDEX;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch {
    /* not a real file/directory — SPA fallback below */
  }
  // SPA fallback: extensionless app routes (/set/<id>, /browse, ...) don't
  // exist on disk; serve index.html and let js/app.js route client-side.
  try {
    if (!fs.statSync(file).isFile()) return INDEX;
  } catch {
    return INDEX;
  }
  return file;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url || "/");
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("serve-spa: read failed");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`vaultdex spa static server: http://127.0.0.1:${PORT} (root ${ROOT})`);
});
