/**
 * test_http_get.c — Minimal HTTP GET via raw sockets.
 * Connects to a specified IP:port, sends an HTTP GET request, prints response.
 *
 * Usage: ./test_http_get <ip> <port> <path> <host>
 * E.g.:  ./test_http_get 93.184.216.34 80 / example.com
 *
 * If no args, uses hardcoded defaults for testing.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    setvbuf(stdout, NULL, _IONBF, 0); /* unbuffered stdout */
    setvbuf(stderr, NULL, _IONBF, 0);

    const char *ip   = argc > 1 ? argv[1] : "93.184.216.34";
    int port         = argc > 2 ? atoi(argv[2]) : 80;
    const char *path = argc > 3 ? argv[3] : "/";
    const char *host = argc > 4 ? argv[4] : "example.com";

    printf("HTTP GET http://%s:%d%s (Host: %s)\n", ip, port, path, host);

    /* Create socket */
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        printf("FAIL: socket() errno=%d %s\n", errno, strerror(errno));
        return 1;
    }
    printf("PASS: socket() fd=%d\n", fd);

    /* Connect */
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    inet_pton(AF_INET, ip, &addr.sin_addr);

    int rc = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
    if (rc < 0) {
        printf("FAIL: connect() errno=%d %s\n", errno, strerror(errno));
        close(fd);
        return 1;
    }
    printf("PASS: connect()\n");

    /* Send HTTP GET */
    char req[512];
    int reqlen = snprintf(req, sizeof(req),
        "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n",
        path, host);

    ssize_t sent = write(fd, req, reqlen);
    if (sent < 0) {
        printf("FAIL: write() errno=%d %s\n", errno, strerror(errno));
        close(fd);
        return 1;
    }
    printf("PASS: write(%d bytes)\n", (int)sent);

    /* Read response */
    char buf[4096];
    int total = 0;
    ssize_t n;
    while ((n = read(fd, buf + total, sizeof(buf) - total - 1)) > 0) {
        total += n;
        if (total >= (int)sizeof(buf) - 1) break;
    }
    buf[total] = '\0';

    if (total > 0) {
        printf("PASS: read(%d bytes)\n", total);
        /* Print first line of response */
        char *nl = strchr(buf, '\n');
        if (nl) *nl = '\0';
        printf("Response: %s\n", buf);
    } else {
        printf("FAIL: read() returned %d, errno=%d\n", (int)n, errno);
    }

    close(fd);
    return (total > 0 && strstr(buf, "HTTP/") != NULL) ? 0 : 1;
}
