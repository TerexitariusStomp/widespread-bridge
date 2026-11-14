import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/widespread-discovery/**", "**/watcher-web/**", "**/watcher-extension/**", "**/widespread-near/**", "**/widespread-mcp/**"],
  },
});
