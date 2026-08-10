CREATE TABLE "scm_webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_repository_id" text NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event_name" text NOT NULL,
	"body_sha256" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"last_error" text,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "scm_webhook_delivery_repository_delivery_unique" UNIQUE("integration_repository_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "scm_webhook_delivery" ADD CONSTRAINT "scm_webhook_delivery_integration_repository_id_integration_repository_id_fk" FOREIGN KEY ("integration_repository_id") REFERENCES "public"."integration_repository"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "scm_webhook_delivery_repositoryId_idx" ON "scm_webhook_delivery" USING btree ("integration_repository_id");--> statement-breakpoint
CREATE INDEX "scm_webhook_delivery_status_receivedAt_idx" ON "scm_webhook_delivery" USING btree ("status","received_at");