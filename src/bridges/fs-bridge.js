export class InMemoryFsBridge {
  constructor() {
    this._mounted = false;
    this._files = new Map();
    this._dirs = new Set(['/']);
  }

  async mount({ rootfs = {}, overlay = {} } = {}) {
    this._mounted = true;
    this._files.clear();
    this._dirs = new Set(['/']);

    for (const [path, content] of Object.entries({ ...rootfs, ...overlay })) {
      await this.writeFile(path, content);
    }
  }

  ensureMounted() {
    if (!this._mounted) throw new Error('FS bridge not mounted');
  }

  _parentDirs(path) {
    const normalized = path.replace(/\/+/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const dirs = ['/'];
    let current = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      current += `/${parts[i]}`;
      dirs.push(current);
    }
    return dirs;
  }

  async mkdir(path) {
    this.ensureMounted();
    if (!path.startsWith('/')) throw new Error(`EINVAL: ${path}`);
    this._dirs.add(path);
  }

  async readFile(path) {
    this.ensureMounted();
    if (!this._files.has(path)) throw new Error(`ENOENT: ${path}`);
    return this._files.get(path);
  }

  async writeFile(path, content) {
    this.ensureMounted();
    if (!path.startsWith('/')) throw new Error(`EINVAL: ${path}`);
    for (const dir of this._parentDirs(path)) this._dirs.add(dir);
    this._files.set(path, String(content));
  }

  async exists(path) {
    this.ensureMounted();
    return this._files.has(path) || this._dirs.has(path);
  }

  async list(prefix = '/') {
    this.ensureMounted();
    const all = [...this._dirs, ...this._files.keys()];
    return Array.from(new Set(all)).filter((p) => p.startsWith(prefix)).sort();
  }

  snapshot() {
    return {
      mounted: this._mounted,
      files: Array.from(this._files.entries()),
      dirs: Array.from(this._dirs.values()),
    };
  }

  restore(snapshot) {
    this._mounted = Boolean(snapshot?.mounted);
    this._files = new Map(snapshot?.files || []);
    this._dirs = new Set(snapshot?.dirs || ['/']);
  }
}
