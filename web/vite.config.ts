import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Plain Vite config. (The Replit-era version required PORT/BASE_PATH env vars
// and Replit-only plugins; none of that applies outside Replit.)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  build: { outDir: "dist", emptyOutDir: true },
});
