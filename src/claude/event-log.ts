import * as fs from "node:fs";
import * as path from "node:path";
import { isAkaneClaudeEvent, type AkaneClaudeEvent } from "./event-types";
import { sanitizeSessionId } from "./state-dir";

const NEWLINE = 0x0a;

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
  private readonly cursors = new Map<string, FileCursor>();

  constructor(private readonly dir: string) {}

  poll(): AkaneClaudeEvent[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".ndjson")).sort();
    } catch {
      return []; // dir not created yet
    }
    const out: AkaneClaudeEvent[] = [];
    for (const name of names) {
      out.push(...this.readFile(name));
    }
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
    if (content.length < cursor.offset) cursor.offset = 0; // truncated / rotated
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
    this.cursors.delete(`${sanitizeSessionId(sessionId)}.ndjson`);
  }
}
