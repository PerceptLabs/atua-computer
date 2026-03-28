#ifndef BLINK_FDS_H_
#define BLINK_FDS_H_
#include <dirent.h>
#include <limits.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdbool.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <termios.h>

#include "blink/dll.h"
#include "blink/thread.h"
#include "blink/types.h"

#define FD_CONTAINER(e) DLL_CONTAINER(struct Fd, elem, e)

struct winsize;

struct FdCb {
  int (*close)(int);
  ssize_t (*readv)(int, const struct iovec *, int);
  ssize_t (*writev)(int, const struct iovec *, int);
  int (*poll)(struct pollfd *, nfds_t, int);
  int (*tcgetattr)(int, struct termios *);
  int (*tcsetattr)(int, int, const struct termios *);
  int (*tcgetwinsize)(int, struct winsize *);
  int (*tcsetwinsize)(int, const struct winsize *);
};

#ifdef __ATUA_BROWSER__
/* In the browser target, each fd is routed to a different JS import
   based on its type. The host WASI fd is unused — all I/O goes through
   atua_term_*, atua_fs_*, atua_pipe_*, or atua_socket_* imports. */
enum {
  ATUA_FD_HOST   = 0,  // unused in browser (WASI fallback)
  ATUA_FD_PIPE   = 1,  // ring buffer pipe between fork'd processes
  ATUA_FD_FILE   = 2,  // VFS file handle (JS filesystem)
  ATUA_FD_STDIN  = 3,  // terminal input (SharedArrayBuffer)
  ATUA_FD_STDOUT = 4,  // terminal output (postMessage)
  ATUA_FD_STDERR = 5,  // terminal output (postMessage)
  ATUA_FD_SOCKET = 6,  // TCP socket via Wisp relay
};
#endif

struct Fd {
  int fildes;      // file descriptor
  int oflags;      // host O_XXX constants
#ifdef __ATUA_BROWSER__
  int atua_type;          // routing type (ATUA_FD_*)
  int atua_host_handle;   // JS-side handle (fs handle, pipe id, sock id)
#endif
  int socktype;    // host SOCK_XXX constants
  bool norestart;  // is SO_RCVTIMEO in play?
  DIR *dirstream;  // for getdents() lazilly
  struct Dll elem;
  pthread_mutex_t_ lock;
  const struct FdCb *cb;
  char *path;
  union {
    struct sockaddr sa;
    struct sockaddr_in sin;
    struct sockaddr_in6 sin6;
  } saddr;
};

struct Fds {
  struct Dll *list;
  pthread_mutex_t_ lock;
};

extern const struct FdCb kFdCbHost;

void InitFds(struct Fds *);
struct Fd *AddFd(struct Fds *, int, int);
struct Fd *ForkFd(struct Fds *, struct Fd *, int, int);
struct Fd *GetFd(struct Fds *, int);
void LockFd(struct Fd *);
void UnlockFd(struct Fd *);
int CountFds(struct Fds *);
void FreeFd(struct Fd *);
void DestroyFds(struct Fds *);
void InheritFd(struct Fd *);

#endif /* BLINK_FDS_H_ */
