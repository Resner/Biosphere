// Instanced quads in world units: the instance matrix carries position, size and rotation; its
// otherwise unused z scale carries a per-item phase for the twinkle.
varying vec2 vP;
varying float vPhase;

void main() {
  vP = position.xy;
  vPhase = instanceMatrix[2][2];
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
}
