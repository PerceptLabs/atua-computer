# Phase F2 — Production Parity Plan

## Goal

Move from prototype-complete validation to production parity by proving non-memory backends, real transport paths, and browser-scale behavior.

## Required Criteria

1. **Backend parity**
   - FS bridge is not in-memory
   - NET bridge is not in-memory
   - PTY bridge is not in-memory
   - Engine backend is production-target runtime

2. **MCP parity**
   - Tool invocation over production transport (not in-process direct function calls)
   - AuthN/AuthZ policy enforcement enabled
   - Tool schema versioning and compatibility checks active

3. **Browser parity**
   - lifecycle tests: suspend/resume/reload
   - long session continuity and restore reliability
   - performance SLOs from target browser matrix

4. **Compatibility parity**
   - golden pack in production backend path
   - syscall missing list remains empty for must-have and should-have profile

## Gate Output

- `docs/reports/phase-f2-production-parity-report.md`
- Decision: `Go` only if all criteria above pass.
