// Caustics (M6 T17): the sunlight focused by the rippled surface into bright, moving filaments. The
// pattern lives in world space and is projected straight down, so the water and the bodies over it
// (creature.frag.glsl) show the same lines in the same places.

// Folded sine caustics: bright filaments where the folded waves converge. The filament width is a
// constant: scaling it with `p` (as the shader this comes from does) makes it depend on the origin.
float caustic(vec2 p, float t) {
  vec2 i = p;
  float c = 1.0;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    // The sine and cosine are floored away from zero, where the term would blow up.
    float sx = max(abs(sin(i.x + tt)), 1e-3);
    float cy = max(abs(cos(i.y + tt)), 1e-3);
    c += 1.0 / length(vec2(0.44 / sx, 0.44 / cy));
  }
  c /= 4.0;
  return pow(abs(1.17 - pow(c, 1.4)), 5.0);
}

// The caustic light (0..1) at world point `w` at `t` seconds. The sine terms repeat every 2 pi, so
// the coordinate is wrapped to one tile and the look does not depend on where in the world it is.
float causticAt(vec2 w, float t) {
  return clamp(caustic(mod(w / 18.0, 6.2831853), t * 0.35), 0.0, 1.0);
}
