import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolPart } from "@opencode-ai/sdk/v2";
import { categoryColor, createCategoryResolver, type CategorySession } from "../src/tui-category";

const theme = {
  primary: { r: 1, g: 1, b: 1, a: 255 },
  secondary: { r: 2, g: 2, b: 2, a: 255 },
  accent: { r: 3, g: 3, b: 3, a: 255 },
  error: { r: 4, g: 4, b: 4, a: 255 },
  warning: { r: 5, g: 5, b: 5, a: 255 },
  success: { r: 6, g: 6, b: 6, a: 255 },
  info: { r: 7, g: 7, b: 7, a: 255 },
  textMuted: { r: 9, g: 9, b: 9, a: 255 },
};

function session(input: Partial<CategorySession> = {}): CategorySession {
  return {
    id: "child",
    parentID: "parent",
    title: "inspect files",
    ...input,
  };
}

function tempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "akane-category-"));
}

describe("category resolver", () => {
  it("resolves a category from an OMO task record by child session ID", () => {
    const root = tempDirectory();
    try {
      const tasks = path.join(root, ".omo", "senpi-task", "tasks");
      fs.mkdirSync(tasks, { recursive: true });
      fs.writeFileSync(
        path.join(tasks, "task-1.json"),
        JSON.stringify({ task_id: "task-1", child_session_id: "child", category: "quick" }),
      );

      const resolver = createCategoryResolver();
      resolver.refresh({ taskDirectory: tasks });

      expect(resolver.resolve(session())).toEqual({
        kind: "resolved",
        category: "quick",
        source: "task-record",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a category from a Team runtime state member", () => {
    const root = tempDirectory();
    try {
      const runtime = path.join(root, "runtime", "team-1");
      fs.mkdirSync(runtime, { recursive: true });
      fs.writeFileSync(
        path.join(runtime, "state.json"),
        JSON.stringify({ members: [{ name: "scout", sessionId: "child", category: "deep" }] }),
      );

      const resolver = createCategoryResolver();
      resolver.refresh({ teamRuntimeDirectory: path.join(root, "runtime") });

      expect(resolver.resolve(session())).toEqual({
        kind: "resolved",
        category: "deep",
        source: "team-runtime",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a tool event after a matching child session is created", () => {
    const resolver = createCategoryResolver();
    resolver.observeToolCall("parent", "task", { category: "research" });
    resolver.observeSessionCreated(session({ id: "child", parentID: "parent" }));

    expect(resolver.resolve(session())).toEqual({
      kind: "resolved",
      category: "research",
      source: "event",
    });
  });

  it("resolves a category from the parent task tool part", () => {
    const resolver = createCategoryResolver();
    const part = {
      id: "part",
      sessionID: "parent",
      messageID: "message",
      type: "tool",
      callID: "call",
      tool: "task",
      state: {
        status: "completed",
        input: { category: "quick", description: "local category verification" },
        output: "",
        title: "task",
        metadata: { category: "quick" },
        time: { start: 0, end: 1 },
      },
    } satisfies ToolPart;

    expect(
      resolver.resolve(
        session({ title: "local category verification (@Sisyphus-Junior subagent)" }),
        [part],
      ),
    ).toEqual({
      kind: "resolved",
      category: "quick",
      source: "parent-history",
    });
  });

  it("falls back to a bracketed title category", () => {
    const resolver = createCategoryResolver();

    expect(resolver.resolve(session({ title: "[visual-engineering] inspect files" }))).toEqual({
      kind: "resolved",
      category: "visual-engineering",
      source: "title",
    });
  });

  it("returns unknown when no supported source contains a category", () => {
    expect(createCategoryResolver().resolve(session())).toEqual({ kind: "unknown" });
  });
});

describe("category colors", () => {
  it("maps known categories to stable theme colors", () => {
    expect(categoryColor("quick", theme)).toEqual(theme.info);
    expect(categoryColor("deep", theme)).toEqual(theme.warning);
    expect(categoryColor("ultrabrain", theme)).toEqual(theme.error);
  });

  it("uses muted text for unknown categories", () => {
    expect(categoryColor("custom", theme)).toEqual(theme.textMuted);
  });
});
