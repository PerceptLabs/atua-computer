# Phase B Engine Integration Workplan

## Goal

Integrate the execution engine into host runtime path with bootable Alpine userspace and baseline shell commands.

## Work Packages

## B1 — Engine Runtime Wiring

- Define engine module lifecycle (`init`, `boot`, `shutdown`)
- Connect engine I/O loop to bridge adapters
- Add process table and PID mapping stubs

**Deliverable:** Engine host adapter module skeleton.

## B2 — RootFS + Overlay Mount Path

- Define rootfs image mount flow
- Define writable overlay behavior
- Validate mount semantics for `/`, `/tmp`, and project path

**Deliverable:** Documented mount sequence with validation checklist.

## B3 — Syscall Baseline Closure

- Implement or map must-have syscalls for shell/coreutils/apk baseline
- Add ENOSYS trace logging with syscall names
- Maintain syscall coverage table

**Deliverable:** Baseline syscall matrix with pass/fail per workload.

## B4 — Boot and Command Validation

- Repeat boot cycles and record success rate
- Validate shell command set (`sh`, `ls`, `pwd`, `mkdir`, `cat`, `ps`)
- Validate apk metadata + simple install path

**Deliverable:** Phase B validation report with measured outcomes.

## Exit Gate Metrics

- Boot success rate: target >= 95% (test batch)
- Baseline command pass rate: target >= 95%
- Critical crash count: 0 known blockers unresolved
