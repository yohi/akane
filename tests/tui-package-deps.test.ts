import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const TUI_RUNTIME_DEPS = ["@opentui/core", "@opentui/solid", "solid-js"];

describe("TUI package runtime dependencies", () => {
  it("declares all TUI runtime dependencies in dependencies, not devDependencies", () => {
    for (const name of TUI_RUNTIME_DEPS) {
      expect(pkg.dependencies?.[name]).toBeDefined();
      expect(pkg.devDependencies?.[name]).toBeUndefined();
    }
  });
});
