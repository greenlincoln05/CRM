-- Addresses belong in the search haystack.
--
-- Third bug found by using the app: "whitcomb colchester" returned nothing.
-- customer.search_text held names, phone, email, and account number - but no
-- address. Meanwhile the search box invites you to type one, and staff narrow
-- by town constantly, because half of Chittenden County shares a surname.
--
-- The haystack is assembled at query time from the customer, the billing
-- address, and every service property address, rather than denormalized onto
-- customer.search_text. Keeping a copy in sync would mean triggers on address
-- and property firing back into customer, and at a few thousand customers the
-- join costs less than the complexity. Revisit if this ever reaches six figures.

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
      (btrim(q) ~ '^[0-9()\-\.\s+]+$')                              AS is_numeric
  ),
  toks AS (
    SELECT nq.*,
           ARRAY(SELECT t FROM unnest(string_to_array(nq.q, ' ')) AS t WHERE t <> '') AS tokens
    FROM nq
  ),
  -- Every service address a customer has, in one pass.
  prop_addr AS (
    SELECT p.customer_id, string_agg(DISTINCT ad.search_text, ' ') AS txt
    FROM property p
    JOIN address ad ON ad.id = p.address_id
    WHERE p.active
    GROUP BY p.customer_id
  ),
  hay AS (
    SELECT
      c.id, c.display_name, c.account_number, c.primary_phone, c.primary_email,
      c.status, a.city, a.state,
      lower(unaccent(
        c.search_text
        || ' ' || COALESCE(a.search_text, '')
        || ' ' || COALESCE(pa.txt, '')
      )) AS haystack
    FROM customer c
    LEFT JOIN address a   ON a.id = c.billing_address_id
    LEFT JOIN prop_addr pa ON pa.customer_id = c.id
  )
  SELECT
    h.id, h.display_name, h.account_number, h.primary_phone, h.primary_email,
    h.city, h.state,
    GREATEST(
      -- exact account number always wins
      CASE WHEN t.qdigits <> '' AND h.account_number = t.qdigits THEN 1.0 ELSE 0 END,
      CASE WHEN h.account_number = t.q                          THEN 1.0 ELSE 0 END,
      -- full phone digits
      CASE WHEN t.is_numeric AND length(t.qdigits) >= 7
            AND h.haystack LIKE '%' || t.qdigits || '%'         THEN 0.9 ELSE 0 END,
      CASE WHEN t.is_numeric AND length(t.qdigits) >= 3
            AND h.haystack LIKE '%' || t.qdigits || '%'         THEN 0.7 ELSE 0 END,
      -- whole query in order: the strongest name signal
      CASE WHEN NOT t.is_numeric
            AND h.haystack LIKE t.q || '%'                      THEN 0.98 ELSE 0 END,
      CASE WHEN NOT t.is_numeric
            AND h.haystack LIKE '%' || t.q || '%'               THEN 0.92 ELSE 0 END,
      -- every token present, any order
      CASE WHEN NOT t.is_numeric AND cardinality(t.tokens) > 1
            AND (SELECT bool_and(h.haystack LIKE '%' || tok || '%')
                 FROM unnest(t.tokens) AS tok)                  THEN 0.85 ELSE 0 END,
      -- every token at least fuzzily present: the misspelling case
      CASE WHEN NOT t.is_numeric
            THEN COALESCE((SELECT min(word_similarity(tok, h.haystack))
                           FROM unnest(t.tokens) AS tok), 0)
            ELSE 0 END
    )::real AS score
  FROM hay h
  CROSS JOIN toks t
  WHERE t.q <> ''
    AND h.status <> 'merged'
    AND CASE
          WHEN t.is_numeric THEN
            -- identifiers: exact or substring, never approximate
            h.account_number = t.qdigits
            OR (length(t.qdigits) >= 3 AND h.haystack LIKE '%' || t.qdigits || '%')
          ELSE
            -- EVERY token must match somewhere. AND rather than OR: a second
            -- word should narrow the list, never widen it.
            (SELECT bool_and(
                      h.haystack LIKE '%' || tok || '%'
                      OR tok <% h.haystack)
             FROM unnest(t.tokens) AS tok)
        END
  ORDER BY score DESC, h.display_name
  LIMIT lim;
$$;
