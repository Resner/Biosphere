import * as THREE from 'three';
import cellFragment from './shaders/cell.frag.glsl?raw';
import cellVertex from './shaders/cell.vert.glsl?raw';
import flagellumFragment from './shaders/flagellum.frag.glsl?raw';
import flagellumVertex from './shaders/flagellum.vert.glsl?raw';
import foodFragment from './shaders/food.frag.glsl?raw';
import foodVertex from './shaders/food.vert.glsl?raw';
import noise from './shaders/noise.glsl?raw';
import particlesFragment from './shaders/particles.frag.glsl?raw';
import particlesVertex from './shaders/particles.vert.glsl?raw';
import plumeFragment from './shaders/plume.frag.glsl?raw';
import plumeVertex from './shaders/plume.vert.glsl?raw';
import ringsFragment from './shaders/rings.frag.glsl?raw';
import waterFragment from './shaders/water.frag.glsl?raw';
import waterVertex from './shaders/water.vert.glsl?raw';

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

export const waterMaterial = (): THREE.ShaderMaterial =>
  layer(
    waterVertex,
    noise + waterFragment,
    {
      uCam: { value: new THREE.Vector2() },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uWorld: { value: 0 },
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
  layer(foodVertex, foodFragment, {
    uKind: { value: kind },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(color) },
  });

export const plumeMaterial = (): THREE.ShaderMaterial =>
  layer(plumeVertex, noise + plumeFragment, { uTime: { value: 0 } });

/** Pops and ripples reuse the plume's instanced-quad vertex shader; only the fragment differs. */
export const ringMaterial = (): THREE.ShaderMaterial =>
  layer(plumeVertex, ringsFragment, {}, { blending: THREE.AdditiveBlending });

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
}

export const particleMaterial = (style: ParticleStyle): THREE.ShaderMaterial =>
  layer(
    particlesVertex,
    particlesFragment,
    {
      uCam: { value: new THREE.Vector2() },
      uPeriod: { value: style.period },
      uParallax: { value: style.parallax },
      uTime: { value: 0 },
      uSize: { value: style.size },
      uPxPerWu: { value: 1 },
      uColor: { value: new THREE.Color(style.color) },
      uOpacity: { value: style.opacity },
      uBokeh: { value: style.bokeh },
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
