import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "providers/**/*.test.ts", "services/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    sequence: { concurrent: false },
  },
});
