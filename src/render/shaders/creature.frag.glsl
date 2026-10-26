// A translucent membrane for the creature mesh: a fresnel rim, backlight and the same hurt and
// dissolve effects as `cell.frag.glsl`. The genes' own colours, patterns and glow are T12.
uniform vec3 uCore;
uniform vec3 uRim;
uniform float uHurt;
uniform float uDissolve;
uniform float uAlpha;
varying vec3 vNormal;
varying vec2 vUv;
varying float vPart;

void main() {
  float z = abs(normalize(vNormal).z);
  float fres = pow(1.0 - z, 2.2);
  float back = pow(max(dot(normalize(vNormal.xy + 1e-4), normalize(vec2(-0.6, 0.7))), 0.0), 3.0) * fres;
  vec3 col = uCore * (0.6 + 0.9 * z) + uRim * (fres * 1.55 + back * 0.9);

  vec3 hurtCol = vec3(1.0, 0.18, 0.12);
  if (uHurt > 0.0) col = mix(col, col * 0.5 + hurtCol * (0.35 + 0.8 * fres), uHurt * 0.7);

  float alpha = 0.4 + 0.6 * fres;

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
