/* Minimal DNS debug — traces each step musl's resolver does */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <netdb.h>

int main(int argc, char *argv[]) {
    setvbuf(stdout, NULL, _IONBF, 0);

    /* Step 1: Can we open /etc/resolv.conf? */
    int rfd = open("/etc/resolv.conf", O_RDONLY);
    if (rfd < 0) {
        printf("FAIL: open(/etc/resolv.conf) errno=%d %s\n", errno, strerror(errno));
    } else {
        char buf[256] = {0};
        int n = read(rfd, buf, sizeof(buf)-1);
        printf("PASS: /etc/resolv.conf (%d bytes): %s", n, buf);
        close(rfd);
    }

    /* Step 2: Create UDP socket */
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) {
        printf("FAIL: socket(DGRAM) errno=%d %s\n", errno, strerror(errno));
        /* Try without flags */
        fd = socket(AF_INET, SOCK_DGRAM, 0);
        if (fd < 0) {
            printf("FAIL: socket(DGRAM plain) errno=%d %s\n", errno, strerror(errno));
            return 1;
        }
        printf("PASS: socket(DGRAM plain) fd=%d\n", fd);
    } else {
        printf("PASS: socket(DGRAM|CLOEXEC|NONBLOCK) fd=%d\n", fd);
    }

    /* Step 3: Connect to DNS server */
    struct sockaddr_in dns_addr;
    memset(&dns_addr, 0, sizeof(dns_addr));
    dns_addr.sin_family = AF_INET;
    dns_addr.sin_port = htons(53);
    inet_pton(AF_INET, "1.1.1.1", &dns_addr.sin_addr);

    int rc = connect(fd, (struct sockaddr *)&dns_addr, sizeof(dns_addr));
    printf("connect(1.1.1.1:53) = %d errno=%d %s\n", rc, errno, strerror(errno));

    /* Step 4: Build minimal DNS query for example.com */
    unsigned char query[] = {
        0x00, 0x01, /* ID */
        0x01, 0x00, /* flags: recursion desired */
        0x00, 0x01, /* QDCOUNT = 1 */
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, /* other counts */
        /* QNAME: example.com */
        7, 'e','x','a','m','p','l','e',
        3, 'c','o','m',
        0, /* end of name */
        0x00, 0x01, /* QTYPE = A */
        0x00, 0x01, /* QCLASS = IN */
    };

    ssize_t sent = send(fd, query, sizeof(query), 0);
    printf("send(DNS query, %d bytes) = %d errno=%d %s\n",
           (int)sizeof(query), (int)sent, errno, strerror(errno));

    /* Step 5: Poll for response */
    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    rc = poll(&pfd, 1, 5000);
    printf("poll() = %d revents=0x%x\n", rc, pfd.revents);

    /* Step 6: Read response */
    if (rc > 0) {
        unsigned char resp[512];
        ssize_t n = recv(fd, resp, sizeof(resp), 0);
        printf("recv() = %d\n", (int)n);
        if (n > 12) {
            /* Parse answer: skip header + question, read first answer */
            printf("DNS response ID=0x%02x%02x flags=0x%02x%02x\n",
                   resp[0], resp[1], resp[2], resp[3]);
        }
    }

    close(fd);

    /* Step 7: Now try actual getaddrinfo */
    printf("\n--- getaddrinfo(example.com) ---\n");
    struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM };
    struct addrinfo *res;
    int gai = getaddrinfo("example.com", "80", &hints, &res);
    if (gai != 0) {
        printf("FAIL: getaddrinfo errno=%d(%s) gai=%d(%s)\n",
               errno, strerror(errno), gai, gai_strerror(gai));
    } else {
        char ipbuf[64];
        struct sockaddr_in *a = (struct sockaddr_in *)res->ai_addr;
        inet_ntop(AF_INET, &a->sin_addr, ipbuf, sizeof(ipbuf));
        printf("PASS: getaddrinfo → %s\n", ipbuf);
        freeaddrinfo(res);
    }

    return 0;
}
