// A whip strip from the cell's rear: `position.x` runs 0 (root) to -1 (tip) and is scaled by the
// cell radius; the wave travels down it and beats harder with speed. `uPhase` is integrated on
// the CPU, so a change of beat never jumps the wave.
uniform float uPhase;
uniform float uRadius;
uniform float uBeat;
varying float vTip;

void main() {
  float u = -position.x;
  vTip = u;
  float amp = (0.12 + 0.3 * uBeat) * u;
  float width = 0.07 * (1.0 - u * 0.85);
  vec2 p = vec2(position.x * 1.9 - 0.85, position.y * width * 2.0 + sin(u * 8.0 - uPhase) * amp);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p * uRadius, 0.0, 1.0);
}
