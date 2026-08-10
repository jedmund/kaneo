import { describe, expect, it } from "vitest";
import {
  extractGitLabTaskNumber,
  extractKaneoTaskId,
  gitLabObjectKind,
  stripKaneoTaskMarker,
} from "../../../../apps/api/src/plugins/gitlab/webhook-events";

describe("GitLab webhook routing", () => {
  it("finds a Kaneo identifier in a branch, MR title, or MR description", () => {
    expect(extractGitLabTaskNumber("KAN", "kan-42-add-login")).toBe(42);
    expect(extractGitLabTaskNumber("KAN", "feature", "Fix KAN-73 now")).toBe(
      73,
    );
    expect(
      extractGitLabTaskNumber(
        "KAN",
        "feature",
        "Unrelated title",
        "Resolves KAN-91",
      ),
    ).toBe(91);
  });

  it("does not confuse other project slugs or number prefixes", () => {
    expect(extractGitLabTaskNumber("KAN", "other-42")).toBeNull();
    expect(extractGitLabTaskNumber("KAN", "kan-42x")).toBe(42);
    expect(extractGitLabTaskNumber("KAN", "kan-420", "KAN-42")).toBe(420);
  });

  it("reads only a string object kind", () => {
    expect(gitLabObjectKind({ object_kind: "merge_request" })).toBe(
      "merge_request",
    );
    expect(gitLabObjectKind({ object_kind: 1 })).toBeNull();
    expect(gitLabObjectKind(null)).toBeNull();
  });

  it("extracts and strips Kaneo task and sync markers", () => {
    const description = `Issue description

---
<sub>Task: task_123</sub>
<!-- kaneo-scm-sync-job: sync_job_456 -->`;

    expect(extractKaneoTaskId(description)).toBe("task_123");
    expect(stripKaneoTaskMarker(description)).toBe("Issue description");
    expect(
      stripKaneoTaskMarker(
        "<sub>Task: task_123</sub>\n<!-- kaneo-scm-sync-job: sync_job_456 -->",
      ),
    ).toBe("");
  });
});
