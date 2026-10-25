// Translucent membrane: a fresnel rim, backlight, drifting organelle glints and a glowing nucleus.
uniform float uTime;
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uNucleus;
uniform float uHurt;
uniform float uDissolve;
uniform float uAlpha;
varying vec2 vP;

void main() {
  float d = length(vP);
  float angle = atan(vP.y, vP.x);
  float wobble = 1.0 + 0.022 * sin(angle * 5.0 + uTime * 2.1) + 0.016 * sin(angle * 3.0 - uTime * 1.3);
  float r = d / wobble;

  float inside = 1.0 - smoothstep(0.965, 1.0, r);
  float z = sqrt(max(1.0 - r * r, 0.0));
  float fres = pow(1.0 - z, 2.4);
  vec2 dir = vP / max(d, 1e-4);
  float back = pow(max(dot(dir, normalize(vec2(-0.6, 0.7))), 0.0), 3.0) * fres;

  vec3 col = uCore * (0.6 + 0.9 * z) + uRim * (fres * 1.55 + back * 0.9);

  // Organelle glints: a jittered grid of small sparkles that slowly turns.
  float spin = uTime * 0.05;
  vec2 q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * vP * 4.5;
  vec2 cell = floor(q);
  float h = hash21(cell);
  vec2 jitter = vec2(h, hash21(cell + 7.7)) * 0.6 + 0.2;
  float glint = 1.0 - smoothstep(0.0, 0.17, length(fract(q) - jitter));
  glint *= step(0.45, h) * (0.55 + 0.45 * sin(uTime * 1.7 + h * 40.0)) * (1.0 - smoothstep(0.5, 0.85, r));
  col += vec3(1.0, 0.93, 0.78) * glint * 0.8;

  // Nucleus.
  float n = length(vP - vec2(0.2, 0.08));
  col += uNucleus * (exp(-n * n * 26.0) * 0.9 + (1.0 - smoothstep(0.0, 0.03, abs(n - 0.27))) * 0.18) * (1.0 - smoothstep(0.7, 1.0, r));

  // Damage: the body flushes red and the rim brightens, so a hit shows on the cell itself.
  vec3 hurtCol = vec3(1.0, 0.18, 0.12);
  if (uHurt > 0.0) col = mix(col, col * 0.5 + hurtCol * (0.35 + 0.8 * fres), uHurt * 0.7);

  float alpha = inside * (0.4 + 0.6 * fres + 0.3 * glint);
  float halo = exp(-max(d - 1.0, 0.0) * 6.5) * 0.3 * (1.0 - inside);
  vec3 haloCol = mix(uRim * 0.55, hurtCol * 0.6, uHurt);
  alpha = max(alpha, halo);

  // Death: the body breaks up along a noisy front and fades, with a bright edge on the front.
  vec3 rgb = mix(haloCol, col, inside);
  if (uDissolve > 0.0) {
    float front = fbm(vP * 3.2 + 3.7) * 0.75 + 0.125;
    float gone = smoothstep(front - 0.06, front + 0.06, uDissolve * 1.15);
    float edge = 1.0 - smoothstep(0.0, 0.08, abs(front - uDissolve * 1.15));
    alpha *= (1.0 - gone) * (1.0 - 0.35 * uDissolve);
    rgb += vec3(0.9, 0.7, 0.5) * edge * 0.6;
  }
  gl_FragColor = vec4(rgb, alpha * uAlpha);
}
