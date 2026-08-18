-- The search function.
--
-- "Customer lookup requires exact information; want Google-like fuzzy search
-- and predictive typing." This function is that requirement, in one place.
--
-- Two things make it work:
--
--  1. word_similarity() rather than similarity(). similarity() compares the
--     query against the ENTIRE haystack, so a short query against a long
--     concatenated field always scores near zero. word_similarity() scores the
--     query against the best-matching extent inside the target, which is what
--     a person means when they type three letters of a surname.
--
--  2. A function-scoped threshold. 0.35 is loose enough to catch real
--     misspellings ("beuchamp" -> "Beauchamp") without returning the phone
--     book. Tune this ONE number if search feels too noisy or too strict;
--     it is attached to the function, so nothing else in the database shifts.

CREATE OR REPLACE FUNCTION search_customers(q text, lim int DEFAULT 20)
RETURNS TABLE (
  id             uuid,
  display_name   text,
  account_number text,
  primary_phone  text,
  primary_email  text,
  city           text,
  state          text,
  score          real
)
LANGUAGE sql
STABLE
SET pg_trgm.word_similarity_threshold = 0.35
AS $$
  WITH nq AS (
    SELECT
      -- strip LIKE wildcards so a typed '%' cannot turn into a table scan
      replace(replace(lower(unaccent(btrim(q))), '%', ''), '_', '') AS q,
      regexp_replace(q, '\D', '', 'g')                              AS qdigits
  )
  SELECT
    c.id,
    c.display_name,
    c.account_number,
    c.primary_phone,
    c.primary_email,
    a.city,
    a.state,
    GREATEST(
      -- exact account number: always the top hit, staff type these from memory
      CASE WHEN nq.qdigits <> '' AND c.account_number = nq.qdigits THEN 1.0 ELSE 0 END,
      -- name starts with what they typed: predictive-typing behaviour
      CASE WHEN c.search_text LIKE nq.q || '%'         THEN 0.95 ELSE 0 END,
      -- phone digits anywhere, formatting-independent
      CASE WHEN length(nq.qdigits) >= 7
            AND c.search_text LIKE '%' || nq.qdigits || '%' THEN 0.9 ELSE 0 END,
      -- plain substring
      CASE WHEN c.search_text LIKE '%' || nq.q || '%'  THEN 0.8 ELSE 0 END,
      -- fuzzy: the misspelling case
      word_similarity(nq.q, c.search_text)
    )::real AS score
  FROM customer c
  CROSS JOIN nq
  LEFT JOIN address a ON a.id = c.billing_address_id
  WHERE nq.q <> ''
    AND c.status <> 'merged'
    AND (
         nq.q <% c.search_text
      OR c.search_text LIKE '%' || nq.q || '%'
      OR (length(nq.qdigits) >= 4 AND c.search_text LIKE '%' || nq.qdigits || '%')
    )
  ORDER BY score DESC, c.display_name
  LIMIT lim;
$$;
--> statement-breakpoint

-- Search across properties too, for "who lives at 42 lakeview".
CREATE OR REPLACE FUNCTION search_properties(q text, lim int DEFAULT 20)
RETURNS TABLE (
  property_id   uuid,
  customer_id   uuid,
  display_name  text,
  label         text,
  line1         text,
  city          text,
  state         text,
  score         real
)
LANGUAGE sql
STABLE
SET pg_trgm.word_similarity_threshold = 0.35
AS $$
  WITH nq AS (
    SELECT replace(replace(lower(unaccent(btrim(q))), '%', ''), '_', '') AS q
  )
  SELECT
    p.id,
    c.id,
    c.display_name,
    p.label,
    a.line1,
    a.city,
    a.state,
    GREATEST(
      CASE WHEN a.search_text LIKE nq.q || '%'        THEN 0.95 ELSE 0 END,
      CASE WHEN a.search_text LIKE '%' || nq.q || '%' THEN 0.8  ELSE 0 END,
      word_similarity(nq.q, a.search_text)
    )::real AS score
  FROM property p
  JOIN customer c ON c.id = p.customer_id
  JOIN address  a ON a.id = p.address_id
  CROSS JOIN nq
  WHERE nq.q <> ''
    AND p.active
    AND (nq.q <% a.search_text OR a.search_text LIKE '%' || nq.q || '%')
  ORDER BY score DESC
  LIMIT lim;
$$;
