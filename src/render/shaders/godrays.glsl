// God rays (M6 T17): shafts of sunlight slanting down through the water from a fixed light to the
// upper left. Seen from above, each shaft is a soft streak along the light's direction across the
// plane; the streaks drift slowly sideways and swell and fade along their length. The pattern lives
// in world space at the plane, so it stays put as the camera moves, and costs a few sines a pixel.

// The light's direction across the plane (unit): from the upper left towards the lower right, as the
// creatures' key light (creature.frag.glsl).
const vec2 RAY_DIR = vec2(0.8, -0.6);

// The shafts' light (0..1) at world point `w` at `t` seconds.
float godRays(vec2 w, float t) {
  vec2 n = vec2(-RAY_DIR.y, RAY_DIR.x);
  float across = dot(w, n);
  float along = dot(w, RAY_DIR);
  // Three slow bands of different widths, drifting at different speeds: a shaft where they agree.
  float bands = 0.5 * sin(across / 9.0 + t * 0.23) +
    0.3 * sin(across / 14.0 - t * 0.17 + 1.9) +
    0.4 * sin(across / 23.0 + t * 0.09 + 4.2);
  float shaft = smoothstep(0.2, 1.0, bands / 1.2);
  // Each shaft swells and fades along its length, the swells moving slowly down the light.
  float swell = 0.5 + 0.5 * sin(along / 45.0 - t * 0.12 + across / 31.0);
  return shaft * (0.15 + 0.85 * swell * swell);
}
