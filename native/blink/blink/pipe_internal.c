#include "blink/pipe_internal.h"
#include <stdlib.h>
#include <string.h>
#include <errno.h>

struct PipeInternal *CreatePipeInternal(struct System *s) {
    struct PipeInternal *p = (struct PipeInternal *)calloc(1, sizeof(*p));
    if (!p) return NULL;
    p->buffer = (u8 *)malloc(PIPE_BUF_SIZE);
    if (!p->buffer) { free(p); return NULL; }
    p->capacity = PIPE_BUF_SIZE;
    p->read_pos = 0;
    p->write_pos = 0;
    p->write_closed = 0;
    p->read_closed = 0;
    return p;
}

int PipeInternalRead(struct PipeInternal *p, u8 *buf, int len) {
    int bytes_read = 0;
    while (bytes_read < len) {
        if (p->read_pos == p->write_pos) {
            // Buffer empty
            if (p->write_closed) break;  // EOF
            if (bytes_read > 0) break;   // return what we have
            // Would block — for now return what we have (0 = would-block)
            break;
        }
        buf[bytes_read] = p->buffer[p->read_pos];
        p->read_pos = (p->read_pos + 1) % p->capacity;
        bytes_read++;
    }
    return bytes_read;
}

int PipeInternalWrite(struct PipeInternal *p, const u8 *buf, int len) {
    if (p->read_closed) {
        errno = EPIPE;
        return -1;
    }
    int written = 0;
    while (written < len) {
        int next = (p->write_pos + 1) % p->capacity;
        if (next == p->read_pos) break;  // full
        p->buffer[p->write_pos] = buf[written];
        p->write_pos = next;
        written++;
    }
    return written;
}

void PipeInternalClose(struct PipeInternal *p, int end) {
    if (end == 1) {
        p->write_closed = 1;
    } else {
        p->read_closed = 1;
    }
    if (p->write_closed && p->read_closed) {
        free(p->buffer);
        free(p);
    }
}
