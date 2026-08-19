-- Encrypt the fields that open customers' gates. ADR 0003.
--
-- This is the gate that had to close before a technician app exists. Phones get
-- lost in truck beds and left on patios; the moment gate codes leave the office
-- they need to be unreadable without a key the database does not hold.
--
-- Encryption is done in the application (packages/db/src/crypto.ts), so the key
-- never reaches Postgres as a query parameter and never lands in a query log.
-- The column holds ciphertext and nothing else.

-- Ciphertext replaces plaintext. The old column is dropped rather than kept
-- "just in case" - a plaintext copy nobody remembers is exactly the problem.
ALTER TABLE property ADD COLUMN IF NOT EXISTS gate_code_enc text;
--> statement-breakpoint

ALTER TABLE property DROP COLUMN IF EXISTS gate_code;
--> statement-breakpoint

COMMENT ON COLUMN property.gate_code_enc IS
  'AES-256-GCM ciphertext. Decrypt only via decryptField(). Never log, never export, never put in an AI context window.';
--> statement-breakpoint

/*
 * Every reveal is recorded.
 *
 * Not to catch anyone - to answer "who had this code" when a customer calls
 * about a break-in, and to make the honest answer available instead of a shrug.
 * Append-only, like the timeline.
 */
CREATE TABLE IF NOT EXISTS sensitive_access_log (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  user_id      uuid REFERENCES app_user(id),
  actor_label  text,
  entity       text NOT NULL,
  entity_id    uuid,
  field        text NOT NULL,
  reason       text,
  ip           text,
  user_agent   text
);
--> statement-breakpoint

CREATE INDEX sensitive_access_entity_idx ON sensitive_access_log (entity, entity_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX sensitive_access_user_idx ON sensitive_access_log (user_id, occurred_at DESC);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION sensitive_access_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sensitive_access_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER sensitive_access_log_append_only_trg
  BEFORE UPDATE OR DELETE ON sensitive_access_log
  FOR EACH ROW EXECUTE FUNCTION sensitive_access_log_append_only();
