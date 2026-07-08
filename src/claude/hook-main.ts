import { runHook, readStdin } from "./hook";

// akane-hook CLI. Observation-only sensor: always exit 0, never block a turn
// or tool (SPEC §8.1 / AC #7).
async function main(): Promise<void> {
  const stdinText = await readStdin(process.stdin).catch(() => "");
  runHook({
    stdinText,
    env: process.env as Record<string, string | undefined>,
    now: Date.now(),
    logError: (m) => {
      if (process.env.AKANE_DEBUG === "true") process.stderr.write(`[akane-hook] ${m}\n`);
    },
  });
}

main().finally(() => process.exit(0));
