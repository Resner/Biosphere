# 0005: Deterministic simulation and versioned rules

- Status: accepted (no rules version is frozen before v1.0: 0040, which replaces 0035's interim rule for development and stats)
- Date: 2026-10-25

## Context

The brief asks for a shared deterministic simulation, separate from rendering, with versioned rules and verifiable replay. Determinism must hold "across clients": Chromium, Firefox and WebKit players, Node test runs and the Cloudflare authority (workerd). JavaScript numbers are IEEE-754 doubles, and the basic operations are exactly specified. `Math.sin`, `Math.exp`, `Math.pow` and the other transcendental functions are implementation-defined and differ between engines.

## Decision

- **`src/sim` is pure TypeScript**: no DOM, three.js, network, timers, `Date`, `performance` or `Math.random`. State is plain data (numbers, strings, arrays, plain objects) that `structuredClone` and the canonical serializer handle.
- **Fixed tick of 30 Hz** (`TICK_HZ` in `src/sim/rules.ts`). The game loop runs as many ticks as real time requires, at most 5 per frame. Rendering interpolates.
- **Arithmetic**: float64 limited to `+ − × ÷` and `Math.sqrt`, `floor`, `ceil`, `round`, `trunc`, `abs`, `min`, `max`, `sign`, `fround`, `imul` and `clz32`. `sin`, `cos`, `atan2`, `exp`, `log` and `pow` come from `src/sim/math.ts`: range reduction plus polynomials built from those operations, so they are bit-identical everywhere. No NaN or Infinity in state; hashing asserts finite values.
- **Randomness**: xoshiro128** streams from `src/sim/prng.ts`, seeded from (seed, purpose). Each subsystem draws from its own stream, so adding a draw in one place never shifts another subsystem's sequence.
- **Ordering**: whenever iteration order affects an outcome, iterate entities sorted by stable id, never by network arrival or insertion order.
- **State hash**: a canonical serialization of the world state (`src/sim/state-hash.ts`), digested with a fast non-cryptographic 64-bit hash for replays and goldens. Records that need security use SHA-256 (ADR 0009).
- **Rules versions**: `RULES_VERSION` changes with any change that alters outcomes (movement, metabolism, development, inheritance, combat). Implementations that verify history (genesis, development, inheritance, encounter) stay frozen per version in a registry (M9). A new version adds code and never edits the old one. Golden replays and test vectors are per version.
- **Scope of determinism**:
  - Free roam is not lockstep. Each client simulates its own creature and the environment, where food, hazards and currents are functions of (world seed, time, consumed set). Remote creatures come from snapshots.
  - Determinism across clients is required where verification needs it: development and inheritance (ADR 0006), encounters (ADR 0011) and replays of a player's own input log (movement audits).
- **Verification of determinism**: golden replay hashes run in Node on every `check` and in Chromium in E2E. Firefox and WebKit join in the release gate (M14).

## Consequences

- Any engine reproduces fights and offspring exactly, so peers, witnesses and the authority can verify them.
- The sim code is a little more verbose (own math, explicit sorting). A source-scanning test enforces the banned-API list.
- Replays prove that outcomes follow from inputs, not that the inputs came from an honest human (stated wherever replays are used).
- Rejected:
  - fixed-point integers everywhere (awkward across size tiers spanning about 1,000× in radius);
  - `Math.*` transcendental functions;
  - lockstep simulation of the whole free-roam world (latency, and every peer would need every input).
