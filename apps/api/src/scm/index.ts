import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { listProjectRepositories } from "./repositories";

const projectRepositorySchema = v.object({
  id: v.string(),
  integrationId: v.string(),
  connectionId: v.nullable(v.string()),
  projectId: v.string(),
  provider: v.string(),
  providerRepositoryId: v.string(),
  fullPath: v.string(),
  webUrl: v.string(),
  defaultBranch: v.nullable(v.string()),
  isActive: v.boolean(),
});

const scm = new Hono<{
  Variables: { userId: string; workspaceId: string };
}>().get(
  "/repositories/project/:projectId",
  describeRoute({
    operationId: "listProjectRepositories",
    tags: ["SCM"],
    description: "List active source repositories attached to a project",
    responses: {
      200: {
        description: "Attached repositories",
        content: {
          "application/json": {
            schema: resolver(v.array(projectRepositorySchema)),
          },
        },
      },
    },
  }),
  validator("param", v.object({ projectId: v.string() })),
  workspaceAccess.fromProject("projectId"),
  async (c) => {
    const { projectId } = c.req.valid("param");
    return c.json(await listProjectRepositories(projectId));
  },
);

export default scm;
