import { describe, expect, it } from "vitest";
import { gitLabImportLabels } from "../../../../apps/api/src/gitlab-integration/imports";
import { stripKaneoTaskMarker } from "../../../../apps/api/src/plugins/gitlab/webhook-events";

describe("GitLab imports", () => {
  it("keeps external labels and resolves their project colors", () => {
    expect(
      gitLabImportLabels(
        {
          labels: ["priority:high", "status:in-review", "backend", "ux"],
        },
        [
          { id: 1, name: "backend", color: "#123456" },
          { id: 2, name: "ux", color: "ABCDEF" },
        ],
      ),
    ).toEqual([
      { name: "backend", color: "#123456" },
      { name: "ux", color: "#ABCDEF" },
    ]);
  });

  it("uses a stable fallback for inherited labels without color metadata", () => {
    expect(gitLabImportLabels({ labels: ["inherited"] }, [])).toEqual([
      { name: "inherited", color: "#6B7280" },
    ]);
  });

  it("removes Kaneo's outbound marker without changing issue content", () => {
    expect(
      stripKaneoTaskMarker("Issue details\n\n---\n<sub>Task: KAN-42</sub>"),
    ).toBe("Issue details");
    expect(stripKaneoTaskMarker("Issue details")).toBe("Issue details");
  });
});
