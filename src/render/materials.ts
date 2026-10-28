import * as THREE from 'three';
import type { MaterialParams } from './material-params';
import { depthOfParallax } from './post/dof';
import caustics from './shaders/caustics.glsl?raw';
import cellFragment from './shaders/cell.frag.glsl?raw';
import cellVertex from './shaders/cell.vert.glsl?raw';
import creatureFragment from './shaders/creature.frag.glsl?raw';
import creatureVertex from './shaders/creature.vert.glsl?raw';
import flagellumFragment from './shaders/flagellum.frag.glsl?raw';
import flagellumVertex from './shaders/flagellum.vert.glsl?raw';
import foodFragment from './shaders/food.frag.glsl?raw';
import foodVertex from './shaders/food.vert.glsl?raw';
import glowFragment from './shaders/glow.frag.glsl?raw';
import glowVertex from './shaders/glow.vert.glsl?raw';
import noise from './shaders/noise.glsl?raw';
import particlesFragment from './shaders/particles.frag.glsl?raw';
import particlesVertex from './shaders/particles.vert.glsl?raw';
import plumeFragment from './shaders/plume.frag.glsl?raw';
import plumeVertex from './shaders/plume.vert.glsl?raw';
import ringsFragment from './shaders/rings.frag.glsl?raw';
import waterFragment from './shaders/water.frag.glsl?raw';
import waterVertex from './shaders/water.vert.glsl?raw';
import { DETAIL_FADE, DETAIL_SIZE } from './surface';
import { ZONE_UNIFORMS, zoneGlsl } from './zones';

/** The largest sprite in canvas pixels: big discs cost fill, and some GPUs cap point sizes there. */
export const MAX_SPRITE_PX = 256;

/** Every layer is ordered by `renderOrder` alone: no depth test, no depth write. */
function layer(
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  options: { blending?: THREE.Blending } = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: options.blending ?? THREE.NormalBlending,
  });
}

/** The zone chunk (M6 T16) the water and food shaders share, with its uniforms. */
const ZONE_GLSL = zoneGlsl();

export const waterMaterial = (): THREE.ShaderMaterial =>
  layer(
    ZONE_GLSL + waterVertex,
    noise + caustics + ZONE_GLSL + waterFragment,
    {
      ...ZONE_UNIFORMS,
      uCam: { value: new THREE.Vector2() },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uWorld: { value: 0 },
      uLight: { value: 1 },
    },
    { blending: THREE.NoBlending },
  );

export const cellMaterial = (extent: number): THREE.ShaderMaterial =>
  layer(cellVertex, noise + cellFragment, {
    uExtent: { value: extent },
    uTime: { value: 0 },
    uCore: { value: new THREE.Color(0.04, 0.15, 0.16) },
    uRim: { value: new THREE.Color(0.56, 0.95, 0.86) },
    uNucleus: { value: new THREE.Color(0.6, 0.9, 0.55) },
    uHurt: { value: 0 },
    uDissolve: { value: 0 },
    uAlpha: { value: 1 },
  });

/** A GLSL float literal. */
const glslFloat = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/** The surface detail's fade band and sizes (`surface.ts`), as the creature shader's defines. */
export const SURFACE_DEFINES: Readonly<Record<string, string>> = {
  DETAIL_FROM: glslFloat(DETAIL_FADE.from),
  DETAIL_TO: glslFloat(DETAIL_FADE.to),
  DETAIL_PORE: glslFloat(DETAIL_SIZE.pore),
  DETAIL_CELL: glslFloat(DETAIL_SIZE.cell),
  DETAIL_VEIN: glslFloat(DETAIL_SIZE.vein),
  DETAIL_FLAW: glslFloat(DETAIL_SIZE.flaw),
};

/**
 * The water behind the creatures (M6 T13): the post chain's half-resolution backdrop copy and how
 * far the glass bends it, shared by every creature material (`shareBackdrop`). The chain sets them
 * before each frame; with no copy (low) the strength is 0 and the glass is plain translucency.
 */
export const BACKDROP: {
  readonly texture: THREE.IUniform<THREE.Texture | null>;
  readonly strength: THREE.IUniform<number>;
} = { texture: { value: null }, strength: { value: 0 } };

/**
 * Points a creature material at the shared backdrop. A clone copies its uniforms (and three cannot
 * clone a render target's texture), so each view links its own clone after cloning.
 */
export function shareBackdrop(material: THREE.ShaderMaterial): void {
  material.uniforms.tBackdrop = BACKDROP.texture;
  material.uniforms.uRefract = BACKDROP.strength;
}

/**
 * The creature mesh's material (M3 T11, T12, M6 T13): the genes' look is set once from `params` and
 * the glints' brightness (`glintsFor`), then only `uTime`, `uPhase`, `uBeat`, `uTurn`, `uHurt`,
 * `uDissolve`, `uAlpha`, `uSight` and `uCaustic` change. A view clones it, since the gait uniforms are per creature, and
 * links the clone to the shared backdrop.
 */
export const creatureMaterial = (params: MaterialParams, glint = 0): THREE.ShaderMaterial => {
  const material = layer(creatureVertex, noise + caustics + creatureFragment, {
    uAmp: { value: 0 },
    uPhase: { value: 0 },
    uBeat: { value: 0 },
    uBend: { value: 0 },
    uTurn: { value: 0 },
    uTime: { value: 0 },
    uCore: { value: new THREE.Color(...params.core) },
    uRim: { value: new THREE.Color(...params.rim) },
    uOrgan: { value: new THREE.Color(...params.organ) },
    uOil: { value: new THREE.Color(...params.oil) },
    uLumColor: { value: new THREE.Color(...params.lumColor) },
    uTranslucency: { value: params.translucency },
    uMembrane: { value: params.membrane },
    uPattern: { value: params.pattern },
    uPatternCount: { value: params.patternCount },
    uIrid: { value: params.iridescence },
    uLum: { value: params.luminescence },
    uLumPulse: { value: params.lumPulse },
    uPlating: { value: params.plating },
    uRimStrength: { value: params.rimStrength },
    uGlint: { value: glint },
    // Linked to the shared backdrop by `shareBackdrop`; declared here so an unlinked material still draws.
    tBackdrop: { value: null },
    uRefract: { value: 0 },
    uHurt: { value: 0 },
    uDissolve: { value: 0 },
    uAlpha: { value: 1 },
    uSight: { value: 1 },
    uCaustic: { value: 0 },
  });
  material.defines = { ...SURFACE_DEFINES };
  return material;
};

export const flagellumMaterial = (): THREE.ShaderMaterial =>
  layer(flagellumVertex, flagellumFragment, {
    uPhase: { value: 0 },
    uRadius: { value: 1 },
    uBeat: { value: 0 },
    uColor: { value: new THREE.Color(0.62, 0.91, 0.84) },
    uDissolve: { value: 0 },
    uAlpha: { value: 1 },
  });

export const foodMaterial = (kind: number, color: number): THREE.ShaderMaterial =>
  layer(foodVertex, ZONE_GLSL + foodFragment, {
    ...ZONE_UNIFORMS,
    uKind: { value: kind },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(color) },
  });

export const plumeMaterial = (): THREE.ShaderMaterial =>
  layer(plumeVertex, noise + plumeFragment, { uTime: { value: 0 } });

/** Glow pools over the water (M6 T16): additive, coloured per instance. */
export const glowMaterial = (): THREE.ShaderMaterial =>
  layer(glowVertex, glowFragment, {}, { blending: THREE.AdditiveBlending });

/** Pops and ripples reuse the plume's instanced-quad vertex shader; only the fragment differs. */
export const ringMaterial = (): THREE.ShaderMaterial =>
  layer(plumeVertex, ringsFragment, {}, { blending: THREE.AdditiveBlending });

/** An occasional bright speck (M6 T17) is this much larger and brighter than its plain self. */
export const SPARKLE = { size: 1.6, light: 5 } as const;

export interface ParticleStyle {
  /** Sprite diameter in world units. */
  size: number;
  color: number;
  opacity: number;
  /** 0 = a soft dot, 1 = a hard-edged bokeh disc. */
  bokeh: number;
  /** Tile size in world units: wide enough to cover the widest view at the largest zoom. */
  period: number;
  /** How much of the camera motion the layer follows; above 1 sits in front of the plane. */
  parallax: number;
  /** Specks lie up to this far (camera heights) either side of the layer's depth; default 0. */
  spread?: number;
  /** The share of specks that turn bright on high (M6 T17, `ParticleLayer.setSparkle`); default 0. */
  sparkle?: number;
}

export const particleMaterial = (style: ParticleStyle): THREE.ShaderMaterial =>
  layer(
    particlesVertex,
    particlesFragment,
    {
      uCam: { value: new THREE.Vector2() },
      uFlow: { value: new THREE.Vector2() },
      uPeriod: { value: style.period },
      uDepth: { value: depthOfParallax(style.parallax) },
      uSpread: { value: style.spread ?? 0 },
      uTime: { value: 0 },
      uSize: { value: style.size },
      uPxPerWu: { value: 1 },
      uMaxSize: { value: MAX_SPRITE_PX },
      uColor: { value: new THREE.Color(style.color) },
      uOpacity: { value: style.opacity },
      uBokeh: { value: style.bokeh },
      uFocus: { value: 0 },
      uCocSlope: { value: 0 },
      uCocMax: { value: 0 },
      uFringe: { value: 0 },
      uSparkle: { value: 0 },
      uSparkleSize: { value: SPARKLE.size },
      uSparkleLight: { value: SPARKLE.light },
    },
    { blending: THREE.AdditiveBlending },
  );

function uniformOf(material: THREE.ShaderMaterial, name: string): THREE.IUniform {
  const uniform = material.uniforms[name];
  if (!uniform) throw new Error(`shader has no uniform ${name}`);
  return uniform;
}

export function setUniform(material: THREE.ShaderMaterial, name: string, value: number): void {
  uniformOf(material, name).value = value;
}

export function colorUniform(material: THREE.ShaderMaterial, name: string): THREE.Color {
  return uniformOf(material, name).value as THREE.Color;
}

export function vec2Uniform(material: THREE.ShaderMaterial, name: string): THREE.Vector2 {
  return uniformOf(material, name).value as THREE.Vector2;
}
