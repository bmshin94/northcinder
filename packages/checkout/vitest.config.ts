import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The invariant-#4 compile-time battery: *.test-d.ts files are typechecked
    // with tsc — a raw PurchaseMandate reaching a rail is a BUILD failure.
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.typecheck.json",
      include: ["test/**/*.test-d.ts"],
    },
  },
});
