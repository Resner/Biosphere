uniform vec3 uColor;
uniform float uOpacity;
uniform float uBokeh;
varying float vSeed;
varying float vLight;
varying vec3 vInner;
varying vec3 vOuter;
varying vec3 vPeak;
varying vec3 vRim;
varying float vHalf;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0 * vHalf;
  // On high, red reaches further out than green and blue stops short: a rainbow rim on bright discs.
  vec3 profile = vPeak * (vec3(1.0) - smoothstep(vInner, vOuter, vec3(d)));
  // A hard bokeh disc is brighter towards its rim, less so once it is blurred.
  float rim = mix(1.0, 1.0 - vRim.z * (1.0 - smoothstep(vRim.x, vRim.y, d)), uBokeh);
  gl_FragColor = vec4(uColor * profile * (rim * uOpacity * vLight * (0.5 + 0.5 * vSeed)), 1.0);
}
