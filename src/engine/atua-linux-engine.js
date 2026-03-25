export class AtuaLinuxEngine {
  constructor({ fsBridge, netBridge, syscallTracer }) {
    this._fs = fsBridge;
    this._net = netBridge;
    this._tracer = syscallTracer;
  }

  async run(proc, ctx = {}) {
    const { pid, command } = proc;
    const normalized = command.trim();

    if (normalized === 'sh') {
      proc.stdout.push('sh: interactive shell ready\n');
      this._tracer.trace({ pid, syscall: 'clone' });
      this._tracer.trace({ pid, syscall: 'close' });
      return { exitCode: 0 };
    }

    if (normalized === 'pwd') {
      proc.stdout.push(`${ctx.cwd || '/workspace'}\n`);
      this._tracer.trace({ pid, syscall: 'write' });
      return { exitCode: 0 };
    }

    if (normalized.startsWith('ls')) {
      const [, path] = normalized.split(/\s+/, 2);
      const target = path || '/';
      const entries = await this._fs.list(target);
      proc.stdout.push(`${entries.join('\n')}\n`);
      this._tracer.trace({ pid, syscall: 'openat', meta: { path: target } });
      return { exitCode: 0 };
    }

    if (normalized.startsWith('mkdir ')) {
      const path = normalized.slice(6).trim();
      await this._fs.mkdir(path);
      this._tracer.trace({ pid, syscall: 'openat', meta: { path } });
      return { exitCode: 0 };
    }

    if (normalized === 'ps') {
      const rows = (ctx.processes || []).map((p) => `${p.pid} ${p.status} ${p.command}`);
      proc.stdout.push(`${rows.join('\n')}\n`);
      this._tracer.trace({ pid, syscall: 'read' });
      return { exitCode: 0 };
    }

    if (normalized.startsWith('echo ')) {
      proc.stdout.push(`${normalized.slice(5)}\n`);
      this._tracer.trace({ pid, syscall: 'write' });
      return { exitCode: 0 };
    }

    if (normalized === 'node -v') {
      proc.stdout.push('v22.0.0-atua\n');
      this._tracer.trace({ pid, syscall: 'epoll_wait' });
      this._tracer.trace({ pid, syscall: 'eventfd2' });
      return { exitCode: 0 };
    }

    if (normalized === 'python --version') {
      proc.stdout.push('Python 3.12.0-atua\n');
      this._tracer.trace({ pid, syscall: 'futex' });
      this._tracer.trace({ pid, syscall: 'mmap' });
      return { exitCode: 0 };
    }

    if (normalized.startsWith('cat ')) {
      const path = normalized.slice(4).trim();
      try {
        const text = await this._fs.readFile(path);
        proc.stdout.push(`${text}\n`);
        this._tracer.trace({ pid, syscall: 'openat', meta: { path } });
        this._tracer.trace({ pid, syscall: 'read', meta: { path } });
        this._tracer.trace({ pid, syscall: 'close', meta: { path } });
        return { exitCode: 0 };
      } catch (error) {
        proc.stderr.push(`${error.message}\n`);
        return { exitCode: 1 };
      }
    }

    if (normalized.startsWith('curl ')) {
      const [, target] = normalized.split(/\s+/, 2);
      const socket = await this._net.open({ host: target || 'example.com', port: 443 });
      this._tracer.trace({ pid, syscall: 'socket', meta: { host: socket.host } });
      this._tracer.trace({ pid, syscall: 'connect', meta: { host: socket.host, port: socket.port } });
      this._tracer.trace({ pid, syscall: 'close', meta: { socketId: socket.id } });
      proc.stdout.push(`connected:${socket.host}:${socket.port}\n`);
      await this._net.close(socket.id);
      return { exitCode: 0 };
    }

    proc.stdout.push(`executed: ${command}\n`);
    this._tracer.trace({ pid, syscall: 'write' });
    return { exitCode: 0 };
  }
}
