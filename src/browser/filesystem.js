/**
 * In-memory virtual filesystem with overlay (writable) on top of tar (read-only).
 * Provides open/read/write/stat/readdir/close/mkdir/unlink/rename/symlink.
 * Used by atua WASM imports (fs_open, fs_read, etc.) and host_syscall dispatch.
 */

export class VirtualFS {
  constructor() {
    this.files = new Map();       // path → Uint8Array (base + overlay)
    this.dirs = new Set();        // directory paths
    this.symlinks = new Map();    // path → target string
    this.whiteouts = new Set();   // paths that appear deleted from base
    this.metadata = new Map();    // path → {mode, uid, gid, atime, mtime}
    this.children = new Map();    // dirpath → Set<childname> (index for readdir)
    this.nextFd = 4;              // 0-2 reserved, 3 = preopened root
    this.openFiles = new Map();   // fd → { content, position, path, isDir, dirPath, special, append, cloexec }
    // Pre-populate stdin/stdout/stderr so dup2 works on them
    this.openFiles.set(0, { special: 'stdin', position: 0, path: '/dev/stdin' });
    this.openFiles.set(1, { special: 'stdout', position: 0, path: '/dev/stdout' });
    this.openFiles.set(2, { special: 'stderr', position: 0, path: '/dev/stderr' });
    this.bootTime = Math.floor(Date.now() / 1000); // [1d] stable mtime for all base-layer files
  }

  /**
   * Load files from a tar archive (base layer, read-only).
   * Supports basic POSIX tar (ustar) format.
   */
  async loadTar(tarData) {
    const data = tarData instanceof Uint8Array ? tarData : new Uint8Array(tarData);
    let offset = 0;

    while (offset + 512 <= data.length) {
      const header = data.subarray(offset, offset + 512);
      offset += 512;

      if (header.every(b => b === 0)) break;

      let name = '';
      for (let i = 0; i < 100 && header[i]; i++) name += String.fromCharCode(header[i]);

      let prefix = '';
      if (header[257] === 0x75 && header[258] === 0x73 && header[259] === 0x74) {
        for (let i = 345; i < 500 && header[i]; i++) prefix += String.fromCharCode(header[i]);
      }
      if (prefix) name = prefix + '/' + name;

      if (name.startsWith('./')) name = name.substring(2);
      if (!name.startsWith('/')) name = '/' + name;
      name = name.replace(/\/+$/, '');
      if (!name || name === '/') { offset = (offset + 511) & ~511; continue; }

      let sizeStr = '';
      for (let i = 124; i < 136 && header[i] >= 0x30; i++) sizeStr += String.fromCharCode(header[i]);
      const size = parseInt(sizeStr.trim(), 8) || 0;

      let modeStr = '';
      for (let i = 100; i < 108 && header[i] >= 0x30; i++) modeStr += String.fromCharCode(header[i]);
      const mode = parseInt(modeStr.trim(), 8) || 0o755;

      const typeflag = header[156];

      if (typeflag === 0x35 || typeflag === 53 || name.endsWith('/')) {
        this._registerDir(name);
      } else if (typeflag === 2 || typeflag === 0x32) {
        let linkname = '';
        for (let i = 157; i < 257 && header[i]; i++) linkname += String.fromCharCode(header[i]);
        if (!linkname.startsWith('/')) {
          const dir = name.substring(0, name.lastIndexOf('/') + 1);
          linkname = dir + linkname;
        }
        if (!linkname.startsWith('/')) linkname = '/' + linkname;
        linkname = linkname.replace(/\/+/g, '/').replace(/\/$/, '');
        this.symlinks.set(name, linkname);
        this.dirs.add(name);
        this._addChild(name);
      } else if (typeflag === 0 || typeflag === 0x30 || typeflag === 48) {
        if (size > 0 && offset + size <= data.length) {
          this.files.set(name, data.slice(offset, offset + size));
          this._registerParents(name);
          this._addChild(name);
          if (mode !== 0o755) {
            this.metadata.set(name, { mode });
          }
        } else if (size === 0) {
          this.files.set(name, new Uint8Array(0));
          this._registerParents(name);
          this._addChild(name);
        }
      }

      offset += Math.ceil(size / 512) * 512;
    }
  }

  _registerParents(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/') || '/';
      this._registerDir(dir);
    }
  }

  _registerDir(path) {
    if (!this.dirs.has(path)) {
      this.dirs.add(path);
      if (!this.children.has(path)) this.children.set(path, new Set());
      this._addChild(path);
    }
  }

  _addChild(path) {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) {
      if (!this.children.has('/')) this.children.set('/', new Set());
      if (path !== '/') this.children.get('/').add(path.substring(1));
    } else {
      const parent = path.substring(0, lastSlash);
      if (!this.children.has(parent)) this.children.set(parent, new Set());
      this.children.get(parent).add(path.substring(lastSlash + 1));
    }
  }

  _removeChild(path) {
    const lastSlash = path.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : path.substring(0, lastSlash);
    const name = path.substring(lastSlash + 1);
    const ch = this.children.get(parent);
    if (ch) ch.delete(name);
  }

  addFile(path, content) {
    if (!path.startsWith('/')) path = '/' + path;
    this.files.set(path, content instanceof Uint8Array ? content : new Uint8Array(content));
    this.whiteouts.delete(path);
    this._registerParents(path);
    this._addChild(path);
    this.markDirty();
  }

  normalizePath(path) {
    const parts = path.split('/');
    const result = [];
    for (const p of parts) {
      if (p === '' || p === '.') continue;
      if (p === '..') { result.pop(); continue; }
      result.push(p);
    }
    return '/' + result.join('/');
  }

  // [1g] Symlink depth 40 (Linux kernel limit), not 10
  resolvePath(path, depth = 0) {
    if (!this.symlinks || this.symlinks.size === 0 || depth > 40) return path;
    path = this.normalizePath(path);
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const target = this.symlinks.get(prefix);
      if (target) {
        const rest = parts.slice(i).join('/');
        let resolved = rest ? target + '/' + rest : target;
        resolved = this.normalizePath(resolved);
        return this.resolvePath(resolved, depth + 1);
      }
    }
    return path;
  }

  exists(path) {
    if (this.whiteouts.has(path)) return false;
    return this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path);
  }

  // [1c] readdir includes . and ..
  readdir(dirPath) {
    dirPath = this.normalizePath(dirPath);
    const entries = [
      { name: '.', type: 'dir' },
      { name: '..', type: 'dir' },
    ];
    const seen = new Set(['.', '..']);

    const ch = this.children.get(dirPath);
    if (ch) {
      for (const name of ch) {
        const childPath = dirPath === '/' ? '/' + name : dirPath + '/' + name;
        if (this.whiteouts.has(childPath)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        let type = 'file';
        if (this.dirs.has(childPath)) type = 'dir';
        if (this.symlinks.has(childPath)) type = 'symlink';
        entries.push({ name, type });
      }
    }

    return entries;
  }

  mkdir(path) {
    path = this.normalizePath(path);
    this._registerDir(path);
    this._registerParents(path);
    this.whiteouts.delete(path);
    this.markDirty();
  }

  unlink(path) {
    path = this.normalizePath(path);
    this.files.delete(path);
    this.symlinks.delete(path);
    this.metadata.delete(path);
    this.whiteouts.add(path);
    this._removeChild(path);
    this.markDirty();
  }

  rmdir(path) {
    path = this.normalizePath(path);
    this.dirs.delete(path);
    this.children.delete(path);
    this.metadata.delete(path);
    this.whiteouts.add(path);
    this._removeChild(path);
    this.markDirty();
  }

  createSymlink(target, linkpath) {
    linkpath = this.normalizePath(linkpath);
    this.symlinks.set(linkpath, target);
    this.dirs.add(linkpath);
    this.whiteouts.delete(linkpath);
    this._addChild(linkpath);
  }

  rename(from, to) {
    from = this.normalizePath(from);
    to = this.normalizePath(to);

    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from));
      this.files.delete(from);
    }
    if (this.symlinks.has(from)) {
      this.symlinks.set(to, this.symlinks.get(from));
      this.symlinks.delete(from);
    }
    if (this.dirs.has(from)) {
      this.dirs.delete(from);
      this.dirs.add(to);
      const ch = this.children.get(from);
      if (ch) {
        this.children.delete(from);
        this.children.set(to, ch);
      }
    }
    if (this.metadata.has(from)) {
      this.metadata.set(to, this.metadata.get(from));
      this.metadata.delete(from);
    }
    this._removeChild(from);
    this._addChild(to);
    this._registerParents(to);
    this.whiteouts.add(from);
    this.whiteouts.delete(to);
    this.markDirty();
  }

  stat(path, followSymlinks = true) {
    if (!path.startsWith('/')) path = '/' + path;

    if (path === '/dev/null' || path === '/dev/urandom' || path === '/dev/random') {
      return { size: 0, type: 'chardev' };
    }

    if (!followSymlinks && this.symlinks.has(path)) {
      const target = this.symlinks.get(path);
      const meta = this.metadata.get(path) || {};
      return { size: target.length, type: 'symlink', ...meta };
    }

    const resolved = this.resolvePath(path);

    if (this.whiteouts.has(resolved)) return null;

    const content = this.files.get(resolved);
    if (content) {
      const meta = this.metadata.get(resolved) || {};
      return { size: content.length, type: 'file', ...meta };
    }
    if (this.dirs.has(resolved)) {
      const meta = this.metadata.get(resolved) || {};
      return { size: 0, type: 'dir', ...meta };
    }
    if (this.dirs.has(path)) {
      const meta = this.metadata.get(path) || {};
      return { size: 0, type: 'dir', ...meta };
    }
    return null;
  }

  // [1a] O_APPEND, [1b] O_EXCL, [1f] O_CLOEXEC
  open(path, flags, mode) {
    if (!path.startsWith('/')) path = '/' + path;

    // Special files
    if (path === '/dev/null') {
      const fd = this.nextFd++;
      this.openFiles.set(fd, { content: new Uint8Array(0), position: 0, path, special: 'null', append: false, cloexec: !!(flags & 0x80000) });
      return fd;
    }
    if (path === '/dev/urandom' || path === '/dev/random') {
      const fd = this.nextFd++;
      this.openFiles.set(fd, { content: new Uint8Array(0), position: 0, path, special: 'urandom', append: false, cloexec: !!(flags & 0x80000) });
      return fd;
    }

    const resolved = this.resolvePath(path);

    if (this.whiteouts.has(resolved) && !(flags & 0x40)) return -1;

    let content = this.files.get(resolved);

    // O_DIRECTORY (0x10000)
    if (flags & 0x10000) {
      if (this.dirs.has(resolved) || this.dirs.has(path)) {
        const fd = this.nextFd++;
        this.openFiles.set(fd, { isDir: true, dirPath: resolved, position: 0, path: resolved, append: false, cloexec: !!(flags & 0x80000) });
        return fd;
      }
      return -1;
    }

    // [1b] O_EXCL — fail if file already exists
    if ((flags & 0x40) && (flags & 0x80)) { // O_CREAT | O_EXCL
      if (content || this.files.has(resolved) || this.dirs.has(resolved)) return -17; // EEXIST
    }

    // O_CREAT (0x40)
    if (!content && (flags & 0x40)) {
      content = new Uint8Array(0);
      this.files.set(resolved, content);
      this.whiteouts.delete(resolved);
      this._registerParents(resolved);
      this._addChild(resolved);
      if (mode) {
        this.metadata.set(resolved, { ...(this.metadata.get(resolved) || {}), mode: mode & 0o7777 });
      }
    }

    // O_TRUNC (0x200)
    if (content && (flags & 0x200)) {
      content = new Uint8Array(0);
      this.files.set(resolved, content);
    }

    // Try opening as directory if file not found
    if (!content && (this.dirs.has(resolved) || this.dirs.has(path))) {
      const fd = this.nextFd++;
      this.openFiles.set(fd, { isDir: true, dirPath: resolved, position: 0, path: resolved, append: false, cloexec: !!(flags & 0x80000) });
      return fd;
    }

    if (!content) return -1;

    const fd = this.nextFd++;
    this.openFiles.set(fd, {
      content,
      position: 0,
      path: resolved,
      append: !!(flags & 0x400),   // [1a] O_APPEND
      cloexec: !!(flags & 0x80000), // [1f] O_CLOEXEC
    });
    return fd;
  }

  read(fd, dest, offset) {
    const file = this.openFiles.get(fd);
    if (!file) return -1;

    if (file.special === 'null') return 0;
    if (file.special === 'urandom') {
      crypto.getRandomValues(dest);
      return dest.length;
    }

    const off = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
    const available = file.content.length - off;
    if (available <= 0) return 0;

    const toRead = Math.min(dest.length, available);
    dest.set(file.content.subarray(off, off + toRead));
    return toRead;
  }

  // [1a] O_APPEND: if append flag set, always write at end
  write(fd, src, offset) {
    const file = this.openFiles.get(fd);
    if (!file) return -1;

    if (file.special === 'null') return src.length;

    // [1a] O_APPEND — force write to end of file
    let off;
    if (file.append) {
      off = file.content.length;
    } else {
      off = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
    }
    const needed = off + src.length;

    if (needed > file.content.length) {
      const grown = new Uint8Array(needed);
      grown.set(file.content);
      file.content = grown;
      this.files.set(file.path, grown);
    }

    file.content.set(src, off);
    this.markDirty();
    return src.length;
  }

  close(fd) {
    this.openFiles.delete(fd);
  }

  // --- Phase 4: OPFS Persistence ---

  /** Flush VFS overlay state to OPFS. Only user changes persist — not the base tar. */
  async flushToOPFS() {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('atua-computer', { create: true });
      const overlayDir = await dir.getDirectoryHandle('overlay', { create: true });

      // Serialize overlay state as JSON + file blobs
      const state = {
        dirs: Array.from(this.dirs),
        symlinks: Object.fromEntries(this.symlinks),
        whiteouts: Array.from(this.whiteouts),
        metadata: Object.fromEntries(this.metadata),
        children: {},
        fileList: [], // paths only — file contents stored separately
      };
      for (const [p, ch] of this.children) state.children[p] = Array.from(ch);
      for (const [p] of this.files) state.fileList.push(p);

      // Write state JSON
      const stateFile = await overlayDir.getFileHandle('state.json', { create: true });
      const stateWriter = await stateFile.createWritable();
      await stateWriter.write(JSON.stringify(state));
      await stateWriter.close();

      // Write each file as a separate blob
      const filesDir = await overlayDir.getDirectoryHandle('files', { create: true });
      for (const [path, content] of this.files) {
        const safeName = path.replace(/\//g, '__SLASH__'); // encode path as filename
        const fh = await filesDir.getFileHandle(safeName, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
      }
    } catch (err) {
      console.warn('OPFS flush failed:', err.message);
    }
  }

  /** Load VFS overlay from OPFS. Returns true if overlay was found. */
  async loadFromOPFS() {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('atua-computer');
      const overlayDir = await dir.getDirectoryHandle('overlay');

      // Read state JSON
      const stateFile = await overlayDir.getFileHandle('state.json');
      const stateBlob = await stateFile.getFile();
      const state = JSON.parse(await stateBlob.text());

      // Restore collections
      for (const d of state.dirs) this.dirs.add(d);
      for (const w of state.whiteouts) this.whiteouts.add(w);
      for (const [p, t] of Object.entries(state.symlinks)) this.symlinks.set(p, t);
      for (const [p, m] of Object.entries(state.metadata)) this.metadata.set(p, m);
      for (const [p, ch] of Object.entries(state.children)) this.children.set(p, new Set(ch));

      // Read file contents
      const filesDir = await overlayDir.getDirectoryHandle('files');
      for await (const [safeName, handle] of filesDir.entries()) {
        if (handle.kind !== 'file') continue;
        const path = safeName.replace(/__SLASH__/g, '/');
        const blob = await handle.getFile();
        const buf = new Uint8Array(await blob.arrayBuffer());
        this.files.set(path, buf);
      }

      return true;
    } catch {
      return false; // No overlay found — fresh boot
    }
  }

  /** Schedule a debounced flush to OPFS */
  markDirty() {
    if (typeof navigator === 'undefined' || !navigator.storage) return;
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this.flushToOPFS(), 500);
  }

  /** Explicit checkpoint — flush immediately */
  async checkpoint() {
    clearTimeout(this._flushTimer);
    await this.flushToOPFS();
  }
}
