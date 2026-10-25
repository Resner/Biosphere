// Eat pops and dash ripples. `vPhase` is the kind in the integer part (0 pop, 1 ripple) and the
// progress 0..1 in the fraction. Both are additive and drawn above the cell.
varying vec2 vP;
varying float vPhase;

void main() {
  float d = length(vP);
  float kind = floor(vPhase + 0.001);
  float t = clamp(vPhase - kind, 0.0, 1.0);
  float fade = 1.0 - t;
  vec3 col;
  float a;
  if (kind < 0.5) {
    // A bright ring that grows from the middle, with six sparkle spokes that fly outwards.
    float r = mix(0.25, 0.9, 1.0 - fade * fade);
    float ring = 1.0 - smoothstep(0.0, 0.1, abs(d - r));
    float angle = atan(vP.y, vP.x);
    float spoke = pow(max(cos(angle * 3.0), 0.0), 24.0);
    float spark = spoke * (1.0 - smoothstep(0.0, 0.18, abs(d - r * 1.05)));
    a = (ring * 0.8 + spark) * fade;
    col = vec3(0.75, 1.0, 0.8);
  } else {
    // Two thin rings spreading out from the cell.
    float r1 = mix(0.3, 1.0, 1.0 - fade * fade);
    float r2 = r1 * 0.78;
    float w = 0.035 + 0.03 * t;
    float rings = (1.0 - smoothstep(0.0, w, abs(d - r1))) + 0.5 * (1.0 - smoothstep(0.0, w, abs(d - r2)));
    a = rings * fade * 0.7;
    col = vec3(0.65, 0.92, 1.0);
  }
  a *= 1.0 - smoothstep(0.92, 1.0, d);
  gl_FragColor = vec4(col * a, a);
}
