# Request Log Lifecycle

PromptGate treats the database row in `request_logs` as the source of truth for request statistics. SSE events are a delivery channel for live UI updates, not the source of truth.

## Module Boundaries

- Gateway request handling lives in `apps/server/src/routes/gateway.ts`.
- Request log persistence and realtime broadcast live in `apps/server/src/services/requestLogService.ts`.
- UI pages should refresh aggregate data from HTTP APIs after realtime events, because streaming progress events can be missed or arrive out of order.

## Rules For Gateway Changes

1. Use `insertRequestLog()` when a request first enters the queue.
2. Use `publishRequestLogUpdate()` for UI-only streaming progress that should not be persisted.
3. Use `persistRequestLogPatch()` for silent database patches that should not reset the UI's in-memory progress.
4. Use `updateRequestLog()` for final states and errors that must both persist and broadcast.
5. For streaming responses, finalize the request log before closing the downstream response.

Do not call `logEmitter.emit("logUpdate", ...)` or update `request_logs` directly from gateway code. Keep those operations behind `requestLogService` so future routing or streaming changes do not accidentally break My Stats, Dashboard, or Action Logs behavior.
