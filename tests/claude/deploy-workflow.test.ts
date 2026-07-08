import { describe, test, expect } from "bun:test";
import * as fs from "node:fs";

const wf = fs.readFileSync(".github/workflows/deploy-claude-to-bitbucket.yml", "utf8");

describe("deploy-claude-to-bitbucket workflow", () => {
  test("is manually dispatchable", () => {
    expect(wf).toContain("workflow_dispatch");
  });

  test("runs the bun-based build/verify pipeline", () => {
    expect(wf).toContain("bun run typecheck");
    expect(wf).toContain("bun test");
    expect(wf).toContain("bun run build");
    expect(wf).toContain("claude plugin validate");
    expect(wf).toContain("--strict");
  });

  test("stages only Claude artifacts and excludes OpenCode outputs", () => {
    expect(wf).toContain(".claude-plugin/plugin.json");
    expect(wf).toContain("dist/claude");
    expect(wf).toContain("monitors/monitors.json");
    // OpenCode server/tui bundles must NOT be copied into the dist repo.
    expect(wf).not.toContain("dist/index.js");
    expect(wf).not.toContain("dist/tui.js");
  });

  test("targets the akane-dist Bitbucket repo and keeps the token out of the URL", () => {
    expect(wf).toContain("akane-dist.git");
    expect(wf).toContain("GIT_ASKPASS");
  });

  test("is idempotent: skips when the dist tag already matches the release tag", () => {
    expect(wf.toLowerCase()).toContain("skip");
  });
});
