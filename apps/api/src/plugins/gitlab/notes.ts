const KANEO_GENERATED_NOTE_MARKER = "<!-- kaneo-generated-note -->";

export function formatKaneoGeneratedGitLabNote(body: string): string {
  return `${body}\n\n${KANEO_GENERATED_NOTE_MARKER}`;
}

export function isKaneoGeneratedGitLabNote(
  body: string | null | undefined,
): boolean {
  return body?.includes(KANEO_GENERATED_NOTE_MARKER) ?? false;
}
