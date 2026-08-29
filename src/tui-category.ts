import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { Part } from "@opencode-ai/sdk/v2";

export type CategorySession = Pick<import("@opencode-ai/sdk/v2").Session, "id" | "parentID" | "title">;

export type CategorySource = "task-record" | "team-runtime" | "parent-history" | "event" | "title";

export type CategoryResult =
  | { readonly kind: "resolved"; readonly category: string; readonly source: CategorySource }
  | { readonly kind: "unknown" };

export type CategoryDirectories = {
  readonly taskDirectory?: string;
  readonly teamRuntimeDirectory?: string;
};

type CategoryColorName = "primary" | "secondary" | "error" | "warning" | "success" | "info" | "textMuted";

export type CategoryTheme<TColor> = Readonly<Record<CategoryColorName, TColor>>;

export interface CategoryResolver {
  readonly refresh: (directories: CategoryDirectories) => void;
  readonly resolve: (session: CategorySession, parentParts?: readonly Part[]) => CategoryResult;
  readonly observeToolCall: (parentID: string, tool: string, input: Record<string, unknown>, callID: string) => void;
  readonly observeToolSettled: (parentID: string, callID: string, outcome: "success" | "failure") => void;
  readonly observeSessionCreated: (session: CategorySession) => void;
  readonly evict: (sessionID: string) => void;
}

const CATEGORY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TITLE_CATEGORY_RE = /^\[([A-Za-z0-9][A-Za-z0-9_-]{0,63})\]\s+/;
const MAX_PENDING_EVENTS = 1_000;

type PendingCategory = {
  readonly category: string;
  readonly callID: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCategory(value: unknown): string | undefined {
  return typeof value === "string" && CATEGORY_RE.test(value) ? value : undefined;
}

function readJson(filePath: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed;
  } catch {
    // no-excuse-ok: catch — malformed or concurrently-written optional state is non-fatal to the TUI.
    return undefined;
  }
}

function categoryFromTaskRecord(value: unknown): readonly [string, string] | undefined {
  if (!isRecord(value)) return undefined;
  const sessionID = value["child_session_id"];
  const category = parseCategory(value["category"]);
  if (typeof sessionID !== "string" || sessionID.length === 0 || category === undefined) return undefined;
  return [sessionID, category];
}

function categoryEntriesFromTasks(directory: string): readonly (readonly [string, string])[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        const parsed = categoryFromTaskRecord(readJson(path.join(directory, entry.name)));
        return parsed === undefined ? [] : [parsed];
      });
  } catch {
    // no-excuse-ok: catch — optional OMO state directory may not exist or may change during refresh.
    return [];
  }
}

function categoryEntriesFromRuntime(directory: string): readonly (readonly [string, string])[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const state = readJson(path.join(directory, entry.name, "state.json"));
        if (!isRecord(state) || !Array.isArray(state["members"])) return [];
        return state["members"].flatMap((member): readonly (readonly [string, string])[] => {
          if (!isRecord(member)) return [];
          const sessionID = member["sessionId"];
          const category = parseCategory(member["category"]);
          if (typeof sessionID !== "string" || sessionID.length === 0 || category === undefined) return [];
          return [[sessionID, category]];
        });
      });
  } catch {
    // no-excuse-ok: catch — optional OMO state directory may not exist or may change during refresh.
    return [];
  }
}

function titleCategory(title: string): string | undefined {
  return title.match(TITLE_CATEGORY_RE)?.[1];
}

function categoryFromParentParts(session: CategorySession, parentParts: readonly Part[]): CategoryResult | undefined {
  const candidates = parentParts.flatMap((part) => {
    if (part.type !== "tool" || part.tool !== "task") return [];
    const inputCategory = parseCategory(part.state.input["category"]);
    const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : undefined;
    const category = inputCategory ?? parseCategory(metadata?.["category"]);
    if (category === undefined) return [];
    const description = typeof part.state.input["description"] === "string" ? part.state.input["description"] : undefined;
    return [{ category, description }];
  });
  const exact = candidates.find(
    (candidate) =>
      candidate.description !== undefined &&
      (session.title === candidate.description || session.title.startsWith(`${candidate.description} (`)),
  );
  const match = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
  return match === undefined ? undefined : { kind: "resolved", category: match.category, source: "parent-history" };
}

export function categoryColor<TColor>(category: string, theme: CategoryTheme<TColor>): TColor {
  const colorName = categoryColorName(category);
  return colorName === undefined ? theme.textMuted : theme[colorName];
}

function categoryColorName(category: string): CategoryColorName | undefined {
  switch (category) {
    case "quick":
      return "info";
    case "deep":
      return "warning";
    case "visual-engineering":
      return "success";
    case "ultrabrain":
      return "error";
    case "research":
      return "secondary";
    case "writing":
      return "primary";
    default:
      return undefined;
  }
}

export function createCategoryResolver(): CategoryResolver {
  const fileCategories = new Map<string, CategoryResult>();
  const eventCategories = new Map<string, string>();
  const pendingCategories = new Map<string, Map<string, PendingCategory>>();

  return {
    refresh(directories) {
      fileCategories.clear();
      for (const [sessionID, category] of categoryEntriesFromTasks(directories.taskDirectory ?? "")) {
        fileCategories.set(sessionID, { kind: "resolved", category, source: "task-record" });
      }
      for (const [sessionID, category] of categoryEntriesFromRuntime(directories.teamRuntimeDirectory ?? "")) {
        fileCategories.set(sessionID, { kind: "resolved", category, source: "team-runtime" });
      }
    },

    resolve(session, parentParts = []) {
      const fromFile = fileCategories.get(session.id);
      if (fromFile !== undefined) return fromFile;
      const fromParent = categoryFromParentParts(session, parentParts);
      if (fromParent !== undefined) return fromParent;
      const fromPending = session.parentID === undefined
        ? undefined
        : pendingCategories.get(session.parentID)?.get(session.id)?.category;
      if (fromPending !== undefined) return { kind: "resolved", category: fromPending, source: "event" };
      const fromEvent = eventCategories.get(session.id);
      if (fromEvent !== undefined) return { kind: "resolved", category: fromEvent, source: "event" };
      const fromTitle = titleCategory(session.title);
      if (fromTitle !== undefined) return { kind: "resolved", category: fromTitle, source: "title" };
      return { kind: "unknown" };
    },

    observeToolCall(parentID, tool, input, callID) {
      if (tool !== "task") return;
      const category = parseCategory(input["category"]);
      if (category === undefined) return;
      const taskID = input["task_id"];
      if (typeof taskID !== "string" || taskID.length === 0 || callID.length === 0) return;
      const pending = pendingCategories.get(parentID) ?? new Map<string, PendingCategory>();
      if (!pending.has(taskID) && pending.size >= MAX_PENDING_EVENTS) {
        const oldestTaskID = pending.keys().next().value;
        if (oldestTaskID !== undefined) pending.delete(oldestTaskID);
      }
      pending.set(taskID, { category, callID });
      pendingCategories.set(parentID, pending);
    },

    observeToolSettled(parentID, callID, outcome) {
      const pending = pendingCategories.get(parentID);
      if (pending === undefined) return;
      const matched = [...pending.entries()].find(([, entry]) => entry.callID === callID);
      if (matched === undefined) return;
      const [taskID, entry] = matched;
      pending.delete(taskID);
      if (pending.size === 0) pendingCategories.delete(parentID);
      if (outcome === "success") {
        eventCategories.set(taskID, entry.category);
      } else {
        eventCategories.delete(taskID);
      }
    },

    observeSessionCreated(session) {
      if (session.parentID === undefined) return;
      const pending = pendingCategories.get(session.parentID);
      if (pending === undefined) return;
      const entry = pending.get(session.id);
      if (entry === undefined) return;
      pending.delete(session.id);
      if (pending.size === 0) pendingCategories.delete(session.parentID);
      eventCategories.set(session.id, entry.category);
    },

    evict(sessionID) {
      eventCategories.delete(sessionID);
      pendingCategories.delete(sessionID);
      for (const [parentID, pending] of pendingCategories) {
        pending.delete(sessionID);
        if (pending.size === 0) pendingCategories.delete(parentID);
      }
    },
  };
}
