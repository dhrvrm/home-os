import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, HOMEOS_MCP_RESOURCE: "https://home-os.test/mcp", HOMEOS_SETUP_TOKEN: "test-setup-secret", HOMEOS_PASSWORD_PEPPER: "test-pepper-at-least-thirty-two-characters-long" },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      // Each file starts a real Worker/D1/KV runtime; bound startup contention.
      maxWorkers: 2,
    },
  };
});
