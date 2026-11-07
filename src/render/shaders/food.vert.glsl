// Instanced quads in world units: the instance matrix carries position, size and rotation; its
// otherwise unused z scale carries a per-item phase for the twinkle.
uniform float uKind;
// The look's scale (M11 T17, look.ts): a glowing item's halo reaches at least FOOD_HALO_WU times it,
// so a giant sees the halo of a small item as wide on screen as a starter sees a crystal's.
uniform float uLook;
varying vec2 vP;
varying float vPhase;
// How far the quad grew past the item's own for its halo (1: not at all).
varying float vGrow;
// The item's centre in world units, for the zone under it (M6 T16).
varying vec2 vWorld;

void main() {
  float size = max(length(instanceMatrix[0].xy), 1e-3);
  float grow = uKind < 0.5 ? 1.0 : max(1.0, FOOD_HALO_WU * uLook / size);
  vP = position.xy * grow;
  vGrow = grow;
  vPhase = instanceMatrix[2][2];
  vWorld = (modelMatrix * instanceMatrix[3]).xy;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(vP, 0.0, 1.0);
}
