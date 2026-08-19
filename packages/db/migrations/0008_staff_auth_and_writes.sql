-- Staff authentication, and the tightening a write path requires. Sprint 2.
--
-- Sprint 1 shipped a read-only app, so every row in the database arrived
-- through the ETL and carried its Evosus provenance. Sprint 2 lets staff type
-- into it. Two things follow from that, and both are here:
--
--   1. Every write needs a name attached to it. ADR 0003 made real identity a
--      hard gate on the technician app; it is equally a gate on letting anyone
--      edit a customer record, because "who changed this" is the first question
--      asked when a record turns out to be wrong.
--
--   2. The append-only trigger was written when nothing but the ETL could issue
--      an UPDATE. It now has to hold against a UI.
--
-- The DDL below is generated from the schema; the triggers and comments after
-- it are hand-written, because that is the half the schema DSL cannot express.

-- == Sessions ==============================================================
-- A table rather than a self-contained signed cookie, because the realistic
-- failure here is not a forged token: it is the shop laptop that went home in
-- somebody's bag, or the seasonal hire who finished in October. Both need a
-- sign-out that works without the browser's cooperation, and that needs
-- server-side state.
--
-- The cookie carries a random token; this table stores only its SHA-256, so a
-- stolen backup contains no usable session.
CREATE TABLE "app_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint

-- == Credentials on the staff record =======================================
-- app_user was always the local mirror of an identity provider we have not
-- bought yet (ADR 0005). These columns are the interim credential, shaped so
-- that dropping them later removes the interim scheme without touching
-- anything that references a user.
--
-- The email index becomes unique on lower(email), because email is now the
-- login and "DGreen@" must not become a second account beside "dgreen@".
DROP INDEX "app_user_email_idx";--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "pin_hash" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "pin_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint

-- == Redaction gets a reason and a name ====================================
-- redacted_at already existed as the sanctioned alternative to DELETE. Hiding
-- something from the feed without recording who hid it or why is the same trust
-- problem the append-only rule exists to prevent, one level up.
ALTER TABLE "timeline_event" ADD COLUMN "redacted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD COLUMN "redacted_reason" text;--> statement-breakpoint

ALTER TABLE "app_session" ADD CONSTRAINT "app_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_session_token_idx" ON "app_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "app_session_user_idx" ON "app_session" USING btree ("user_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_redacted_by_user_id_app_user_id_fk" FOREIGN KEY ("redacted_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_idx" ON "app_user" USING btree (lower("email"));--> statement-breakpoint

-- == Everything below is hand-written ======================================

COMMENT ON COLUMN app_user.pin_hash IS
  'scrypt hash of the counter PIN. Never a plaintext PIN, never anything reversible.';
--> statement-breakpoint

-- Expiry sweeps read this constantly and only ever care about live sessions.
CREATE INDEX app_session_expiry_idx ON app_session (expires_at) WHERE revoked_at IS NULL;
--> statement-breakpoint

CREATE TRIGGER app_user_touch_trg BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER water_test_touch_trg BEFORE UPDATE ON water_test
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

-- == Append-only, tightened ================================================
-- The original trigger froze id, customer_id, occurred_at, kind, title and
-- body. That was the whole attack surface when only the ETL could write.
--
-- With a UI in front of it, everything that gives an event its meaning has to
-- be frozen too: an event whose payload, actor or source can be rewritten after
-- the fact is exactly as untrustworthy as one whose body can. The rule staff
-- are told is "corrections are new rows", and that is now literally true --
-- pinned and the three redaction columns are the only things that may change.
CREATE OR REPLACE FUNCTION timeline_event_append_only() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'timeline_event is append-only: use redacted_at instead of DELETE';
  END IF;

  IF NEW.id             IS DISTINCT FROM OLD.id
  OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id
  OR NEW.property_id    IS DISTINCT FROM OLD.property_id
  OR NEW.occurred_at    IS DISTINCT FROM OLD.occurred_at
  OR NEW.kind           IS DISTINCT FROM OLD.kind
  OR NEW.source         IS DISTINCT FROM OLD.source
  OR NEW.direction      IS DISTINCT FROM OLD.direction
  OR NEW.actor_user_id  IS DISTINCT FROM OLD.actor_user_id
  OR NEW.actor_label    IS DISTINCT FROM OLD.actor_label
  OR NEW.title          IS DISTINCT FROM OLD.title
  OR NEW.body           IS DISTINCT FROM OLD.body
  OR NEW.ref_type       IS DISTINCT FROM OLD.ref_type
  OR NEW.ref_id         IS DISTINCT FROM OLD.ref_id
  OR NEW.payload        IS DISTINCT FROM OLD.payload
  OR NEW.legacy_source  IS DISTINCT FROM OLD.legacy_source
  OR NEW.legacy_id      IS DISTINCT FROM OLD.legacy_id
  OR NEW.created_at     IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'timeline_event is append-only: only pinned and redaction may change. Record a correction as a new event.';
  END IF;

  -- Un-redacting is allowed, because a mistaken redaction should not be
  -- permanent. But while a redaction is in force, its reason and its author
  -- cannot be quietly rewritten.
  IF NEW.redacted_at IS NOT NULL
     AND OLD.redacted_at IS NOT NULL
     AND (NEW.redacted_by_user_id IS DISTINCT FROM OLD.redacted_by_user_id
          OR NEW.redacted_reason  IS DISTINCT FROM OLD.redacted_reason) THEN
    RAISE EXCEPTION 'timeline_event: a redaction in force cannot have its reason or author rewritten';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- == Water tests are append-only too =======================================
-- A chemistry reading is an observation of a moment. Correcting one by editing
-- it destroys both the seasonal trend the table exists to support and the
-- record of what the customer was actually told to buy. Notes and
-- recommendation stay editable, because those are advice, not measurement.
CREATE OR REPLACE FUNCTION water_test_readings_immutable() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'water_test is append-only: a reading that was taken was taken';
  END IF;

  IF NEW.tested_at        IS DISTINCT FROM OLD.tested_at
  OR NEW.customer_id      IS DISTINCT FROM OLD.customer_id
  OR NEW.free_chlorine    IS DISTINCT FROM OLD.free_chlorine
  OR NEW.total_chlorine   IS DISTINCT FROM OLD.total_chlorine
  OR NEW.ph               IS DISTINCT FROM OLD.ph
  OR NEW.total_alkalinity IS DISTINCT FROM OLD.total_alkalinity
  OR NEW.calcium_hardness IS DISTINCT FROM OLD.calcium_hardness
  OR NEW.cyanuric_acid    IS DISTINCT FROM OLD.cyanuric_acid
  OR NEW.salt             IS DISTINCT FROM OLD.salt
  OR NEW.phosphates       IS DISTINCT FROM OLD.phosphates
  OR NEW.temperature_f    IS DISTINCT FROM OLD.temperature_f THEN
    RAISE EXCEPTION 'water_test readings are immutable: record a new test rather than editing this one';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER water_test_immutable_trg BEFORE UPDATE OR DELETE ON water_test
  FOR EACH ROW EXECUTE FUNCTION water_test_readings_immutable();
