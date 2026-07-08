import { describe, test, expect } from "bun:test";
import { resolveStateDir, eventsDir, sanitizeSessionId, eventsPathFor } from "../../src/claude/state-dir";
import * as os from "node:os";
import * as path from "node:path";

describe("resolveStateDir", () => {
  test("AKANE_STATE_DIR wins", () => {
    expect(resolveStateDir({ AKANE_STATE_DIR: "/x/state", XDG_STATE_HOME: "/y", HOME: "/h" })).toBe("/x/state");
  });

  test("falls back to XDG_STATE_HOME/akane", () => {
    expect(resolveStateDir({ XDG_STATE_HOME: "/y", HOME: "/h" })).toBe("/y/akane");
  });

  test("falls back to HOME/.local/state/akane", () => {
    expect(resolveStateDir({ HOME: "/h" })).toBe("/h/.local/state/akane");
  });

  test("ignores blank AKANE_STATE_DIR", () => {
    expect(resolveStateDir({ AKANE_STATE_DIR: "  ", XDG_STATE_HOME: "/y" })).toBe("/y/akane");
  });

  test("HOME 未設定でも cwd 相対でなく決定論的な絶対パスに解決する (SPEC §4.3)", () => {
    const dir = resolveStateDir({});
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.join(os.homedir(), ".local", "state", "akane"));
  });
});

describe("sanitizeSessionId", () => {
  test("neutralizes path separators and traversal", () => {
    expect(sanitizeSessionId("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeSessionId("a/b")).toBe("a_b");
  });

  test("keeps safe uuid-like ids", () => {
    expect(sanitizeSessionId("ses_01AB-cd.9")).toBe("ses_01AB-cd.9");
  });
});

describe("eventsPathFor", () => {
  test("composes under <stateDir>/.akane and stays inside it", () => {
    expect(eventsDir("/s")).toBe("/s/.akane");
    expect(eventsPathFor("/s", "abc")).toBe("/s/.akane/abc.ndjson");
    const p = eventsPathFor("/s", "../evil");
    expect(p.startsWith("/s/.akane/")).toBe(true);
    expect(p.includes("/../")).toBe(false);
  });
});
