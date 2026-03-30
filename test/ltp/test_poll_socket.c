/**
 * test_poll_socket.c — Verifies poll() works on socket fds.
 * Connects via TCP, uses poll() to wait for data, then reads.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <poll.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    const char *ip   = argc > 1 ? argv[1] : "127.0.0.1";
    int port         = argc > 2 ? atoi(argv[2]) : 80;

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { printf("FAIL: socket() errno=%d\n", errno); return 1; }
    printf("PASS: socket() fd=%d\n", fd);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    inet_pton(AF_INET, ip, &addr.sin_addr);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        printf("FAIL: connect() errno=%d\n", errno); close(fd); return 1;
    }
    printf("PASS: connect()\n");

    /* Send HTTP GET */
    const char *req = "GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    write(fd, req, strlen(req));
    printf("PASS: write()\n");

    /* poll() for readability before reading */
    struct pollfd pfd;
    pfd.fd = fd;
    pfd.events = POLLIN;
    pfd.revents = 0;

    int pr = poll(&pfd, 1, 10000); /* 10s timeout */
    if (pr < 0) {
        printf("FAIL: poll() errno=%d %s\n", errno, strerror(errno));
        close(fd);
        return 1;
    }
    if (pr == 0) {
        printf("FAIL: poll() timeout\n");
        close(fd);
        return 1;
    }
    printf("PASS: poll() returned %d revents=0x%x\n", pr, pfd.revents);

    if (pfd.revents & POLLIN) {
        char buf[4096];
        ssize_t n = read(fd, buf, sizeof(buf) - 1);
        if (n > 0) {
            buf[n] = '\0';
            printf("PASS: read(%d bytes)\n", (int)n);
        } else {
            printf("FAIL: read() returned %d errno=%d\n", (int)n, errno);
        }
    }

    close(fd);
    return 0;
}
