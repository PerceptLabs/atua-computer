import { EventEmitter } from 'node:events';
import { FsBridge } from './bridges/fs-bridge.js';
import { NetBridge } from './bridges/net-bridge.js';
import { PtyBridge } from './bridges/pty-bridge.js';
import { SyscallTracer } from './syscall-tracer.js';
import { AtuaLinuxEngine } from './engine/atua-linux-engine.js';
import { runGoldenWorkloads } from './workloads/golden-workloads.js';

export class AtuaComputerRuntime {
  constructor(deps = {}) {
    this._booted = false;
    this._nextPid = 1000;
    this._processes = new Map();
    this._services = new Map();
    this._checkpoints = new Map();
    this._events = new EventEmitter();

    this._fs = deps.fsBridge || new FsBridge();
    this._net = deps.netBridge || new NetBridge();
    this._pty = deps.ptyBridge || new PtyBridge();
    this._tracer = deps.syscallTracer || new SyscallTracer();
    this._engine = deps.engine || new AtuaLinuxEngine({
      fsBridge: this._fs,
      netBridge: this._net,
      ptyBridge: this._pty,
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

    // Boot the real engine (loads Blink WASIX binary, initializes bridges)
    await this._engine.boot(options);

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
    this._emit('process.spawned', { pid, command, ptySessionId: proc.ptySessionId });
    return { pid, command, status: proc.status, ptySessionId: proc.ptySessionId };
  }

  async signal(pid, signal) {
    this._requireBooted();
    const proc = this._mustGetProcess(pid);
    if (proc.status !== 'running') return;
    proc.status = 'signaled';
    proc.exitCode = typeof signal === 'number' ? 128 + signal : 143;
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
    // Real implementation: runs `apk add <packages>` via exec() inside the engine.
    // The engine executes the real apk binary from the Alpine rootfs.
    const pkgList = Array.from(packages || []).join(' ');
    const result = await this.exec(`apk add ${pkgList}`);
    this._emit('packages.installed', { packages, options });
    return {
      ok: result.exitCode === 0,
      installed: result.exitCode === 0 ? Array.from(packages || []) : [],
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
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
    // Real implementation: snapshot the ext2 write overlay in OPFS + Nitro service configs.
    // For now, this captures process/service state. FS snapshot requires real OPFS integration.
    const id = label;
    const snapshot = {
      id,
      createdAt: Date.now(),
      nextPid: this._nextPid,
      processes: Array.from(this._processes.values()).map((p) => ({ ...p })),
      services: Array.from(this._services.values()).map((s) => ({ ...s })),
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
    this._tracer.restore(snapshot.tracer);
    this._logs = [...(snapshot.logs || [])];
    this._serviceHistory = new Map(snapshot.serviceHistory || []);

    this._emit('checkpoint.restored', { id });
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
    const methods = ['boot', 'exec', 'spawn', 'signal', 'read', 'write', 'install', 'service', 'checkpoint', 'restore', 'status', 'reset', 'runGoldenWorkloadPack', 'logs'];
    const available = methods.reduce((acc, name) => {
      acc[name] = typeof this[name] === 'function';
      return acc;
    }, {});
    return { methods: available };
  }

  async syscallReport() {
    return {
      counts: this._tracer.countsByTier(),
      coverage: this._tracer.coverage(),
    };
  }

  async backendProfile() {
    return { ...this._backend };
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
