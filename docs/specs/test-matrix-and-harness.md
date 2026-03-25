# Test Matrix and Command Harness

## Core Runtime Matrix

| Area | Commands/Checks | Automation |
|---|---|---|
| Boot | `runtime.boot()` repeated attempts | `scripts/phase-b-validation.js` |
| Shell baseline | `sh`, `ls /`, `pwd`, `mkdir /tmp/phase-b`, `cat /etc/os-release`, `ps` | `scripts/phase-b-validation.js` |
| Package path | `runtime.install(['busybox'])` + verify installed marker exists | `scripts/phase-b-validation.js` |
| Dev viability | `node -v`, `python --version`, `curl` | `test/runtime.test.js` + golden workloads |
| Services/checkpoints | service lifecycle + checkpoint/restore | `test/runtime.test.js` |

## Gate Thresholds

- Phase B boot pass rate >= 95%
- Phase B baseline command pass rate >= 95%
- Phase B apk install smoke must succeed

## Harness Commands

- `npm test`
- `npm run validate:phase-b`
