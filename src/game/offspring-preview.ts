// A flat silhouette of a body for the offspring card (M5 T11): the plan's segments drawn side-on on a
// 2D canvas, so the card needs no second WebGL context. It shows the shape and size, not the shading.

import type { Body } from './body';

/** Fills `canvas` with the body's outline, scaled to fit with a small margin. */
export function drawPreview(canvas: HTMLCanvasElement, body: Body): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const { segments } = body.creature.plan;
  if (segments.length === 0) return;
  let [minX, maxX, maxY] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0];
  for (const s of segments) {
    minX = Math.min(minX, s.x - s.rx);
    maxX = Math.max(maxX, s.x + s.rx);
    maxY = Math.max(maxY, s.ry);
  }
  const margin = 6;
  const scale = Math.min(
    (width - 2 * margin) / (maxX - minX || 1),
    (height - 2 * margin) / (2 * maxY || 1),
  );
  const cx = width / 2 - ((minX + maxX) / 2) * scale;
  ctx.fillStyle = 'rgb(160 215 235 / 0.35)';
  ctx.strokeStyle = 'rgb(200 240 255 / 0.9)';
  ctx.lineWidth = 1.5;
  for (const s of segments) {
    ctx.beginPath();
    ctx.ellipse(
      cx + s.x * scale,
      height / 2,
      Math.max(1, s.rx * scale),
      Math.max(1, s.ry * scale),
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.stroke();
  }
}
