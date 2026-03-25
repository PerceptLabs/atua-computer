# Repo Module Layout

## Purpose

Define implementation package/module layout for `atua-computer` runtime work.

## Layout

- `src/runtime.js` — orchestration/control-plane runtime facade
- `src/engine/` — execution engine adapters and runtime loop internals
- `src/bridges/` — host bridge adapters (FS, net, PTY)
- `src/workloads/` — golden workload definitions and runners
- `src/syscall-tracer.js` — syscall trace capture + tier reporting
- `test/` — unit/integration tests for runtime, engine and bridges
- `scripts/` — validation harnesses and phase gate automation
- `docs/specs/` — contracts, plans, ownership, test matrix
- `docs/reports/` — phase validation evidence artifacts

## Conventions

- Add new runtime subsystems under `src/<subsystem>/` with focused modules.
- Keep phase validation scripts in `scripts/` and make them executable via `package.json` scripts.
- Each phase gate must reference at least one script output and one report in `docs/reports/`.
