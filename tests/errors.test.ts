import { describe, test, expect } from "bun:test";
import { classifyError, reasonToJa } from "../src/errors";

describe("classifyError", () => {
  test("detects rate limit from message", () => {
    expect(classifyError({ message: "Rate limit exceeded" })).toBe("rate_limit");
    expect(classifyError({ message: "HTTP 429 Too Many Requests" })).toBe("rate_limit");
  });

  test("detects provider timeout", () => {
    expect(classifyError({ name: "Error", message: "request timed out" })).toBe(
      "provider_timeout",
    );
    expect(classifyError({ message: "ETIMEDOUT" })).toBe("provider_timeout");
    expect(classifyError({ message: "deadline exceeded" })).toBe("provider_timeout");
  });

  test("returns unknown when a string is extractable but no pattern matches", () => {
    expect(classifyError({ message: "weird provider explosion" })).toBe("unknown");
    expect(classifyError({ error: { name: "Boom" } })).toBe("unknown");
  });

  test("returns null when nothing extractable", () => {
    expect(classifyError({})).toBeNull();
    expect(classifyError(undefined)).toBeNull();
    expect(classifyError(42)).toBeNull();
    expect(classifyError(null)).toBeNull();
  });

  test("rate_limit takes precedence over timeout when both present", () => {
    expect(classifyError({ message: "429 rate limit after timeout" })).toBe("rate_limit");
  });
});

describe("reasonToJa", () => {
  test("maps each reason to Japanese", () => {
    expect(reasonToJa("rate_limit")).toBe("APIレート制限に到達しました");
    expect(reasonToJa("provider_timeout")).toBe("プロバイダ応答がタイムアウトしました");
    expect(reasonToJa("unknown")).toBe("原因不明のエラーが発生しました");
  });
});
