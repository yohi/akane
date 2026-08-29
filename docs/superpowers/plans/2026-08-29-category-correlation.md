# Category Correlation Implementation Plan

> **For agentic workers:** This plan is executed inline because the user explicitly prohibited subagent use.

**Goal:** Replace unsafe parent FIFO category assignment with exact task-to-child-session correlation.

**Architecture:** Keep category resolution precedence unchanged. Replace the parent-owned category array with exact task ID records carrying the originating tool call ID. Only exact task/session ID matches can promote an event category; successful and failed task events finalize or discard the record.

**Tech Stack:** Bun, TypeScript, `bun test`, `tsc --noEmit`.

## Global Constraints

- Use Bun for execution and tests.
- Preserve `CategoryResult` source precedence: file, parent history, event, title.
- Do not assign a category when `task_id` is absent or does not equal a child session ID.
- Keep `evict()` safe for both parent and child session deletion.

### Task 1: Regression Tests

**Files:**
- Modify: `tests/tui-category.test.ts`

**Interfaces:**
- Consume the existing `CategoryResolver` methods and the planned task-settlement method.
- Produce behavioral coverage for exact correlation, reuse, failure, reverse creation, and eviction.

- [ ] Add tests that fail under the current FIFO implementation for missing `task_id`, reverse creation, failed task cleanup, existing-session reuse, and parent/child eviction.
- [ ] Run `bun test tests/tui-category.test.ts` and confirm failures are caused by the missing exact-correlation behavior.

### Task 2: Resolver Correlation

**Files:**
- Modify: `src/tui-category.ts:22-28,142-192`

**Interfaces:**
- Extend tool observation with `callID`.
- Add task settlement observation for successful and failed calls.

- [ ] Replace FIFO arrays with parent-scoped task ID records containing category and call ID.
- [ ] Resolve reused sessions by exact pending task ID.
- [ ] Promote only exact `session.id` matches from `observeSessionCreated`.
- [ ] Remove failed task records and clear parent/child records in `evict()`.
- [ ] Run the focused category tests.

### Task 3: TUI Event Wiring

**Files:**
- Modify: `src/tui.tsx:88-119`

**Interfaces:**
- Pass `callID` from `session.next.tool.called` to the resolver.
- Forward `session.next.tool.success` and `session.next.tool.failed` to task settlement observation.

- [ ] Register success and failure listeners and dispose all listeners through the existing cleanup pattern.
- [ ] Run `bun run typecheck`.

### Task 4: Full Verification

**Files:**
- No source changes.

- [ ] Run `bun test`.
- [ ] Run `bun run typecheck`.
- [ ] Run the TypeScript no-excuse audit on modified TypeScript files.
