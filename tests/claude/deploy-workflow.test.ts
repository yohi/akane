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

  test("is idempotent: compares the resolved tag against the dist repo and gates subsequent steps on the guard's skip output", () => {
    // The guard step must actually query the dist repo for the resolved tag
    // and branch on whether that ref already exists there.
    expect(wf).toContain('id: guard');
    expect(wf).toContain('REMOTE_TAG="$(git ls-remote --tags "$DIST_URL" "refs/tags/$TAG_REF")"');
    expect(wf).toContain('if [ -n "$REMOTE_TAG" ]; then');
    expect(wf).toContain('echo "skip=true" >> "$GITHUB_OUTPUT"');
    expect(wf).toContain('echo "skip=false" >> "$GITHUB_OUTPUT"');
    // Later steps must actually be gated on the guard's skip output, not just
    // print the word "skip" somewhere unrelated.
    const gatedSteps = wf.match(/if: steps\.guard\.outputs\.skip != 'true'/g) ?? [];
    expect(gatedSteps.length).toBeGreaterThan(0);
  });
});
