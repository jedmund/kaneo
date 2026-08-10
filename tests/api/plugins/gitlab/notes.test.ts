import { describe, expect, it } from "vitest";
import {
  formatKaneoGeneratedGitLabNote,
  isKaneoGeneratedGitLabNote,
} from "../../../../apps/api/src/plugins/gitlab/notes";

describe("GitLab note origins", () => {
  it("marks only comments created by Kaneo", () => {
    const note = formatKaneoGeneratedGitLabNote("Status update");

    expect(note).toContain("Status update");
    expect(isKaneoGeneratedGitLabNote(note)).toBe(true);
    expect(isKaneoGeneratedGitLabNote("Manual status update")).toBe(false);
  });
});
