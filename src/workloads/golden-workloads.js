export const GOLDEN_WORKLOADS = [
  { name: 'shell-init', command: 'sh' },
  { name: 'shell-echo', command: 'echo workload-ok' },
  { name: 'filesystem-cat', command: 'cat /etc/os-release' },
  { name: 'network-curl', command: 'curl api.atua.ai' },
  { name: 'node-runtime', command: 'node -v' },
  { name: 'python-runtime', command: 'python --version' },
];

export async function runGoldenWorkloads(runtime, workloads = GOLDEN_WORKLOADS) {
  const results = [];
  for (const workload of workloads) {
    const startedAt = Date.now();
    const result = await runtime.exec(workload.command);
    results.push({
      ...workload,
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  return {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
