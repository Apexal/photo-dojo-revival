import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defaultClientConditions, type Connect, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Serve /capture, /studio and /about like Cloudflare Pages does (pretty URLs for their .html files). */
function prettyUrls(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const match = req.url?.match(/^\/(capture|studio|about)\/?(\?.*)?$/);
    if (match) req.url = `/${match[1]}.html${match[2] ?? ""}`;
    next();
  };
  return {
    name: "pretty-urls",
    configureServer: (server) => { server.middlewares.use(rewrite); },
    configurePreviewServer: (server) => { server.middlewares.use(rewrite); },
  };
}

/**
 * Serve models/ (built by scripts/build-matting-model.py, git-ignored) at /models/.
 * Not in public/: the files are far over Cloudflare Pages' 25 MiB limit, so
 * production builds point VITE_MATTING_MODEL_URL at wherever they're hosted.
 */
function localModels(): Plugin {
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const match = req.url?.match(/^\/models\/([\w.-]+\.onnx)(\?|$)/);
    const file = match && resolve(import.meta.dirname, "models", match[1]);
    if (!file || !existsSync(file)) return next();
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", statSync(file).size);
    createReadStream(file).pipe(res);
  };
  return {
    name: "local-models",
    configureServer: (server) => { server.middlewares.use(serve); },
    configurePreviewServer: (server) => { server.middlewares.use(serve); },
  };
}

/**
 * HTML placeholders: __APP_VERSION__ (package.json) and __SITE_URL__ (VITE_SITE_URL,
 * e.g. https://photo-dojo.pages.dev: link previews need an absolute image URL;
 * without it they fall back to a relative one, which some apps ignore).
 */
function htmlPlaceholders(): Plugin {
  const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string };
  const siteUrl = (process.env.VITE_SITE_URL ?? "").replace(/\/$/, "");
  return {
    name: "html-placeholders",
    transformIndexHtml: (html) => html.replaceAll("__APP_VERSION__", version).replaceAll("__SITE_URL__", siteUrl),
  };
}

const workerProxy = {
  "/room": { target: "http://localhost:8787", ws: true, changeOrigin: true },
  "/turn-credentials": { target: "http://localhost:8787", changeOrigin: true },
};

export default defineConfig({
  // HTTPS=1 npm run dev: self-signed HTTPS so phones on the LAN get camera access.
  plugins: [prettyUrls(), htmlPlaceholders(), localModels(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  server: {
    host: true,
    // The signaling Worker (wrangler dev on :8787) is proxied through the dev server, so pages
    // use same-origin ws(s):// and a phone only has to trust one certificate.
    proxy: workerProxy,
    allowedHosts: [".ngrok-free.dev", "localhost"]
  },
  preview: { host: true, proxy: workerProxy },
  resolve: {
    // ONNX Runtime without its 28 MB WASM bundled in: that's over Cloudflare Pages' 25 MiB file limit.
    // It's loaded from the CDN instead (ORT_RUNTIME_BASE in src/capture/vision-runtime.ts).
    conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions],
  },
  build: {
    target: "es2022",
    // Phaser alone is ~1.2 MB minified.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        // The phone camera page: streams to the studio (docs/character-studio.md §4).
        capture: resolve(import.meta.dirname, "capture.html"),
        about: resolve(import.meta.dirname, "about.html"),
        // The Character Studio: builds fighters on the computer (docs/character-studio.md).
        studio: resolve(import.meta.dirname, "studio.html"),
      },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
