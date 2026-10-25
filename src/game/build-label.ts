/** The label shown in the page corner: the release tag, or `dev` for local and PR builds. */
export function formatBuildLabel(raw: string): string {
  const label = raw.trim();
  return label === '' ? 'dev' : label;
}
