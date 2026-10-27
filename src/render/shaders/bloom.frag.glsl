// Dual-filter bloom (Bjørge, SIGGRAPH 2015). PREFILTER keeps only what is brighter than the
// threshold, with a soft knee, as it halves the scene; DOWN halves a mip; UP doubles one and is
// added onto the mip above it with additive blending.
uniform sampler2D tSource;
/** One texel of the source. */
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
/** UP: how much of the wider level is added onto the one inside it. */
uniform float uScatter;
varying vec2 vUv;

vec3 tap(vec2 uv) {
  vec3 c = texture2D(tSource, uv).rgb;
#ifdef PREFILTER
  float peak = max(c.r, max(c.g, c.b));
  float soft = clamp(peak - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  c *= max(soft, peak - uThreshold) / max(peak, 1e-5);
#endif
  return c;
}

void main() {
#ifdef UP
  vec2 h = uTexel * 0.5;
  vec3 sum = tap(vUv + vec2(-2.0 * h.x, 0.0)) + tap(vUv + vec2(2.0 * h.x, 0.0))
    + tap(vUv + vec2(0.0, -2.0 * h.y)) + tap(vUv + vec2(0.0, 2.0 * h.y))
    + 2.0 * (tap(vUv + h) + tap(vUv - h) + tap(vUv + vec2(h.x, -h.y)) + tap(vUv + vec2(-h.x, h.y)));
  gl_FragColor = vec4(sum / 12.0 * uScatter, 1.0);
#elif defined(PREFILTER)
  // One bilinear tap averages the 2x2 block this texel halves; the downs blur from there.
  gl_FragColor = vec4(tap(vUv), 1.0);
#else
  // Each bilinear tap averages a 2x2 block; the five together cover 4x4 source texels.
  vec2 h = uTexel;
  vec3 sum = 4.0 * tap(vUv) + tap(vUv + h) + tap(vUv - h) + tap(vUv + vec2(h.x, -h.y))
    + tap(vUv + vec2(-h.x, h.y));
  gl_FragColor = vec4(sum / 8.0, 1.0);
#endif
}
