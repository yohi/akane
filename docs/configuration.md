# OpenCode V2 Configuration

Akane on this branch supports OpenCode `2.1.4` and the Promise-based
`@opencode/plugin` API. Register the package using V2 `plugins` entries. Put
watchdog fields inside that entry's `options` object. The old V1
`experimental.watchdog`, top-level `watchdog`, and legacy prompt aliases are not
read.

```jsonc
{
  "plugins": [
    {
  "package": "@yohi/akane@3.0.0",
      "options": {
        "enabled": true,
        "stage1Ms": 180000,
        "stage2Ms": 180000,
        "maxPings": 1,
        "maxToolGateCycles": 1,
        "delivery": "steer",
        "suppressPingWhileToolRunning": true,
        "pauseOnInputRequest": true,
        "notifyWaiting": true,
        "notifierType": "tmux",
        "tmux": { "highlightWindow": true },
        "agents": { "include": [], "exclude": [] }
      }
    }
  ]
}
```

## Precedence

Environment variables override validated plugin `options`, which override
defaults. Invalid values are ignored in favor of the next valid source and
warnings do not include the supplied value. Unknown fields are ignored.

- `OPENCODE_WATCHDOG_ENABLED`: enable monitoring; default `true`.
- `OPENCODE_WATCHDOG_STAGE1_MS`: initial notification delay in ms; default `180000`.
- `OPENCODE_WATCHDOG_STAGE2_MS`: recovery ping delay in ms; default `180000`.
- `OPENCODE_WATCHDOG_MAX_PINGS`: maximum pings per run; default `1`.
- `OPENCODE_WATCHDOG_MAX_TOOL_GATE_CYCLES`: tool deferrals; default `1`.
- `OPENCODE_WATCHDOG_NOTIFIER_TYPE`: `tmux` or `os`; default `tmux`.
- `OPENCODE_WATCHDOG_DELIVERY`: `steer` or `queue`; default `steer`.
- `OPENCODE_WATCHDOG_SUPPRESS_PING_WHILE_TOOL`: default `true`.
- `OPENCODE_WATCHDOG_PAUSE_ON_INPUT`: pause on forms/permissions; default `true`.
- `OPENCODE_WATCHDOG_NOTIFY_WAITING`: notify while paused; default `true`.
- `OPENCODE_WATCHDOG_VERBOSE`: verbose event summaries; default `false`.
- `OPENCODE_WATCHDOG_REPORT_MS`: telemetry interval in ms; default `60000`.
- `AKANE_DEBUG`: detailed local debug logging only when set to `true`.

The automatic ping is admitted through `session.prompt` with a caller-allocated
message ID. `steer` requests prompt steering and then uses the public interrupt
operation to resume it; `queue` admits the prompt without interrupting the
current execution. The two modes have distinct runtime behavior. Neither mode
falls back to a V1 request shape.

## Shared state

The plugin writes `.akane/watchdog-state.json` with schema version `1` for the
parallel `@yohi/sibyl/tui` consumer. Do not change this version or field contract
without coordinating with the consumer migration. Local development should use
an isolated workspace or the package's normal OpenCode V2 local plugin config.
