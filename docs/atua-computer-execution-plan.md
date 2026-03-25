# Atua Computer Execution Plan

**Status:** Active  
**Date:** 2026-03-25  
**Scope:** Full build of `atua-computer` from architecture to validated alpha

## 1) Objective

Build a browser-native Linux userspace runtime for agents with:

- x86-64 Linux userspace execution
- AtuaFS and atua-net integration
- stable orchestration APIs (`boot`, `exec`, `spawn`, `signal`, `status`, checkpoints)
- persistent, agent-oriented runtime operations

## 2) Program Principles

1. **Borrow proven patterns** from existing browser-Linux systems where clean-room-safe.
2. **Differentiate on agent operations**, not novelty in basic runtime plumbing.
3. **Validate every phase** before advancing.
4. **Use trace-driven prioritization** for syscall and compatibility closure.
5. **Keep one default architecture path** unless evidence forces fallback.

## 3) Scope

### In Scope (v1 alpha)

- Engine bring-up for x86-64 user-mode workloads
- Filesystem, network, terminal/PTY host bridges
- Linux syscall coverage for shell/package/dev workflows
- Agent operating layer (services, logs, checkpoints, process control)
- JS/TS runtime API and MCP surface

### Out of Scope (v1 alpha)

- Full desktop Linux parity
- Full namespace/container parity
- io_uring-first feature completeness
- broad GUI compatibility targets

## 4) Tracks and Ownership Model

- **Execution Core Track**: loader, execution, memory, syscall handling, threads/signals
- **Host Integration Track**: AtuaFS/atua-net/terminal bridge adapters
- **Agent Runtime Track**: orchestration API, services, checkpoints, logs
- **Product Surface Track**: UI integration and operator visibility
- **QA/Compat Track**: golden workloads, regressions, stability/perf reporting

## 5) Phase Plan and Gates

## Phase A — Foundations

**Goals**

- repository-level planning artifacts and contract skeletons
- validation templates and gate definitions
- observability schema for runtime events/logs

**Exit Criteria**

- plan published
- phase templates published
- interface skeletons published
- baseline command/checklist passes

## Phase B — Engine Bring-up

**Goals**

- base engine integrated in host runtime path
- rootfs + writable overlay mounts working
- shell/coreutils baseline operational

**Exit Criteria**

- repeated boot success target met
- must-have syscall set materially covered
- shell + basic file/process commands pass

## Phase C — Dev Runtime Viability

**Goals**

- Node/Python workflows on real packages
- PTY behavior and net bridge stability
- should-have syscall coverage closure via traces

**Exit Criteria**

- golden dev workflows pass
- network-dependent workloads stable
- PTY interaction tests pass

## Phase D — Agent Operating Layer

**Goals**

- full orchestration API implementation
- service supervision and structured logs
- checkpoint/restore v1 behavior

**Exit Criteria**

- API conformance suite passes
- service lifecycle tests pass
- checkpoint scenario set passes

## Phase E — UX & MCP Integration

**Goals**

- terminal/editor/runtime surfaces cohesive
- MCP tools mapped to runtime APIs
- error taxonomy and remediation messaging

**Exit Criteria**

- end-to-end agent task through MCP passes
- observability dashboards expose runtime health

## Phase F — Performance & Hardening

**Goals**

- benchmark-guided optimization
- long-run stability and recovery hardening
- release readiness criteria

**Exit Criteria**

- performance targets met
- soak/recovery tests pass
- release checklist complete

## 6) Validation Policy (Mandatory)

Each phase must produce:

1. entry criteria confirmation
2. execution log of tests/checks
3. pass/fail results
4. risks and mitigation updates
5. explicit go/no-go decision

No phase advances without a written validation report.

## 7) Golden Workload Pack (Program-Level)

- shell automation and package management
- Node install/run test workload
- Python install/run test workload
- git clone/build/run scenario
- long-running service start/restart/log replay
- checkpoint/restore smoke scenario

## 8) Cadence

- daily integration smoke checks
- bi-weekly full compatibility run
- weekly gate review with explicit decision record

## 9) Immediate Actions (Now)

1. publish this execution plan
2. create phase validation template
3. create phase action backlog
4. create API contract skeleton for implementation handoff
5. begin Phase A validation report
