import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Unit tests must never touch the network. Integration work lives in scripts/.
    testTimeout: 10_000,
  },
});
