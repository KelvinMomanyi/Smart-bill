import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Serve only generated fixtures, never the live OCR evidence or environment.
const allowed = /^(PNG\.png|JPG\.jpg|ROTATED180\.png|ROTATED90\.png|POOR\.png|MISSING\.png|PDF\.pdf|MULTIPAGE\.pdf|manifest\.json)$/;
export default defineConfig({
  envDir: false,
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false,
    fs: { deny: [".env", ".env.*", "*.{crt,pem,key}", "**/.git/**", "**/.cache/**", "**/.local-backups/**", "**/old/**"] },
  },
  plugins: [{ name: "ocr-test-fixtures", configureServer(server) {
    server.middlewares.use("/ocr-fixtures", async (req, res, next) => {
      const filename = (req.url || "").split("?")[0].slice(1);
      if (!allowed.test(filename)) return next();
      try {
        const buffer = await readFile(resolve(".cache/ocr-browser-fixtures", filename));
        res.setHeader("Content-Type", filename.endsWith(".json") ? "application/json" : filename.endsWith(".pdf") ? "application/pdf" : filename.endsWith(".jpg") ? "image/jpeg" : "image/png");
        res.end(buffer);
      } catch { res.statusCode = 404; res.end("Test fixture unavailable"); }
    });
  } }],
});
