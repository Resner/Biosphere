// Drifting marine snow, tiled in world space with a period of `uPeriod` wu. Each layer follows the
// camera at its own parallax: 1 is anchored to the water, below 1 sits behind it, above 1 in front.
uniform vec2 uCam;
uniform float uPeriod;
uniform float uParallax;
uniform float uTime;
uniform float uSize;
uniform float uPxPerWu;
attribute float aSeed;
varying float vSeed;

void main() {
  vec2 drift = vec2(0.8 + 1.2 * aSeed, 0.3 * sin(uTime * 0.3 + aSeed * 6.2831)) * uTime;
  vec2 rel = mod(position.xy * uPeriod + drift - uCam * uParallax, uPeriod) - 0.5 * uPeriod;
  vSeed = aSeed;
  gl_PointSize = min(uSize * (0.6 + aSeed) * uPxPerWu, 256.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uCam + rel, 0.0, 1.0);
}
