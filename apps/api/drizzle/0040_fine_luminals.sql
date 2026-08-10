CREATE TABLE "scm_oauth_state" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text,
	"connection_name" text NOT NULL,
	"code_verifier_ciphertext" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scm_oauth_state_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
ALTER TABLE "scm_oauth_state" ADD CONSTRAINT "scm_oauth_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "scm_oauth_state" ADD CONSTRAINT "scm_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "scm_oauth_state" ADD CONSTRAINT "scm_oauth_state_connection_id_scm_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."scm_connection"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "scm_oauth_state_workspaceId_idx" ON "scm_oauth_state" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "scm_oauth_state_userId_idx" ON "scm_oauth_state" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scm_oauth_state_connectionId_idx" ON "scm_oauth_state" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scm_oauth_state_expiresAt_idx" ON "scm_oauth_state" USING btree ("expires_at");