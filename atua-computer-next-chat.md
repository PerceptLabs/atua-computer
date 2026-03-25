# Atua Computer Next-Chat Bootstrap

This file is the operational handoff for a fresh agent or chat thread.

## Read These Files First

Read these in order before doing any work:

1. [atua-computer.md](C:\Users\v1sua\atua-node\atua-computer.md)
2. [atua-computer-spike-plan.md](C:\Users\v1sua\atua-node\atua-computer-spike-plan.md)

These two files are the authoritative context. Do not assume chat history exists beyond them.

## Environment

Use this environment model unless the user explicitly changes it:

- use the Linux Docker container for spike execution and non-Windows validation
- keep repo-tracked document edits on the host workspace unless explicitly told otherwise
- keep exploratory prototype code in a separate Linux-side spike workspace, not in the main `atua-node` tree

The current intent is:

- docs and architecture decisions live in this repo
- experimental code and third-party clones live in Linux-side sibling workspaces
- findings return to this repo as Markdown documents, not only chat text

## Default Assumptions

Assume all of these unless the user changes them:

- `atua-computer` is the product name
- `atua-linux` is the first runtime target
- the default architecture remains user-mode-first
- the master product/architecture spec is [atua-computer.md](C:\Users\v1sua\atua-node\atua-computer.md)
- the execution-backend spike is exploratory and must not silently replace the default architecture
- Blink is the preferred donor/reference if it proves practically useful
- QEMU-WASM is a bounded fallback or co-track candidate, not the default

## First Task For The Next Chat

The next chat should begin with the execution-backend spike defined in [atua-computer-spike-plan.md](C:\Users\v1sua\atua-node\atua-computer-spike-plan.md).

Concrete first actions:

1. confirm it has read both docs
2. use the Linux Docker container for spike execution
3. create a separate Linux-side spike workspace
4. run the Blink viability investigation
5. run the QEMU-WASM viability investigation
6. write findings back into this repo as documents
7. state which architecture remains the default after evidence

## Required Outputs From The Next Chat

The next chat is not done until it has produced:

- a Blink spike report
- a QEMU-WASM spike report
- a final recommendation that says:
  - whether Blink meaningfully shortens the path
  - whether QEMU-WASM remains under consideration
  - whether there is a reusable backend seam or only reusable techniques
  - which architecture remains the default

## Guardrails

The next chat must:

- keep spike work isolated from the main `atua-node` implementation path
- avoid mutating the master architecture without evidence
- use only public materials and clean-room-safe sources for competitive learning
- prefer writing durable findings into repo docs over leaving key conclusions only in chat output

## Acceptance Checklist For The Next Chat

The next chat should explicitly confirm all of these in its final response:

- it read [atua-computer.md](C:\Users\v1sua\atua-node\atua-computer.md)
- it read [atua-computer-spike-plan.md](C:\Users\v1sua\atua-node\atua-computer-spike-plan.md)
- it used the Linux container for spike execution
- it kept spike work isolated from the main repo implementation path
- it produced written findings and a recommendation

## Copy-Paste Prompt For A New Chat

Use this prompt in a fresh chat:

```text
Read C:\Users\v1sua\atua-node\atua-computer.md and C:\Users\v1sua\atua-node\atua-computer-spike-plan.md first, then summarize the default architecture, the spike goals, and the hard decision gates before doing any work.

Use the Linux Docker container for non-Windows validation and keep exploratory spike code in a separate Linux-side workspace, not in the main atua-node tree.

Run the execution-backend spike for Blink and QEMU-WASM, write findings back into this repo as docs, and give a final recommendation on whether either candidate materially improves time-to-execution-core or time-to-JIT. Do not mutate the main architecture unless the evidence clearly justifies it.
```
