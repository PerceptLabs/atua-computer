#!/usr/bin/env python3
"""Pass fork state path via env var instead of -F flag.

WASIX posix_spawn ignores the argv parameter and uses the parent's
argv. Use BLINK_FORK_STATE env var instead — env vars DO get passed.
"""

# Fix SysFork: set env var instead of -F flag
with open('/home/ubuntu/blink/blink/syscall.c') as f:
    c = f.read()

old = '''  const char *engine = getenv("BLINK_WASM_SELF");
  if (!engine) engine = "/engine/engine-wasix.wasm";
  char *argv[] = {(char *)engine, "-F", path, NULL};
  pid_t pid;
  int ret = posix_spawn(&pid, engine, NULL, NULL, argv, environ);'''

new = '''  const char *engine = getenv("BLINK_WASM_SELF");
  if (!engine) engine = "/engine/engine-wasix.wasm";
  // WASIX posix_spawn ignores argv — pass fork state path via env var
  char env_entry[128];
  snprintf(env_entry, sizeof(env_entry), "BLINK_FORK_STATE=%s", path);
  // Build envp with the fork state var added
  int env_count = 0;
  while (environ[env_count]) env_count++;
  char **child_env = (char **)calloc(env_count + 2, sizeof(char *));
  for (int i = 0; i < env_count; i++) child_env[i] = environ[i];
  child_env[env_count] = env_entry;
  child_env[env_count + 1] = NULL;
  char *argv[] = {(char *)engine, NULL};
  pid_t pid;
  int ret = posix_spawn(&pid, engine, NULL, NULL, argv, child_env);
  free(child_env);'''

c = c.replace(old, new, 1)

with open('/home/ubuntu/blink/blink/syscall.c', 'w') as f:
    f.write(c)

# Fix blink.c: check BLINK_FORK_STATE env var instead of -F flag
with open('/home/ubuntu/blink/blink/blink.c') as f:
    c = f.read()

c = c.replace(
    '  if (FLAG_restore_fork) {',
    '  FLAG_restore_fork = getenv("BLINK_FORK_STATE");\n  if (FLAG_restore_fork) {'
)

with open('/home/ubuntu/blink/blink/blink.c', 'w') as f:
    f.write(c)

print('Fork state path now passed via BLINK_FORK_STATE env var')
