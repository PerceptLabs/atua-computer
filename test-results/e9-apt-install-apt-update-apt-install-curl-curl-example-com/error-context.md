# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - heading "atua-computer — apt install integration test" [level=1] [ref=e2]
  - generic [ref=e3]: "Booting engine with networking... Relay: ws://localhost:55707 Binary: /bin/bash --norc --noprofile -c echo STEP1PASS; apt update 2>&1 | tail -3; echo DONE STEP1PASS CHILD: malloc state 7590572 CHILD: malloc returned 1179680 CHILD: calling restore_fork CHILD: malloc state 7590564 CHILD: malloc returned 1179680 CHILD: calling restore_fork CHILD: unreachable at RuntimeError: unreachable | at engine.wasm.exit (wasm://wasm/engine.wasm-001b8f06:wasm-function[1153]:0x4731d) | at engine.wasm.LoadElf (wasm://wasm/engine.wasm-001b8f06:wasm-function[202]:0xb8d8) CHILD: unreachable at RuntimeError: unreachable | at engine.wasm.exit (wasm://wasm/engine.wasm-001b8f06:wasm-function[1153]:0x4731d) | at engine.wasm.LoadElf (wasm://wasm/engine.wasm-001b8f06:wasm-function[202]:0xb8d8)"
```