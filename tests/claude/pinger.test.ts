import { describe, test, expect } from "bun:test";
import { ClaudeCodeAdapter } from "../../src/claude/pinger";

describe("ClaudeCodeAdapter", () => {
  test("writes exactly one stdout line with the base message", async () => {
    const out: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line));
    await adapter.inject("sess-abc", "ping?");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("ping?\n");
  });

  test("enriches the message with the Japanese reason (buildPingPrompt)", async () => {
    const out: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line));
    await adapter.inject("sess-abc", "ping?", { reason: "rate_limit" });
    expect(out[0]).toContain("[Watchdog]");
    expect(out[0]).toContain("APIレート制限に到達しました");
  });

  test("collapses embedded newlines so it stays a single stdout line", async () => {
    const out: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line));
    await adapter.inject("sess-abc", "ping?\nsecond line\r\nthird line");
    expect(out).toHaveLength(1);
    // Exactly one trailing newline, none in the middle.
    expect(out[0]).toBe("ping? second line third line\n");
  });

  test("stdout discipline: logs go to the log sink, never to stdout", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line), (m) => logs.push(m));
    await adapter.inject("sess-abcdef", "ping?");
    expect(out).toHaveLength(1); // only the ping line
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join(" ")).toContain("sess***"); // sessionId masked (first 4 chars)
    expect(logs.join(" ")).not.toContain("sess-abcdef");
  });

  test("never throws when the writer throws", async () => {
    const adapter = new ClaudeCodeAdapter(() => {
      throw new Error("pipe closed");
    });
    await expect(adapter.inject("s", "msg")).resolves.toBeUndefined();
  });

  test("logs the writer failure via the shared safeError sanitizer (single-line, redacted)", async () => {
    const logs: string[] = [];
    const adapter = new ClaudeCodeAdapter(
      () => {
        throw new Error(`disk full\nretrying\n${"x".repeat(40)}`);
      },
      (m) => logs.push(m),
    );
    await adapter.inject("sess-abc", "msg");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("PINGER stdout failed");
    expect(logs[0]!.includes("\n")).toBe(false);
    expect(logs[0]).toContain("... (redacted)");
  });

  test("normalizes all newline variants (\\r\\n, \\r, \\n) to single space", async () => {
    const out: string[] = [];
    const adapter = new ClaudeCodeAdapter((line) => out.push(line));
    // Test \\r (carriage return alone) — the key fix for (a)
    await adapter.inject("sess-abc", "ping?\ralone-cr");
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("ping? alone-cr\n");
  });

  test("logger exception does not propagate from inject()", async () => {
    const adapter = new ClaudeCodeAdapter(
      () => {
        throw new Error("writer failed");
      },
      () => {
        throw new Error("logger crashed");
      },
    );
    // Should not throw, should resolve normally (Zero-Crash policy)
    await expect(adapter.inject("sess-abc", "msg")).resolves.toBeUndefined();
  });
});
