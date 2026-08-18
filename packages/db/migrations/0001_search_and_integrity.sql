-- Search, integrity, and maintenance.
--
-- Everything here is hand-written rather than generated: trigram indexes,
-- generated columns, and triggers are outside what the schema DSL expresses,
-- and they are the parts that make the "Google-like search" requirement real.

-- ── Extensions ────────────────────────────────────────────────────────────
-- pg_trgm  : fuzzy matching, so "beuchamp" finds "Beauchamp"
-- unaccent : so "Lelievre" finds "Lelièvre" (Vermont has a lot of these)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint

-- ── Customer search ───────────────────────────────────────────────────────
-- One denormalized haystack per customer. Rebuilt by trigger, never written
-- by application code. Includes the Evosus account number because staff will
-- keep searching by it for years.
ALTER TABLE customer
  ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION customer_refresh_denorm() RETURNS trigger AS $$
BEGIN
  NEW.display_name := NULLIF(
    btrim(
      COALESCE(NEW.company_name, '') || ' ' ||
      CASE WHEN NEW.company_name IS NOT NULL
                AND (NEW.first_name IS NOT NULL OR NEW.last_name IS NOT NULL)
           THEN '(' || btrim(COALESCE(NEW.first_name,'') || ' ' || COALESCE(NEW.last_name,'')) || ')'
           ELSE btrim(COALESCE(NEW.first_name,'') || ' ' || COALESCE(NEW.last_name,''))
      END
    ), '');

  -- Fall back so a record is never nameless and therefore unfindable.
  IF NEW.display_name IS NULL OR NEW.display_name = '' THEN
    NEW.display_name := COALESCE(
      NEW.primary_email,
      NEW.primary_phone,
      'Account ' || COALESCE(NEW.account_number, left(NEW.id::text, 8))
    );
  END IF;

  NEW.search_text := lower(unaccent(btrim(
    COALESCE(NEW.display_name, '')     || ' ' ||
    COALESCE(NEW.company_name, '')     || ' ' ||
    COALESCE(NEW.first_name, '')       || ' ' ||
    COALESCE(NEW.last_name, '')        || ' ' ||
    COALESCE(NEW.account_number, '')   || ' ' ||
    COALESCE(NEW.primary_email, '')    || ' ' ||
    -- digits only, so (802) 555-1234 matches a search for 8025551234
    COALESCE(regexp_replace(NEW.primary_phone, '\D', '', 'g'), '')
  )));

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER customer_denorm_trg
  BEFORE INSERT OR UPDATE ON customer
  FOR EACH ROW EXECUTE FUNCTION customer_refresh_denorm();
--> statement-breakpoint

-- GIN + trigram: the index that makes misspelled, partial, out-of-order
-- searches fast enough to run on every keystroke.
CREATE INDEX customer_search_trgm_idx ON customer USING gin (search_text gin_trgm_ops);
--> statement-breakpoint

-- Address search, for "who lives at 42 lakeview" lookups.
ALTER TABLE address
  ADD COLUMN IF NOT EXISTS search_text text
  GENERATED ALWAYS AS (
    lower(
      COALESCE(line1,'') || ' ' || COALESCE(line2,'') || ' ' ||
      COALESCE(city,'')  || ' ' || COALESCE(state,'') || ' ' ||
      COALESCE(postal_code,'')
    )
  ) STORED;
--> statement-breakpoint

CREATE INDEX address_search_trgm_idx ON address USING gin (search_text gin_trgm_ops);
--> statement-breakpoint

-- Timeline body search, for "find the call where we discussed the liner".
CREATE INDEX timeline_body_trgm_idx ON timeline_event
  USING gin ((COALESCE(title,'') || ' ' || COALESCE(body,'')) gin_trgm_ops);
--> statement-breakpoint

-- ── Timeline is append-only ───────────────────────────────────────────────
-- A feed people trust is a feed nobody can quietly rewrite. Only the two
-- presentation flags may change after insert; corrections are new rows.
CREATE OR REPLACE FUNCTION timeline_event_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'timeline_event is append-only: use redacted_at instead of DELETE';
  END IF;

  IF NEW.id             IS DISTINCT FROM OLD.id
  OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id
  OR NEW.occurred_at    IS DISTINCT FROM OLD.occurred_at
  OR NEW.kind           IS DISTINCT FROM OLD.kind
  OR NEW.body           IS DISTINCT FROM OLD.body
  OR NEW.title          IS DISTINCT FROM OLD.title THEN
    RAISE EXCEPTION 'timeline_event is append-only: only pinned and redacted_at may change';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER timeline_event_append_only_trg
  BEFORE UPDATE OR DELETE ON timeline_event
  FOR EACH ROW EXECUTE FUNCTION timeline_event_append_only();
--> statement-breakpoint

-- ── updated_at maintenance ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER contact_touch_trg BEFORE UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER property_touch_trg BEFORE UPDATE ON property
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER address_touch_trg BEFORE UPDATE ON address
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER property_equipment_touch_trg BEFORE UPDATE ON property_equipment
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
--> statement-breakpoint

-- ── Migration integrity ───────────────────────────────────────────────────
-- Re-running an import must never duplicate a record. These partial unique
-- indexes are what make the ETL safe to run as many times as it takes.
CREATE UNIQUE INDEX contact_legacy_key_idx ON contact (legacy_source, legacy_id)
  WHERE legacy_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX property_legacy_key_idx ON property (legacy_source, legacy_id)
  WHERE legacy_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX timeline_legacy_key_idx ON timeline_event (legacy_source, legacy_id)
  WHERE legacy_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX address_legacy_key_idx ON address (legacy_source, legacy_id)
  WHERE legacy_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX property_equipment_legacy_key_idx ON property_equipment (legacy_source, legacy_id)
  WHERE legacy_id IS NOT NULL;
--> statement-breakpoint

-- Exactly one primary contact and one primary property per customer.
CREATE UNIQUE INDEX contact_one_primary_idx ON contact (customer_id)
  WHERE is_primary;
--> statement-breakpoint
CREATE UNIQUE INDEX property_one_primary_idx ON property (customer_id)
  WHERE is_primary;
