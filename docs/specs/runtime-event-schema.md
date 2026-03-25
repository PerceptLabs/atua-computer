# Runtime Event Schema (v0)

Structured event envelope emitted by runtime, bridges, and orchestration layers.

## Envelope

```ts
export interface RuntimeEvent<T = unknown> {
  eventId: string;            // UUID
  ts: string;                 // ISO timestamp
  type: string;               // e.g. process.spawned
  severity: 'debug' | 'info' | 'warn' | 'error';
  sessionId?: string;
  checkpointId?: string;
  pid?: number;
  service?: string;
  component: 'engine' | 'fs-bridge' | 'net-bridge' | 'pty-bridge' | 'orchestrator';
  data: T;
  error?: {
    code: string;
    message: string;
    syscall?: string;
    errno?: number;
    retriable?: boolean;
  };
}
```

## Minimum Required Event Types

- `runtime.boot.started`
- `runtime.boot.completed`
- `runtime.boot.failed`
- `process.spawned`
- `process.exited`
- `process.signaled`
- `fs.mount.completed`
- `fs.sync.completed`
- `net.connect.opened`
- `net.connect.closed`
- `service.state.changed`
- `checkpoint.created`
- `checkpoint.restored`
- `runtime.error`

## Logging Rules

1. Events must be append-only and time-ordered per session.
2. `runtime.error` must include stable error `code` and origin `component`.
3. User-visible failures must include correlated `eventId` references.
4. Syscall ENOSYS events must include syscall name for prioritization.
