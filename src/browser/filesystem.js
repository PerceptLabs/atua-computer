/**
 * In-memory virtual filesystem loaded from a tar file.
 * Provides open/read/write/stat/readdir/close for the atua WASM imports.
 */

export class VirtualFS {
  constructor() {
    this.files = new Map();    // path → Uint8Array
    this.dirs = new Set();     // directory paths
    this.nextFd = 4;           // 0-2 reserved, 3 = preopened root
    this.openFiles = new Map(); // fd → { content, position, path }
  }

  /**
   * Load files from a tar archive.
   * Supports basic POSIX tar (ustar) format.
   */
  async loadTar(tarData) {
    const data = tarData instanceof Uint8Array ? tarData : new Uint8Array(tarData);
    let offset = 0;

    while (offset + 512 <= data.length) {
      // Read header
      const header = data.subarray(offset, offset + 512);
      offset += 512;

      // Check for end-of-archive (two zero blocks)
      if (header.every(b => b === 0)) break;

      // Parse name (bytes 0-99, null-terminated)
      let name = '';
      for (let i = 0; i < 100 && header[i]; i++) name += String.fromCharCode(header[i]);

      // Parse prefix (bytes 345-499 for ustar)
      let prefix = '';
      if (header[257] === 0x75 && header[258] === 0x73 && header[259] === 0x74) { // "ust"
        for (let i = 345; i < 500 && header[i]; i++) prefix += String.fromCharCode(header[i]);
      }
      if (prefix) name = prefix + '/' + name;

      // Normalize path
      if (name.startsWith('./')) name = name.substring(2);
      if (!name.startsWith('/')) name = '/' + name;
      name = name.replace(/\/+$/, ''); // strip trailing slash
      if (!name || name === '/') { offset = (offset + 511) & ~511; continue; }

      // Parse size (bytes 124-135, octal)
      let sizeStr = '';
      for (let i = 124; i < 136 && header[i] >= 0x30; i++) sizeStr += String.fromCharCode(header[i]);
      const size = parseInt(sizeStr.trim(), 8) || 0;

      // Parse type (byte 156)
      const typeflag = header[156];

      if (typeflag === 0x35 || typeflag === 53 || name.endsWith('/')) {
        // Directory
        this.dirs.add(name);
      } else if (typeflag === 0 || typeflag === 0x30 || typeflag === 48) {
        // Regular file
        if (size > 0 && offset + size <= data.length) {
          this.files.set(name, data.slice(offset, offset + size));
          // Also register parent directories
          const parts = name.split('/');
          for (let i = 1; i < parts.length; i++) {
            this.dirs.add(parts.slice(0, i).join('/') || '/');
          }
        }
      }

      // Advance past file data (padded to 512 bytes)
      offset += Math.ceil(size / 512) * 512;
    }
  }

  /** Add a single file to the VFS */
  addFile(path, content) {
    if (!path.startsWith('/')) path = '/' + path;
    this.files.set(path, content instanceof Uint8Array ? content : new Uint8Array(content));
  }

  /** Check if a path exists */
  exists(path) {
    return this.files.has(path) || this.dirs.has(path);
  }

  /** Open a file, returns fd or -1 */
  open(path, flags, mode) {
    // Normalize
    if (!path.startsWith('/')) path = '/' + path;

    const content = this.files.get(path);
    if (!content) return -1;

    const fd = this.nextFd++;
    this.openFiles.set(fd, { content, position: 0, path });
    return fd;
  }

  /** Read from an open fd at a given offset */
  read(fd, dest, offset) {
    const file = this.openFiles.get(fd);
    if (!file) return -1;

    const off = typeof offset === 'bigint' ? Number(offset) : (offset || 0);
    const available = file.content.length - off;
    if (available <= 0) return 0;

    const toRead = Math.min(dest.length, available);
    dest.set(file.content.subarray(off, off + toRead));
    return toRead;
  }

  /** Write to an open fd (not implemented for read-only rootfs) */
  write(fd, src, offset) {
    return src.length;
  }

  /** Stat a path — returns size or -1 */
  stat(path) {
    if (!path.startsWith('/')) path = '/' + path;
    const content = this.files.get(path);
    if (content) return { size: content.length, type: 'file' };
    if (this.dirs.has(path)) return { size: 0, type: 'dir' };
    return null;
  }

  /** Close an fd */
  close(fd) {
    this.openFiles.delete(fd);
  }

  /** Readdir — returns entries in a directory */
  readdir(fd, buf, len) {
    return 0; // TODO: implement for bash's tab completion
  }
}
