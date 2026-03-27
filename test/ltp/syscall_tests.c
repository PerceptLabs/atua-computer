/*
 * Minimal syscall test suite for atua-computer.
 * Statically linked x86-64 binary. Tests the syscalls that cross
 * the Blink→WASM shim boundary.
 *
 * Exit code = number of failed tests. 0 = all pass.
 * Each test prints PASS/FAIL to stdout.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <errno.h>

static int failures = 0;

#define TEST(name, expr) do { \
    if (expr) { printf("PASS: %s\n", name); } \
    else { printf("FAIL: %s (errno=%d %s)\n", name, errno, strerror(errno)); failures++; } \
} while(0)

/* --- open/close/read/write --- */
static void test_open_close(void) {
    int fd = open("/etc/hostname", O_RDONLY);
    /* File may not exist in minimal rootfs — test that open returns valid fd or ENOENT */
    if (fd >= 0) {
        TEST("open(/etc/hostname)", fd >= 0);
        TEST("close(fd)", close(fd) == 0);
    } else {
        TEST("open(/etc/hostname) returns ENOENT", errno == ENOENT);
    }

    /* open a file we know exists */
    fd = open("/bin/bash", O_RDONLY);
    TEST("open(/bin/bash)", fd >= 0);
    if (fd >= 0) {
        char buf[16];
        ssize_t n = read(fd, buf, 4);
        TEST("read(4 bytes from ELF)", n == 4);
        TEST("ELF magic", buf[0] == 0x7f && buf[1] == 'E' && buf[2] == 'L' && buf[3] == 'F');
        close(fd);
    }
}

static void test_read_write(void) {
    /* write to stdout */
    const char msg[] = "WRITE_TEST_OK\n";
    ssize_t n = write(1, msg, sizeof(msg) - 1);
    TEST("write(stdout)", n == (ssize_t)(sizeof(msg) - 1));

    /* write to stderr */
    n = write(2, "STDERR_OK\n", 10);
    TEST("write(stderr)", n == 10);
}

/* --- stat/fstat --- */
static void test_stat(void) {
    struct stat st;
    int rc = stat("/bin/bash", &st);
    TEST("stat(/bin/bash)", rc == 0);
    if (rc == 0) {
        TEST("stat: size > 0", st.st_size > 0);
        TEST("stat: is regular file", S_ISREG(st.st_mode));
    }

    int fd = open("/bin/bash", O_RDONLY);
    if (fd >= 0) {
        rc = fstat(fd, &st);
        TEST("fstat(bash fd)", rc == 0);
        TEST("fstat: size > 0", st.st_size > 0);
        close(fd);
    }
}

/* --- getcwd/chdir --- */
static void test_getcwd_chdir(void) {
    char buf[4096];
    char *cwd = getcwd(buf, sizeof(buf));
    TEST("getcwd", cwd != NULL);
    if (cwd) {
        TEST("getcwd starts with /", buf[0] == '/');
    }

    int rc = chdir("/");
    TEST("chdir(/)", rc == 0);

    cwd = getcwd(buf, sizeof(buf));
    TEST("getcwd after chdir(/)", cwd != NULL && strcmp(buf, "/") == 0);

    /* chdir to /tmp (may not exist) */
    rc = chdir("/tmp");
    if (rc == 0) {
        cwd = getcwd(buf, sizeof(buf));
        TEST("getcwd after chdir(/tmp)", cwd != NULL && strcmp(buf, "/tmp") == 0);
    }

    /* restore */
    chdir("/");
}

/* --- pipe --- */
static void test_pipe(void) {
    int pipefd[2];
    int rc = pipe(pipefd);
    TEST("pipe()", rc == 0);
    if (rc == 0) {
        const char data[] = "pipe-test-data";
        ssize_t nw = write(pipefd[1], data, sizeof(data) - 1);
        TEST("pipe write", nw == (ssize_t)(sizeof(data) - 1));

        char buf[64];
        ssize_t nr = read(pipefd[0], buf, sizeof(buf));
        TEST("pipe read", nr == (ssize_t)(sizeof(data) - 1));
        TEST("pipe data correct", nr > 0 && memcmp(buf, data, nr) == 0);

        close(pipefd[0]);
        close(pipefd[1]);
    }
}

/* --- dup2 --- */
static void test_dup2(void) {
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        TEST("dup2: pipe setup", 0);
        return;
    }

    int oldfd = dup(1); /* save stdout */
    int rc = dup2(pipefd[1], 1); /* redirect stdout to pipe */
    TEST("dup2(pipe, stdout)", rc == 1);

    if (rc == 1) {
        write(1, "DUP2OK", 6);
        dup2(oldfd, 1); /* restore stdout */
        close(oldfd);
        close(pipefd[1]);

        char buf[64];
        ssize_t nr = read(pipefd[0], buf, sizeof(buf));
        TEST("dup2: read redirected output", nr == 6 && memcmp(buf, "DUP2OK", 6) == 0);
    } else {
        dup2(oldfd, 1);
        close(oldfd);
        close(pipefd[1]);
    }
    close(pipefd[0]);
}

/* --- fork/waitpid --- */
static void test_fork_waitpid(void) {
    pid_t pid = fork();
    TEST("fork()", pid >= 0);

    if (pid == 0) {
        /* child */
        write(1, "CHILD_OK\n", 9);
        _exit(42);
    } else if (pid > 0) {
        /* parent */
        int status;
        pid_t w = waitpid(pid, &status, 0);
        TEST("waitpid()", w == pid);
        TEST("child exited normally", WIFEXITED(status));
        TEST("child exit code 42", WEXITSTATUS(status) == 42);
    }
}

/* --- mmap --- */
static void test_mmap(void) {
    /* anonymous mmap */
    void *p = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    TEST("mmap(anonymous)", p != MAP_FAILED);
    if (p != MAP_FAILED) {
        /* write and read back */
        memset(p, 0xAB, 4096);
        TEST("mmap: write/read", ((unsigned char *)p)[0] == 0xAB);
        int rc = munmap(p, 4096);
        TEST("munmap", rc == 0);
    }

    /* file mmap */
    int fd = open("/bin/bash", O_RDONLY);
    if (fd >= 0) {
        struct stat st;
        fstat(fd, &st);
        size_t len = st.st_size < 4096 ? st.st_size : 4096;
        void *m = mmap(NULL, len, PROT_READ, MAP_PRIVATE, fd, 0);
        TEST("mmap(file)", m != MAP_FAILED);
        if (m != MAP_FAILED) {
            TEST("mmap file: ELF magic", ((unsigned char *)m)[0] == 0x7f);
            munmap(m, len);
        }
        close(fd);
    }
}

int main(void) {
    /* Disable stdio buffering — engine exits via trap, no flush */
    setbuf(stdout, NULL);
    setbuf(stderr, NULL);
    printf("=== atua-computer syscall tests ===\n");

    test_open_close();
    test_read_write();
    test_stat();
    test_getcwd_chdir();
    test_pipe();
    test_dup2();
    test_fork_waitpid();
    test_mmap();

    printf("=== Results: %d failures ===\n", failures);
    return failures;
}
