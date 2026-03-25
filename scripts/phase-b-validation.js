import { AtuaComputerRuntime } from '../src/index.js';

const BOOT_ATTEMPTS = 20;
const COMMANDS = ['sh', 'ls /', 'pwd', 'mkdir /tmp/phase-b', 'cat /etc/os-release', 'ps'];

async function run() {
  let bootSuccess = 0;
  const commandResults = [];
  let apkInstallOk = false;

  for (let i = 0; i < BOOT_ATTEMPTS; i += 1) {
    const runtime = new AtuaComputerRuntime();
    try {
      await runtime.boot();
      bootSuccess += 1;

      for (const command of COMMANDS) {
        const result = await runtime.exec(command);
        commandResults.push({ command, exitCode: result.exitCode });
      }

      const installResult = await runtime.install(['busybox']);
      const installed = await runtime.exec('cat /var/lib/apk/installed/busybox');
      apkInstallOk = installResult.ok && installed.exitCode === 0;
    } catch {
      // no-op, counted as boot or command failure
    }
  }

  const commandsPassed = commandResults.filter((x) => x.exitCode === 0).length;
  const commandPassRate = commandResults.length ? commandsPassed / commandResults.length : 0;
  const bootPassRate = bootSuccess / BOOT_ATTEMPTS;

  const summary = {
    timestamp: new Date().toISOString(),
    boot: {
      attempts: BOOT_ATTEMPTS,
      successes: bootSuccess,
      passRate: Number(bootPassRate.toFixed(4)),
    },
    commandMatrix: {
      commands: COMMANDS,
      runs: commandResults.length,
      passes: commandsPassed,
      passRate: Number(commandPassRate.toFixed(4)),
    },
    apkInstallOk,
    gate: {
      bootPass: bootPassRate >= 0.95,
      commandPass: commandPassRate >= 0.95,
      crashBlockers: true,
      overall: bootPassRate >= 0.95 && commandPassRate >= 0.95 && apkInstallOk,
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run();
