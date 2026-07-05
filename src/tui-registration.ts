import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, modify, applyEdits } from "jsonc-parser";

export interface TuiRegistrationDeps {
  configDir: string;
  serverModuleUrl: string;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
}

function parseJsonc(content: string): unknown {
  return parse(content, [], { allowTrailingComma: true });
}

function isAkanePlugin(entry: string): boolean {
  if (entry === "@yohi/akane" || entry.startsWith("@yohi/akane@")) {
    return true;
  }
  if (entry.startsWith("file:")) {
    const segments = entry.replace(/^file:\/\//, "").split(/[\\/]/);
    const basename = segments[segments.length - 1];
    return (
      basename === "akane" ||
      basename?.startsWith("akane-") === true ||
      basename?.startsWith("akane@") === true
    );
  }
  return false;
}

function isAkaneTuiEntry(entry: string): boolean {
  if (!entry.startsWith("file:")) {
    return false;
  }
  const segments = entry.replace(/^file:\/\//, "").split(/[\\/]/);
  const basename = segments[segments.length - 1];
  if (basename !== "tui.js") {
    return false;
  }
  // Conservative cleanup: only treat dist/tui.js paths inside an akane package
  // directory as derived TUI entries. This avoids accidentally removing unrelated
  // plugins while still cleaning up stale akane TUI specs.
  const parentDir = segments[segments.length - 2];
  if (parentDir !== "dist") {
    return false;
  }
  const packageDir = segments[segments.length - 3];
  return (
    packageDir === "akane" ||
    packageDir?.startsWith("akane-") === true ||
    packageDir?.startsWith("akane@") === true
  );
}

function deriveTuiPluginSpec(
  serverEntry: string,
  serverModuleUrl: string,
  exists: (path: string) => boolean,
): string | undefined {
  // npm package specs are resolved by OpenCode via package.json exports, so keep them as-is.
  if (!serverEntry.startsWith("file:")) {
    return serverEntry;
  }

  // For local file: specs, OpenCode TUI path loading never uses package.json main,
  // so a directory spec cannot load the TUI plugin. Derive the actual TUI module file
  // from the running server plugin location.
  if (!serverModuleUrl.startsWith("file:")) {
    return undefined;
  }

  const serverPath = fileURLToPath(serverModuleUrl);
  const serverDir = dirname(serverPath);
  const parentDir = dirname(serverDir);
  const dirName = serverDir.split(/[\\/]/).pop();

  let tuiPath: string;
  if (dirName === "dist") {
    tuiPath = join(serverDir, "tui.js");
  } else if (dirName === "src") {
    tuiPath = join(parentDir, "dist", "tui.js");
  } else {
    return undefined;
  }

  if (!exists(tuiPath)) {
    return undefined;
  }

  return pathToFileURL(tuiPath).href;
}

function loadServerConfig(
  configDir: string,
  readFile: (path: string) => string,
  exists: (path: string) => boolean,
): { plugin?: unknown } | null {
  const jsoncPath = join(configDir, "opencode.jsonc");
  const jsonPath = join(configDir, "opencode.json");

  if (exists(jsoncPath)) {
    try {
      return parseJsonc(readFile(jsoncPath)) as { plugin?: unknown };
    } catch {
      return null;
    }
  } else if (exists(jsonPath)) {
    try {
      return JSON.parse(readFile(jsonPath)) as { plugin?: unknown };
    } catch {
      return null;
    }
  }

  return null;
}

function readTuiConfig(
  tuiJsonPath: string,
  readFile: (path: string) => string,
  exists: (path: string) => boolean,
): { plugin: unknown[]; originalText: string } {
  let originalText = "{}";
  if (exists(tuiJsonPath)) {
    try {
      originalText = readFile(tuiJsonPath);
    } catch {
      originalText = "{}";
    }
  }

  let tuiConfig = parseJsonc(originalText) as { plugin?: unknown } | null;
  if (!tuiConfig || typeof tuiConfig !== "object") {
    tuiConfig = {};
  }
  if (!Array.isArray(tuiConfig.plugin)) {
    tuiConfig.plugin = [];
  }

  return { plugin: tuiConfig.plugin as unknown[], originalText };
}

function normalizePluginList(pluginList: unknown[], tuiSpec: string): unknown[] {
  // Remove any existing akane server or derived TUI entries to avoid
  // duplicate/conflicting specs.
  const cleaned = pluginList.filter((entry) => {
    return !(typeof entry === "string" && (isAkanePlugin(entry) || isAkaneTuiEntry(entry)));
  });

  // Only add if the exact target spec is not already present.
  if (!cleaned.includes(tuiSpec)) {
    cleaned.push(tuiSpec);
  }

  return cleaned;
}

export function ensureTuiPluginEntry(deps: TuiRegistrationDeps): void {
  try {
    ensureTuiPluginEntryUnsafe(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[akane] Failed to ensure TUI plugin entry: ${message}`);
  }
}

function ensureTuiPluginEntryUnsafe(deps: TuiRegistrationDeps): void {
  const { configDir, serverModuleUrl, readFile, writeFile, exists, mkdir } = deps;

  const serverConfig = loadServerConfig(configDir, readFile, exists);
  if (!serverConfig || !Array.isArray(serverConfig.plugin)) {
    return;
  }

  const serverEntry = serverConfig.plugin.find((entry: unknown) => {
    return typeof entry === "string" && isAkanePlugin(entry);
  }) as string | undefined;

  if (!serverEntry) {
    return;
  }

  const tuiSpec = deriveTuiPluginSpec(serverEntry, serverModuleUrl, exists);
  if (!tuiSpec) {
    return;
  }

  const tuiJsonPath = join(configDir, "tui.json");
  const { plugin: pluginList, originalText } = readTuiConfig(tuiJsonPath, readFile, exists);

  const cleaned = normalizePluginList(pluginList, tuiSpec);

  // Avoid unnecessary disk I/O when the plugin list is unchanged.
  if (JSON.stringify(pluginList) === JSON.stringify(cleaned)) {
    return;
  }

  const edits = modify(originalText, ["plugin"], cleaned, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2,
    },
  });

  if (edits.length === 0) {
    return;
  }

  mkdir(configDir);
  const updatedText = applyEdits(originalText, edits);
  writeFile(tuiJsonPath, updatedText.trim() + "\n");
}

export function defaultTuiRegistrationDeps(): TuiRegistrationDeps {
  return {
    configDir: getOpenCodeConfigDir(),
    serverModuleUrl: import.meta.url,
    readFile: (path) => readFileSync(path, "utf-8"),
    writeFile: (path, content) => writeFileSync(path, content),
    exists: (path) => existsSync(path),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  };
}

function getOpenCodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

export function ensureTuiPluginEntryDefault(): void {
  ensureTuiPluginEntry(defaultTuiRegistrationDeps());
}
