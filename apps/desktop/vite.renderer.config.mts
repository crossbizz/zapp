import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const ReactCompilerConfig = {};

// https://vite.dev/config/
export default defineConfig({
  build: { sourcemap: "hidden" },
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // zapp: @electron-forge/plugin-vite hardcodes `resolve.preserveSymlinks:
    // true` for the renderer, which assumes a flat npm/yarn node_modules. Under
    // pnpm every dependency is a symlink into the virtual store, so esbuild
    // resolves transitive imports (motion-dom, @base-ui/utils/*, tiny-invariant,
    // ...) from the *link* path and fails with ~600 "Could not resolve" errors.
    // `mergeConfig` gives this user config precedence over Forge's default.
    preserveSymlinks: false,
  },
});
