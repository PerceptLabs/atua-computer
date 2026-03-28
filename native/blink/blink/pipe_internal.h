#ifndef BLINK_PIPE_INTERNAL_H_
#define BLINK_PIPE_INTERNAL_H_
#include "blink/types.h"

#define PIPE_BUF_SIZE (64 * 1024)  // 64KB ring buffer

struct PipeInternal {
    u8 *buffer;          // points into contiguous pool or malloc'd
    int capacity;
    int read_pos;
    int write_pos;
    int write_closed;
    int read_closed;
};

struct System;
struct PipeInternal *CreatePipeInternal(struct System *s);
int PipeInternalRead(struct PipeInternal *p, u8 *buf, int len);
int PipeInternalWrite(struct PipeInternal *p, const u8 *buf, int len);
void PipeInternalClose(struct PipeInternal *p, int end);  // 0=read, 1=write

#endif
