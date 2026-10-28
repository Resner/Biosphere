// The motion of a creature mesh (M3 T11, M6 T11); `gaitPosition` in gait.ts is the CPU reference
// with the same formulas. A body vertex rides the travelling wave across the spine's normal where
// it hangs (`aFrame.xy`), or a radial bell's pulse. A part vertex takes the body's motion at its
// part's root (`aFrame.zw`) and turns about it by an angle its motion class gives (`aMotion`), so
// it keeps its distance from the root and cannot come off. `uPhase` is integrated on the CPU and
// wraps at four beats, so a changed frequency never jumps the pose and the slower cycles stay
// continuous.
attribute float aAttach;
attribute float aWeight;
attribute float aPart;
attribute vec4 aFrame;
attribute vec4 aMotion;
attribute float aFlutter;

uniform float uAmp;
uniform float uPhase;
uniform float uBeat;
uniform float uBend;
uniform float uTurn;

varying vec3 vNormal;
varying vec2 vUv;
varying float vPart;
// The rest position in core radii, for the surface detail (M6 T13); where the vertex falls on the
// screen (0..1), and screen shares per core radius, for the refraction.
varying vec2 vRest;
varying vec2 vScreen;
varying vec2 vUnit;
// Where the vertex lies in the world, for the caustics projected from above (M6 T17).
varying vec2 vWorld;

const float TAU = 6.28318530718;
const float SPINE_SWAY = 0.16;
const float SPINE_WAVES = 0.8;
const float PART_WAVES = 1.0;
const float BREATH = 0.2;
const float ROW_SWEEP = 0.55;
const float ROW_LAG = 0.8;
const float WHIP_BEND = 0.6;
const float ANTENNA_SWAY = 0.25;
const float TURN_MAX = 0.35;
const float WING_FLAP = 0.6;
const float WING_STROKE = 0.4;
const float PULSE = 0.1;
const float PULSE_SQUEEZE = 0.3;
const float TENTACLE_BEND = 0.55;
const float TENTACLE_LAG = 2.2;
const float FLUTTER = 0.08;
const float FLUTTER_RATE = 3.0;
const float FLUTTER_SHIFT = 9.0;
// `aMotion.x`, the motion classes of creature-mesh.ts.
const float MOTION_RIGID = 0.0;
const float MOTION_BEAT = 1.0;
const float MOTION_ANTENNA = 2.0;
const float MOTION_WING = 3.0;
const float MOTION_TENTACLE = 4.0;
const float MOTION_BELL = 5.0;
// `aPart` is the appendage number times this, plus the part kind (creature-mesh.ts).
const float PART_KINDS = 16.0;

bool isMotion(float motion, float id) {
  return abs(motion - id) < 0.5;
}

float bellPulse(float x) {
  float u = fract(x / TAU);
  return u < PULSE_SQUEEZE
    ? smoothstep(0.0, 1.0, u / PULSE_SQUEEZE)
    : 1.0 - smoothstep(0.0, 1.0, (u - PULSE_SQUEEZE) / (1.0 - PULSE_SQUEEZE));
}

float wingFlap(float x) {
  float u = fract(x / TAU);
  return u < WING_STROKE ? 0.5 - 0.5 * cos(TAU * u / WING_STROKE) : 0.0;
}

void main() {
  float motion = aMotion.x;
  float effort = BREATH + (1.0 - BREATH) * clamp(uBeat, 0.0, 1.0);
  float amp = clamp(uAmp, 0.0, 1.0);
  float drive = effort * clamp(amp + 0.25, 0.0, 1.0);
  bool radial = isMotion(motion, MOTION_BELL) || isMotion(motion, MOTION_TENTACLE);
  bool turns = !isMotion(motion, MOTION_RIGID) && !isMotion(motion, MOTION_BELL);
  float k = radial ? 1.0 - PULSE * drive * bellPulse(uPhase / 2.0) : 1.0;
  float sway = SPINE_SWAY * amp * (0.4 + 0.6 * clamp(uBend, 0.0, 1.0)) * effort;
  float wave = radial ? 0.0 : sway * aAttach * sin(TAU * SPINE_WAVES * aAttach - uPhase);

  vec3 p = position;
  vec3 n = normal;
  if (!turns) {
    p.xy = position.xy * k + aFrame.xy * wave;
  } else {
    float w = aWeight;
    float gain = aMotion.z;
    float angle = 0.0;
    if (isMotion(motion, MOTION_BEAT)) {
      float psi = uPhase - aMotion.y;
      float row = ROW_SWEEP * sin(psi - ROW_LAG * w);
      float whip = WHIP_BEND * w * sin(psi - TAU * PART_WAVES * w);
      angle = gain * drive * (aMotion.w * row + (1.0 - aMotion.w) * whip);
    } else if (isMotion(motion, MOTION_ANTENNA)) {
      float idle = ANTENNA_SWAY * w * sin(uPhase / 4.0 - aMotion.y);
      angle = gain * effort * idle + abs(gain) * w * clamp(uTurn, -TURN_MAX, TURN_MAX);
    } else if (isMotion(motion, MOTION_WING)) {
      angle = gain * drive * WING_FLAP * (0.6 + 0.4 * w) * wingFlap(uPhase / 2.0);
    } else {
      angle = gain * drive * TENTACLE_BEND * w * bellPulse(uPhase / 2.0 - TENTACLE_LAG * w);
    }
    float f = FLUTTER * aFlutter * effort * sin(FLUTTER_RATE * uPhase + FLUTTER_SHIFT * w);
    vec2 d = (position.xy + normal.xy * f - aFrame.zw) * k;
    float c = cos(angle);
    float s = sin(angle);
    mat2 turn = mat2(c, s, -s, c);
    p.xy = aFrame.zw * k + aFrame.xy * wave + turn * d;
    n.xy = turn * normal.xy;
  }
  vNormal = normalize(normalMatrix * n);
  vUv = uv;
  vPart = aPart;
  vRest = position.xy;
  vWorld = (modelMatrix * vec4(p, 1.0)).xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vScreen = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
  vUnit = 0.5 * vec2(projectionMatrix[0][0], projectionMatrix[1][1]) * length(modelViewMatrix[0].xyz);
}
