// A mote: a faint, soft speck of pale sea-green light, added over the water.
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.25, 1.0, d)) * vAlpha * uOpacity;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(uColor * a, a);
}
