import { describe, expect, it } from "vitest";
import {
  formatIssueBody,
  formatIssueTitle,
  formatSyncComment,
  formatTaskDescriptionFromIssue,
  getLabelsForIssue,
  hasScmSyncJobMarker,
} from "../../../../../apps/api/src/plugins/github/utils/format";

describe("github format helpers", () => {
  it("returns the title unchanged", () => {
    expect(formatIssueTitle("Ship notifications")).toBe("Ship notifications");
  });

  it("formats issue bodies with and without a description", () => {
    expect(formatIssueBody(null, "task_123")).toBe("<sub>Task: task_123</sub>");
    expect(formatIssueBody("Body text", "task_123")).toBe(`Body text

---
<sub>Task: task_123</sub>`);
  });

  it("formats sync comments and task descriptions", () => {
    expect(formatSyncComment("task_123")).toBe("Task: task_123");
    expect(formatTaskDescriptionFromIssue("Issue body")).toBe("Issue body");
    expect(formatTaskDescriptionFromIssue(null)).toBe("");
  });

  it("adds and recognizes a durable SCM sync job marker", () => {
    const body = formatIssueBody("Body text", "task_123", "sync_job_456");

    expect(body).toContain("<sub>Task: task_123</sub>");
    expect(body).toContain("<!-- kaneo-scm-sync-job: sync_job_456 -->");
    expect(hasScmSyncJobMarker(body, "sync_job_456")).toBe(true);
    expect(hasScmSyncJobMarker(body, "another_job")).toBe(false);
  });

  it("builds labels while skipping no-priority", () => {
    expect(getLabelsForIssue("high", "in-review")).toEqual([
      "priority:high",
      "status:in-review",
    ]);
    expect(getLabelsForIssue("no-priority", "done")).toEqual(["status:done"]);
    expect(getLabelsForIssue(null, "planned")).toEqual(["status:planned"]);
  });
});
