import * as fs from "node:fs";
import * as path from "node:path";
import { eventsPathFor, sanitizeSessionId } from "./state-dir";
import { safeError } from "./safe-error";

const TOMBSTONE_FILE = "tombstones.json";
const TOMBSTONE_CAPACITY = 10_000;
const NDJSON_EXT = ".ndjson";

export function deleteSessionLog(stateDir: string, sessionId: string): void {
  try {
    fs.rmSync(eventsPathFor(stateDir, sessionId));
  } catch {
    // Already gone (SessionEnd race / prior sweep). Tolerated.
  }
}

export class TombstoneStore {
  private readonly filePath: string;
  private ids: string[];

  constructor(private readonly dir: string) {
    this.filePath = path.join(dir, TOMBSTONE_FILE);
    this.ids = this.load();
  }

  private load(): string[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
    } catch {
      // Missing / corrupt — start empty.
    }
    return [];
  }

  has(sessionId: string): boolean {
    return this.ids.includes(sanitizeSessionId(sessionId));
  }

  record(sessionId: string): void {
    const id = sanitizeSessionId(sessionId);
    if (this.ids.includes(id)) return;
    this.ids.push(id);
    if (this.ids.length > TOMBSTONE_CAPACITY) {
      this.ids = this.ids.slice(-TOMBSTONE_CAPACITY);
    }
    this.flush();
  }

  private flush(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.ids));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn(`[akane] tombstone flush failed: ${safeError(err)}`);
    }
  }
}

export interface SweepDeps {
  now: number;
  ttlMs: number;
  isTombstoned: (fileStem: string) => boolean;
}

export function sweepOrphans(dir: string, deps: SweepDeps): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(NDJSON_EXT));
  } catch {
    return [];
  }
  const swept: string[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const stem = name.slice(0, -NDJSON_EXT.length);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }
    const expired = deps.now - mtimeMs > deps.ttlMs;
    if (deps.isTombstoned(stem) || expired) {
      try {
        fs.rmSync(filePath);
        swept.push(stem);
      } catch {
        // Race with another deleter — ignore.
      }
    }
  }
  return swept;
}
