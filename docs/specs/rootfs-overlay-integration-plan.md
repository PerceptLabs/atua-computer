# RootFS + Overlay Integration Plan

## Goal

Define and validate mount semantics for rootfs and writable overlay in runtime boot path.

## Mount Sequence (Current)

1. Initialize FS bridge.
2. Mount rootfs baseline (`/etc/os-release`, `/bin/sh`).
3. Apply writable overlay entries from boot options.
4. Expose mounted tree to engine command path.

## Required Paths

- `/` root directory exists.
- `/tmp` writable directory for temp artifacts.
- `/workspace` writable path for project files.

## Validation Checklist

- Boot with overlay file and read it using `cat`.
- Create writable path using `mkdir /tmp/phase-b`.
- Verify rootfs file access with `cat /etc/os-release`.
