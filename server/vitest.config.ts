import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["server/src/**/*.test.ts"],
    coverage: {
      include: ["server/src/**/*.ts"],
      exclude: [
        "server/src/**/*.test.ts",
        "server/src/index.ts",
        "server/src/icloud/test.ts",
      ],
    },
  },
});
