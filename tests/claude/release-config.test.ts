import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";

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

type YamlRecord = Readonly<Record<string, unknown>>;

const isYamlRecord = (value: unknown): value is YamlRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const config = fs.existsSync("release-please-config.json")
  ? (JSON.parse(fs.readFileSync("release-please-config.json", "utf8")) as ReleaseConfig)
  : {};
const manifest = fs.existsSync(".release-please-manifest.json")
  ? (JSON.parse(fs.readFileSync(".release-please-manifest.json", "utf8")) as ReleaseManifest)
  : {};
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
const releaseWorkflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const parsedReleaseWorkflow: unknown = parseYaml(releaseWorkflow);

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
    if (!isYamlRecord(parsedReleaseWorkflow)) {
      throw new Error("Release workflow must be a YAML mapping");
    }

    const jobs = parsedReleaseWorkflow["jobs"];
    if (!isYamlRecord(jobs)) {
      throw new Error("Release workflow must define jobs");
    }

    const releaseJob = jobs["release-please"];
    if (!isYamlRecord(releaseJob)) {
      throw new Error("Release workflow must define the release-please job");
    }

    const steps = releaseJob["steps"];
    if (!Array.isArray(steps)) {
      throw new Error("Release Please job must define steps");
    }

    const releaseStep = steps.find(
      (step) =>
        isYamlRecord(step) &&
        step["uses"] === "googleapis/release-please-action@v4",
    );
    if (!isYamlRecord(releaseStep)) {
      throw new Error("Release workflow must use the Release Please action");
    }

    const withValues = releaseStep["with"];
    if (!isYamlRecord(withValues)) {
      throw new Error("Release Please action must define with values");
    }

    expect(withValues["config-file"]).toBe("release-please-config.json");
    expect(withValues["manifest-file"]).toBe(".release-please-manifest.json");
    expect(withValues["release-type"]).not.toBe("node");
  });

  test("tracks the current package version in the release manifest", () => {
    expect(manifest["."]).toBe(packageJson.version);
  });
});
