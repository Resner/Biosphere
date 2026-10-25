// The backdrop: deep water with a slow body colour, animated caustics and a glowing world wall.
uniform vec2 uCam;
uniform vec2 uHalf;
uniform float uTime;
uniform float uWorld;
varying vec2 vNdc;

// Folded sine caustics: bright filaments where the folded waves converge.
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    // The sine and cosine are floored away from zero, where the term would blow up.
    float sx = max(abs(sin(i.x + tt)), 1e-3);
    float cy = max(abs(cos(i.y + tt)), 1e-3);
    c += 1.0 / length(vec2(p.x * 0.006 / sx, p.y * 0.006 / cy));
  }
  c /= 4.0;
  return pow(abs(1.17 - pow(c, 1.4)), 8.0);
}

void main() {
  vec2 w = uCam + vNdc * uHalf;
  float body = fbm(w / 700.0 + vec2(uTime * 0.01, 0.0));
  vec3 col = mix(vec3(0.010, 0.026, 0.034), vec3(0.040, 0.100, 0.110), body);

  float c = caustic(w / 55.0, uTime * 0.35);
  col += vec3(0.09, 0.27, 0.24) * clamp(c, 0.0, 1.0) * (0.35 + body);

  col *= 1.0 - 0.4 * dot(vNdc, vNdc) * 0.5;

  // Negative outside the world. The wall is a soft glow, and beyond it the water is black.
  float edge = min(min(w.x, uWorld - w.x), min(w.y, uWorld - w.y));
  col = mix(col, vec3(0.0, 0.004, 0.006), (1.0 - smoothstep(-30.0, 0.0, edge)));
  col += vec3(0.10, 0.26, 0.30) * exp(-abs(edge) / 14.0) * 0.5;

  gl_FragColor = vec4(col, 1.0);
}
