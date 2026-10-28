// The light a luminous creature throws on the water around it, falling off smoothly to its edge;
// added over the water (additive blending).
varying vec2 vP;
varying vec3 vColor;

void main() {
  float k = 1.0 - smoothstep(0.0, 1.0, length(vP));
  gl_FragColor = vec4(vColor * k * k, 1.0);
}
