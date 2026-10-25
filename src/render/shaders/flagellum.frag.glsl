uniform vec3 uColor;
uniform float uDissolve;
uniform float uAlpha;
varying float vTip;

void main() {
  gl_FragColor = vec4(uColor, 0.8 * (1.0 - vTip * 0.8) * (1.0 - smoothstep(0.0, 0.6, uDissolve)) * uAlpha);
}
