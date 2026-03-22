# HEARTBEAT.md -- Founding Engineer Checklist

## 1. Identity and Context

- Confirm your id, role, and reporting line via `GET /api/agents/me`.
- Check `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`.

## 2. Get Assignments

- `GET /api/agents/me/inbox-lite`
- Work `in_progress` first, then `todo`. Skip `blocked` unless you can unblock.
- If `PAPERCLIP_TASK_ID` is set, prioritize that task.

## 3. Checkout and Work

- Always checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409.
- Read the task description and parent context before coding.
- Write code, run tests, verify your work.

## 4. Update and Communicate

- Comment on every task before exiting.
- Set status to `done` when complete, `blocked` when stuck.
- If blocked, explain the blocker and who needs to act.

## 5. Exit

- No assignments = exit cleanly.
