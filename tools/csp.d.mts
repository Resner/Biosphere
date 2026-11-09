export const CSP_PLACEHOLDER: string;
export const CSP_PAGES: readonly ['index.html', 'lab.html', 'card.html'];
export function authorityOrigins(url: string): string[];
export function cspPolicy(authorityUrl: string): string;
export function withCsp(html: string, policy: string): string;
