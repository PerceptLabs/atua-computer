#!/usr/bin/env python3
"""Phase F: Add ATUA_FD_SOCKET and __ATUA_BROWSER__ blocks for socket syscalls."""

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

# --- 1. fds.h: Add ATUA_FD_SOCKET = 6 ---
patch(f"{BLINK}/fds.h",
    old="    ATUA_FD_STDERR = 5,  // terminal output\n};",
    new="    ATUA_FD_STDERR = 5,  // terminal output\n    ATUA_FD_SOCKET = 6,  // network socket (Wisp relay)\n};",
    label="fds.h: add ATUA_FD_SOCKET")

# --- 2. syscall.c: Declare socket atua imports ---
# Add after the existing pipe imports
patch(f"{BLINK}/syscall.c",
    old="extern void atua_pipe_close(int pipe_id, int end);",
    new="""extern void atua_pipe_close(int pipe_id, int end);

/* Socket imports — Phase F networking */
__attribute__((import_module("atua"), import_name("socket_open")))
extern int atua_socket_open(int domain, int type, int protocol);

__attribute__((import_module("atua"), import_name("socket_connect")))
extern int atua_socket_connect(int sock_id, const void *addr, int addrlen);

__attribute__((import_module("atua"), import_name("socket_send")))
extern int atua_socket_send(int sock_id, const void *buf, int len);

__attribute__((import_module("atua"), import_name("socket_recv")))
extern int atua_socket_recv(int sock_id, void *buf, int len);

__attribute__((import_module("atua"), import_name("socket_close")))
extern void atua_socket_close(int sock_id);""",
    label="syscall.c: declare socket imports")

# --- 3. SysSocket: Add __ATUA_BROWSER__ block ---
patch(f"{BLINK}/syscall.c",
    old="""static int SysSocket(struct Machine *m, i32 family, i32 type, i32 protocol) {
  struct Fd *fd;
  int lim, flags, fildes;
  flags = type & (SOCK_NONBLOCK_LINUX | SOCK_CLOEXEC_LINUX);
  type &= ~(SOCK_NONBLOCK_LINUX | SOCK_CLOEXEC_LINUX);""",
    new="""static int SysSocket(struct Machine *m, i32 family, i32 type, i32 protocol) {
#ifdef __ATUA_BROWSER__
  {
    int raw_type = type & ~(SOCK_NONBLOCK_LINUX | SOCK_CLOEXEC_LINUX);
    int oflags = O_RDWR;
    if (type & SOCK_CLOEXEC_LINUX) oflags |= O_CLOEXEC;
    if (type & SOCK_NONBLOCK_LINUX) oflags |= O_NDELAY;
    int sock_id = atua_socket_open(family, raw_type, protocol);
    if (sock_id < 0) return -1;
    struct Fd *fd;
    LOCK(&m->system->fds.lock);
    fd = AddFd(&m->system->fds, sock_id, oflags);
    if (fd) {
      fd->atua_type = ATUA_FD_SOCKET;
      fd->atua_host_handle = sock_id;
      fd->socktype = (raw_type == SOCK_STREAM_LINUX) ? SOCK_STREAM
                   : (raw_type == SOCK_DGRAM_LINUX) ? SOCK_DGRAM
                   : raw_type;
    }
    UNLOCK(&m->system->fds.lock);
    return sock_id;
  }
#endif
  struct Fd *fd;
  int lim, flags, fildes;
  flags = type & (SOCK_NONBLOCK_LINUX | SOCK_CLOEXEC_LINUX);
  type &= ~(SOCK_NONBLOCK_LINUX | SOCK_CLOEXEC_LINUX);""",
    label="SysSocket: __ATUA_BROWSER__ block")

# --- 4. SysConnect: Add __ATUA_BROWSER__ block ---
patch(f"{BLINK}/syscall.c",
    old="""static int SysConnect(struct Machine *m, int fd, i64 aa, u32 as) {
  return SysConnectBind(m, fd, aa, as, VfsConnect);
}""",
    new="""static int SysConnect(struct Machine *m, int fd, i64 aa, u32 as) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fde;
    int fd_type = -1, fd_handle = -1;
    LOCK(&m->system->fds.lock);
    fde = GetFd(&m->system->fds, fd);
    if (fde) { fd_type = fde->atua_type; fd_handle = fde->atua_host_handle; }
    UNLOCK(&m->system->fds.lock);
    if (fd_type == ATUA_FD_SOCKET) {
      u8 addr_buf[128];
      if (as > sizeof(addr_buf)) return einval();
      if (CopyFromUserRead(m, addr_buf, aa, as) == -1) return -1;
      return atua_socket_connect(fd_handle, addr_buf, as);
    }
  }
#endif
  return SysConnectBind(m, fd, aa, as, VfsConnect);
}""",
    label="SysConnect: __ATUA_BROWSER__ block")

# --- 5. SysRead: Add ATUA_FD_SOCKET case ---
# Add after the ATUA_FD_PIPE case in the browser block
patch(f"{BLINK}/syscall.c",
    old="""    if (fd_type == ATUA_FD_PIPE) {
      int pipe_id = (fd_handle - 200) / 2;
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepW(m, addr, size))) return -1;
      int n = atua_pipe_read(pipe_id, buf, (int)size);
      return n >= 0 ? n : -1;
    }
  }
#endif
  i64 rc;
  int oflags;
  struct Fd *fd;
  struct Iovs iv;
  ssize_t (*readv_impl)(int, const struct iovec *, int);
  if (size > NUMERIC_MAX(size_t)) return eoverflow();
  LOCK(&m->system->fds.lock);
  if ((fd = GetFd(&m->system->fds, fildes))) {""",
    new="""    if (fd_type == ATUA_FD_PIPE) {
      int pipe_id = (fd_handle - 200) / 2;
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepW(m, addr, size))) return -1;
      int n = atua_pipe_read(pipe_id, buf, (int)size);
      return n >= 0 ? n : -1;
    }
    if (fd_type == ATUA_FD_SOCKET) {
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepW(m, addr, size))) return -1;
      int n = atua_socket_recv(fd_handle, buf, (int)size);
      return n >= 0 ? n : -1;
    }
  }
#endif
  i64 rc;
  int oflags;
  struct Fd *fd;
  struct Iovs iv;
  ssize_t (*readv_impl)(int, const struct iovec *, int);
  if (size > NUMERIC_MAX(size_t)) return eoverflow();
  LOCK(&m->system->fds.lock);
  if ((fd = GetFd(&m->system->fds, fildes))) {""",
    label="SysRead: add ATUA_FD_SOCKET case")

# --- 6. SysWrite: Add ATUA_FD_SOCKET case ---
patch(f"{BLINK}/syscall.c",
    old="""    if (fd_type == ATUA_FD_PIPE) {
      int pipe_id = (fd_handle - 200) / 2;
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepR(m, addr, size))) return -1;
      int n = atua_pipe_write(pipe_id, buf, (int)size);
      return n >= 0 ? n : -1;
    }
  }
#endif
  i64 rc;
  int oflags;
  struct Fd *fd;
  struct Iovs iv;
  ssize_t (*writev_impl)(int, const struct iovec *, int);""",
    new="""    if (fd_type == ATUA_FD_PIPE) {
      int pipe_id = (fd_handle - 200) / 2;
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepR(m, addr, size))) return -1;
      int n = atua_pipe_write(pipe_id, buf, (int)size);
      return n >= 0 ? n : -1;
    }
    if (fd_type == ATUA_FD_SOCKET) {
      u8 *buf;
      if (size > NUMERIC_MAX(size_t)) return eoverflow();
      if (!(buf = (u8 *)SchlepR(m, addr, size))) return -1;
      int n = atua_socket_send(fd_handle, buf, (int)size);
      return n >= 0 ? n : -1;
    }
  }
#endif
  i64 rc;
  int oflags;
  struct Fd *fd;
  struct Iovs iv;
  ssize_t (*writev_impl)(int, const struct iovec *, int);""",
    label="SysWrite: add ATUA_FD_SOCKET case")

# --- 7. SysClose: Add ATUA_FD_SOCKET case ---
# close.c already has ATUA_FD_PIPE handling. Add socket case.
patch(f"{BLINK}/close.c",
    old="""    if (fd->atua_type == ATUA_FD_PIPE)
      pipe_host_handle = fd->atua_host_handle;""",
    new="""    if (fd->atua_type == ATUA_FD_PIPE)
      pipe_host_handle = fd->atua_host_handle;
    if (fd->atua_type == ATUA_FD_SOCKET)
      socket_host_handle = fd->atua_host_handle;""",
    label="SysClose: detect ATUA_FD_SOCKET")

patch(f"{BLINK}/close.c",
    old="""  int pipe_host_handle = -1;""",
    new="""  int pipe_host_handle = -1;
  int socket_host_handle = -1;""",
    label="SysClose: declare socket_host_handle")

# Add socket close call after pipe close
patch(f"{BLINK}/close.c",
    old="""    atua_pipe_close(pipe_id, end);
  }
#endif
  return FinishClose(m, CloseFd(fd));""",
    new="""    atua_pipe_close(pipe_id, end);
  }
  if (socket_host_handle >= 0) {
    extern __attribute__((import_module("atua"), import_name("socket_close")))
      void atua_socket_close(int sock_id);
    atua_socket_close(socket_host_handle);
  }
#endif
  return FinishClose(m, CloseFd(fd));""",
    label="SysClose: call atua_socket_close")

# --- 8. SysSendto: Add __ATUA_BROWSER__ block ---
patch(f"{BLINK}/syscall.c",
    old="""static i64 SysSendto(struct Machine *m,  //
                     i32 fildes,         //
                     i64 bufaddr,        //
                     u64 buflen,         //
                     i32 flags,          //
                     i64 sockaddr_addr,  //
                     i32 sockaddr_size) {
  ssize_t rc;
  int socktype;
  struct Fd *fd;""",
    new="""static i64 SysSendto(struct Machine *m,  //
                     i32 fildes,         //
                     i64 bufaddr,        //
                     u64 buflen,         //
                     i32 flags,          //
                     i64 sockaddr_addr,  //
                     i32 sockaddr_size) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fd;
    int fd_type = -1, fd_handle = -1;
    LOCK(&m->system->fds.lock);
    fd = GetFd(&m->system->fds, fildes);
    if (fd) { fd_type = fd->atua_type; fd_handle = fd->atua_host_handle; }
    UNLOCK(&m->system->fds.lock);
    if (fd_type == ATUA_FD_SOCKET) {
      u8 *buf;
      if (buflen > NUMERIC_MAX(size_t)) return eoverflow();
      if (buflen == 0) return 0;
      if (!(buf = (u8 *)SchlepR(m, bufaddr, buflen))) return -1;
      int n = atua_socket_send(fd_handle, buf, (int)buflen);
      return n >= 0 ? n : -1;
    }
  }
#endif
  ssize_t rc;
  int socktype;
  struct Fd *fd;""",
    label="SysSendto: __ATUA_BROWSER__ block")

# --- 9. SysRecvfrom: Add __ATUA_BROWSER__ block ---
patch(f"{BLINK}/syscall.c",
    old="""static i64 SysRecvfrom(struct Machine *m,  //
                       i32 fildes,         //
                       i64 bufaddr,        //
                       u64 buflen,         //
                       i32 flags,          //
                       i64 sockaddr_addr,  //
                       i64 sockaddr_size_addr) {
  ssize_t rc;
  int hostflags;""",
    new="""static i64 SysRecvfrom(struct Machine *m,  //
                       i32 fildes,         //
                       i64 bufaddr,        //
                       u64 buflen,         //
                       i32 flags,          //
                       i64 sockaddr_addr,  //
                       i64 sockaddr_size_addr) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fd;
    int fd_type = -1, fd_handle = -1;
    LOCK(&m->system->fds.lock);
    fd = GetFd(&m->system->fds, fildes);
    if (fd) { fd_type = fd->atua_type; fd_handle = fd->atua_host_handle; }
    UNLOCK(&m->system->fds.lock);
    if (fd_type == ATUA_FD_SOCKET) {
      u8 *buf;
      if (buflen > NUMERIC_MAX(size_t)) return eoverflow();
      if (buflen == 0) return 0;
      if (!(buf = (u8 *)SchlepW(m, bufaddr, buflen))) return -1;
      int n = atua_socket_recv(fd_handle, buf, (int)buflen);
      return n >= 0 ? n : -1;
    }
  }
#endif
  ssize_t rc;
  int hostflags;""",
    label="SysRecvfrom: __ATUA_BROWSER__ block")

# --- 10. SysGetsockopt: Add __ATUA_BROWSER__ block ---
patch(f"{BLINK}/syscall.c",
    old="""static int SysGetsockopt(struct Machine *m, i32 fildes, i32 level, i32 optname,
                         i64 optvaladdr, i64 optvalsizeaddr) {
  int rc;
  void *optval;""",
    new="""static int SysGetsockopt(struct Machine *m, i32 fildes, i32 level, i32 optname,
                         i64 optvaladdr, i64 optvalsizeaddr) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fd;
    int fd_type = -1;
    LOCK(&m->system->fds.lock);
    fd = GetFd(&m->system->fds, fildes);
    if (fd) fd_type = fd->atua_type;
    UNLOCK(&m->system->fds.lock);
    if (fd_type == ATUA_FD_SOCKET) {
      /* Return success with sensible defaults for common options */
      u8 optvalsize_buf[4];
      if (CopyFromUserRead(m, optvalsize_buf, optvalsizeaddr, 4) == -1) return -1;
      u32 optvalsize = Read32(optvalsize_buf);
      if (optvalsize >= 4) {
        u8 val[4] = {0, 0, 0, 0}; /* default: 0 */
        if (level == SOL_SOCKET_LINUX && optname == SO_TYPE_LINUX) {
          /* Return SOCK_STREAM */
          Write32(val, SOCK_STREAM_LINUX);
        }
        CopyToUserWrite(m, optvaladdr, val, 4);
        Write32(optvalsize_buf, 4);
        CopyToUserWrite(m, optvalsizeaddr, optvalsize_buf, 4);
      }
      return 0;
    }
  }
#endif
  int rc;
  void *optval;""",
    label="SysGetsockopt: __ATUA_BROWSER__ block")

# --- 11. SysSetsockopt: Add __ATUA_BROWSER__ block ---
patch(f"{BLINK}/syscall.c",
    old="""static int SysSetsockopt(struct Machine *m, i32 fildes, i32 level, i32 optname,
                         i64 optvaladdr, u32 optvalsize) {
  int rc;
  void *optval;
  struct Fd *fd;""",
    new="""static int SysSetsockopt(struct Machine *m, i32 fildes, i32 level, i32 optname,
                         i64 optvaladdr, u32 optvalsize) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fd;
    int fd_type = -1;
    LOCK(&m->system->fds.lock);
    fd = GetFd(&m->system->fds, fildes);
    if (fd) fd_type = fd->atua_type;
    UNLOCK(&m->system->fds.lock);
    if (fd_type == ATUA_FD_SOCKET) return 0; /* no-op success */
  }
#endif
  int rc;
  void *optval;
  struct Fd *fd;""",
    label="SysSetsockopt: __ATUA_BROWSER__ block")

# --- 12. SysGetpeername: Add __ATUA_BROWSER__ block ---
# SysGetpeername calls SysSocketName which calls VfsGetpeername.
# We intercept at SysGetpeername level.
patch(f"{BLINK}/syscall.c",
    old="""static int SysGetpeername(struct Machine *m, i32 fd, i64 aa, i64 as) {
  return SysSocketName(m, fd, aa, as, VfsGetpeername);
}""",
    new="""static int SysGetpeername(struct Machine *m, i32 fd, i64 aa, i64 as) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fde;
    int fd_type = -1;
    LOCK(&m->system->fds.lock);
    fde = GetFd(&m->system->fds, fd);
    if (fde && fde->atua_type == ATUA_FD_SOCKET) {
      /* Return stored peer address if available, else synthetic */
      u8 addr[16] = {0};
      addr[0] = 2; /* AF_INET */
      u8 size_buf[4];
      Write32(size_buf, 16);
      if (aa) CopyToUserWrite(m, aa, addr, 16);
      if (as) CopyToUserWrite(m, as, size_buf, 4);
      UNLOCK(&m->system->fds.lock);
      return 0;
    }
    UNLOCK(&m->system->fds.lock);
  }
#endif
  return SysSocketName(m, fd, aa, as, VfsGetpeername);
}""",
    label="SysGetpeername: __ATUA_BROWSER__ block")

# --- 13. SysGetsockname: Add __ATUA_BROWSER__ block ---
patch(f"{BLINK}/syscall.c",
    old="""static int SysGetsockname(struct Machine *m, i32 fd, i64 aa, i64 as) {
  return SysSocketName(m, fd, aa, as, VfsGetsockname);
}""",
    new="""static int SysGetsockname(struct Machine *m, i32 fd, i64 aa, i64 as) {
#ifdef __ATUA_BROWSER__
  {
    struct Fd *fde;
    int fd_type = -1;
    LOCK(&m->system->fds.lock);
    fde = GetFd(&m->system->fds, fd);
    if (fde && fde->atua_type == ATUA_FD_SOCKET) {
      /* Return synthetic local address 0.0.0.0:random_port */
      u8 addr[16] = {0};
      addr[0] = 2; /* AF_INET */
      addr[2] = 0xC0; addr[3] = 0x01; /* port 49153 */
      u8 size_buf[4];
      Write32(size_buf, 16);
      if (aa) CopyToUserWrite(m, aa, addr, 16);
      if (as) CopyToUserWrite(m, as, size_buf, 4);
      UNLOCK(&m->system->fds.lock);
      return 0;
    }
    UNLOCK(&m->system->fds.lock);
  }
#endif
  return SysSocketName(m, fd, aa, as, VfsGetsockname);
}""",
    label="SysGetsockname: __ATUA_BROWSER__ block")

print("\nAll 13 patches applied successfully!")
