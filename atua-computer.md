# Atua Computer

`Atua Computer` is a browser-native computer substrate for agents: a runtime product that reuses the Atua host platform but stops pretending the browser is "close enough" to Node.js. `Atua` remains the umbrella platform, `atua-computer` is the full runtime system and product surface, `atua-linux` is the first execution target/profile, and `atua-node` remains a separate compatibility track rather than the basis of this system.

## Why This Exists

The current `atua-node` direction in this repo is a compatibility-layer strategy: vendored Node.js JavaScript, `internalBinding()` shims, WASIX-backed libraries, host bridges, and package-compat work. That can move compatibility materially forward, but it still spends most of its effort emulating a runtime above a browser substrate that is not actually Linux or Node.

`atua-computer` changes the framing. The goal is not "approximate Node in-browser" but "run real Linux userland software in-browser under a browser-native host." The target user experience is:

- real Linux userland binaries instead of JS-level polyfills
- real package managers and language runtimes where feasible
- persistent shell, services, logs, checkpoints, and structured process control
- first-class reuse of existing host primitives:
  - `AtuaFS` for persistent/shared storage
  - `atua-net` for outbound networking
  - browser terminal and editor integrations
  - MCP/agent orchestration as the control plane

This is a parallel R&D and runtime track, not a drop-in continuation of the current `atua-node` architecture. If it succeeds, it may reduce or obsolete parts of `atua-node`, but that is not assumed for early phases.

## Competitive Analysis

### Comparison Set

This design is informed by public information about:

- CheerpX public documentation and package surface
- WebVM's public repository and deployment model
- v86 public repository and README
- WebContainers public documentation
- the current `atua-node` repository and design docs

### Market and Technical Position

| System | Strength | Constraint | What `atua-computer` should learn |
|---|---|---|---|
| CheerpX | Proven browser Linux virtualization product with syscall emulation and JIT | Proprietary engine, currently publicly positioned around 32-bit x86 support | Device/mount model, browser-safe Linux product shape, block-backed filesystem layering |
| WebVM | Open product shell around CheerpX with terminal-first UX and image customization | Inherits CheerpX limits and a general-purpose VM UX rather than an agent-first control plane | Dockerfile-to-image workflow, terminal UX, operational shape of a browser Linux product |
| v86 | Open-source x86 emulator with x86-to-WASM JIT and broad demo coverage | Hardware-emulation model, 32-bit focus, heavier virtualization overhead | JIT feasibility, browser embedding, open-source implementation reference for code generation patterns |
| WebContainers | Excellent browser-native developer UX for Node-centric workflows | Not a general Linux userland runtime; package/workload scope is narrower | Product ergonomics, fast boot expectations, host/editor integration quality |
| Atua + `atua-node` | Strong host primitives already aligned to the browser and agent use cases | Compatibility-layer complexity and ongoing Node parity closure | Reuse AtuaFS, atua-net, MCP/orchestration, avoid rebuilding host capabilities |

### Public Facts That Matter

- CheerpX publicly exposes a `CheerpX.Linux` API with device-oriented storage abstractions such as `httpBytesDevice`, `OverlayDevice`, `IDBDevice`, and `DataDevice`, which confirms the usefulness of a layered mount/device model rather than a single monolithic disk abstraction.
- WebVM publicly describes itself as a client-side Linux virtual machine built on CheerpX, uses an ext2 disk image flow, and ships a terminal-centric product shell with image customization driven by Dockerfiles.
- The public `@leaningtech/cheerpx` NPM package is a thin wrapper package, not an open engine implementation. The engine remains proprietary.
- v86 publicly documents an x86-to-WASM JIT and broad browser execution, but also clearly reflects the costs of hardware-style emulation and lack of 64-bit support.
- WebContainers publicly demonstrates the product value of tight editor/runtime integration and rapid startup, but it is not trying to be a full Linux userland runtime.

### Where `atua-computer` Aims To Win

- **64-bit first**: target Linux x86-64 userspace from day one, not a long-term 64-bit aspiration after a 32-bit platform.
- **Agent-native control plane**: persistent shell, managed services, logs, checkpoints, process handles, and structured status are product primitives, not add-ons around a terminal.
- **Atua-native host integration**: project files live in `AtuaFS`; outbound networking rides `atua-net`; the editor and runtime share the same host-aware storage model.
- **Browser-modern architecture**: host bridges are explicit, browser ceilings are acknowledged early, and the runtime is designed for in-browser orchestration rather than pretending to be a desktop VM.

### Where Incumbents Are Ahead

- CheerpX and WebVM are materially ahead on proven engine maturity.
- CheerpX is ahead on demonstrated production-hardening for syscall coverage, self-modifying code handling, and JIT stability.
- WebContainers is ahead on polished UX and startup expectations for browser development environments.
- The current `atua-node` repo is ahead on immediate incremental value for Node-focused workloads because it already exists and has a verified test suite.

### Strategic Conclusion

`atua-computer` should not be sold internally as "we can quickly outbuild CheerpX." It should be treated as a more ambitious runtime product whose differentiation is:

1. browser-native agent workflows
2. explicit reuse of Atua host capabilities
3. 64-bit Linux userspace as the first-class target

## Clean-Room Rules

The implementation must follow a clean-room methodology strict enough that another engineer or agent can implement from this document and public standards without needing proprietary implementation access.

### Allowed Sources

- public documentation
- public repositories
- package metadata, wrappers, type definitions, and exposed JS APIs
- black-box behavior observable from public demos or products
- public technical standards and specifications:
  - Linux syscall ABI and man pages
  - ELF and System V ABI
  - x86-64 ISA references
  - ext2 filesystem specification
  - WebAssembly specification
  - browser platform APIs

### Prohibited Sources

- proprietary engine source code
- decompiled or reverse-engineered proprietary internals
- copied implementation details from non-public artifacts
- reconstructed code derived from proprietary binaries

### Team Split Model

If the project uses a two-team clean-room structure:

- **Research/spec team**
  - may inspect only allowed public sources and black-box behavior
  - produces architecture notes, behavior specs, acceptance tests, and compatibility findings
  - must not produce copied implementation code
- **Implementation team**
  - implements only from the public standards and the research/spec outputs
  - must not consult proprietary implementation materials

The clean-room posture for `atua-computer` should be described as "competitive analysis plus standards-based implementation," not "reverse engineering proprietary internals."

## System Architecture

`atua-computer` is a four-layer system.

### 1. Engine Layer

The engine is a browser-hosted Linux userspace runtime targeting x86-64 guest execution in user mode.

Core responsibilities:

- x86-64 decode and execution
- ELF loading
- userspace memory management
- Linux syscall handling
- process and thread state
- signal dispatch
- interpreter first, JIT later

This is **not** a full hardware VM in the first target profile. The target is Linux userspace ABI compatibility, not emulated motherboard/device fidelity.

### 2. Host Bridge Layer

The engine must delegate host-owned capabilities through explicit bridges:

- **filesystem bridge**
  - owned by `AtuaFS`
  - responsible for shared project mount, persistent storage, cache/overlay storage, and checkpointable file state
- **network bridge**
  - owned by `atua-net`
  - responsible for outbound client networking, DNS path integration, TLS path integration, and socket-like userland behavior
- **terminal/display bridge**
  - owned by the browser host
  - responsible for terminal I/O, PTY/TTY mediation, and later graphical display integration
- **orchestration bridge**
  - owned by `atua-computer`
  - responsible for shell control, process lifecycle, services, logs, checkpoints, and MCP-facing runtime APIs

### 3. Agent Operating Layer

This is the product layer above the engine and bridges.

Responsibilities:

- persistent login shell
- service supervision
- structured process APIs
- checkpoint/restore
- package installation flow
- image/profile management
- runtime status and logs

This layer should feel like "an agent computer," not "a terminal wrapped around a VM."

### 4. UI, Editor, and Tooling Layer

This layer remains host-native and browser-native.

Responsibilities:

- editor integration
- terminal rendering
- runtime dashboards
- logs and process views
- MCP tool exposure
- project mount visibility between host/editor and guest runtime

### First Runtime Target: `atua-linux`

The first target profile is:

- Linux userspace ABI
- x86-64 guest binaries
- user-mode execution
- no full hardware virtualization in the MVP
- no promise of complete desktop Linux parity in the MVP

### Engine Design Constraints

The engine design must remain standards-based:

- ELF loader for initial binary support
- Linux syscall layer with explicit coverage targets
- memory manager for `mmap`, `munmap`, `mprotect`, `brk`, and related primitives
- process/thread model grounded in browser worker realities
- interpreter as the correctness baseline
- JIT as a later performance layer

## Public Interfaces

`atua-computer` exposes a first-class JS/TS runtime API. These interfaces are product contracts and must not be left implicit.

### Top-Level Runtime Interface

```ts
interface AtuaComputer {
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

### Required Types

```ts
type CheckpointId = string;
type ServiceAction = 'start' | 'stop' | 'restart' | 'status' | 'create' | 'logs';

interface BootOptions {
  profile?: 'atua-linux';
  projectMount?: string;
  autoStartShell?: boolean;
}

interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  streamOutput?: boolean;
}

interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: boolean;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface ProcessHandle {
  pid: number;
  command: string;
  startedAt: number;
}

interface InstallOpts {
  manager?: 'apk';
}

interface InstallResult {
  manager: 'apk';
  requested: string[];
  installed: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ServiceOpts {
  run?: string;
  cwd?: string;
  env?: Record<string, string>;
}

interface ServiceResult {
  name: string;
  state: 'UP' | 'DOWN' | 'STARTING' | 'RESTARTING' | 'FAILED';
  pid?: number;
  uptimeMs?: number;
  logs?: string;
}

interface SystemStatus {
  ready: boolean;
  profile: 'atua-linux';
  shellPid?: number;
  services: ServiceResult[];
  processes: Array<{ pid: number; command: string; state: string }>;
  mounts: Array<{ guestPath: string; hostPath?: string; kind: string }>;
  storage: { usedBytes: number; availableBytes?: number };
  uptimeMs: number;
}
```

### Locked Semantics

- `boot()` initializes the runtime profile and makes the runtime ready for structured operations.
- The persistent shell is the default operator context. `exec()` is defined relative to that persistent environment unless overridden by options.
- `service()` is a first-class managed-service interface. Services are not modeled as "shell snippets the caller remembers."
- `checkpoint()` and `restore()` are product-level features, not internal-only debugging tools.
- The project mount is shared host storage. Files written by the editor must be visible to the guest runtime, and files written by the guest runtime must be visible to the host/editor.
- Structured status and log access are part of the product API; terminal scraping is not the primary interface.

## MVP Scope

The MVP must be narrower than "a full browser Linux machine."

### In Scope

- boot a shell
- mount shared project storage
- run simple guest binaries
- support outbound client networking
- support package installation for a constrained initial image/profile
- support persistent shell semantics
- support at least one managed long-running service
- support basic checkpoint/restore for file and process state that the product owns

### Explicitly Deferred

- broad GUI environment parity
- native desktop equivalence
- arbitrary kernel feature parity
- full `listen()` / server parity in early phases
- claims of "100% Node" or "100% Linux"
- broad performance claims before JIT maturity
- unrestricted local machine equivalence

### MVP Success Statement

The MVP succeeds when an agent can boot the runtime, work against a shared project mount, install and run a constrained set of real Linux packages, use outbound network tools, run real `node` inside the guest profile, start a managed service, and checkpoint/restore meaningful runtime state.

## Implementation Roadmap

The roadmap is deliberately more conservative than the earlier draft. It is structured around dependency closure rather than optimistic calendar estimates.

### Phase 0: Clean-Room Framework and Standards Baseline

Deliverables:

- clean-room protocol
- architecture source register listing allowed source classes
- standards reference index
- competitive analysis notes separated from implementation notes
- acceptance harness skeleton for engine, syscall, bridge, and workflow tests

Acceptance:

- implementation team has a document set that does not rely on proprietary internals
- all future implementation tasks can cite standards or public sources only

Dependencies:

- blocked by nothing
- unblocks every later phase

### Phase 1: Engine Bring-Up and Static ELF Execution

Deliverables:

- browser-loadable engine runtime
- x86-64 interpreter baseline
- minimal ELF loader sufficient for static binaries
- initial memory model and syscall trap path
- ability to start and complete a trivial static guest binary

Acceptance:

- engine loads in a dedicated worker
- a simple static x86-64 userspace binary executes to completion
- basic stdout/stderr bridging works

Dependencies:

- depends on Phase 0 standards baseline
- unblocks terminal and filesystem integration

### Phase 2: Shared Filesystem and Terminal Integration

Deliverables:

- host filesystem bridge to `AtuaFS`
- project mount contract
- terminal bridge with PTY-aware behavior for shell bring-up
- runtime-owned mount model for project files and internal storage

Acceptance:

- shell boots
- project file written on host is readable in guest
- project file written in guest is visible on host
- terminal interaction is good enough for login shell operation

Dependencies:

- depends on Phase 1 execution baseline
- unblocks package/image work and shell-driven workflows

### Phase 3: Outbound Networking and Package/Image Path

Deliverables:

- outbound networking bridge to `atua-net`
- DNS path sufficient for userland client tooling
- initial image/profile pipeline
- package manager bring-up for the constrained first profile

Acceptance:

- outbound fetch/curl-like workflows succeed
- package manager can refresh metadata and install at least a constrained test package set
- runtime profile is reproducibly bootable

Dependencies:

- depends on Phase 2 shell and filesystem integration
- unblocks real language runtime smoke tests

### Phase 4: Process Model and Service Supervisor

Deliverables:

- workable process table and wait/signal model
- initial `fork` / `exec` / `clone` strategy aligned with browser worker realities
- persistent shell lifecycle management
- service supervision layer for managed long-running processes

Acceptance:

- shell state persists across `exec()` calls
- managed service can be created, started, queried, logged, and stopped
- process status reflects reality strongly enough for MCP use

Dependencies:

- depends on Phase 3 network/package baseline
- unblocks agent-grade orchestration APIs

### Phase 5: Agent APIs and Checkpoints

Deliverables:

- full public `atua-computer` control surface
- structured process/log/status APIs
- checkpoint/restore path for owned storage/runtime state
- MCP integration surface

Acceptance:

- another agent can drive the runtime entirely through structured APIs
- checkpoint/restore works for a defined supported state subset

Dependencies:

- depends on Phase 4 process/service model
- unblocks productization and workload testing

### Phase 6: JIT and Performance Work

Deliverables:

- hot-path profiling
- basic block detection
- initial x86-64 to WASM JIT for a constrained instruction set
- code cache and invalidation model

Acceptance:

- no correctness regressions versus interpreter baseline
- measured speedup on defined benchmark cases
- unsupported instructions continue to fall back safely to the interpreter path

Dependencies:

- depends on previous phases for correctness baseline and usable workloads

## Risk Register

### Dynamic ELF and Shared Library Support

Risk type: correctness

Risk:

- dynamic ELF loading is materially harder than static ELF bring-up
- musl loader and relocation behavior can dominate early complexity

Mitigation:

- static ELF first
- dynamic loader as a later milestone after baseline execution works
- use explicit conformance tests rather than assuming "simple binaries imply loader correctness"

### `fork()` / `clone()` in Browser Workers

Risk type: correctness and performance

Risk:

- browser worker/process realities do not map directly to Linux process semantics
- snapshot/restore cost may make naive `fork()` unusable

Mitigation:

- optimize for `fork+exec` fast path
- make ownership boundaries explicit
- test shell and package manager process patterns early

### PTY/TTY Fidelity

Risk type: correctness

Risk:

- interactive shell behavior can fail in subtle ways long before raw process execution is broken

Mitigation:

- treat terminal/PTY correctness as a first-class phase goal
- validate login shell, line editing, environment persistence, and signal behavior early

### `epoll` / `poll` / event readiness behavior

Risk type: correctness and scalability

Risk:

- event loop behavior affects Node, package managers, shells, and long-running services

Mitigation:

- start with correctness over scalability
- explicitly document fallback strategies
- run real workload tests instead of only syscall unit tests

### JIT invalidation and self-modifying code

Risk type: correctness and performance

Risk:

- guest runtimes such as real Node/V8 will stress code generation and invalidation behavior

Mitigation:

- interpreter remains the correctness baseline
- JIT is additive
- page-level invalidation and code cache rules are designed before broad JIT expansion

### Memory Ceilings

Risk type: product and performance

Risk:

- browser memory limits and worker overhead can cap realistic workloads

Mitigation:

- define hard runtime budgets
- make failure states explicit
- validate representative workloads early, not only synthetic demos

### Host Bridge Bottlenecks

Risk type: performance and product correctness

Risk:

- `AtuaFS`, `atua-net`, and terminal bridges can dominate user-visible runtime quality even if the engine is sound

Mitigation:

- benchmark host bridge paths independently
- keep ownership boundaries explicit
- do not hide bridge limitations under "VM" abstraction language

## Testing and Acceptance

Testing must be driven by user-visible workflows, not just subsystem unit tests.

### Test Categories

- engine conformance tests
- syscall correctness tests
- filesystem bridge tests
- networking bridge tests
- process and service tests
- package-install smoke tests
- real workload tests for:
  - shell workflows
  - Node
  - Python
  - package managers

### Acceptance Scenarios

The following scenarios are mandatory acceptance cases for the master plan:

1. **Boot and Shell**
   - boot runtime to ready shell
   - run `echo hello`
   - verify shell remains available for subsequent commands

2. **Shared Project Mount**
   - write a file in the host/editor-visible project mount
   - read it from the guest runtime
   - write a file from the guest runtime
   - read it back from the host/editor side

3. **Outbound Networking**
   - execute a `curl` or equivalent fetch from the guest
   - verify outbound network success through the host bridge

4. **Package Installation**
   - install a package-manager payload within the constrained first profile
   - run the installed binary successfully

5. **Real Node Runtime**
   - install or boot a runtime image containing real `node`
   - run `node -e "console.log('hi')"`

6. **Managed Service Lifecycle**
   - start a long-running service
   - inspect status
   - stream logs
   - stop the service

7. **Checkpoint and Restore**
   - create a checkpoint
   - mutate filesystem and/or runtime state
   - restore checkpoint
   - verify supported state is restored correctly

### Acceptance Philosophy

Passing synthetic engine tests is not enough. The project must pass real workflow scenarios that exercise:

- shell interactivity
- file sharing with the host
- real outbound network behavior
- real package workflows
- real language runtime execution
- long-lived service behavior

## Assumptions and Defaults

The following defaults are locked unless changed explicitly in a later revision:

- `atua-computer` is the product name
- `atua-linux` is the first runtime target/profile
- Linux x86-64 user-mode runtime is the first engine target
- the engine is interpreter-first, JIT-later
- outbound networking only is in scope for early phases
- agent-first service/process APIs are mandatory
- this is parallel to `atua-node`, not an immediate replacement
- this document is for implementation planning, not marketing
- competitive analysis is based only on public materials and standards-derived reasoning
- the spec must remain honest about risk and must not promise full parity or exact performance before prototypes prove it

## Relationship to Current Atua Work

This project intentionally reuses the strongest existing Atua-side primitives while avoiding the `atua-node` strategy as its foundation.

What `atua-computer` should reuse:

- `AtuaFS` as the persistent/shared project filesystem substrate
- `atua-net` as the outbound networking substrate
- browser terminal and editor integrations
- MCP and agent orchestration concepts

What `atua-computer` should not inherit as architectural constraints:

- WASIX as the execution substrate
- vendored Node.js internals as the main runtime strategy
- Node compatibility routing as the primary product abstraction

`atua-node` can continue as a shorter-term compatibility track. `atua-computer` is the longer-range runtime track.

## Public Source References

These sources are suitable for competitive understanding and clean-room specification work:

- CheerpX docs: https://cheerpx.io/docs
- CheerpX `Linux` API docs: https://cheerpx.io/docs/reference/CheerpX.Linux
- CheerpX device/mount docs: https://cheerpx.io/docs/reference/CheerpX.httpBytesDevice and adjacent reference pages
- CheerpX licensing page: https://cheerpx.io/docs/licensing
- WebVM repository: https://github.com/leaningtech/webvm
- WebVM README: https://raw.githubusercontent.com/leaningtech/webvm/main/README.md
- WebVM public terminal config shape: https://raw.githubusercontent.com/leaningtech/webvm/main/config_public_terminal.js
- `@leaningtech/cheerpx` npm package metadata: https://www.npmjs.com/package/@leaningtech/cheerpx
- v86 repository and README: https://github.com/copy/v86
- WebContainers documentation: https://developer.stackblitz.com/platform/api/webcontainer-api

These references are for public competitive understanding only. They are not an authorization to copy proprietary implementation internals.
