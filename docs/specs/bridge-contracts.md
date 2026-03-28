# Host Bridge Contracts (Phase A/B)

This document defines the first-pass bridge contracts between the execution engine and browser host capabilities.

## 1) Filesystem Bridge Contract

```ts
export interface FsBridge {
  mountSharedProject(opts: { guestPath: string; hostPath: string; readOnly?: boolean }): Promise<void>;
  mountOverlay(opts: { guestPath: string; lower: string; upper: string; work?: string }): Promise<void>;
  readFile(path: string, opts?: { offset?: number; length?: number }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, opts?: { offset?: number }): Promise<number>;
  stat(path: string): Promise<{
    mode: number;
    uid: number;
    gid: number;
    size: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    type: 'file' | 'dir' | 'symlink' | 'other';
  }>;
  readdir(path: string): Promise<Array<{ name: string; type: 'file' | 'dir' | 'symlink' | 'other' }>>;
  mkdir(path: string, mode?: number): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  sync(): Promise<void>;
}
```

### Semantics

- All paths are guest-absolute POSIX paths.
- `sync()` is durability boundary for checkpoint safety.
- `mountOverlay()` must preserve lower layer immutability.

## 2) Network Bridge Contract

```ts
export interface NetBridge {
  resolve(hostname: string): Promise<Array<{ family: 4 | 6; address: string }>>;
  openTcp(opts: { host: string; port: number; localAddress?: string; localPort?: number }): Promise<number>;
  openUdp(opts: { localAddress?: string; localPort?: number }): Promise<number>;
  send(fd: number, data: Uint8Array): Promise<number>;
  recv(fd: number, maxBytes: number): Promise<Uint8Array>;
  shutdown(fd: number, how: 'read' | 'write' | 'both'): Promise<void>;
  close(fd: number): Promise<void>;
  setSockOpt(fd: number, level: number, name: number, value: Uint8Array): Promise<void>;
  getSockOpt(fd: number, level: number, name: number, maxLen: number): Promise<Uint8Array>;
}
```

### Semantics

- Outbound only by default policy.
- DNS resolution and socket lifecycle events must be logged.

## 3) PTY/Terminal Bridge Contract

```ts
export interface PtyBridge {
  createPty(opts?: { cols?: number; rows?: number; env?: Record<string, string> }): Promise<{ id: string; masterFd: number }>;
  read(id: string, maxBytes?: number): Promise<Uint8Array>;
  write(id: string, data: Uint8Array): Promise<number>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  setForegroundProcessGroup(id: string, pgrp: number): Promise<void>;
  close(id: string): Promise<void>;
}
```

### Semantics

- Must support SIGINT/SIGTSTP-relevant control behavior.
- Resize events must propagate to guest process tree.

## 4) Cross-Cutting Contract Requirements

- All bridge errors map to stable runtime error codes.
- All bridge calls emit structured events.
- Bridge APIs must be cancellation-safe for process teardown.
