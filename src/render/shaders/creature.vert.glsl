// The gait of a creature mesh; `gaitOffset` in gait.ts is the CPU reference with the same formulas.
// A vertex takes the spine's sway at the position its part hangs from, then its own beat weighted
// by distance from the part's base. `uPhase` is integrated on the CPU, so a changed frequency
// never jumps the pose: the genome's frequency only sets how fast it runs there.
attribute float aAttach;
attribute float aWeight;
attribute float aPart;

uniform float uAmp;
uniform float uPhase;
uniform float uBeat;
uniform float uBend;

varying vec3 vNormal;
varying vec2 vUv;
varying float vPart;

const float TAU = 6.28318530718;
const float SPINE_SWAY = 0.16;
const float PART_SWING = 0.3;
const float SPINE_WAVES = 0.8;
const float PART_WAVES = 1.0;
const float BREATH = 0.12;
const float PART_STAGGER = 2.399963;
const float ROW = 0.6;

void main() {
  float effort = BREATH + (1.0 - BREATH) * clamp(uBeat, 0.0, 1.0);
  float amp = clamp(uAmp, 0.0, 1.0);
  float sway = SPINE_SWAY * amp * (0.4 + 0.6 * clamp(uBend, 0.0, 1.0)) * effort;
  float base = sway * aAttach * sin(TAU * SPINE_WAVES * aAttach - uPhase);

  float swing = PART_SWING * effort * clamp(amp + 0.25, 0.0, 1.0) * aWeight;
  float wave = sin(TAU * PART_WAVES * aWeight - uPhase + floor(aPart / 4.0) * PART_STAGGER);
  float row = min(abs(position.y) * ROW, ROW);

  vec3 p = position + vec3(swing * wave * row, base + swing * wave * (1.0 - row), 0.0);
  vNormal = normalize(normalMatrix * normal);
  vUv = uv;
  vPart = aPart;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
