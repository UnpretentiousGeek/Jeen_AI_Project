import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Mirrors the `@/*` path in tsconfig.json so component tests resolve app imports.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
});
