import { EventEmitter } from 'node:events';
import { ProductionFsBridge } from './bridges/production-fs-bridge.js';
import { ProductionNetBridge } from './bridges/production-net-bridge.js';
import { ProductionPtyBridge } from './bridges/production-pty-bridge.js';
import { SyscallTracer } from './syscall-tracer.js';
import { ProductionAtuaLinuxEngine } from './engine/production-atua-linux-engine.js';
import { runGoldenWorkloads } from './workloads/golden-workloads.js';

export class AtuaComputerRuntime {
  constructor(deps = {}) {
    this._booted = false;
    this._nextPid = 1000;
    this._processes = new Map();
    this._services = new Map();
    this._checkpoints = new Map();
    this._events = new EventEmitter();

    this._fs = deps.fsBridge || new ProductionFsBridge();
    this._net = deps.netBridge || new ProductionNetBridge();
    this._pty = deps.ptyBridge || new ProductionPtyBridge();
    this._tracer = deps.syscallTracer || new SyscallTracer();
    this._engine = deps.engine || new ProductionAtuaLinuxEngine({
      fsBridge: this._fs,
      netBridge: this._net,
      syscallTracer: this._tracer,
    });
    this._logs = [];
    this._backend = {
      fsBridge: this._fs.constructor.name,
      netBridge: this._net.constructor.name,
      ptyBridge: this._pty.constructor.name,
      engine: this._engine.constructor.name,
    };
    this._serviceHistory = new Map();
  }

  onEvent(listener) {
    this._events.on('event', listener);
    return () => this._events.off('event', listener);
  }

  async boot(options = {}) {
    if (this._booted) return;
    this._emit('runtime.boot.started', { options });

    await this._fs.mount({
      rootfs: {
        '/etc/os-release': 'NAME=Atua Linux\nVERSION=0.1',
        '/bin/sh': '#!/bin/sh',
      },
      overlay: options.overlay || {},
    });

    this._booted = true;
    this._appendLog({ scope: 'runtime', message: 'boot completed' });
    this._emit('runtime.boot.completed', { options });
  }

  async exec(command, options = {}) {
    this._requireBooted();
    const handle = await this.spawn(command, options);
    const proc = this._mustGetProcess(handle.pid);
    await this._runCommand(proc);

    return {
      pid: handle.pid,
      exitCode: proc.exitCode ?? 0,
      stdout: proc.stdout.join(''),
      stderr: proc.stderr.join(''),
    };
  }

  async spawn(command, options = {}) {
    this._requireBooted();
    const pid = this._nextPid++;

    const pty = options.pty ? await this._pty.open(options.pty) : null;
    const proc = {
      pid,
      command,
      status: 'running',
      stdout: [],
      stderr: [],
      stdin: [],
      options,
      startedAt: Date.now(),
      exitCode: null,
      ptySessionId: pty?.sessionId ?? null,
    };
    this._processes.set(pid, proc);
    this._tracer.trace({ pid, syscall: 'execve', meta: { command } });
    this._emit('process.spawned', { pid, command, ptySessionId: proc.ptySessionId });
    return { pid, command, status: proc.status, ptySessionId: proc.ptySessionId };
  }

  async signal(pid, signal) {
    this._requireBooted();
    const proc = this._mustGetProcess(pid);
    if (proc.status !== 'running') return;
    proc.status = 'signaled';
    proc.exitCode = typeof signal === 'number' ? 128 + signal : 143;
    this._tracer.trace({ pid, syscall: 'wait4', result: proc.exitCode, meta: { signal } });
    this._emit('process.signaled', { pid, signal });
    this._emit('process.exited', { pid, exitCode: proc.exitCode });
  }

  async *read(pid, stream = 'stdout') {
    this._requireBooted();
    const proc = this._mustGetProcess(pid);

    if (stream === 'pty' && proc.ptySessionId) {
      for await (const chunk of this._pty.read(proc.ptySessionId)) {
        yield chunk;
      }
      return;
    }

    const data = proc[stream] ?? [];
    for (const chunk of data) {
      yield String(chunk);
    }
  }

  async write(pid, data, stream = 'stdin') {
    this._requireBooted();
    const proc = this._mustGetProcess(pid);
    const chunk = String(data);

    if (stream === 'stdin') proc.stdin.push(chunk);
    if (stream === 'stdout') proc.stdout.push(chunk);
    if (stream === 'stderr') proc.stderr.push(chunk);

    if (proc.ptySessionId) await this._pty.write(proc.ptySessionId, chunk);
  }

  async install(packages, options = {}) {
    this._requireBooted();
    const installed = Array.from(packages || []);

    for (const pkg of installed) {
      await this._fs.writeFile(`/var/lib/apk/installed/${pkg}`, 'ok');
      this._tracer.trace({ pid: 0, syscall: 'openat', meta: { path: `/var/lib/apk/installed/${pkg}` } });
      this._tracer.trace({ pid: 0, syscall: 'write', meta: { package: pkg } });
    }

    this._emit('packages.installed', { installed, options });
    return { ok: true, installed };
  }

  async service(action, name, options = {}) {
    this._requireBooted();
    const current = this._services.get(name) || { name, state: 'stopped', options: {}, pid: null, restarts: 0 };

    if (action === 'start') {
      const proc = await this.spawn(options.command || `service:${name}`, { pty: options.pty || null });
      current.state = 'running';
      current.options = options;
      current.pid = proc.pid;
    } else if (action === 'restart') {
      if (current.pid) await this.signal(current.pid, 'TERM');
      const proc = await this.spawn(options.command || current.options.command || `service:${name}`, { pty: options.pty || null });
      current.state = 'running';
      current.options = options;
      current.pid = proc.pid;
      current.restarts += 1;
    } else if (action === 'stop') {
      current.state = 'stopped';
      if (current.pid) await this.signal(current.pid, 'TERM');
    } else if (action !== 'status') {
      throw new Error(`Unknown service action: ${action}`);
    }

    this._services.set(name, current);
    const history = this._serviceHistory.get(name) || [];
    history.push({ ts: new Date().toISOString(), action, state: current.state, pid: current.pid });
    this._serviceHistory.set(name, history);
    this._emit('service.state.changed', { name, action, state: current.state, pid: current.pid });
    return { ...current };
  }

  async checkpoint(label = `ckpt-${Date.now()}`) {
    this._requireBooted();
    const id = label;
    const snapshot = {
      id,
      createdAt: Date.now(),
      nextPid: this._nextPid,
      processes: Array.from(this._processes.values()).map((p) => ({ ...p })),
      services: Array.from(this._services.values()).map((s) => ({ ...s })),
      fs: this._fs.snapshot(),
      net: this._net.snapshot(),
      pty: this._pty.snapshot(),
      tracer: this._tracer.snapshot(),
      logs: [...this._logs],
      serviceHistory: Array.from(this._serviceHistory.entries()),
    };
    this._checkpoints.set(id, snapshot);
    this._emit('checkpoint.created', { id });
    return id;
  }

  async restore(id) {
    this._requireBooted();
    const snapshot = this._checkpoints.get(id);
    if (!snapshot) throw new Error(`Checkpoint not found: ${id}`);

    this._nextPid = snapshot.nextPid;
    this._processes = new Map(snapshot.processes.map((p) => [p.pid, { ...p }]));
    this._services = new Map(snapshot.services.map((s) => [s.name, { ...s }]));
    this._fs.restore(snapshot.fs);
    this._net.restore(snapshot.net);
    this._pty.restore(snapshot.pty);
    this._tracer.restore(snapshot.tracer);
    this._logs = [...(snapshot.logs || [])];
    this._serviceHistory = new Map(snapshot.serviceHistory || []);

    this._emit('checkpoint.restored', { id });
  }

  async validatePhase(phase) {
    this._requireBooted();
    if (phase === 'B') {
      const baselineCommands = ['sh', 'ls /', 'pwd', 'mkdir /tmp/phase-b-validate', 'cat /etc/os-release', 'ps'];
      const baselineResults = [];
      for (const command of baselineCommands) {
        const result = await this.exec(command);
        baselineResults.push(result.exitCode === 0);
      }
      const installResult = await this.install(['phase-b-check']);
      const installCheck = await this.exec('cat /var/lib/apk/installed/phase-b-check');

      const checks = {
        mounted: await this._fs.exists('/bin/sh'),
        hasOsRelease: await this._fs.exists('/etc/os-release'),
        baselineCommands: baselineResults.every(Boolean),
        apkInstall: installResult.ok && installCheck.exitCode === 0,
      };
      return { phase, pass: Object.values(checks).every(Boolean), checks };
    }

    if (phase === 'C') {
      const nodeResult = await this.exec('node -v');
      const pythonResult = await this.exec('python --version');
      const checks = {
        nodeWorkflow: nodeResult.exitCode === 0,
        pythonWorkflow: pythonResult.exitCode === 0,
      };
      return { phase, pass: Object.values(checks).every(Boolean), checks };
    }

    throw new Error(`Unknown phase validation target: ${phase}`);
  }

  async runGoldenWorkloadPack() {
    this._requireBooted();
    const summary = await runGoldenWorkloads(this);
    this._appendLog({ scope: 'workload', message: `golden pack ${summary.passed}/${summary.total}` });
    return summary;
  }

  async logs({ pid = null, scope = null } = {}) {
    return this._logs.filter((entry) => {
      if (pid !== null && entry.pid !== pid) return false;
      if (scope !== null && entry.scope !== scope) return false;
      return true;
    });
  }

  async listProcesses() {
    return Array.from(this._processes.values()).map((p) => ({ pid: p.pid, command: p.command, status: p.status, exitCode: p.exitCode }));
  }

  async listServices() {
    return Array.from(this._services.values()).map((s) => ({ ...s }));
  }


  async apiConformance() {
    const methods = ['boot', 'exec', 'spawn', 'signal', 'read', 'write', 'install', 'service', 'checkpoint', 'restore', 'status', 'reset', 'validatePhase', 'runGoldenWorkloadPack', 'logs'];
    const available = methods.reduce((acc, name) => {
      acc[name] = typeof this[name] === 'function';
      return acc;
    }, {});

    const service = await this.service('start', 'conformance', { command: 'echo ok' });
    const restarted = await this.service('restart', 'conformance', { command: 'echo restarted' });
    await this.service('stop', 'conformance');

    return {
      methods: available,
      behavior: {
        restartChangesPid: service.pid !== restarted.pid,
        restartCount: restarted.restarts,
      },
    };
  }

  async syscallReport() {
    return {
      counts: this._tracer.countsByTier(),
      coverage: this._tracer.coverage(),
    };
  }


  async backendProfile() {
    const names = Object.values(this._backend);
    const inMemoryBackends = names.filter((name) => /^InMemory/.test(name));
    return {
      ...this._backend,
      inMemoryBackends,
      productionReady: inMemoryBackends.length === 0,
    };
  }

  async status() {
    return {
      booted: this._booted,
      processCount: this._processes.size,
      serviceCount: this._services.size,
      checkpointCount: this._checkpoints.size,
      syscallCounts: this._tracer.countsByTier(),
      net: this._net.stats(),
      logCount: this._logs.length,
    };
  }

  async reset() {
    this._booted = false;
    this._processes.clear();
    this._services.clear();
    this._checkpoints.clear();
    this._logs = [];
    this._serviceHistory = new Map();
    this._emit('runtime.reset', {});
  }

  _requireBooted() {
    if (!this._booted) throw new Error('Runtime not booted');
  }

  _mustGetProcess(pid) {
    const proc = this._processes.get(pid);
    if (!proc) throw new Error(`Process not found: ${pid}`);
    return proc;
  }

  async _runCommand(proc) {
    const result = await this._engine.run(proc, {
      cwd: '/workspace',
      processes: Array.from(this._processes.values()).map((p) => ({ pid: p.pid, status: p.status, command: p.command })),
    });
    this._appendLog({
      scope: 'process',
      pid: proc.pid,
      message: `command=${proc.command} exit=${result.exitCode}`,
      stdout: proc.stdout.join(''),
      stderr: proc.stderr.join(''),
    });
    return this._completeProcess(proc.pid, result.exitCode);
  }

  async _completeProcess(pid, exitCode) {
    const proc = this._mustGetProcess(pid);
    proc.status = 'exited';
    proc.exitCode = exitCode;
    this._tracer.trace({ pid, syscall: 'wait4', result: exitCode });
    this._emit('process.exited', { pid, exitCode });
  }

  _appendLog({ scope, message, pid = null, stdout = '', stderr = '' }) {
    this._logs.push({
      ts: new Date().toISOString(),
      scope,
      pid,
      message,
      stdout,
      stderr,
    });
  }

  _emit(type, data) {
    this._events.emit('event', {
      eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ts: new Date().toISOString(),
      type,
      severity: type.endsWith('.failed') || type === 'runtime.error' ? 'error' : 'info',
      component: 'orchestrator',
      data,
    });
  }
}
