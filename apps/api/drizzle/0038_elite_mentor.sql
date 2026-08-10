CREATE TABLE "integration_repository" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"connection_id" text,
	"provider" text NOT NULL,
	"remote_origin" text NOT NULL,
	"provider_repository_id" text NOT NULL,
	"full_path" text NOT NULL,
	"web_url" text NOT NULL,
	"default_branch" text,
	"webhook_id" text,
	"webhook_secret_ciphertext" text,
	"metadata" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_repository_remote_unique" UNIQUE("provider","remote_origin","provider_repository_id"),
	CONSTRAINT "integration_repository_integration_path_unique" UNIQUE("integration_id","full_path")
);
--> statement-breakpoint
CREATE TABLE "scm_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"auth_type" text NOT NULL,
	"public_url" text NOT NULL,
	"internal_url" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"owner_user_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"status_message" text,
	"expires_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scm_connection_workspace_provider_name_unique" UNIQUE("workspace_id","provider","name")
);
--> statement-breakpoint
CREATE TABLE "scm_sync_job" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"integration_repository_id" text NOT NULL,
	"operation" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scm_sync_job_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "external_link" ADD COLUMN "integration_repository_id" text;--> statement-breakpoint
-- Preserve each existing single-repository GitHub/Gitea integration as the
-- first repository attached to its provider anchor. Provider IDs were not
-- stored historically, so the normalized full path is the stable fallback.
INSERT INTO "integration_repository" (
	"id",
	"integration_id",
	"provider",
	"remote_origin",
	"provider_repository_id",
	"full_path",
	"web_url",
	"metadata",
	"is_active",
	"created_at",
	"updated_at"
)
SELECT
	'legacy_' || md5(i."id" || ':' || i."type" || ':' || lower((i."config"::jsonb ->> 'repositoryOwner') || '/' || (i."config"::jsonb ->> 'repositoryName'))),
	i."id",
	i."type",
	CASE
		WHEN i."type" = 'github' THEN 'https://github.com'
		ELSE rtrim(i."config"::jsonb ->> 'baseUrl', '/')
	END,
	COALESCE(
		i."config"::jsonb ->> 'repositoryId',
		lower((i."config"::jsonb ->> 'repositoryOwner') || '/' || (i."config"::jsonb ->> 'repositoryName'))
	),
	(i."config"::jsonb ->> 'repositoryOwner') || '/' || (i."config"::jsonb ->> 'repositoryName'),
	CASE
		WHEN i."type" = 'github' THEN 'https://github.com/' || (i."config"::jsonb ->> 'repositoryOwner') || '/' || (i."config"::jsonb ->> 'repositoryName')
		ELSE rtrim(i."config"::jsonb ->> 'baseUrl', '/') || '/' || (i."config"::jsonb ->> 'repositoryOwner') || '/' || (i."config"::jsonb ->> 'repositoryName')
	END,
	jsonb_build_object('legacyConfig', true),
	COALESCE(i."is_active", true),
	i."created_at",
	i."updated_at"
FROM "integration" i
WHERE i."type" IN ('github', 'gitea')
	AND nullif(i."config"::jsonb ->> 'repositoryOwner', '') IS NOT NULL
	AND nullif(i."config"::jsonb ->> 'repositoryName', '') IS NOT NULL
	AND (
		i."type" = 'github'
		OR nullif(i."config"::jsonb ->> 'baseUrl', '') IS NOT NULL
	)
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "external_link" link
SET "integration_repository_id" = repository."id"
FROM "integration_repository" repository
WHERE link."integration_id" = repository."integration_id"
	AND link."integration_repository_id" IS NULL;--> statement-breakpoint
-- The legacy schema allowed more than one task link for the same remote
-- resource. Once those rows are assigned to a repository they would violate
-- the repository-scoped unique constraint below. Keep the oldest link as the
-- canonical mapping and remove only its later conflicts.
WITH "ranked_external_links" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "integration_repository_id", "resource_type", "external_id"
			ORDER BY "created_at" ASC, "id" ASC
		) AS "duplicate_rank"
	FROM "external_link"
	WHERE "integration_repository_id" IS NOT NULL
)
DELETE FROM "external_link" link
USING "ranked_external_links" ranked
WHERE link."id" = ranked."id"
	AND ranked."duplicate_rank" > 1;--> statement-breakpoint
ALTER TABLE "integration_repository" ADD CONSTRAINT "integration_repository_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "integration_repository" ADD CONSTRAINT "integration_repository_connection_id_scm_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."scm_connection"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "scm_connection" ADD CONSTRAINT "scm_connection_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "scm_connection" ADD CONSTRAINT "scm_connection_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "scm_sync_job" ADD CONSTRAINT "scm_sync_job_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "scm_sync_job" ADD CONSTRAINT "scm_sync_job_integration_repository_id_integration_repository_id_fk" FOREIGN KEY ("integration_repository_id") REFERENCES "public"."integration_repository"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "integration_repository_integrationId_idx" ON "integration_repository" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "integration_repository_connectionId_idx" ON "integration_repository" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "integration_repository_provider_idx" ON "integration_repository" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "scm_connection_workspaceId_idx" ON "scm_connection" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "scm_connection_provider_idx" ON "scm_connection" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "scm_connection_ownerUserId_idx" ON "scm_connection" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "scm_sync_job_taskId_idx" ON "scm_sync_job" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "scm_sync_job_repositoryId_idx" ON "scm_sync_job" USING btree ("integration_repository_id");--> statement-breakpoint
CREATE INDEX "scm_sync_job_status_nextAttemptAt_idx" ON "scm_sync_job" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "external_link" ADD CONSTRAINT "external_link_integration_repository_id_integration_repository_id_fk" FOREIGN KEY ("integration_repository_id") REFERENCES "public"."integration_repository"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "external_link_integrationRepositoryId_idx" ON "external_link" USING btree ("integration_repository_id");--> statement-breakpoint
ALTER TABLE "external_link" ADD CONSTRAINT "external_link_repository_resource_external_unique" UNIQUE("integration_repository_id","resource_type","external_id");
