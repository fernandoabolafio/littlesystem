import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };
import { createApi } from "./server/api";

/** Serves the same /api the CLI does, so `pnpm dev` edits your real littlesystem projects. */
function localApi(): Plugin {
  return {
    name: "littlesystem-api",
    configureServer(server) {
      const api = createApi({ version: pkg.version });
      server.middlewares.use((req, res, next) => api.handle(req, res, next));
      server.httpServer?.on("close", () => api.close());
    },
  };
}

export default defineConfig({
  plugins: [react(), localApi()],
  build: { outDir: "dist/app", emptyOutDir: true },
});
