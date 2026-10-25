uniform vec3 uColor;
varying float vTip;

void main() {
  gl_FragColor = vec4(uColor, 0.8 * (1.0 - vTip * 0.8));
}
