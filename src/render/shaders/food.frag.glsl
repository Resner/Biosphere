// uKind: 0 = detritus flake, 1 = globule, 2 = crystal.
uniform float uKind;
uniform float uTime;
uniform vec3 uColor;
varying vec2 vP;
varying float vPhase;

void main() {
  float d = length(vP);
  float pulse = 0.85 + 0.15 * sin(uTime * 2.0 + vPhase * 6.2831);
  vec3 col;
  float alpha;
  if (uKind < 0.5) {
    // A ragged flake: a thin ellipse, dull and slightly translucent.
    float e = length(vP * vec2(0.8, 1.9));
    float body = 1.0 - smoothstep(0.55, 0.7, e);
    col = uColor * (0.7 + 0.5 * vP.x);
    alpha = body * 0.85;
  } else if (uKind < 1.5) {
    // A glowing sphere with a soft halo and a highlight.
    float body = 1.0 - smoothstep(0.34, 0.4, d);
    float halo = exp(-d * 5.5) * 0.45;
    float spec = 1.0 - smoothstep(0.0, 0.16, length(vP - vec2(-0.1, 0.1)));
    col = uColor * (0.6 + 0.8 * (1.0 - d * 2.0)) + vec3(0.7) * spec;
    alpha = max(body, halo * pulse);
  } else {
    // A faceted hexagonal crystal: each sector has its own shade, with a bright core.
    float a = atan(vP.y, vP.x);
    float sector = floor(a / 1.0471976 + 6.0);
    float hex = max(abs(vP.x) * 0.866 + abs(vP.y) * 0.5, abs(vP.y)) * 2.0;
    float body = 1.0 - smoothstep(0.62, 0.7, hex);
    float shade = 0.55 + 0.45 * fract(sector * 0.618 + 0.3);
    float halo = exp(-d * 5.0) * 0.4;
    col = uColor * shade + vec3(0.8, 0.9, 1.0) * (1.0 - smoothstep(0.0, 0.35, d)) * 0.5 * pulse;
    alpha = max(body, halo * pulse);
  }
  gl_FragColor = vec4(col, alpha);
}
