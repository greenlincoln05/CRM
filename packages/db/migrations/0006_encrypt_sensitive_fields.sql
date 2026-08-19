-- 0006 — Encrypt gate codes, log every reveal (ADR 0003).
--
-- Reconstructed 2026-08-18: the original file for this journal entry was never
-- pushed. Rebuilt from the schema (customer.ts, timeline.ts), the 0005
-- snapshot, and the call sites in transform.ts and the reveal route.
--
-- The plaintext column is DROPPED, not kept alongside the ciphertext. Any
-- value in it at migration time is lost by design — encryption happens in the
-- application so the key never reaches Postgres, which means SQL cannot
-- migrate the data. At the time this ran, only synthetic demo data existed;
-- the demo pipeline re-encrypts on the next run.

ALTER TABLE "property" ADD COLUMN "gate_code_enc" text;
--> statement-breakpoint

ALTER TABLE "property" DROP COLUMN "gate_code";
--> statement-breakpoint

-- Who looked at a gate code, and when. Not to catch anyone — to answer a
-- customer asking "who had our code" with something better than a shrug.
CREATE TABLE "sensitive_access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"actor_label" text,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"field" text NOT NULL,
	"reason" text,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint

ALTER TABLE "sensitive_access_log"
  ADD CONSTRAINT "sensitive_access_log_user_id_app_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "sensitive_access_entity_idx"
  ON "sensitive_access_log" ("entity", "entity_id", "occurred_at" DESC);
--> statement-breakpoint

CREATE INDEX "sensitive_access_user_idx"
  ON "sensitive_access_log" ("user_id", "occurred_at" DESC);
--> statement-breakpoint

-- An audit log that can be edited is not an audit log. Same pattern as
-- timeline_event in 0001, but stricter: NOTHING may change after insert.
CREATE OR REPLACE FUNCTION sensitive_access_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sensitive_access_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER sensitive_access_log_append_only_trg
  BEFORE UPDATE OR DELETE ON sensitive_access_log
  FOR EACH ROW EXECUTE FUNCTION sensitive_access_log_append_only();
