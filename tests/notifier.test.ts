import { describe, test, expect, beforeEach } from "bun:test";
import {
  TmuxNotifier,
  type NotifierStage,
  type SpawnFn,
  type WhichFn,
} from "../src/notifier";

interface SpawnCall {
  cmd: string[];
  result: { exitCode: number; stdout?: string };
}

function buildEnv(overrides: Partial<{ tmux: string }> = {}) {
  return { TMUX: overrides.tmux ?? "/tmp/tmux-1000/default,1234,0" };
}

function buildSpawn(plan: Record<string, { exitCode: number; stdout?: string }>): {
  spawn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = async (cmd) => {
    const key = cmd.join(" ");
    const result = plan[key] ?? { exitCode: 0 };
    calls.push({ cmd, result });
    return result;
  };
  return { spawn, calls };
}

describe("TmuxNotifier - detection", () => {
  test("disables tmux integration when TMUX env is missing", async () => {
    const { spawn, calls } = buildSpawn({});
    const which: WhichFn = () => "/usr/bin/tmux";
    const n = new TmuxNotifier({ env: {}, spawn, which });
    await n.notify("s1", "warn", "msg");
    expect(calls.length).toBe(0);
  });

  test("disables tmux when which returns null", async () => {
    const { spawn, calls } = buildSpawn({});
    const which: WhichFn = () => null;
    const n = new TmuxNotifier({ env: buildEnv(), spawn, which });
    await n.notify("s1", "warn", "msg");
    expect(calls.length).toBe(0);
  });

  test("disables tmux when dry-run probe fails", async () => {
    const { spawn, calls } = buildSpawn({
      "/usr/bin/tmux display-message -p #{session_name}": { exitCode: 1 },
    });
    const which: WhichFn = () => "/usr/bin/tmux";
    const n = new TmuxNotifier({ env: buildEnv(), spawn, which });
    await n.notify("s1", "warn", "msg");
    // probe runs once, then no further calls
    expect(calls.length).toBe(1);
  });
});

describe("TmuxNotifier - actions", () => {
  let plan: Record<string, { exitCode: number; stdout?: string }>;
  let spawn: SpawnFn;
  let calls: SpawnCall[];
  let notifier: TmuxNotifier;

  beforeEach(() => {
    plan = {
      "/usr/bin/tmux display-message -p #{session_name}": { exitCode: 0, stdout: "main" },
    };
    const built = buildSpawn(plan);
    spawn = built.spawn;
    calls = built.calls;
    const which: WhichFn = () => "/usr/bin/tmux";
    notifier = new TmuxNotifier({ env: buildEnv(), spawn, which });
  });

  // Notifier passes `message` verbatim. The watchdog caller is responsible for
  // building design §5.2 mandated text; these tests assert verbatim pass-through
  // with exact match (no implicit prefix or formatting by the notifier).

  test("notify(warn) passes message verbatim and applies yellow highlight", async () => {
    const exact = "[Watchdog] Agent sess-1 idle for 180000ms";
    await notifier.notify("sess-1", "warn", exact);
    const displayCall = calls.find((c) => c.cmd.length === 3 && c.cmd[1] === "display-message");
    expect(displayCall).toBeDefined();
    expect(displayCall!.cmd).toEqual(["/usr/bin/tmux", "display-message", exact]);
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("bg=yellow"),
      ),
    ).toBe(true);
  });

  test("notify(critical) passes message verbatim and applies red highlight", async () => {
    const exact = "[Watchdog] Ping injected to sess-1";
    await notifier.notify("sess-1", "critical", exact);
    const displayCall = calls.find((c) => c.cmd.length === 3 && c.cmd[1] === "display-message");
    expect(displayCall!.cmd).toEqual(["/usr/bin/tmux", "display-message", exact]);
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("bg=red"),
      ),
    ).toBe(true);
  });

  test("notify(silenced) passes message verbatim and keeps red highlight", async () => {
    const exact = "[Watchdog] Max pings reached. Manual intervention required.";
    await notifier.notify("sess-1", "silenced", exact);
    const displayCall = calls.find((c) => c.cmd.length === 3 && c.cmd[1] === "display-message");
    expect(displayCall!.cmd).toEqual(["/usr/bin/tmux", "display-message", exact]);
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("bg=red"),
      ),
    ).toBe(true);
  });

  test("clear() restores default window-status-current-style", async () => {
    await notifier.clear("sess-1");
    expect(
      calls.some(
        (c) => c.cmd[1] === "set-window-option" && c.cmd.includes("default"),
      ),
    ).toBe(true);
  });

  test("passes args as array (no shell injection risk)", async () => {
    // sessionId-shaped attack surface must not be split into multiple shell tokens.
    const malicious = "sess-1; rm -rf /";
    const message = `[Watchdog] Agent ${malicious} idle for 180000ms`;
    await notifier.notify(malicious, "warn", message);
    const displayCall = calls.find((c) => c.cmd.length === 3 && c.cmd[1] === "display-message");
    expect(displayCall!.cmd.length).toBe(3);
    expect(displayCall!.cmd[2]).toBe(message);
    for (const c of calls) {
      expect(Array.isArray(c.cmd)).toBe(true);
    }
  });
});

describe("TmuxNotifier - error containment", () => {
  test("spawn rejection is swallowed (no throw)", async () => {
    const which: WhichFn = () => "/usr/bin/tmux";
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT");
    };
    const n = new TmuxNotifier({ env: buildEnv(), spawn, which });
    await expect(n.notify("s1", "warn", "m")).resolves.toBeUndefined();
  });
});
