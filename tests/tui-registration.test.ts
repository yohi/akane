import { describe, it, expect } from "bun:test";
import { ensureTuiPluginEntry, type TuiRegistrationDeps } from "../src/tui-registration";

function createFs(initial: Record<string, string> = {}): {
  files: Map<string, string>;
  deps: TuiRegistrationDeps;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const deps: TuiRegistrationDeps = {
    configDir: "/home/test/.config/opencode",
    serverModuleUrl: "file:///home/test/.config/opencode/plugins/akane/dist/index.js",
    readFile: (p) => {
      const content = files.get(p);
      if (content === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return content;
    },
    writeFile: (p, c) => files.set(p, c),
    exists: (p) => files.has(p),
    mkdir: () => {},
  };
  return { files, deps };
}

describe("ensureTuiPluginEntry", () => {
  it("writes the TUI plugin file URL when server config uses a file: directory entry", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({ plugin: [] }),
      "/home/test/.config/opencode/plugins/akane/dist/tui.js": "export default {}",
    });

    ensureTuiPluginEntry(deps);

    const written = deps.readFile("/home/test/.config/opencode/tui.json");
    const config = JSON.parse(written);
    expect(config.plugin).toContain(
      "file:///home/test/.config/opencode/plugins/akane/dist/tui.js",
    );
  });

  it("preserves npm package entries as-is", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["@yohi/akane@latest"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({ plugin: [] }),
      "/home/test/.config/opencode/plugins/akane/dist/tui.js": "export default {}",
    });

    ensureTuiPluginEntry(deps);

    const written = deps.readFile("/home/test/.config/opencode/tui.json");
    const config = JSON.parse(written);
    expect(config.plugin).toContain("@yohi/akane@latest");
  });

  it("does nothing when akane is not in server config", () => {
    const { deps, files } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["some-other-plugin"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({ plugin: [] }),
      "/home/test/.config/opencode/plugins/akane/dist/tui.js": "export default {}",
    });

    ensureTuiPluginEntry(deps);

    expect(files.has("/home/test/.config/opencode/tui.json")).toBe(true);
    const config = JSON.parse(deps.readFile("/home/test/.config/opencode/tui.json"));
    expect(config.plugin).toEqual([]);
  });

  it("does not add duplicate TUI file URL", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane/dist/tui.js"],
      }),
      "/home/test/.config/opencode/plugins/akane/dist/tui.js": "export default {}",
    });

    ensureTuiPluginEntry(deps);

    const written = deps.readFile("/home/test/.config/opencode/tui.json");
    const config = JSON.parse(written);
    expect(config.plugin).toEqual([
      "file:///home/test/.config/opencode/plugins/akane/dist/tui.js",
    ]);
  });

  it("replaces an existing directory-style akane entry with the TUI file URL", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane"],
      }),
      "/home/test/.config/opencode/plugins/akane/dist/tui.js": "export default {}",
    });

    ensureTuiPluginEntry(deps);

    const written = deps.readFile("/home/test/.config/opencode/tui.json");
    const config = JSON.parse(written);
    expect(config.plugin).not.toContain("file:///home/test/.config/opencode/plugins/akane");
    expect(config.plugin).toContain(
      "file:///home/test/.config/opencode/plugins/akane/dist/tui.js",
    );
  });

  it("does not write when dist/tui.js does not exist", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({ plugin: [] }),
    });

    ensureTuiPluginEntry(deps);

    const written = deps.readFile("/home/test/.config/opencode/tui.json");
    const config = JSON.parse(written);
    expect(config.plugin).toEqual([]);
  });

  it("derives dist/tui.js from src/index.ts during development", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["file:///home/test/projects/akane"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({ plugin: [] }),
      "/home/test/projects/akane/dist/tui.js": "export default {}",
    });
    deps.serverModuleUrl = "file:///home/test/projects/akane/src/index.ts";

    ensureTuiPluginEntry(deps);

    const written = deps.readFile("/home/test/.config/opencode/tui.json");
    const config = JSON.parse(written);
    expect(config.plugin).toContain("file:///home/test/projects/akane/dist/tui.js");
  });

  it("does not throw when mkdir/writeFile fails", () => {
    const deps: TuiRegistrationDeps = {
      configDir: "/home/test/.config/opencode",
      serverModuleUrl: "file:///home/test/.config/opencode/plugins/akane/dist/index.js",
      readFile: () => {
        throw new Error("read error");
      },
      writeFile: () => {
        throw new Error("write error");
      },
      exists: () => true,
      mkdir: () => {
        throw new Error("mkdir error");
      },
    };
    expect(() => ensureTuiPluginEntry(deps)).not.toThrow();
  });

  it("removes stale akane dist/tui.js entries when the plugin path changes", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({
        plugin: [
          "file:///home/test/.config/opencode/plugins/akane-old/dist/tui.js",
          "file:///home/test/.config/opencode/plugins/akane/dist/tui.js",
        ],
      }),
      "/home/test/.config/opencode/plugins/akane/dist/tui.js": "export default {}",
    });

    ensureTuiPluginEntry(deps);

    const written = deps.readFile("/home/test/.config/opencode/tui.json");
    const config = JSON.parse(written);
    expect(config.plugin).toEqual([
      "file:///home/test/.config/opencode/plugins/akane/dist/tui.js",
    ]);
  });

  it("does not write tui.json when the plugin list is already up to date", () => {
    const { deps } = createFs({
      "/home/test/.config/opencode/opencode.jsonc": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane"],
      }),
      "/home/test/.config/opencode/tui.json": JSON.stringify({
        plugin: ["file:///home/test/.config/opencode/plugins/akane/dist/tui.js"],
      }),
      "/home/test/.config/opencode/plugins/akane/dist/tui.js": "export default {}",
    });

    let writeCount = 0;
    const originalWriteFile = deps.writeFile;
    deps.writeFile = (p, c) => {
      writeCount++;
      originalWriteFile(p, c);
    };

    ensureTuiPluginEntry(deps);

    expect(writeCount).toBe(0);
  });
});

