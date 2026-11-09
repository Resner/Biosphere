// A file imported as text through Vite (`?raw`), as the worker tests read docs/SECURITY.md.
declare module '*?raw' {
  const text: string;
  export default text;
}
