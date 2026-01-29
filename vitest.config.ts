import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

// Module resolver for CommonJS compatibility in ESM context
// @ts-ignore
const resolver = createRequire(import.meta.url);

// Constants for Allure configuration
const OUTPUT_DIR = "./out/allure-results";
const MODULE_LABEL = "commons";

export default defineConfig({
  test: {
    setupFiles: [resolver.resolve("allure-vitest/setup")],
    reporters: [
      "default",
      [
        "allure-vitest/reporter",
        {
          resultsDir: OUTPUT_DIR,
          globalLabels: [{ name: "module", value: MODULE_LABEL }],
        },
      ],
    ],
  },
});
