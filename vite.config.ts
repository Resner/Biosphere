import { defineConfig } from 'vite';
import { cspPolicy, withCsp } from './tools/csp';

export default defineConfig({
  // Relative asset URLs work both at the Pages path (/Biosphere/) and at the preview root.
  base: './',
  // Every page's Content-Security-Policy (M14 T16), for the authority this build names.
  plugins: [
    {
      name: 'biosphere-csp',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => withCsp(html, cspPolicy(process.env.AUTHORITY_URL ?? '')),
      },
    },
  ],
  define: {
    __BUILD_LABEL__: JSON.stringify(process.env.BUILD_LABEL ?? ''),
    __AUTHORITY_URL__: JSON.stringify(process.env.AUTHORITY_URL ?? ''),
  },
  build: {
    sourcemap: true,
    // The game, the Creature Lab (M3 T13) and the creature card (M9 T12) are three pages of one build.
    rolldownOptions: {
      input: { main: 'index.html', lab: 'lab.html', card: 'card.html' },
    },
    // three.js alone is about 540 kB minified; warn when the app grows well beyond it.
    chunkSizeWarningLimit: 900,
  },
});
