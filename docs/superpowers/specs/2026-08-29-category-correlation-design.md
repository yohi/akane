# Category Correlation Design

**Goal:** Prevent the TUI from assigning one task's category to another child session.

**Decision:** Treat `task_id` from a task tool input as the child session ID. A category is correlated only by exact `task_id === session.id`; parent-session FIFO order is not a valid correlation signal.

## Data Flow

`observeToolCall` records only task calls with a valid category and non-empty `task_id`. The resolver stores the task ID under its parent session and retains the tool `callID` so a failed task can discard the pending entry.

`observeSessionCreated` promotes a pending category only when the created session ID exactly matches a recorded task ID. A child session without that match remains uncategorized. Existing-session reuse is supported by allowing `resolve` to read an exact pending task ID even when no `session.created` event occurs.

Successful task events finalize the exact mapping. Failed task events remove it. Session eviction removes both event categories and pending entries for the evicted parent or child task.

## Acceptance Criteria

- Two task calls created in reverse order retain their own categories.
- A task failure cannot leave its category available for an unrelated child session.
- Reusing an existing session through its `task_id` resolves its category without `session.created`.
- A child session with no matching `task_id` remains unknown.
- Evicting a parent removes its pending task mappings.
- Evicting a child removes its event category.
- Existing file, parent-history, and title category fallbacks remain unchanged.
