import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Host } from "@opencode/plugin/host";

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    console.error(`Command failed: ${command.join(" ")}\n${stderr}`);
  }

  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const sourceDirectory = process.cwd();
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "akane-publish-test-"));

function resolvedServerEntrypoint(): string {
  const { server } = Host.resolve({ directory: fixtureDirectory });
  if (server === undefined) throw new Error("OpenCode did not resolve the local server entrypoint");
  return server;
}

function symlinkDependency(source: string, target: string): void {
  const type = fs.statSync(source).isDirectory() ? "dir" : "file";
  fs.symlinkSync(source, target, type);
}

describe("published package contents", () => {
  beforeAll(() => {
    for (const file of ["package.json", "build.ts", "server.js", "README.md", "LICENSE"]) {
      fs.copyFileSync(path.join(sourceDirectory, file), path.join(fixtureDirectory, file));
    }
    fs.cpSync(path.join(sourceDirectory, "src"), path.join(fixtureDirectory, "src"), { recursive: true });
    const sourceNodeModules = path.join(sourceDirectory, "node_modules");
    const fixtureNodeModules = path.join(fixtureDirectory, "node_modules");
    fs.mkdirSync(fixtureNodeModules);
    for (const name of fs.readdirSync(sourceNodeModules)) {
      const source = path.join(sourceNodeModules, name);
      const target = path.join(fixtureNodeModules, name);
      if (name.startsWith("@")) {
        fs.mkdirSync(target);
        for (const scopedName of fs.readdirSync(source)) {
          symlinkDependency(path.join(source, scopedName), path.join(target, scopedName));
        }
      } else {
        symlinkDependency(source, target);
      }
    }
    const fixturePackageScope = path.join(fixtureNodeModules, "@yohi");
    fs.mkdirSync(fixturePackageScope, { recursive: true });
    fs.symlinkSync(fixtureDirectory, path.join(fixturePackageScope, "akane"), "dir");

    expect(fs.existsSync(path.join(fixtureDirectory, "dist"))).toBe(false);
    run([process.execPath, "run", "build"], fixtureDirectory);
  });

  afterAll(() => {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("resolves server.js as the OpenCode local server entrypoint", () => {
    expect(resolvedServerEntrypoint()).toBe(pathToFileURL(path.join(fixtureDirectory, "server.js")).href);
  });

  it("loads the resolved entrypoint's V2 default plugin", async () => {
    const loaded: unknown = await Host.load(resolvedServerEntrypoint());
    if (!isRecord(loaded) || !isRecord(loaded.default)) throw new Error("Local server entrypoint is not a plugin");
    expect(loaded.default.id).toBe("opencode-watchdog");
    expect(typeof loaded.default.setup).toBe("function");
  });

  it("publishes an importable V2 server without a TUI entry or wrapper", async () => {
    const output = run([process.execPath, "pm", "pack", "--dry-run"], fixtureDirectory);
    const filePaths = new Set(
      [...output.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((match) => match[1]),
    );

    expect(filePaths.has("dist/index.js")).toBe(true);
    expect(filePaths.has("server.js")).toBe(true);
    expect(filePaths.has("dist/tui.js")).toBe(false);
    expect(filePaths.has(".opencode/plugins/akane.tui.js")).toBe(false);
    const modulePath = pathToFileURL(path.join(fixtureDirectory, "dist/index.js")).href;
    const loaded: unknown = await import(modulePath);
    if (!isRecord(loaded) || !isRecord(loaded.default)) throw new Error("V2 package entrypoint is not an object");
    expect(loaded.default.id).toBe("opencode-watchdog");
    expect(typeof loaded.default.setup).toBe("function");
    expect("server" in loaded.default).toBe(false);
  }, { timeout: 30000 });

  it("preserves both existing package export imports", async () => {
    const packageJson = JSON.parse(await Bun.file("package.json").text()) as {
      exports: Record<string, string>;
    };
    expect(packageJson.exports["."]).toBe("./dist/index.js");
    expect(packageJson.exports["./server"]).toBe("./dist/index.js");

    const script = [
      'const plugins = [];',
      'for (const specifier of ["@yohi/akane", "@yohi/akane/server"]) {',
      '  const loaded = await import(specifier);',
      '  plugins.push({ id: loaded.default.id, setup: typeof loaded.default.setup });',
      '}',
      'console.log(JSON.stringify(plugins));',
    ].join("\n");
    const plugins: unknown = JSON.parse(run([process.execPath, "-e", script], fixtureDirectory));
    expect(plugins).toEqual([
      { id: "opencode-watchdog", setup: "function" },
      { id: "opencode-watchdog", setup: "function" },
    ]);
  });
});
