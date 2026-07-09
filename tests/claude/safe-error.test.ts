import { describe, test, expect } from "bun:test";
import { safeError } from "../../src/claude/safe-error";

describe("safeError", () => {
  test("returns the message as-is when under the 30-char cap", () => {
    expect(safeError(new Error("short error"))).toBe("short error");
  });

  test("truncates and redacts messages over 30 chars", () => {
    const msg = "a".repeat(40);
    expect(safeError(new Error(msg))).toBe(`${"a".repeat(30)}... (redacted)`);
  });

  test("stringifies non-Error values", () => {
    expect(safeError("plain string")).toBe("plain string");
  });

  test("collapses embedded newlines so the log stays single-line", () => {
    expect(safeError(new Error("line one\nline two\r\nline three"))).toBe(
      "line one line two line three",
    );
  });

test("collapses newlines before applying the 30-char cap", () => {
const msg = `first\n${"b".repeat(40)}`;
const result = safeError(new Error(msg));
expect(result.includes("\n")).toBe(false);
expect(result.endsWith("... (redacted)")).toBe(true);
expect(result).toHaveLength(30 + "... (redacted)".length);
  });

  test("collapses a lone carriage return (old Mac line ending), not just \\r\\n", () => {
    expect(safeError(new Error("line one\rline two"))).toBe("line one line two");
  });
});
