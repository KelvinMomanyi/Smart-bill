import { defineConfig, loadEnv } from "vite";

// Tests and queue workers do not need the Remix development server or route scan.
export default defineConfig(({ mode }) => {
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { plugins: [] };
});
