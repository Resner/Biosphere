// The backdrop: water coloured by the zone under it (M6 T16; `zoneGlsl` in zones.ts, looked up per
// vertex in water.vert.glsl), with a slow body colour, animated caustics, the dimming beyond the
// player's sight in dark zones, and a glowing world wall.
uniform vec2 uCam;
uniform vec2 uHalf;
uniform float uTime;
uniform float uWorld;
varying vec2 vNdc;
varying vec3 vLow;
varying vec3 vHaze;
varying vec3 vZone;

// Folded sine caustics: bright filaments where the folded waves converge. The filament width is a
// constant: scaling it with `p` (as the shader this comes from does) makes it depend on the origin.
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    // The sine and cosine are floored away from zero, where the term would blow up.
    float sx = max(abs(sin(i.x + tt)), 1e-3);
    float cy = max(abs(cos(i.y + tt)), 1e-3);
    c += 1.0 / length(vec2(0.44 / sx, 0.44 / cy));
  }
  c /= 4.0;
  return pow(abs(1.17 - pow(c, 1.4)), 8.0);
}

void main() {
  vec2 w = uCam + vNdc * uHalf;
  float body = fbm(w / 700.0 + vec2(uTime * 0.01, 0.0));
  vec3 col = mix(vLow, vHaze, body);

  // The sine terms repeat every 2 pi, so the coordinate is wrapped to one tile and the look does
  // not depend on where in the world the camera is.
  float c = caustic(mod(w / 55.0, 6.2831853), uTime * 0.35);
  col += vec3(0.09, 0.27, 0.24) * clamp(c, 0.0, 1.0) * (0.35 + body) * vZone.z;

  // Beyond the player's sight the dark zones' water fades into fog. (Glow pools are drawn over it
  // by glows.ts: a loop over the lights per pixel is too slow for software GL.)
  col *= 1.0 - vZone.x * smoothstep(uViewer.z, uViewer.z * SIGHT_FADE, length(w - uViewer.xy));

  col *= 1.0 - 0.4 * dot(vNdc, vNdc) * 0.5;

  // Negative outside the world. The wall is a soft glow, and beyond it the water is black.
  float edge = min(min(w.x, uWorld - w.x), min(w.y, uWorld - w.y));
  col = mix(col, vec3(0.0, 0.004, 0.006), (1.0 - smoothstep(-30.0, 0.0, edge)));
  col += vec3(0.10, 0.26, 0.30) * exp(-abs(edge) / 14.0) * 0.5;

  gl_FragColor = vec4(col, 1.0);
}
