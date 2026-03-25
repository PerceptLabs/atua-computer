# Runtime API Contract Skeleton

This file is the implementation handoff skeleton for the `AtuaComputer` runtime surface.

## TypeScript Interface (Target)

```ts
export interface AtuaComputer {
  boot(options?: BootOptions): Promise<void>;
  exec(command: string, options?: ExecOpts): Promise<ExecResult>;
  spawn(command: string, options?: SpawnOpts): Promise<ProcessHandle>;
  signal(pid: number, signal: string | number): Promise<void>;
  read(pid: number, stream?: 'stdout' | 'stderr'): AsyncIterable<string>;
  write(pid: number, data: string): Promise<void>;
  install(packages: string[], options?: InstallOpts): Promise<InstallResult>;
  service(action: ServiceAction, name: string, options?: ServiceOpts): Promise<ServiceResult>;
  checkpoint(label?: string): Promise<CheckpointId>;
  restore(id: CheckpointId): Promise<void>;
  status(): Promise<SystemStatus>;
  reset(): Promise<void>;
}
```

## Event Model (Initial)

- `runtime.boot.started`
- `runtime.boot.completed`
- `process.spawned`
- `process.exited`
- `service.state.changed`
- `checkpoint.created`
- `checkpoint.restored`
- `runtime.error`

## Required Next Steps

1. Define all option/result types.
2. Define error taxonomy and stable error codes.
3. Define streaming semantics and backpressure behavior.
4. Define MCP mapping per method.
