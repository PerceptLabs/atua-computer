# Syscall Trace Capture Strategy

## Purpose

Use trace-driven compatibility closure by capturing unimplemented and high-failure syscall paths from real workloads.

## Trace Record Format

```ts
export interface SyscallTraceRecord {
  ts: string;
  pid: number;
  tid?: number;
  process: string;
  syscall: string;
  number: number;
  args: Array<string | number>;
  result?: number;
  errno?: number;
  durationUs?: number;
  workload: string;
  phase: 'boot' | 'shell' | 'apk' | 'node' | 'python' | 'service';
}
```

## Capture Rules

1. Capture all ENOSYS returns.
2. Capture top latency syscalls (p95/p99).
3. Sample high-frequency calls to reduce overhead.
4. Correlate records to workload name and phase.

## Prioritization Rules

1. ENOSYS blocking boot/shell/apk first.
2. ENOSYS blocking Node/Python second.
3. High-frequency expensive syscalls third.
4. Rare edge-case syscalls deferred unless they block a golden workload.

## Outputs

- `syscall-missing-top-N.md`
- `syscall-latency-top-N.md`
- workload-by-workload syscall failure map

## Decision Hook

At each weekly gate, update:

- implemented syscall count
- unresolved blocking syscall count
- trend over previous week
