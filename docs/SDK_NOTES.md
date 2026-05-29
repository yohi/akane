# @opencode-ai/plugin SDK Notes

- 確認日: 2026-05-29
- 確認バージョン: `@opencode-ai/plugin@1.15.12` (依存: `@opencode-ai/sdk@1.15.12`)

## Plugin エントリ型

実測 (`node_modules/@opencode-ai/plugin/dist/index.d.ts` から):

```ts
export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: Project;
    directory: string;
    worktree: string;
    experimental_workspace: { register(type: string, adapter: WorkspaceAdapter): void };
    serverUrl: URL;
    $: BunShell;
};
export type PluginOptions = Record<string, unknown>;
export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;

export interface Hooks {
    dispose?: () => Promise<void>;
    event?: (input: { event: Event }) => Promise<void>;
    config?: (input: Config) => Promise<void>;
    tool?: { [key: string]: ToolDefinition };
    auth?: AuthHook;
    provider?: ProviderHook;
    "chat.message"?: ...;
    // ... 他多数
}
```

> **要点**: Plugin は `(input, options?) => Promise<Hooks>` の形。`Hooks.event` が watchdog のメインフック。

## client.session.prompt の呼び出し形

実測 (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` の `SessionPromptData`):

```ts
export type SessionPromptData = {
    body?: {
        messageID?: string;
        model?: { providerID: string; modelID: string };
        agent?: string;
        noReply?: boolean;
        system?: string;
        tools?: { [key: string]: boolean };
        parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
    };
    path: { id: string };  // Session ID
    query?: { directory?: string };
    url: "/session/{id}/message";
};

export type TextPartInput = {
    id?: string;
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
    time?: { start: number; end?: number };
    // ...
};
```

呼び出し形 (計画書ベースラインと整合):

```ts
client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: "text", text: message }] }
})
```

> **計画書整合**: ✅ 計画書 Task 1.3 のベースライン (`{ path: { id }, body: { parts } }`) と完全一致。

## イベント payload の sessionID / role 抽出パス

実測 (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` の各 Event 定義):

```ts
// message.updated → properties.info に Message が入る (Message = UserMessage | AssistantMessage)
export type EventMessageUpdated = {
    type: "message.updated";
    properties: { info: Message };
};

// UserMessage / AssistantMessage の双方が sessionID / role / id を直接持つ
export type UserMessage = { id: string; sessionID: string; role: "user"; ... };
export type AssistantMessage = { id: string; sessionID: string; role: "assistant"; ... };

// message.part.updated → properties.part に Part が入る (Part = TextPart | ReasoningPart | ...)
export type EventMessagePartUpdated = {
    type: "message.part.updated";
    properties: { part: Part; delta?: string };
};
// 各 Part variant も sessionID: string を直接持つ

// session.created / session.updated / session.deleted → properties.info に Session が入る
export type EventSessionCreated = {
    type: "session.created";
    properties: { info: Session };
};
export type Session = { id: string; ... };

// session.idle → properties.sessionID 直接 (info ラップなし)
export type EventSessionIdle = {
    type: "session.idle";
    properties: { sessionID: string };
};

// session.error → properties.sessionID? 直接 (オプショナル)
export type EventSessionError = {
    type: "session.error";
    properties: { sessionID?: string; error?: ProviderAuthError | ... };
};
```

### 抽出パス確定表

| イベント type | sessionID 抽出パス | 計画書ベースラインとの差異 |
| --- | --- | --- |
| `message.updated` | `event.properties.info.sessionID` | OK 一致 |
| `message.part.updated` | `event.properties.part.sessionID` | OK 一致 |
| `session.created` | `event.properties.info.id` | OK 一致 |
| `session.updated` | `event.properties.info.id` | (計画書未明記 / Watchdog では未使用) |
| `session.deleted` | `event.properties.info.id` | OK 一致 |
| `session.idle` | `event.properties.sessionID` | **計画書 `info.id` と相違**。実 SDK では直接 `sessionID` |
| `session.error` | `event.properties.sessionID` (optional) | **計画書 `info.id` と相違**。実 SDK では直接 `sessionID` (省略あり) |

### role 判定 (initial-trigger)

```ts
event.type === "message.updated" && event.properties.info.role === "user"
```

`UserMessage.role` は厳格に `"user"` リテラル型。`AssistantMessage.role` は `"assistant"`。`message.part.updated` は role を持たない (Part 型のみ)。

## Plugin 実装上の差し替えポイント

Task 3.1 (`src/index.ts`) の `extractSessionId` は **計画書ベースラインのままだと `session.idle` / `session.error` のセッション ID 抽出に失敗する**。本ファイルの抽出パス確定表に従って実装する:

```ts
case "session.idle":
case "session.error":
  return event.properties.sessionID;  // 直接 sessionID。info.id ではない。
case "session.created":
case "session.deleted":
  return event.properties.info?.id;
```

このバグは smoke test (`tests/index.smoke.test.ts`) でも顕在化するため、テストの fake event payload を SDK 実測形に合わせる必要がある。
