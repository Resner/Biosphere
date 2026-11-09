# 0077: The engines: what CI checks in Firefox and WebKit, and what only the owner can

- Status: accepted
- Date: 2026-11-09

## Context

v1.0 promises Chrome, Edge, Firefox and Safari (M14). CI has Linux runners with no GPU and Playwright's own builds of Chromium, Firefox and WebKit. Until M14 only Chromium played the game in CI; Firefox ran two look checks (`m6c-firefox`, `m6c-flash`, M6c T8). M14 T6 measured what each of Playwright's Linux engines can do on a runner and in a cloud session:

- **Chromium** draws WebGL2 through SwiftShader headless, and links over WebRTC with host candidates once `WebRtcHideLocalIpsWithMdns` is off.
- **Firefox** finds no GL driver headless (no EGL): run headed under Xvfb it draws WebGL2 through Mesa (llvmpipe). Its ICE hides host addresses behind mDNS names unless `media.peerconnection.ice.obfuscate_host_addresses` is false; with the pref it links to itself and to Chromium. On a runner, where `localhost` resolves to ::1 first and the host has no global IPv6, a page served over IPv6 loopback gathers no ICE candidates at all (ICE fails within milliseconds), while the same page over 127.0.0.1 links; so the E2E page server listens on 127.0.0.1 (`--host 127.0.0.1`), as the hubs do.
- **WebKit** draws WebGL2 headless and has `RTCPeerConnection`, but it offers only mDNS host candidates (`<uuid>.local`), and Playwright exposes no switch for WebKit's mDNS setting. Nothing on a runner resolves those names, so two WebKit peers never connect, not even two `RTCPeerConnection`s in one page (ICE stays `new`).

## Decision

CI checks, in `e2e-full.yml` (Release and `E2E main`; PR CI stays Chromium):

| | Chromium (PR and full) | Firefox part (`E2E_FIREFOX`, headed under Xvfb) | WebKit part (`E2E_WEBKIT`, headless) |
|---|---|---|---|
| Every golden set recomputed in the page (`m14-goldens`) | yes | yes | yes |
| The game: recorded hatch with the egg charged and cracked, feeding, a dash, the menu and Settings, the help panel, a verified card, drawn frames and no page error (`m14-smoke`) | yes | yes | yes |
| Two pages of the same engine link and see each other move (in `m14-smoke`) | yes | yes | no (mDNS) |
| A Chromium page and this engine link and duel to the referee's hash (`m14-mixed`) | (the other side) | yes | no (mDNS) |
| The look checks (`m6c-firefox`, `m6c-flash`) | `m6c-flash` | yes | no |
| The capability screen (`m14-capability`: no WebRTC, no IndexedDB, no WebGL2) | yes | no | no |

Each engine part installs its engine and Chromium (`npx playwright install --with-deps`) and runs on one worker. `m14-smoke` skips its link step in WebKit, naming this ADR; `m14-mixed` runs only in the firefox project.

Edge is Chromium for every check CI can make: same engine, same WebGL2 and WebRTC stack.

What only the owner can check, on the `Playtest: v1.0.0` issue:

- **Safari** (macOS, and iPadOS with a keyboard): its WebRTC links to Chrome and to another Safari, across real NATs and through the TURN relay; the look on a real GPU; audio after the first gesture.
- **Edge** on Windows: a session from the Pages link, the look, a link to another browser.
- **Firefox and Chrome on real GPUs**: the look (CI draws through Mesa and SwiftShader, which may not show every driver's artefacts) and the frame rate.
- **Real networks**: links across NATs, the relay, and a dropped connection.

## Consequences

- A golden that differs in an engine is a determinism bug, fixed at its cause in `src/sim/math.ts` or wherever it starts; it is never left out. In M14 every set matched in all three engines with no change.
- WebKit's links are unchecked in CI. If Playwright exposes WebKit's mDNS setting (or a runner resolves `.local` names), `m14-mixed` gains a WebKit page and `m14-smoke` drops its skip, and this ADR is amended.
- The capability screen (`src/game/capability.ts`) is checked in Chromium by taking each capability away before load, which is engine-independent; the engine parts stay small, since every scenario there gates a release.
