// The backdrop: water coloured by the zone under it (M6 T16; `zoneGlsl` in zones.ts, looked up per
// vertex in water.vert.glsl), with a slow body colour, animated caustics (M6 T17), the dimming beyond the
// player's sight in dark zones, and a glowing world wall.
uniform vec2 uCam;
uniform vec2 uHalf;
uniform float uTime;
uniform float uWorld;
uniform float uLight;
varying vec2 vNdc;
varying vec3 vLow;
varying vec3 vHaze;
varying vec2 vZone;

const vec3 CAUSTIC_WATER = vec3(0.14, 0.4, 0.36);

void main() {
  vec2 w = uCam + vNdc * uHalf;
  float body = fbm(w / 700.0 + vec2(uTime * 0.01, 0.0));
  vec3 col = mix(vLow, vHaze, body);

  // Caustics (caustics.glsl), as strong as the sunlight that reaches this depth (`zoneSun`).
  col += CAUSTIC_WATER * causticAt(w, uTime) * (0.35 + body) * vZone.y * uLight;

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
