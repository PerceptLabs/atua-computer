# claude.md — Project Rules for atua-computer

## Identity

This project is `atua-computer`, a browser-native Linux userspace runtime for agents. The authoritative spec is `atua-computer.md` in the repo root. The implementation companion is `atua-computer-implementation-addendum.md`. The CC implementation brief is `atua-computer-cc-brief.md`. Read all three before any implementation work.

## Engineering Principles — No Half Measures

Every implementation must be robust, performant, and future-ready. No shortcuts. No hacks. No "temporary" workarounds that become permanent.

- **No partial implementations.** If a syscall handler needs fd routing, implement the full fd table lookup. Do not add `if (fd >= 200) return success` hacks.
- **No guessing internal state.** If the kernel needs to know what fd numbers Blink assigns for pipes, add a proper registration syscall. Do not hardcode `200 + pipeId * 2`.
- **No fallback paths.** One source of truth per data structure. If `proc.fdTable` is the fd routing table, do NOT also check `vfs.openFiles` as a fallback. EBADF means EBADF.
- **No magic numbers.** Use named constants. Document struct offsets. Parse binary formats with explicit field-by-field reads.
- **Use existing code.** Before writing anything: does Blink already handle this? Does a library exist? Does the plan specify an approach? Only write new code for glue.
- **Ship the proper fix.** If the proper fix requires a C change + WASM rebuild, do it. Do not ship a JS workaround that avoids the rebuild. The workaround becomes permanent debt.
- **Mark technical debt explicitly.** If you MUST ship a temporary workaround, mark it with `// TEMPORARY: <what and why and when to remove>`. Track it. Remove it on schedule.

## Absolute Rules

### No stubs. No mocks. No fakes. No canned output.

If a function cannot produce real behavior yet, it must throw `new Error('NOT IMPLEMENTED: <description>')`. It must NOT return hardcoded values that make tests pass. It must NOT simulate behavior with in-memory data structures disguised as real backends.

Specific prohibitions:
- Do NOT write `if (command === 'ls') return ['bin', 'etc', 'usr']`. The engine executes real x86-64 instructions that produce real directory listings.
- Do NOT write `if (command === 'node -v') return 'v22.0.0'`. Real Node.js runs inside the engine or it doesn't run at all.
- Do NOT write `proc.stdout.push('executed: ' + command)` as a fallback. If a command can't execute, throw or return a real error.
- Do NOT create "Production" wrapper classes that extend in-memory implementations and add a label. A production bridge connects to a real backend or it doesn't exist yet.
- Do NOT write syscall tracers that log syscall names from hardcoded strings. Syscall traces must come from real syscall dispatch in the engine.
- Do NOT mark phases complete when tests pass against mocked behavior.

### No scope reduction without explicit approval.

Do not silently shrink what a function does to make it easier to implement. If the spec says `exec()` runs a command in a persistent shell session, implement that. Do not implement "exec() runs a single command with no persistence" and call it done.

If something is genuinely too complex for the current phase, write it as `throw new Error('NOT IMPLEMENTED: <what and why>')` and document it in the phase validation report as a known gap. Do not silently degrade.

### No hand-rolled implementations when proven libraries exist.

- Do NOT write a custom ext2 parser. Use an existing ext2 library.
- Do NOT write a custom WASM binary encoder from scratch if a library exists. Check npm/crates.io first.
- Do NOT write a custom terminal emulator. Use xterm.js + xterm-pty.
- Do NOT write a custom x86 instruction decoder. Blink has one (Xed-derived, ISC license).
- Do NOT write a custom ELF loader. Blink has one.
- Do NOT write a custom init system. Use Nitro (MIT).
- Do NOT write a custom coreutils. Use uutils (MIT).
- Do NOT hand-roll HTTP range request logic if a fetch-with-ranges library exists.

The principle: if a battle-tested open-source implementation exists for a component, use it. Every line of custom code is a line that needs debugging. Minimize custom code. Maximize library reuse.

### No "easy mode" fallbacks that become permanent.

If you implement a simpler version of something as a stepping stone (e.g., downloading the full rootfs tar instead of block-streaming ext2), that MUST be:
1. Documented in the code with `// TEMPORARY: replace with block-streaming ext2 in Phase X`
2. Tracked in the phase validation report as a known shortcut
3. Actually replaced in the specified phase

Temporary simplifications that are never replaced are lies.

### Use real tools for real work.

- Compile Blink with wasi-sdk + wasi-sdk. Do not try to "simulate" what Blink does in JavaScript.
- Build the Alpine rootfs with real Alpine tools (apk, mkinitfs, or Dockerfile-based pipeline). Do not create a fake rootfs from JavaScript objects.
- Cross-compile test binaries with a real musl cross-compiler. Do not write JavaScript that pretends to be a compiled binary.
- Use @wasmer/sdk to load and run the engine WASM binary. Do not write a JavaScript "WASM emulator."

### Validation must test real behavior.

Every phase validation script must test actual execution, not interface conformance of mocks.

**Bad test (current repo):**
```javascript
const result = await runtime.exec('ls /');
assert(result.exitCode === 0); // Mock always returns 0
```

**Good test:**
```javascript
const result = await runtime.exec('ls /');
assert(result.exitCode === 0);
assert(result.stdout.includes('bin')); // Real Alpine rootfs has /bin
assert(result.stdout.includes('etc')); // Real Alpine rootfs has /etc
// Verify these came from real ext2 filesystem, not a hardcoded array
```

**Good test (Phase B):**
```javascript
// hello.elf is a REAL static x86-64 binary compiled with musl
const result = await runtime.exec('/test/hello.elf');
assert.strictEqual(result.stdout, 'hello from atua-computer\n');
// This passed because real x86 instructions executed in a real engine
```

### Report honestly.

If a phase gate fails, report it as failed. Do not adjust the gate criteria to match what currently works. Do not redefine "engine bring-up" to mean "mock returns correct strings."

The progress tracker must reflect reality:
- "Phase B: In Progress — engine compiles to WASI, static ELF loads, write() syscall not yet bridged to terminal"
- NOT: "Phase B: Complete" when the engine is a command string matcher.

### Do not conflate class naming with real implementation.

Renaming `InMemoryFsBridge` to `ProductionFsBridge` without changing behavior is not production readiness. A production bridge:
- Connects to a real backend (AtuaFS/OPFS for filesystem, atua-net for network)
- Handles real async I/O
- Has error handling for real failure modes
- Passes tests that verify real data round-trips through the real backend

### Read existing code before writing new code.

Before implementing any component, check:
1. Does Blink already implement this? (It probably does — 63,500 lines of proven code)
2. Does an existing Atua bridge handle this? (AtuaFS bridge, atua-net bridge from atua-node)
3. Does a library on npm/crates.io do this?
4. Does the implementation addendum specify a particular approach?

Only write new code for glue between existing components, not reimplementations of solved problems.

## Architecture Constraints

### WASI is the compilation target for the engine.

The engine (Blink) compiles to WASI via wasi-sdk + wasi-sdk sysroot. It runs on @wasmer/sdk. It does NOT compile via Emscripten. It does NOT run as browser-native JavaScript. It does NOT run as a standalone WASM module outside @wasmer/sdk.

### AtuaFS is the filesystem.

Guest file operations route through WASI fd calls to AtuaFS (OPFS-backed). Not IndexedDB. Not in-memory Maps. Not localStorage. AtuaFS.

### atua-net is the network.

Guest socket operations route through WASI socket calls to atua-net (Wisp relay). Not fetch(). Not XMLHttpRequest. Not fake connections. atua-net.

### The rootfs is ext2 with block-level streaming.

The Alpine rootfs is an ext2 image on a CDN. Blocks are fetched on demand via HTTP range requests. Fetched blocks cache in OPFS. Writes go to a copy-on-write overlay. The full image is never downloaded unless every block is touched.

### Nitro is PID 1.

The init system is Nitro (leahneukirchen/nitro, MIT). It runs as a real x86-64 binary inside the engine. It provides service supervision. The agent's shell is a Nitro-managed service. Do not write a custom init system. Do not manage processes from JavaScript.

### uutils replaces BusyBox.

Coreutils are provided by uutils (uutils/coreutils, MIT). 96% GNU coreutils compatibility. Multicall binary. Do not use BusyBox. Do not write custom coreutils.

## Definition of Done

A component is done when:
1. It performs real work (not simulated/mocked)
2. It connects to real backends (not in-memory stubs)
3. It passes tests that verify real behavior end-to-end
4. It handles errors from real failure modes
5. It is documented in the relevant phase validation report with honest pass/fail

A phase is done when:
1. All exit criteria from `atua-computer-execution-plan.md` are met with real behavior
2. A validation report exists with real test results
3. Known gaps are documented as gaps, not hidden behind mocks
4. The progress tracker reflects the true state

## File Organization

```
atua-computer/
  atua-computer.md                    # Authoritative architecture spec (DO NOT MODIFY)
  atua-computer-implementation-addendum.md  # Implementation companion (DO NOT MODIFY without arch review)
  atua-computer-cc-brief.md           # This implementation brief
  CLAUDE.md                           # This file — project rules
  src/
    engine/                           # Real engine integration (Blink-on-WASI)
    bridges/                          # Real bridges (AtuaFS, atua-net, xterm.js)
    mcp/                              # MCP tool registry (keep existing)
    runtime.js                        # Runtime wrapper (keep existing shape)
  native/                             # Blink source fork, WASI build scripts
  rootfs/                             # Alpine rootfs build pipeline (Dockerfile, scripts)
  wasm/                               # Built WASM artifacts (engine.wasm, etc.)
  test/                               # Real tests against real behavior
  docs/
    specs/                            # Technical specs
    reports/                          # Phase validation reports (real, not mocked)
```

## Git Workflow — Snapshots

When I say "push", "snapshot", or "checkpoint":

1. `git add -A`
2. `git commit -m "Snapshot: <description>"` — use context from recent work
3. Create snapshot branch using **today's actual date**:
   ```bash
   git branch "snapshot-$(date +%Y-%m-%d)-<short-description>"
   ```
4. Push it:
   ```bash
   git push origin "snapshot-$(date +%Y-%m-%d)-<short-description>"
   ```
5. **Stay on current branch** — do NOT checkout the snapshot
6. Tell me: what was committed, the snapshot branch name, and confirm I'm still on my working branch
