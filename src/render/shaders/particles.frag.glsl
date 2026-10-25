uniform vec3 uColor;
uniform float uOpacity;
uniform float uBokeh;
varying float vSeed;

void main() {
  float d = length(gl_PointCoord - 0.5);
  float disc = 1.0 - smoothstep(0.42, 0.5, d);
  float edge = mix(1.0, 0.55 + 0.45 * smoothstep(0.25, 0.47, d), uBokeh);
  float soft = mix((1.0 - smoothstep(0.0, 0.5, d)), disc * edge, uBokeh);
  gl_FragColor = vec4(uColor, soft * uOpacity * (0.5 + 0.5 * vSeed));
}
