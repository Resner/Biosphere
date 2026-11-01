---
paths:
  - "src/sim/**"
---

# Simulation (`src/sim`)

Bit-for-bit determinism across Chromium, Firefox, WebKit, Node and workerd is the invariant (ADR 0005). Peers, witnesses and the authority all re-run this code.

- Numbers: only `+ − × ÷` and `Math.sqrt`, `floor`, `ceil`, `round`, `trunc`, `abs`, `min`, `max`, `sign`, `fround`, `imul`, `clz32`, and the constants `Math.PI`, `SQRT2`, `LOG2E`. Use `sin`, `cos`, `atan2`, `exp`, `log` and `pow` from `src/sim/math.ts`. Never `Math.random`, `Math.log2` or any other transcendental `Math.*`.
- Never import or use `Date`, `performance`, `crypto`, timers, DOM, three.js, `src/render` or `src/net`. Time is the tick number; randomness is a seeded stream.
- One PRNG stream per purpose (`createRng(seed, 'food')`), or stateless `hashU32(...)` for per-cell randomness. Adding a draw must never shift another subsystem's sequence.
- Iterate entities in stable id order whenever order can affect an outcome. Never iterate in network-arrival or Map-insertion order of external data.
- State is plain data (numbers, strings, arrays, plain objects), with no NaN or Infinity, no class instances and no closures. It must survive `structuredClone` and hash identically.
- Every number belongs in `RULES` (`rules.ts`) and in `docs/DESIGN.md`. A change that alters outcomes regenerates the goldens in the same PR. The first such change after a release also bumps `RULES_VERSION`; later ones before the next release stay on that version (ADR 0018). Never edit a golden just to get green.
- Food slots keep their `consumed` entry for good: it holds the slot's next cycle `k`. Never prune it.
- Budget: one tick for a full pond (24 creatures plus visible food) stays under 2 ms in Node. Avoid per-tick allocations in hot loops.
