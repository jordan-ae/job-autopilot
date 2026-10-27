/** Collapse whitespace and trim. */
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}
