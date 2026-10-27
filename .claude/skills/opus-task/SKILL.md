---
name: opus-task
description: Implement one Biosphere task marked [opus] (UI and look, netcode, security) on Opus 5.5 at high effort. Use only when /next routes here.
model: opus
effort: high
---

# Opus task

This skill changes only the model: the task /next picked runs on Opus 5.5 at high effort, because UI and look, netcode and security work gains the most from the stronger model (ADR 0023).

1. Implement the task exactly as the `next` skill's "Implementing a task" says: tests first, `npm run check`, `/simplify`, `/code-review`, tick it with a short note.
2. For a look or UI task, open the references the task or its owner issue names (`docs/art/`, `docs/art/README.md`) and compare your screenshots with them before you call it done. Green tests never settle a look.
3. Then continue with the `next` skill's "Ship" section. Everything else stays as /next says: one step, one PR, the same claim and the same report line.
