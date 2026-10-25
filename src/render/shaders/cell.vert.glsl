// A quad that covers the cell plus its halo; `vP` is in radii from the centre.
uniform float uExtent;
varying vec2 vP;

void main() {
  vP = position.xy * uExtent;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
