/**
 * FsBridge — Filesystem bridge to AtuaFS (OPFS-backed).
 *
 * This bridge routes guest filesystem operations from the engine's
 * WASI fd calls to the real AtuaFS persistent filesystem.
 *
 * Phase B: Minimal — engine reads ELF binaries from a provided buffer.
 * Phase C: Full — block-streaming ext2 rootfs + AtuaFS project mount.
 */
export class FsBridge {
  constructor(options = {}) {
    this._mounted = false;
    this._backend = options.backend || 'opfs';
  }

  async mount(options = {}) {
    // Phase C: Connect to AtuaFS (OPFS), set up ext2 block-streaming
    // for rootfs, mount project directory at /mnt/project.
    //
    // Phase B (temporary): Accept a minimal set of files needed for
    // engine bootstrapping (ELF binaries for testing).
    throw new Error(
      'NOT IMPLEMENTED: FsBridge.mount() — AtuaFS/OPFS integration not yet built. ' +
      'Requires: (1) OPFS access via navigator.storage.getDirectory(), ' +
      '(2) ext2 block reader for rootfs image, ' +
      '(3) copy-on-write overlay for writes.'
    );
  }

  async readFile(path) {
    throw new Error(`NOT IMPLEMENTED: FsBridge.readFile("${path}") — no real filesystem connected`);
  }

  async writeFile(path, content) {
    throw new Error(`NOT IMPLEMENTED: FsBridge.writeFile("${path}") — no real filesystem connected`);
  }

  async exists(path) {
    throw new Error(`NOT IMPLEMENTED: FsBridge.exists("${path}") — no real filesystem connected`);
  }

  async list(prefix = '/') {
    throw new Error(`NOT IMPLEMENTED: FsBridge.list("${prefix}") — no real filesystem connected`);
  }

  async mkdir(path) {
    throw new Error(`NOT IMPLEMENTED: FsBridge.mkdir("${path}") — no real filesystem connected`);
  }

  async stat(path) {
    throw new Error(`NOT IMPLEMENTED: FsBridge.stat("${path}") — no real filesystem connected`);
  }

  snapshot() {
    throw new Error('NOT IMPLEMENTED: FsBridge.snapshot() — no real filesystem to snapshot');
  }

  restore(snapshot) {
    throw new Error('NOT IMPLEMENTED: FsBridge.restore() — no real filesystem to restore');
  }
}
