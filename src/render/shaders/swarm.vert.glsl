// Ambient swarms (M11 T17, swarms.ts): one point per mote, its size in target pixels and its alpha
// (the cloud's fade times its own twinkle) written per frame.
attribute float aSize;
attribute float aAlpha;
varying float vAlpha;

void main() {
  vAlpha = aAlpha;
  gl_PointSize = max(aSize, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
