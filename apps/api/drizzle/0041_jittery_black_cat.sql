ALTER TABLE "scm_oauth_state" DROP CONSTRAINT "scm_oauth_state_connection_id_scm_connection_id_fk";
--> statement-breakpoint
ALTER TABLE "scm_oauth_state" ADD CONSTRAINT "scm_oauth_state_connection_id_scm_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."scm_connection"("id") ON DELETE cascade ON UPDATE cascade;