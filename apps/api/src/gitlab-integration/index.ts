import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import * as v from "valibot";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import {
  createTokenConnection,
  deleteGitLabConnection,
  listConnectionProjects,
  listGitLabConnections,
  rotateTokenConnection,
} from "./connections";
import {
  attachGitLabRepository,
  detachGitLabRepository,
  listProjectGitLabRepositories,
} from "./repositories";

const connectionSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  name: v.string(),
  authType: v.string(),
  publicUrl: v.string(),
  status: v.string(),
  statusMessage: v.nullable(v.string()),
  credentialHint: v.nullable(v.string()),
  gitlabUsername: v.nullable(v.string()),
  expiresAt: v.nullable(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
  attachedRepositoryCount: v.number(),
});

const projectSchema = v.object({
  id: v.number(),
  name: v.string(),
  path_with_namespace: v.string(),
  web_url: v.string(),
  default_branch: v.nullable(v.string()),
  visibility: v.picklist(["private", "internal", "public"]),
  archived: v.boolean(),
  issues_enabled: v.boolean(),
  merge_requests_enabled: v.boolean(),
});

const repositorySchema = v.object({
  id: v.string(),
  integrationId: v.string(),
  connectionId: v.string(),
  providerRepositoryId: v.string(),
  fullPath: v.string(),
  webUrl: v.string(),
  defaultBranch: v.nullable(v.string()),
  webhookConfigured: v.boolean(),
  isActive: v.boolean(),
  createdAt: v.string(),
  updatedAt: v.string(),
});

const routeVariables = {
  Variables: {} as {
    userId: string;
    workspaceId: string;
    apiKey?: { id: string; userId: string; enabled: boolean };
  },
};

const gitlabIntegration = new Hono<typeof routeVariables>()
  .get(
    "/project/:projectId/repositories",
    describeRoute({
      operationId: "listProjectGitLabRepositories",
      tags: ["GitLab"],
      description: "List GitLab repositories attached to a Kaneo project",
      responses: {
        200: {
          description: "Attached GitLab repositories",
          content: {
            "application/json": {
              schema: resolver(
                v.object({ repositories: v.array(repositorySchema) }),
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      return c.json({
        repositories: await listProjectGitLabRepositories(projectId),
      });
    },
  )
  .post(
    "/project/:projectId/repositories",
    describeRoute({
      operationId: "attachGitLabRepository",
      tags: ["GitLab"],
      description:
        "Attach a GitLab project and provision its signed webhook automatically",
      responses: {
        201: {
          description: "GitLab repository attached",
          content: {
            "application/json": { schema: resolver(repositorySchema) },
          },
        },
      },
    }),
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        connectionId: v.string(),
        providerRepositoryId: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const repository = await attachGitLabRepository({
        projectId,
        ...c.req.valid("json"),
      });
      return c.json(repository, 201);
    },
  )
  .delete(
    "/project/:projectId/repositories/:repositoryId",
    describeRoute({
      operationId: "detachGitLabRepository",
      tags: ["GitLab"],
      description: "Remove a GitLab project webhook and detach its repository",
      responses: { 200: { description: "GitLab repository detached" } },
    }),
    validator(
      "param",
      v.object({ projectId: v.string(), repositoryId: v.string() }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const params = c.req.valid("param");
      await detachGitLabRepository(params);
      return c.json({ success: true });
    },
  )
  .get(
    "/workspace/:workspaceId/connections",
    describeRoute({
      operationId: "listGitLabConnections",
      tags: ["GitLab"],
      description: "List workspace GitLab connections without credentials",
      responses: {
        200: {
          description: "GitLab connections",
          content: {
            "application/json": {
              schema: resolver(
                v.object({ connections: v.array(connectionSchema) }),
              ),
            },
          },
        },
      },
    }),
    validator("param", v.object({ workspaceId: v.string() })),
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const workspaceId = c.get("workspaceId");
      return c.json({ connections: await listGitLabConnections(workspaceId) });
    },
  )
  .post(
    "/workspace/:workspaceId/connections/token",
    describeRoute({
      operationId: "createGitLabTokenConnection",
      tags: ["GitLab"],
      description: "Create and verify an encrypted GitLab token connection",
      responses: {
        201: {
          description: "GitLab connection created",
          content: {
            "application/json": { schema: resolver(connectionSchema) },
          },
        },
      },
    }),
    validator("param", v.object({ workspaceId: v.string() })),
    validator(
      "json",
      v.object({
        name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
        publicUrl: v.pipe(v.string(), v.url()),
        accessToken: v.pipe(v.string(), v.minLength(1)),
      }),
    ),
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const body = c.req.valid("json");
      const connection = await createTokenConnection({
        workspaceId: c.get("workspaceId"),
        ownerUserId: c.get("userId"),
        ...body,
      });
      return c.json(connection, 201);
    },
  )
  .put(
    "/workspace/:workspaceId/connections/:connectionId/token",
    describeRoute({
      operationId: "rotateGitLabTokenConnection",
      tags: ["GitLab"],
      description: "Verify and replace a GitLab connection token",
      responses: {
        200: {
          description: "GitLab token rotated",
          content: {
            "application/json": { schema: resolver(connectionSchema) },
          },
        },
      },
    }),
    validator(
      "param",
      v.object({ workspaceId: v.string(), connectionId: v.string() }),
    ),
    validator(
      "json",
      v.object({ accessToken: v.pipe(v.string(), v.minLength(1)) }),
    ),
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      return c.json(
        await rotateTokenConnection({
          workspaceId: c.get("workspaceId"),
          connectionId: params.connectionId,
          accessToken: body.accessToken,
        }),
      );
    },
  )
  .get(
    "/workspace/:workspaceId/connections/:connectionId/projects",
    describeRoute({
      operationId: "listGitLabConnectionProjects",
      tags: ["GitLab"],
      description:
        "List active GitLab projects where the connection has Maintainer access",
      responses: {
        200: {
          description: "Attachable GitLab projects",
          content: {
            "application/json": {
              schema: resolver(v.object({ projects: v.array(projectSchema) })),
            },
          },
        },
      },
    }),
    validator(
      "param",
      v.object({ workspaceId: v.string(), connectionId: v.string() }),
    ),
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const { connectionId } = c.req.valid("param");
      return c.json({
        projects: await listConnectionProjects(
          c.get("workspaceId"),
          connectionId,
        ),
      });
    },
  )
  .delete(
    "/workspace/:workspaceId/connections/:connectionId",
    describeRoute({
      operationId: "deleteGitLabConnection",
      tags: ["GitLab"],
      description: "Delete an unused GitLab connection",
      responses: { 200: { description: "GitLab connection deleted" } },
    }),
    validator(
      "param",
      v.object({ workspaceId: v.string(), connectionId: v.string() }),
    ),
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ workspace: ["manage_settings"] }),
    async (c) => {
      const { connectionId } = c.req.valid("param");
      await deleteGitLabConnection(c.get("workspaceId"), connectionId);
      return c.json({ success: true });
    },
  );

export default gitlabIntegration;
