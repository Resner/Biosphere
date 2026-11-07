// A toxic plume: swirling violet murk with a pulsing, dashed rim, so it reads without colour.
uniform float uTime;
// The look's scale (M11 T17, look.ts): the rim is at least PLUME_RIM_WU times it wide, so a giant
// still reads a plume's dashed edge, up to a tenth of the plume's radius.
uniform float uLook;
varying vec2 vP;
varying float vPhase;
varying float vSize;

void main() {
  float d = length(vP);
  if (d > 1.0) discard;
  float angle = atan(vP.y, vP.x);
  float spin = uTime * 0.12 + vPhase * 6.2831;
  vec2 q = mat2(cos(spin), sin(spin), -sin(spin), cos(spin)) * vP * 2.4;
  float n = fbm(q + vec2(uTime * 0.08, vPhase * 10.0));

  float mask = 1.0 - smoothstep(0.78, 1.0, d);
  vec3 col = mix(vec3(0.30, 0.05, 0.42), vec3(0.85, 0.25, 0.60), n);
  float alpha = mask * (0.30 + 0.35 * n);

  float rim = clamp(PLUME_RIM_WU * uLook / max(vSize, 1e-3), 0.045, 0.1);
  float ring = 1.0 - smoothstep(0.0, rim, abs(d - 0.9));
  float dashes = 0.55 + 0.45 * sin(angle * 18.0 - uTime * 1.6);
  col += vec3(1.0, 0.55, 0.85) * ring * dashes;
  alpha = max(alpha, ring * (0.35 + 0.5 * dashes));

  gl_FragColor = vec4(col, alpha);
}
