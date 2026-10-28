// A glow pool (M6 T16, glows.ts): an instanced quad whose instance colour is the glow's colour,
// already scaled by its strength and the zone's.
varying vec2 vP;
varying vec3 vColor;

void main() {
  vP = position.xy;
  vColor = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
}
