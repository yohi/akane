import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";

type ExtraFile = {
  type: string;
  path: string;
  jsonpath: string;
};

type ReleaseConfig = {
  "include-component-in-tag"?: boolean;
  packages?: {
    "."?: {
      "release-type"?: string;
      "extra-files"?: ExtraFile[];
    };
  };
};

type ReleaseManifest = Record<string, string>;

const config = fs.existsSync("release-please-config.json")
  ? (JSON.parse(fs.readFileSync("release-please-config.json", "utf8")) as ReleaseConfig)
  : {};
const manifest = fs.existsSync(".release-please-manifest.json")
  ? (JSON.parse(fs.readFileSync(".release-please-manifest.json", "utf8")) as ReleaseManifest)
  : {};
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
const releaseWorkflow = fs.readFileSync(".github/workflows/release.yml", "utf8");

describe("release-please configuration", () => {
  test("updates the Claude plugin manifest with the package version", () => {
    const rootPackage = config.packages?.["."];
    const extraFiles = rootPackage?.["extra-files"] ?? [];

    expect(config["include-component-in-tag"]).toBe(false);
    expect(rootPackage?.["release-type"]).toBe("node");
    expect(extraFiles).toContainEqual({
      type: "json",
      path: ".claude-plugin/plugin.json",
      jsonpath: "$.version",
    });
  });

  test("runs Release Please in manifest mode", () => {
    expect(releaseWorkflow).toContain("config-file: release-please-config.json");
    expect(releaseWorkflow).toContain("manifest-file: .release-please-manifest.json");
    expect(releaseWorkflow).not.toContain("release-type: node");
  });

  test("tracks the current package version in the release manifest", () => {
    expect(manifest["."]).toBe(packageJson.version);
  });
});
