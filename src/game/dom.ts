/** The element for a selector; a missing one is a markup bug, so it throws. */
export function pick<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing element ${selector}`);
  return element;
}
