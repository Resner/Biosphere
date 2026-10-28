// Instanced quads in world units: the instance matrix carries position, size and rotation; its
// otherwise unused z scale carries a per-item phase for the twinkle.
varying vec2 vP;
varying float vPhase;
// The item's centre in world units, for the zone under it (M6 T16).
varying vec2 vWorld;

void main() {
  vP = position.xy;
  vPhase = instanceMatrix[2][2];
  vWorld = (modelMatrix * instanceMatrix[3]).xy;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
}
