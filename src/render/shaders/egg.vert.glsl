// The egg layer (M6 T20, egg.ts): instanced quads, each an egg or the tether behind one.
attribute vec4 aEggA;
attribute vec4 aEggB;
attribute vec3 aEggTint;
varying vec2 vP;
varying vec4 vA;
varying vec4 vB;
varying vec3 vTint;

void main() {
  vP = position.xy;
  vA = aEggA;
  vB = aEggB;
  vTint = aEggTint;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
}
