// A glassy egg seen from above (M6 T20): a clear shell with a rim light and a highlight, the child's
// light inside, cracks that glow, and the burst (a flash for a reveal; for a hatch the cap flies off
// and the base drops away). `vA` is kind (0 egg, 1 tether), glow, crack and burst; `vB` is alpha,
// burst light, spread and a seed; `vC` the burst's shard and ray counts (M6b T11). Output is
// premultiplied: the shell covers, the light adds.
uniform float uTime;
varying vec2 vP;
varying vec4 vA;
varying vec4 vB;
varying vec2 vC;
varying vec3 vTint;

// The quad's half-extent in egg half-heights (EGG_QUAD in egg.ts).
#define QUAD 2.4

// About 0 on the shell, negative inside; the egg narrows towards its top (+y).
float eggDist(vec2 q) {
  float w = 0.7 * (1.0 - 0.14 * q.y);
  return length(vec2(q.x / w, q.y)) - 1.0;
}

// The crack's zigzag across the shell, a little above the middle.
float crackY(float x, float seed) {
  float z = abs(fract(x * 2.4 + seed) - 0.5) * 2.0;
  return 0.12 + 0.2 * (z - 0.5) + 0.04 * sin(x * 11.0 + seed * 6.0);
}

mat2 turn(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

void main() {
  float glow = vA.y;
  float crack = vA.z;
  float burst = vA.w;
  float alpha = vB.x;
  float light = vB.y;
  float spread = vB.z;
  float seed = vB.w;

  if (vA.x > 0.5) {
    // The tether: a thin strand with a slow pulse running along it.
    float across = 1.0 - smoothstep(0.15, 1.0, abs(vP.y));
    float bead = 0.7 + 0.3 * sin(vP.x * 7.0 - uTime * 2.5 + seed * 6.28);
    float a = across * 0.45 * alpha;
    gl_FragColor = vec4(vTint * (0.5 + 0.5 * glow) * bead * a, a);
    return;
  }

  vec2 q = vP * QUAD;
  // An opened shell: the cap flies up and tilts away, the base drops back a little.
  vec2 qs = q;
  float d;
  if (spread > 0.0) {
    vec2 qt = turn(-0.9 * spread) * (q - vec2(0.3, 1.2) * spread);
    vec2 qb = q + vec2(0.0, 0.4) * spread;
    float dt = qt.y > crackY(qt.x, seed) ? eggDist(qt) : 9.0;
    float db = qb.y <= crackY(qb.x, seed) ? eggDist(qb) : 9.0;
    if (dt < db) {
      qs = qt;
      d = dt;
    } else {
      qs = qb;
      d = db;
    }
  } else {
    d = eggDist(q);
  }

  // Far outside a whole shell with no burst there is nothing to draw (the halo is under 0.3% by
  // here): the genesis egg's quad covers a fifth of the screen, so this saves most of its fragments.
  if (spread <= 0.0 && burst <= 0.0 && d > 1.6) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float inside = 1.0 - smoothstep(-0.03, 0.03, d);
  // Glass: a dim clear body, a bright rim, a backlit edge and one soft highlight.
  float rim = smoothstep(-0.38, 0.0, d) * inside;
  float back = pow(max(dot(normalize(qs + 1e-4), normalize(vec2(-0.6, 0.75))), 0.0), 3.0) * rim;
  vec3 shell = vec3(0.04, 0.12, 0.14) + vTint * (rim * 0.9 + back * 0.6);
  float hl = exp(-dot(qs - vec2(-0.24, 0.48), (qs - vec2(-0.24, 0.48)) * vec2(14.0, 30.0)));
  shell += vec3(0.95, 1.0, 1.0) * hl * 0.55;
  // Fine speckles in the membrane, so the shell reads as a living thing, not a bead: soft round
  // dots (M6b T11; square cells read as pixels on a genesis egg alone at the centre).
  vec2 sc = qs * 9.0 + seed * 31.0;
  float spot = 1.0 - smoothstep(0.1, 0.28, length(fract(sc) - 0.5));
  float speck = step(0.8, hash21(floor(sc))) * spot * 0.14 * (1.0 - rim);
  shell += vTint * speck;
  float shellA = inside * (0.38 + 0.52 * rim + 0.3 * hl) * alpha;

  // The child's light inside: a soft core that breathes, brighter as the cracks run.
  float breathe = 0.85 + 0.15 * sin(uTime * 2.2 + seed * 6.28);
  float core = exp(-dot(qs - vec2(0.0, -0.12), qs - vec2(0.0, -0.12)) * 3.2);
  vec3 add = vTint * core * glow * breathe * 0.7 * inside * alpha;

  // Cracks: a zigzag that runs out from the middle and a short branch, glowing from within.
  if (crack > 0.0) {
    float reach = crack * 0.8;
    float line = 1.0 - smoothstep(0.0, 0.05, abs(qs.y - crackY(qs.x, seed)));
    line *= 1.0 - smoothstep(reach - 0.08, reach, abs(qs.x));
    vec2 b = qs - vec2(0.18, crackY(0.18, seed));
    float branch = (1.0 - smoothstep(0.0, 0.04, abs(b.x + b.y * 0.55))) * step(0.0, b.y) * step(b.y, 0.35 * crack);
    float cracks = max(line, branch * step(0.45, crack)) * inside;
    add += vTint * cracks * (1.2 + 1.8 * glow) * alpha;
    shellA = max(shellA, cracks * 0.6 * alpha);
  }

  // A soft halo around the shell.
  float halo = exp(-max(spread > 0.0 ? eggDist(q) : d, 0.0) * 4.0) * (1.0 - inside);
  add += vTint * halo * glow * 0.35 * alpha;

  // The burst: a flash from the centre and a ring that runs out, by the child's rarity.
  if (burst > 0.0 && light > 0.0) {
    float r = length(q);
    float fade = (1.0 - burst) * (1.0 - burst);
    float flash = exp(-r * r * 1.4) * fade;
    float ring = exp(-pow((r - (0.9 + 1.3 * burst)) * 6.0, 2.0)) * (1.0 - burst);
    // The flash stays below white at its heart, so the rays and shards read through it (M6b T11).
    add += mix(vTint, vec3(1.0), 0.3) * (flash * 0.65 + ring * 0.8) * light;
  }

  // Light rays for a rare or exotic child: thin beams from the shell, rising and fading fast.
  float rays = vC.y;
  if (burst > 0.0 && rays > 0.5) {
    float r = length(q);
    float beam = pow(abs(cos(atan(q.y, q.x) * rays * 0.5 + seed * 3.0)), 28.0);
    float reach = smoothstep(0.55, 1.0, r) * exp(-(r - 1.0) * 0.9);
    float rise = sin(3.14159 * min(burst * 1.4, 1.0));
    add += mix(vTint, vec3(1.0), 0.55) * beam * reach * rise * light * 0.9;
  }

  // Shell shards: small chips of glass thrown out from the cracks, spinning as they fade.
  float shards = vC.x;
  if (burst > 0.0 && shards > 0.5) {
    float fly = 1.0 - (1.0 - burst) * (1.0 - burst);
    float chips = 0.0;
    for (int i = 0; i < 12; i++) {
      float fi = float(i);
      if (fi >= shards) break;
      float jitter = hash21(vec2(fi, seed * 17.0));
      float a = (fi + 0.5) / shards * 6.28318 + seed * 6.28318 + 0.5 * (jitter - 0.5);
      vec2 c = vec2(cos(a), sin(a) + 0.15) * (0.5 + (1.2 + 0.6 * jitter) * fly);
      vec2 p = turn(fly * (3.0 + 2.0 * jitter) * (mod(fi, 2.0) * 2.0 - 1.0)) * (q - c);
      float size = 0.17 * (0.7 + 0.6 * jitter);
      // A sliver of glass: a long, thin diamond, bright at its edge and clear inside.
      float d = abs(p.x) + abs(p.y) * 2.2;
      float body = 1.0 - smoothstep(size * 0.8, size, d);
      float edge = body * smoothstep(size * 0.35, size * 0.8, d);
      chips = max(chips, 0.35 * body + 0.65 * edge);
    }
    float a = chips * (1.0 - burst * burst);
    add += (vec3(0.04, 0.12, 0.14) + vTint * 1.1) * a;
    shellA = max(shellA, a * 0.6);
  }

  // Edges of the quad stay dark.
  float edge = 1.0 - smoothstep(0.9, 1.0, max(abs(vP.x), abs(vP.y)));
  gl_FragColor = vec4((shell * shellA + add) * edge, shellA * edge);
}
