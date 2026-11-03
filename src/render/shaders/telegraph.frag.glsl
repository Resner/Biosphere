// Fight telegraphs (M7 T12, T15). `vPhase` is the kind in the integer part (0 windup glow, 1 block
// spark, 2 fighting ring, 3 target ring) and its value 0..1 in the fraction. All are additive,
// above the bodies.
varying vec2 vP;
varying float vPhase;

void main() {
  float d = length(vP);
  float kind = floor(vPhase + 0.001);
  float v = clamp(vPhase - kind, 0.0, 1.0);
  vec3 col;
  float a;
  if (kind < 0.5) {
    // A windup's glow: a warm bloom with a hot core that swells and reddens as the strike nears.
    float halo = exp(-d * d * 3.0);
    float core = exp(-d * d * 14.0);
    a = v * (0.6 * halo + 0.7 * core);
    col = mix(vec3(1.0, 0.7, 0.34), vec3(1.0, 0.4, 0.16), v);
  } else if (kind < 1.5) {
    // A block's spark: a glassy flash, eight rays flying out and a thin ring, fading as it goes.
    float fade = 1.0 - v;
    float r = mix(0.15, 0.85, 1.0 - fade * fade);
    float angle = atan(vP.y, vP.x);
    float ray = pow(max(cos(angle * 4.0), 0.0), 18.0) * (1.0 - smoothstep(0.0, r, d)) * step(0.05, d);
    float ring = 1.0 - smoothstep(0.0, 0.06, abs(d - r));
    float flash = exp(-d * d * 30.0) * fade * fade;
    a = (ray * 0.9 + ring * 0.55 + flash) * fade;
    col = vec3(0.78, 0.93, 1.0);
  } else if (kind < 2.5) {
    // A fight seen from outside: a faint broken ring, so it reads by shape and not colour alone.
    float angle = atan(vP.y, vP.x);
    float dash = step(0.0, sin(angle * 6.0));
    float ring = 1.0 - smoothstep(0.0, 0.05, abs(d - 0.85));
    a = ring * dash * v;
    col = vec3(1.0, 0.6, 0.45);
  } else {
    // The player's target: a thin whole ring with four bold brackets on the diagonals, a sight
    // that reads by shape; brighter when chosen than for the default nearest.
    float angle = atan(vP.y, vP.x);
    float thin = 1.0 - smoothstep(0.0, 0.025, abs(d - 0.8));
    float onDiagonal = smoothstep(0.86, 0.94, abs(sin(angle * 2.0)));
    float bracket = (1.0 - smoothstep(0.0, 0.06, abs(d - 0.8))) * onDiagonal;
    a = (0.45 * thin + bracket) * v;
    col = vec3(0.85, 0.95, 1.0);
  }
  a *= 1.0 - smoothstep(0.92, 1.0, d);
  gl_FragColor = vec4(col * a, a);
}
