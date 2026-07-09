import * as fs from "node:fs";
import * as path from "node:path";
import { isAkaneClaudeEvent, type AkaneClaudeEvent } from "./event-types";
import { sanitizeSessionId } from "./state-dir";
import { safeError } from "./safe-error";

const NEWLINE = 0x0a;
const CURSOR_FILE = "cursors.json";

export function appendEvent(filePath: string, event: AkaneClaudeEvent): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Single write of one line. POSIX append (O_APPEND) is atomic for small
  // writes, satisfying the one-way IPC append requirement (SPEC §3-3/§8.2).
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

interface FileCursor {
  offset: number;
}

export class EventTailer {
  private readonly cursors: Map<string, FileCursor>;
  private readonly cursorFile: string;

  // `dir` is the events directory shared with the .ndjson logs. The optional
  // `pid` mirrors TombstoneStore so the atomic .tmp write uses a PID-unique
  // name (AGENTS.md §3.5 / SPEC §8.2). Callers keep the one-arg form:
  // `new EventTailer(dir)` stays source-compatible.
  constructor(private readonly dir: string, private readonly pid: number = process.pid) {
    this.cursorFile = path.join(dir, CURSOR_FILE);
    // Restore offsets persisted by a previous monitor process so a restart does
    // NOT re-dispatch already-processed events (which would, e.g., re-fire a
    // resolved input_requested -> notifier.notify("waiting") side effect via
    // event-map). Missing/corrupt file -> empty state (Zero-Crash).
    this.cursors = this.loadCursors();
  }

  poll(): AkaneClaudeEvent[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".ndjson")).sort();
    } catch {
      return []; // dir not created yet
    }
    const out: AkaneClaudeEvent[] = [];
    let advanced = false;
    for (const name of names) {
      const before = this.cursors.get(name)?.offset ?? 0;
      out.push(...this.readFile(name));
      // Persist only when an offset actually moved (forward progress OR a
      // truncation reset). Steady-state polls that read no new complete line
      // skip disk I/O entirely (task constraint: write only when advanced).
      if ((this.cursors.get(name)?.offset ?? 0) !== before) advanced = true;
    }
    if (advanced) this.persistCursors();
    return out;
  }

  private readFile(name: string): AkaneClaudeEvent[] {
    const filePath = path.join(this.dir, name);
    let content: Buffer;
    try {
      content = fs.readFileSync(filePath);
    } catch {
      this.cursors.delete(name);
      return [];
    }
    const cursor = this.cursors.get(name) ?? { offset: 0 };
    // Saved offset now exceeds the file length => the file was replaced, not
    // appended to. .ndjson logs are never rotated in place; they are deleted
    // wholesale on session_end (deleteSessionLog) or by the orphan sweep. This
    // branch therefore fires when a NEW file appears under a previously-used
    // name — e.g. a persisted cursor (cursors.json) outliving its deleted log,
    // or a reused session id — where the stale offset would otherwise skip the
    // fresh content. Reset to re-read from the start.
    if (content.length < cursor.offset) cursor.offset = 0;
    const slice = content.subarray(cursor.offset);
    const lastNl = slice.lastIndexOf(NEWLINE);
    if (lastNl === -1) {
      this.cursors.set(name, cursor); // no complete line yet
      return [];
    }
    const complete = slice.subarray(0, lastNl).toString("utf8");
    cursor.offset += lastNl + 1;
    this.cursors.set(name, cursor);
    const events: AkaneClaudeEvent[] = [];
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isAkaneClaudeEvent(parsed)) events.push(parsed);
      } catch {
        // Skip corrupt / partial line (SPEC §8.1 robustness).
      }
    }
    return events;
  }

  forget(sessionId: string): void {
    // session_end path: drop the in-memory cursor AND rewrite the persisted
    // file so cursors.json cannot grow unbounded as sessions come and go.
    const removed = this.cursors.delete(`${sanitizeSessionId(sessionId)}.ndjson`);
    if (removed) this.persistCursors();
  }

  // Batched sibling of forget(): used when many sessions end in the same poll
  // (e.g. a monitor restart replaying a backlog). A per-session persistCursors()
  // call would re-serialize the whole cursor map once per ended session (O(n^2)
  // I/O for n concurrently-ending sessions); this collapses that to one write.
  forgetMany(sessionIds: Iterable<string>): void {
    let removedAny = false;
    for (const sessionId of sessionIds) {
      if (this.cursors.delete(`${sanitizeSessionId(sessionId)}.ndjson`)) removedAny = true;
    }
    if (removedAny) this.persistCursors();
  }

  private loadCursors(): Map<string, FileCursor> {
    const cursors = new Map<string, FileCursor>();
    try {
      const raw = fs.readFileSync(this.cursorFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, offset] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof offset === "number" && Number.isFinite(offset) && offset >= 0) {
            cursors.set(name, { offset });
          }
        }
      }
    } catch {
      // Missing / corrupt — start empty (Zero-Crash; mirrors TombstoneStore.load).
    }
    return cursors;
  }

  private persistCursors(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const snapshot: Record<string, number> = {};
      for (const [name, cursor] of this.cursors) snapshot[name] = cursor.offset;
      // PID-unique tmp + renameSync = atomic replace with no cross-process
      // ENOENT clobber (AGENTS.md §3.5; mirrors TombstoneStore.flush).
      const tmp = `${this.cursorFile}.${this.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, this.cursorFile);
    } catch (err) {
      console.warn(`[akane] cursor persist failed: ${safeError(err)}`);
    }
  }
}
