-- Numeric queries must never match fuzzily.
--
-- Bug found by searching a real phone number through the app: "8025550142"
-- returned every customer in the database. Trigram similarity treats digit
-- strings as very alike - "8025550142" and "8025557700" share the trigrams
-- 802, 025, 255, 555 - so every Vermont number scored above threshold.
--
-- Fuzzy is right for names and wrong for identifiers. A phone number or account
-- number that is nearly correct belongs to a DIFFERENT customer, and showing it
-- as a match at a counter is how the wrong account gets charged.
--
-- So: if the query is only digits and phone punctuation, it is an identifier
-- lookup. Exact and substring matching only.

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
      replace(replace(lower(unaccent(btrim(q))), '%', ''), '_', '') AS q,
      regexp_replace(q, '\D', '', 'g')                              AS qdigits,
      -- digits, spaces, and the characters people type inside phone numbers
      (btrim(q) ~ '^[0-9()\-\.\s+]+$')                              AS is_numeric
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
      -- exact account number: staff type these from memory, always rank first
      CASE WHEN nq.qdigits <> '' AND c.account_number = nq.qdigits THEN 1.0 ELSE 0 END,
      CASE WHEN c.account_number = nq.q                            THEN 1.0 ELSE 0 END,
      -- full phone digits, formatting-independent
      CASE WHEN nq.is_numeric AND length(nq.qdigits) >= 7
            AND c.search_text LIKE '%' || nq.qdigits || '%'        THEN 0.9 ELSE 0 END,
      -- partial identifier: they typed the first few digits
      CASE WHEN nq.is_numeric AND length(nq.qdigits) >= 3
            AND c.search_text LIKE '%' || nq.qdigits || '%'        THEN 0.7 ELSE 0 END,
      -- name prefix: predictive-typing behaviour
      CASE WHEN NOT nq.is_numeric
            AND c.search_text LIKE nq.q || '%'                     THEN 0.95 ELSE 0 END,
      CASE WHEN NOT nq.is_numeric
            AND c.search_text LIKE '%' || nq.q || '%'              THEN 0.8 ELSE 0 END,
      -- fuzzy, names only
      CASE WHEN NOT nq.is_numeric
            THEN word_similarity(nq.q, c.search_text) ELSE 0 END
    )::real AS score
  FROM customer c
  CROSS JOIN nq
  LEFT JOIN address a ON a.id = c.billing_address_id
  WHERE nq.q <> ''
    AND c.status <> 'merged'
    AND CASE
          WHEN nq.is_numeric THEN
            -- identifiers: exact or substring, never approximate
            c.account_number = nq.qdigits
            OR (length(nq.qdigits) >= 3 AND c.search_text LIKE '%' || nq.qdigits || '%')
          ELSE
            nq.q <% c.search_text
            OR c.search_text LIKE '%' || nq.q || '%'
        END
  ORDER BY score DESC, c.display_name
  LIMIT lim;
$$;
