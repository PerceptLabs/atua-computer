/**
 * test_dns_http.c — DNS resolution + HTTP GET via raw sockets.
 * Uses getaddrinfo() to resolve hostname, then connects and fetches.
 *
 * Usage: ./test_dns_http <hostname> [port] [path]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <errno.h>

int main(int argc, char *argv[]) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    const char *hostname = argc > 1 ? argv[1] : "example.com";
    const char *port_str = argc > 2 ? argv[2] : "80";
    const char *path     = argc > 3 ? argv[3] : "/";

    printf("DNS+HTTP test: %s:%s%s\n", hostname, port_str, path);

    /* DNS resolution */
    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    int gai = getaddrinfo(hostname, port_str, &hints, &res);
    if (gai != 0) {
        printf("FAIL: getaddrinfo(%s) error=%d %s\n", hostname, gai, gai_strerror(gai));
        return 1;
    }

    struct sockaddr_in *addr = (struct sockaddr_in *)res->ai_addr;
    char ipbuf[64];
    inet_ntop(AF_INET, &addr->sin_addr, ipbuf, sizeof(ipbuf));
    printf("PASS: getaddrinfo(%s) → %s\n", hostname, ipbuf);

    /* Create socket */
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        printf("FAIL: socket() errno=%d\n", errno);
        freeaddrinfo(res);
        return 1;
    }
    printf("PASS: socket() fd=%d\n", fd);

    /* Connect */
    int rc = connect(fd, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);
    if (rc < 0) {
        printf("FAIL: connect(%s) errno=%d %s\n", ipbuf, errno, strerror(errno));
        close(fd);
        return 1;
    }
    printf("PASS: connect(%s:%s)\n", ipbuf, port_str);

    /* Send HTTP GET */
    char req[512];
    int reqlen = snprintf(req, sizeof(req),
        "GET %s HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n",
        path, hostname);

    ssize_t sent = write(fd, req, reqlen);
    if (sent < 0) {
        printf("FAIL: write() errno=%d\n", errno);
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
        char *nl = strchr(buf, '\n');
        if (nl) *nl = '\0';
        printf("Response: %s\n", buf);
    } else {
        printf("FAIL: read() returned %d, errno=%d\n", (int)n, errno);
    }

    close(fd);
    return (total > 0 && strstr(buf, "HTTP/") != NULL) ? 0 : 1;
}
