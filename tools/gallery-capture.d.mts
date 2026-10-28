import type { Page } from '@playwright/test';

export const GALLERY_PATH: string;
export const GALLERY_VIEWPORT: { width: number; height: number };
export function chromiumPath(expected: string): string | undefined;
export function captureGallery(page: Page, baseURL: string): Promise<Buffer>;
export function parseGalleryArgs(argv: readonly string[]): { pass: number; build: boolean };
