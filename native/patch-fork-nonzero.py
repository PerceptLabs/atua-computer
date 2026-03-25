#!/usr/bin/env python3
"""Fix SysFork to return nonzero PID (parent path) and defer exec to posix_spawn.

The old approach returned 0 (child path), which made the parent enter the
child's code path and _Exit after exec. This broke pipes because the second
fork never happened.

New approach:
- SysFork returns a fake child PID (parent continues normally)
- The "child" is created lazily: when the shell would normally have the
  child call execve, we intercept it differently

Actually, the real fix for pipes is:
- SysFork returns 0 (child path) for SINGLE commands (sh -c "cmd")
- For pipes, we need the parent to survive

The problem is we can't tell at fork time whether it's a pipe or not.

Better approach: make posix_spawn NOT _Exit. Instead, after posix_spawn,
"undo" the vfork by returning from the child's code path back to the
parent. We do this by making SysExecve, instead of _Exit, use longjmp
or a special return that skips back to the fork return point and returns
the child PID.

Simplest working approach: use SysExecve to do posix_spawn and then
RETURN the child PID instead of _Exit. The caller of execve sees it
"fail" (return -1 from execve means exec failed, but we return the PID).
Actually, execve on success never returns. So returning anything means
failure from the shell's perspective.

The REAL fix: save the instruction pointer at fork time, do posix_spawn
at exec time, then restore the IP and return the child PID from fork.
This is what real vfork does — it returns twice.

For now, the pragmatic fix: SysFork uses posix_spawn to spawn a COPY
of the engine that will read commands from a pipe. The parent continues.
But this requires the child to have the right arguments...

Actually — the simplest pragmatic fix for pipes:
Make SysExecve NOT call _Exit. Instead, posix_spawn the child and
return to the interpreter loop. The guest's execve "fails" (returns -1),
and the shell handles exec failure by calling _exit(127) in the child
path. Our SysExit then calls _Exit(127). But the parent already got
the child PID from the fork and continues to the second fork.

Wait — the parent and child are the SAME PROCESS. After fork returns 0,
the shell enters the child branch. If execve "fails" (returns), the
shell calls _exit(127). That _Exit kills the parent.

I think the real answer is: stop trying to fake vfork. Instead, make
SysFork return a REAL child PID by doing posix_spawn(self) immediately.
The child continues from main() and re-executes the same shell command.
The parent continues with the PID.

But the child needs the same state as the parent at fork time...

For Phase D, let me try the simplest thing that might work:
1. SysFork returns FAKE_PID to parent
2. Parent continues (second fork, wait, etc.)
3. At waitpid(FAKE_PID), we... need the child to have run.
4. This doesn't work because the child never actually runs.

OK, the ACTUAL simplest fix: when the guest calls execve and isfork is
true, do posix_spawn and DON'T _Exit. Instead, return the child PID
as if from a new fork. Store the PID for later waitpid.
Then return from execve with -1 (exec failed from guest's perspective).
The guest's child path calls _exit(127) thinking exec failed.
Our _exit(127) calls... _Exit(127). Which kills the parent.

The fundamental issue is that _Exit kills the WHOLE process.
On real Unix, _exit in a fork'd child only kills the child.
On WASI with vfork, the child IS the parent.

THE REAL FIX: don't use vfork semantics at all. Instead:
- SysFork spawns a NEW engine process (posix_spawn of self)
- The new process re-enters Blink, loads the same ELF, and continues
  from the fork point with return value 0
- The parent gets the real child PID
- Both processes run independently

But this requires the child to have the parent's memory state... which
posix_spawn can't provide.

FOR PHASE D: Accept that pipes don't work with the current vfork model.
Document it. Move to D3 (interactive shell) which doesn't need pipes.
"""

# No changes — this file documents the analysis
print("Analysis complete — see comments for pipe fix options")
print("Current vfork model incompatible with pipes")
print("Pipes require either real fork or a re-architected spawn model")
