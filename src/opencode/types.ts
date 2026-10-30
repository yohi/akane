import type { Plugin } from "@opencode/plugin";
import type { Watchdog } from "../watchdog";

export type V2Context = Plugin.Context;
export type HostEvent = ReturnType<V2Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never;
export type HostSession = Awaited<ReturnType<V2Context["session"]["get"]>>;
export type SessionPort = Pick<V2Context["session"], "get" | "list" | "context" | "wait" | "prompt" | "interrupt">;
export type WatchdogPort = Pick<Watchdog,
  "onUserMessage" | "onActivity" | "onToolRunning" | "onToolSettled" |
  "onInputRequested" | "onInputResolved" | "onStatusRetry" | "onStatusActive" |
  "noteError" | "stop" | "getLastPingTime">;
