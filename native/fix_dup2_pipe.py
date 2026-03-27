#!/usr/bin/env python3
"""Fix dup2+pipe bug: replace fildes>=200 hack with atua_type routing."""

import sys

BLINK = "/home/ubuntu/blink/blink"

def patch(path, old, new, label):
    with open(path, "r") as f:
        content = f.read()
    if old not in content:
        print(f"ERROR: {label} not found in {path}", file=sys.stderr)
        sys.exit(1)
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print(f"  patched: {label}")

# --- 1. fds.c: ForkFd copies atua_type/atua_host_handle/atua_pipe ---
patch(f"{BLINK}/fds.c",
    old="""      fd2->norestart = fd->norestart;
      memcpy(&fd2->saddr, &fd->saddr, sizeof(fd->saddr));""",
    new="""      fd2->norestart = fd->norestart;
      memcpy(&fd2->saddr, &fd->saddr, sizeof(fd->saddr));
#ifdef __ATUA_BROWSER__
      fd2->atua_type = fd->atua_type;
      fd2->atua_host_handle = fd->atua_host_handle;
      fd2->atua_pipe = fd->atua_pipe;
#endif""",
    label="ForkFd: copy atua fields")

# --- 2. fds.c: AddStdFd sets atua_type for 0/1/2 ---
patch(f"{BLINK}/fds.c",
    old="""    int oflags = (fildes == 0) ? O_RDONLY : O_WRONLY;
    InheritFd(AddFd(fds, fildes, oflags));
    return;""",
    new="""    int oflags = (fildes == 0) ? O_RDONLY : O_WRONLY;
    struct Fd *fd = AddFd(fds, fildes, oflags);
    if (fd) {
      if (fildes == 0) fd->atua_type = ATUA_FD_STDIN;
      else if (fildes == 1) fd->atua_type = ATUA_FD_STDOUT;
      else fd->atua_type = ATUA_FD_STDERR;
    }
    InheritFd(fd);
    return;""",
    label="AddStdFd: set atua_type for 0/1/2")

# --- 3. pipe.c: SysPipe2 sets atua_type=ATUA_FD_PIPE ---
patch(f"{BLINK}/pipe.c",
    old="""  LOCK(&m->system->fds.lock);
  unassert(AddFd(&m->system->fds, read_fd, O_RDONLY | oflags));
  unassert(AddFd(&m->system->fds, write_fd, O_WRONLY | oflags));
  UNLOCK(&m->system->fds.lock);""",
    new="""  LOCK(&m->system->fds.lock);
  {
    struct Fd *rfd = AddFd(&m->system->fds, read_fd, O_RDONLY | oflags);
    struct Fd *wfd = AddFd(&m->system->fds, write_fd, O_WRONLY | oflags);
    unassert(rfd);
    unassert(wfd);
    rfd->atua_type = ATUA_FD_PIPE;
    rfd->atua_host_handle = read_fd;
    wfd->atua_type = ATUA_FD_PIPE;
    wfd->atua_host_handle = write_fd;
  }
  UNLOCK(&m->system->fds.lock);""",
    label="SysPipe2: set atua_type=ATUA_FD_PIPE")

# --- 4. syscall.c: SysWrite uses atua_type instead of fildes>=200 ---
patch(f"{BLINK}/syscall.c",
    old="""static i64 SysWrite(struct Machine *m, i32 fildes, i64 addr, u64 size) {
#ifdef __ATUA_BROWSER__
  {
    int pipe_fildes = fildes;
    /* Check if this fd was dup2'd from a pipe fd */
    if (fildes < 200) {
      struct Fd *fd;
      LOCK(&m->system->fds.lock);
      fd = GetFd(&m->system->fds, fildes);
      if (fd && fd->fildes >= 200) pipe_fildes = fd->fildes;
      UNLOCK(&m->system->fds.lock);
    }
    if (pipe_fildes >= 200) {
      int pipe_id = (pipe_fildes - 200) / 2;
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepR(m, addr, size))) return -1;
      int n = atua_pipe_write(pipe_id, buf, (int)size);
      return n >= 0 ? n : -1;
    }
  }
#endif""",
    new="""static i64 SysWrite(struct Machine *m, i32 fildes, i64 addr, u64 size) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fd;
    int fd_type = -1, fd_handle = -1;
    LOCK(&m->system->fds.lock);
    fd = GetFd(&m->system->fds, fildes);
    if (fd) { fd_type = fd->atua_type; fd_handle = fd->atua_host_handle; }
    UNLOCK(&m->system->fds.lock);
    if (fd_type == ATUA_FD_PIPE) {
      int pipe_id = (fd_handle - 200) / 2;
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepR(m, addr, size))) return -1;
      int n = atua_pipe_write(pipe_id, buf, (int)size);
      return n >= 0 ? n : -1;
    }
  }
#endif""",
    label="SysWrite: route by atua_type")

# --- 5. syscall.c: SysRead uses atua_type instead of fildes>=200 ---
patch(f"{BLINK}/syscall.c",
    old="""static i64 SysRead(struct Machine *m, i32 fildes, i64 addr, u64 size) {
#ifdef __ATUA_BROWSER__
  if (fildes == 0) {
    // Guest stdin read via SYS_read
    u8 tmp[4096];
    int read_len = size < sizeof(tmp) ? (int)size : (int)sizeof(tmp);
    int n = atua_term_read(tmp, read_len);
    if (n > 0) {
      if (CopyToUserWrite(m, addr, tmp, n) == -1) return -1;
    }
    return n >= 0 ? n : -1;
  }
  if (fildes >= 200) {
    // Pipe fd: route to atua_pipe_read
    int pipe_id = (fildes - 200) / 2;
    u8 *buf;
    if (size > NUMERIC_MAX(size_t)) return eoverflow();
    if (!(buf = (u8 *)SchlepW(m, addr, size))) return -1;
    int n = atua_pipe_read(pipe_id, buf, (int)size);
    return n >= 0 ? n : -1;
  }
#endif""",
    new="""static i64 SysRead(struct Machine *m, i32 fildes, i64 addr, u64 size) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fd;
    int fd_type = -1, fd_handle = -1;
    LOCK(&m->system->fds.lock);
    fd = GetFd(&m->system->fds, fildes);
    if (fd) { fd_type = fd->atua_type; fd_handle = fd->atua_host_handle; }
    UNLOCK(&m->system->fds.lock);
    if (fd_type == ATUA_FD_STDIN) {
      u8 tmp[4096];
      int read_len = size < sizeof(tmp) ? (int)size : (int)sizeof(tmp);
      int n = atua_term_read(tmp, read_len);
      if (n > 0) {
        if (CopyToUserWrite(m, addr, tmp, n) == -1) return -1;
      }
      return n >= 0 ? n : -1;
    }
    if (fd_type == ATUA_FD_PIPE) {
      int pipe_id = (fd_handle - 200) / 2;
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepW(m, addr, size))) return -1;
      int n = atua_pipe_read(pipe_id, buf, (int)size);
      return n >= 0 ? n : -1;
    }
  }
#endif""",
    label="SysRead: route by atua_type")

# --- 6. close.c: SysClose uses atua_type ---
patch(f"{BLINK}/close.c",
    old="""int SysClose(struct Machine *m, i32 fildes) {
#ifdef __ATUA_BROWSER__
  if (fildes >= 200) {
    // Pipe fd: notify JS to close the pipe end
    extern __attribute__((import_module("atua"), import_name("pipe_close")))
      void atua_pipe_close(int pipe_id, int end);
    int pipe_id = (fildes - 200) / 2;
    int end = (fildes - 200) % 2;  // 0=read, 1=write
    atua_pipe_close(pipe_id, end);
  }
#endif
  struct Fd *fd;
  LOCK(&m->system->fds.lock);
  if ((fd = GetFd(&m->system->fds, fildes))) {
    dll_remove(&m->system->fds.list, &fd->elem);
  }
  UNLOCK(&m->system->fds.lock);
  if (!fd) return -1;
  return FinishClose(m, CloseFd(fd));
}""",
    new="""int SysClose(struct Machine *m, i32 fildes) {
  struct Fd *fd;
#ifdef __ATUA_BROWSER__
  int pipe_host_handle = -1;
#endif
  LOCK(&m->system->fds.lock);
  if ((fd = GetFd(&m->system->fds, fildes))) {
#ifdef __ATUA_BROWSER__
    if (fd->atua_type == ATUA_FD_PIPE)
      pipe_host_handle = fd->atua_host_handle;
#endif
    dll_remove(&m->system->fds.list, &fd->elem);
  }
  UNLOCK(&m->system->fds.lock);
  if (!fd) return -1;
#ifdef __ATUA_BROWSER__
  if (pipe_host_handle >= 0) {
    extern __attribute__((import_module("atua"), import_name("pipe_close")))
      void atua_pipe_close(int pipe_id, int end);
    int pipe_id = (pipe_host_handle - 200) / 2;
    int end = (pipe_host_handle - 200) % 2;
    atua_pipe_close(pipe_id, end);
  }
#endif
  return FinishClose(m, CloseFd(fd));
}""",
    label="SysClose: route by atua_type")

print("\nAll 6 patches applied successfully!")
