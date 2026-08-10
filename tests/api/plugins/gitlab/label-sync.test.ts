import { describe, expect, it } from "vitest";
import { toGitLabLabelColor } from "../../../../apps/api/src/plugins/gitlab/utils/sync-label-to-gitlab";

describe("GitLab label sync", () => {
  it("normalizes Kaneo named, short, and full colors for GitLab", () => {
    expect(toGitLabLabelColor("rose")).toBe("#F43F5E");
    expect(toGitLabLabelColor("#abc")).toBe("#AABBCC");
    expect(toGitLabLabelColor("123def")).toBe("#123DEF");
    expect(toGitLabLabelColor("not-a-color")).toBe("#6B7280");
  });
});
