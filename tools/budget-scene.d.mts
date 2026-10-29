import type { Page } from '@playwright/test';
import type { RenderInfo } from '../src/render/scene';

export type BudgetScene = 'empty' | 'crowded' | 'abyss';
export const BUDGET_VIEWPORT: { width: number; height: number };
export const BUDGET_SCENES: readonly BudgetScene[];
export const CROWD: number;
export function galleryGenomes(): string[];
export function budgetCast(genomes?: readonly string[]): { player: string; crowd: string[] };
export function frames(page: Page, count?: number, timeout?: number): Promise<void>;
export function openBudgetGame(
  page: Page,
  baseURL: string,
  preset: 'low' | 'medium' | 'high',
  player: string,
): Promise<void>;
export function stageScene(page: Page, scene: BudgetScene, crowd: readonly string[]): Promise<RenderInfo>;
