#!/usr/bin/env python3
"""Clean up remaining vfork references after the main patch."""

with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

# 1. Remove the old case 0x3C vfork intercept
old_exit_intercept = '''#ifdef __wasi__
      if (m->system->isfork) {
        // Vfork child exit: spawn dummy child, restore state, return to parent
        pid_t dummy = 0;
        const char *eng = getenv("BLINK_WASM_SELF");
        if (!eng) eng = "/engine/engine-wasix.wasm";
        char *da[] = {(char*)eng, "/rootfs/bin/busybox.static", "true", NULL};
        posix_spawn(&dummy, eng, NULL, NULL, da, environ);
        RestoreFds(&m->system->fds);
        m->system->isfork = false;
        m->ip = g_vfork_rip;
        Put64(m->ax, dummy > 0 ? dummy : 1);
        ax = Get64(m->ax);
        break;
      }
#endif'''
c = c.replace(old_exit_intercept, '', 2)  # remove from both 0x3C and 0xE7 cases

# 2. Move TrackHostPage declaration before DeserializeForkState
c = c.replace('\nextern u64 TrackHostPage(u8 *);\n\nuint8_t *ReadForkFile', '\nuint8_t *ReadForkFile')
# Add the declaration before DeserializeForkState instead
c = c.replace(
    'int DeserializeForkState(struct Machine *m',
    'static u64 TrackHostPage(u8 *);\n\nint DeserializeForkState(struct Machine *m'
)

# Actually TrackHostPage is defined in memorymalloc.c — it's not static, so extern is right
# But we already have it in the #ifdef block. Let me just add a forward decl at the top
c = c.replace(
    'static u64 TrackHostPage(u8 *);\n\nint DeserializeForkState',
    'int DeserializeForkState'
)
# Add extern before the serialize/deserialize functions
c = c.replace(
    'uint8_t *SerializeForkState(struct Machine *m',
    'extern u64 TrackHostPage(u8 *);\n\nuint8_t *SerializeForkState(struct Machine *m'
)

# 3. Fix the corrupted SysExecve line
c = c.replace(
    '  if (!(envp = CopyStrList(m, ea))) return   LOCK(&m->system->exec_lock);',
    '  if (!(envp = CopyStrList(m, ea))) return -1;\n  LOCK(&m->system->exec_lock);'
)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

print('Cleaned up remaining vfork references')
