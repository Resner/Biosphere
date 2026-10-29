// Size outlines (M6 T21): `vPhase` packs the kind and the pulse, the matrix's spare slot the alpha.
varying vec2 vP;
varying float vPhase;
varying float vAlpha;

void main() {
  vP = position.xy;
  vPhase = instanceMatrix[2][2];
  vAlpha = instanceMatrix[2][3];
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position.xy, 0.0, 1.0);
}
