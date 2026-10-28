// Drifting marine snow, tiled in world space with a period of `uPeriod` wu. Each speck lies at a
// depth (camera heights, 0 at the gameplay plane, positive towards the camera): the layer's depth
// plus up to `uSpread` either way. The depth sets how much of the camera motion the speck follows
// and, with the depth of field (M6 T3), the radius of its circle of confusion: the sprite grows by
// it and spreads its light over the larger disc (`bokehShape` in `post/dof.ts` mirrors this).
uniform vec2 uCam;
uniform float uPeriod;
uniform float uDepth;
uniform float uSpread;
uniform float uTime;
uniform float uSize;
uniform float uPxPerWu;
/** The largest sprite, in pixels of the target drawn into. */
uniform float uMaxSize;
uniform float uBokeh;
uniform float uFocus;
/** CoC radius in target pixels per camera height off focus, and its cap. */
uniform float uCocSlope;
uniform float uCocMax;
uniform float uFringe;
attribute float aSeed;
varying float vSeed;
/**
 * The profile of each channel: `vPeak` inside `vInner`, falling to 0 at `vOuter` (pixels). With the
 * fringe, red reaches further out and blue stops short, each keeping the light it carries.
 */
varying vec3 vInner;
varying vec3 vOuter;
varying vec3 vPeak;
/** The hard disc's brighter rim: where it starts and ends (pixels) and its contrast. */
varying vec3 vRim;
/** Half the point size, in pixels. */
varying float vHalf;

float profileEnergy(float a, float w) {
  return a * a + a * w + 0.3 * w * w;
}

void main() {
  float z = uDepth + uSpread * (2.0 * position.z - 1.0);
  float parallax = 1.0 / (1.0 - z);
  vec2 drift = vec2(0.8 + 1.2 * aSeed, 0.3 * sin(uTime * 0.3 + aSeed * 6.2831)) * uTime;
  vec2 rel = mod(position.xy * uPeriod + drift - uCam * parallax, uPeriod) - 0.5 * uPeriod;
  vSeed = aSeed;

  float coc = min(uCocMax, uCocSlope * abs(z - uFocus));
  float fringe = uFringe * coc;
  float size = max(min(uSize * (0.6 + aSeed) * uPxPerWu, uMaxSize - 2.0 * (coc + fringe)), 0.5);
  float radius = size * (0.25 + 0.21 * uBokeh);
  float edge = size * (0.25 - 0.21 * uBokeh);
  float inner = max(abs(radius - coc) - edge, 0.0);
  float outer = radius + coc + edge;
  float peak = coc > 0.0
    ? min(1.0, profileEnergy(radius - edge, 2.0 * edge) / profileEnergy(inner, outer - inner))
    : 1.0;
  float light = peak * profileEnergy(inner, outer - inner);
  float innerBlue = max(inner - fringe, 0.0);
  vInner = vec3(inner + fringe, inner, innerBlue);
  vOuter = vec3(outer + fringe, outer, outer - fringe);
  vPeak = vec3(
    light / profileEnergy(inner + fringe, outer - inner),
    peak,
    light / profileEnergy(innerBlue, outer - fringe - innerBlue)
  );
  vRim = vec3(0.25 * size - coc, 0.47 * size + coc, 0.45 * radius / (radius + coc));
  vHalf = outer + fringe;
  gl_PointSize = 2.0 * vHalf;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(uCam + rel, 0.0, 1.0);
}
