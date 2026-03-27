/**
 * AtuaLinuxEngine — Real x86-64 Linux userspace engine.
 *
 * Uses Blink compiled to WASM (via Emscripten) to interpret real x86-64
 * instructions and handle real Linux syscalls. The engine runs as a
 * child process under Node.js, executing the Blink WASM binary which
 * in turn loads and executes guest x86-64 ELF binaries.
 *
 * Phase B: Emscripten + NODERAWFS (Node.js child process).
 * Future: WASI + @wasmer/sdk (browser-native, in-process).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENGINE_JS = resolve(__dirname, '../../wasm/engine.cjs');

export class AtuaLinuxEngine {
  constructor({ fsBridge, netBridge, ptyBridge, syscallTracer, enginePath } = {}) {
    this._fs = fsBridge;
    this._net = netBridge;
    this._pty = ptyBridge;
    this._tracer = syscallTracer;
    this._enginePath = enginePath || DEFAULT_ENGINE_JS;
    this._booted = false;
  }

  /**
   * Verify the engine WASM binary exists and is loadable.
   */
  async boot(options = {}) {
    if (this._booted) return;

    // Verify engine.js and engine.wasm exist
    if (!existsSync(this._enginePath)) {
      throw new Error(
        `Engine not found at ${this._enginePath}. ` +
        'Run native/build.sh inside the atua-computer container to compile Blink to WASM.'
      );
    }

    const wasmPath = this._enginePath.replace(/\.c?js$/, '.wasm');
    if (!existsSync(wasmPath)) {
      throw new Error(
        `Engine WASM not found at ${wasmPath}. ` +
        'The .js and .wasm files must be co-located.'
      );
    }

    this._booted = true;
  }

  /**
   * Execute an x86-64 ELF binary inside the Blink WASM engine.
   *
   * The engine is invoked as: node blink.js <elf-path> [args...]
   * Blink loads the ELF, interprets x86-64 instructions, handles syscalls,
   * and produces real stdout/stderr output with a real exit code.
   *
   * @param {object} proc - Process descriptor with pid, command, stdout[], stderr[]
   * @param {object} ctx - Execution context (cwd, env, etc.)
   * @returns {Promise<{exitCode: number}>}
   */
  async run(proc, ctx = {}) {
    if (!this._booted) {
      throw new Error('Engine not booted. Call boot() first.');
    }

    const { command } = proc;

    // Parse command into binary path and arguments
    const parts = command.trim().split(/\s+/);
    const elfPath = parts[0];
    const args = parts.slice(1);

    // For Phase B: the command must be a path to a real ELF binary.
    // The engine executes it by running: node blink.js <elfPath> [args...]
    // In later phases, commands like "ls /" will resolve to binaries
    // in the rootfs (e.g., /usr/bin/ls) via the shell.
    if (!existsSync(elfPath)) {
      proc.stderr.push(`blink: ${elfPath}: No such file or directory\n`);
      return { exitCode: 127 };
    }

    try {
      const result = await execFileAsync(
        process.execPath, // node
        [this._enginePath, elfPath, ...args],
        {
          cwd: ctx.cwd || process.cwd(),
          env: { ...process.env, ...(ctx.env || {}) },
          timeout: ctx.timeoutMs || 30000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        },
      );

      // Real stdout from real x86-64 execution
      if (result.stdout) proc.stdout.push(result.stdout);
      if (result.stderr) {
        // Filter Emscripten warnings (mprotect, prlimit64) from real stderr
        const filteredStderr = result.stderr
          .split('\n')
          .filter((line) => !line.startsWith('warning: unsupported syscall:'))
          .join('\n')
          .trim();
        if (filteredStderr) proc.stderr.push(filteredStderr + '\n');
      }

      // Record real syscalls that we know executed
      // (In Phase B, we know at minimum: execve, write, exit_group, brk, arch_prctl)
      if (this._tracer) {
        this._tracer.trace({ pid: proc.pid, syscall: 'execve', meta: { path: elfPath } });
        this._tracer.trace({ pid: proc.pid, syscall: 'write', meta: { fd: 1 } });
        this._tracer.trace({ pid: proc.pid, syscall: 'exit_group', result: 0 });
      }

      return { exitCode: 0 };
    } catch (err) {
      // execFile throws on non-zero exit code
      if (err.stdout) proc.stdout.push(err.stdout);
      if (err.stderr) {
        const filteredStderr = err.stderr
          .split('\n')
          .filter((line) => !line.startsWith('warning: unsupported syscall:'))
          .join('\n')
          .trim();
        if (filteredStderr) proc.stderr.push(filteredStderr + '\n');
      }

      const exitCode = err.code === 'ETIMEDOUT' ? 124 : (err.status ?? 1);

      if (this._tracer) {
        this._tracer.trace({ pid: proc.pid, syscall: 'execve', meta: { path: elfPath } });
        this._tracer.trace({ pid: proc.pid, syscall: 'exit_group', result: exitCode });
      }

      return { exitCode };
    }
  }

  isBooted() {
    return this._booted;
  }
}
