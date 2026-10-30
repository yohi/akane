# OpenCode V2 Migration

## Supported host

This branch's stable V2 release is `@yohi/akane@3.0.0`
([GitHub Release](https://github.com/yohi/akane/releases/tag/v3.0.0)).
It targets OpenCode `2.1.4` at upstream commit
`68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`, using exact dependency
`@opencode/plugin@2.1.4`. This is a V2-only branch. The V1 implementation remains
on `master`; this package does not provide V1 server-hook, loose event, or
configuration compatibility.

The V2 entrypoint is `Plugin.define({ id: "opencode-watchdog", setup })`.
`setup` receives a Promise API context and returns idempotent cleanup. Monitoring
logic remains host-independent in `Watchdog`; V2 adapter modules own typed event
routing, session-location checks, recovery message identity, and host operations.

## Event contract

The adapter consumes V2 discriminated events and their `data` payloads. Current
routes include admitted user inbox items, text/reasoning deltas, tool call and
terminal tool events, permission requests, forms, retry/busy status, execution
completion/failure/interruption, deletion, and moves. Request IDs are namespaced
(`permission:<id>` and `form:<id>`). Global forms are ignored. Duplicate event
IDs are bounded and deduplicated. Session ownership is checked with the public
session API before monitoring or recovery effects.

Self-injected input is recognized using its caller-allocated message ID, never
by matching prompt text. The arm lock is `Math.max(stage2Ms * 2, 30000)`, and the
watchdog retains a FIFO set of up to `10000` stopped sessions.

## Recovery semantics

Recovery uses `session.prompt` and `session.interrupt` only. `steer` admits the
message with `resume: false`, then interrupts with `resume: true`; `queue` admits
with `resume: true` and does not interrupt. The target session's selected model
and agent are not overwritten. Host API failures are contained and never cause
an automatic duplicate submission.

The Promise adapter in OpenCode `2.1.4` does not forward request cancellation
options to every in-process API operation. Cleanup fences future effects and
awaits already-started operations; it cannot roll back an inbox item already
committed by OpenCode.

## Shutdown and state

Each project directory has one active runtime owner. Duplicate setup returns a
no-op cleanup. The owning cleanup fences activity, aborts the event subscription,
stops heartbeat/reporters/watchdog timers, awaits the stream and tracked recovery
operations, releases the reference-counted state store, then releases the owner
guard. State files use same-directory temporary writes and atomic rename. The
consumer-facing schema remains version `1`; unobserved prior-process sessions
restart as `IDLE`.

## Verification status

Unit tests cover event routing, identity, options, recovery phases, and duplicate
setup. `bun run typecheck`, `bun run build`, and the default Bun test suite have
been run in Bun `1.4.4`.

The isolated OpenCode `2.1.4` host activates the V2 plugin, runs a controlled
stalled model, observes successful recovery prompt admission and interruption,
and verifies a second model request in the same session. Akane's version-1
state writer has also been verified against the
`@yohi/sibyl@3.0.0-alpha.1` parser at revision
`2c81d141e9fed59e54ce950ea26fb53190cb9308`. Combined-host TUI verification
confirmed direct-child activity and parent selection: both parents showed
`WATCHING` with distinct `BUSY` children, and selection changed the displayed
child category. Three xterm.js captures passed the 42x120 layout check, and two
independent visual reviews returned PASS. The runtime assertion confirms
distinct child ownership but does not retain literal child session IDs. See
[`opencode-v2-verification.md`](opencode-v2-verification.md) for scope and details.
