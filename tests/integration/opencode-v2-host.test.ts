import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";

test.skipIf(process.env.AKANE_V2_HOST_TEST !== "1")("steer interrupts an active generation and resumes the same session", async () => {
  const root = mkdtempSync(join(tmpdir(), "akane-v2-host-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  const stateDir = join(root, "state");
  for (const directory of [home, workspace, configDir, dataDir, stateDir]) {
    await Bun.$`mkdir -p ${directory}`;
  }
  const encoder = new TextEncoder();
  let modelRequests = 0;
  const modelServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      modelRequests++;
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 500);
        },
        cancel() { if (timer) clearInterval(timer); },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const configContent = JSON.stringify({
    model: "fixture/stalled",
    providers: { fixture: { name: "Fixture", package: "@opencode/ai/providers/openai-compatible",
      env: ["AKANE_V2_FIXTURE_API_KEY"], settings: { baseURL: `${modelServer.url}v1` },
      models: { stalled: { name: "Stalled fixture", limit: { context: 8192, output: 1024 },
        capabilities: { tools: false, input: ["text"], output: ["text"] } } } } },
    plugins: [{ package: resolve("dist"), options: {
      enabled: true, stage1Ms: 100, stage2Ms: 100, maxPings: 1, notifierType: "os", delivery: "steer",
    } }],
  });
  writeFileSync(join(workspace, "opencode.json"), configContent);
  const port = 43100 + Math.floor(Math.random() * 2000);
  const password = "akane-v2-fixture-password";
  const child = Bun.spawn([resolve("node_modules/.bin/opencode"), "serve", "--hostname", "127.0.0.1",
    "--port", String(port), "--print-logs", "--log-level", "debug"], {
    cwd: workspace,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configDir, XDG_DATA_HOME: dataDir,
      XDG_STATE_HOME: stateDir,
      OPENCODE_SERVER_PASSWORD: password, AKANE_V2_FIXTURE_API_KEY: "fixture-only" },
    stdout: "pipe", stderr: "pipe",
  });
  const logs: string[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      logs.push(new TextDecoder().decode(chunk.value).replaceAll(password, "[redacted]"));
    }
  };
  const output = Promise.all([collect(child.stdout), collect(child.stderr)]);
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization } });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) break;
      try {
        const info = await client.server.info();
        if (info.version === "2.1.4") ready = true;
      } catch {
        await Bun.sleep(100);
      }
      if (ready) break;
    }
    expect(ready).toBe(true);
    const configs = await client.config.get({ location: { directory: workspace } });
    expect(configs.some((entry) => entry.type === "document" && entry.info.plugins?.length)).toBe(true);
    const session = await client.session.create({ location: { directory: workspace } });
    expect(session.id.length).toBeGreaterThan(0);
    await client.session.context({ sessionID: session.id });
    await client.session.prompt({ sessionID: session.id, text: "integration fixture", delivery: "queue", resume: true });
    const statePath = join(workspace, ".akane", "watchdog-state.json");
    let state: {
      enabled: boolean;
      global: { pingsSent: number };
      sessions: Record<string, { state: string }>;
    } | undefined;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        state = JSON.parse(readFileSync(statePath, "utf8")) as typeof state;
      } catch {
        state = undefined;
      }
      if (state?.global.pingsSent && logs.some((line) => line.includes("Recovery interrupt accepted"))) break;
      await Bun.sleep(50);
    }
    if (!state) throw new Error("Watchdog state was not created in the fixture workspace");
    expect(state.enabled).toBe(true);
    expect(state.global.pingsSent).toBeGreaterThan(0);
    expect(state.sessions[session.id]).toBeDefined();
    expect(logs.some((line) => line.includes("Recovery prompt admitted"))).toBe(true);
    expect(logs.some((line) => line.includes("Recovery interrupt accepted"))).toBe(true);
    expect(modelRequests).toBeGreaterThanOrEqual(2);
  } finally {
    child.kill();
    await child.exited;
    await output;
    rmSync(root, { recursive: true, force: true });
    modelServer.stop(true);
  }
}, 30000);
