// A translucent membrane for the creature mesh, coloured by the genes (`materialParams`): a fresnel
// rim and backlight, a marking (rings, spots, stripes), a thin-film shimmer, a glow that may pulse,
// opaque plates and a marked mouth, with the same hurt and dissolve effects as `cell.frag.glsl`.
// One program serves every creature; only the uniforms differ.
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uLumColor;
uniform float uTime;
uniform float uTranslucency;
uniform float uMembrane;
uniform float uPattern;
uniform float uPatternCount;
uniform float uIrid;
uniform float uLum;
uniform float uLumPulse;
uniform float uPlating;
uniform float uRimStrength;
uniform float uHurt;
uniform float uDissolve;
uniform float uAlpha;
varying vec3 vNormal;
varying vec2 vUv;
varying float vPart;

// Marking weight 0..1 over the body's own coordinates: u runs around the body (it closes at 1,
// so the repeat count is a whole number) and v runs along it.
float stripeMask(float x, float width) {
  return 1.0 - smoothstep(width, width + 0.12, abs(fract(x) - 0.5) * 2.0);
}

float spotMask(vec2 uv, float count) {
  vec2 g = vec2(uv.x * count, uv.y * count * 0.7);
  vec2 id = floor(g);
  id.x = mod(id.x, count);
  vec2 jitter = vec2(hash21(id), hash21(id + 7.3)) - 0.5;
  float d = length(fract(g) - 0.5 - jitter * 0.3);
  return 1.0 - smoothstep(0.2, 0.3, d);
}

float markings(vec2 uv) {
  float rings = stripeMask(uv.y * uPatternCount, 0.35);
  float bands = stripeMask(uv.y * uPatternCount * 0.5, 0.55);
  float stripes = stripeMask(uv.x * uPatternCount, 0.45);
  float spots = spotMask(uv, uPatternCount);
  if (uPattern < 0.5) return 0.0;
  if (uPattern < 1.5) return rings;
  if (uPattern < 2.5) return spots;
  if (uPattern < 3.5) return stripes;
  if (uPattern < 4.5) return max(spots, stripes);
  return bands;
}

void main() {
  float z = abs(normalize(vNormal).z);
  float fres = pow(1.0 - z, mix(2.6, 1.6, uMembrane));
  float back = pow(max(dot(normalize(vNormal.xy + 1e-4), normalize(vec2(-0.6, 0.7))), 0.0), 3.0) * fres;
  int kind = int(mod(vPart, 4.0) + 0.5);

  vec3 col = uCore * (0.6 + 0.9 * z) + uRim * ((fres * 1.55 + back * 0.9) * uRimStrength);
  col = mix(col, uRim * 1.1, markings(vUv) * 0.55);

  // Thin-film shimmer: the hue slides with the view angle.
  vec3 film = 0.5 + 0.5 * cos(6.28318 * (fres * 1.4 + vec3(0.0, 0.33, 0.67)));
  col = mix(col, film * (0.45 + 0.7 * fres), uIrid * (0.25 + 0.55 * fres));

  // Glow in its own hue, pulsing along the body when the pulse allele is expressed.
  float pulse = mix(1.0, 0.5 + 0.5 * sin(uTime * 2.2 + vUv.y * 6.0 + vPart * 1.3), uLumPulse);
  float glint = 0.55 + 0.45 * fbm(vUv * 5.0 + uTime * 0.15);
  col += uLumColor * uLum * pulse * (0.25 + 0.5 * fres) * glint;

  float alpha = mix(0.85, 0.35, uTranslucency) * (1.0 - fres) + fres;
  if (kind == 2) {
    col = mix(col, uRim * 1.2 + 0.05, 0.3);
    alpha = mix(alpha, 1.0, uPlating);
  } else if (kind == 3) {
    col = mix(col, vec3(0.95, 0.5, 0.42), 0.35) + 0.05;
    alpha = max(alpha, 0.92);
  }

  vec3 hurtCol = vec3(1.0, 0.18, 0.12);
  if (uHurt > 0.0) col = mix(col, col * 0.5 + hurtCol * (0.35 + 0.8 * fres), uHurt * 0.7);

  // Death: the body breaks up along a noisy front and fades, with a bright edge on the front.
  if (uDissolve > 0.0) {
    float front = fbm(vUv * 7.0 + vPart) * 0.75 + 0.125;
    float gone = smoothstep(front - 0.06, front + 0.06, uDissolve * 1.15);
    float edge = 1.0 - smoothstep(0.0, 0.08, abs(front - uDissolve * 1.15));
    alpha *= (1.0 - gone) * (1.0 - 0.35 * uDissolve);
    col += vec3(0.9, 0.7, 0.5) * edge * 0.6;
  }
  gl_FragColor = vec4(col, alpha * uAlpha);
}
