float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum;
}

// Noise over the world (M11 T11): the lattice is wrapped to 289 points before hashing, since the
// hash loses its precision on the large lattice coordinates far out in the world. Within the first
// 289 lattice points it is `vnoise` and `fbm` exactly.
float vnoiseWorld(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(mod(i, 289.0)), hash21(mod(i + vec2(1.0, 0.0), 289.0)), u.x),
    mix(hash21(mod(i + vec2(0.0, 1.0), 289.0)), hash21(mod(i + vec2(1.0, 1.0), 289.0)), u.x),
    u.y
  );
}

float fbmWorld(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoiseWorld(p);
    p = p * 2.03 + 17.1;
    amp *= 0.5;
  }
  return sum;
}
