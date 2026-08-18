-- Multi-word search, matched per token instead of as one phrase.
--
-- Second bug found by using the app: "beauchamp robert" returned nothing, while
-- "beauchamp" returned the right customer. The haystack reads
-- "robert & linda beauchamp ...", so the literal phrase "beauchamp robert"
-- appears nowhere and the whole-string trigram score falls below threshold.
--
-- People type names in whatever order comes to mind - "robert beauchamp",
-- "beauchamp robert", "bob beauchamp colchester". So every token must match
-- SOMEWHERE in the record, independently, and order stops mattering. Requiring
-- all tokens (AND, not OR) is what keeps a two-word search from returning half
-- the database.

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
      -- exact account number always wins
      CASE WHEN t.qdigits <> '' AND c.account_number = t.qdigits THEN 1.0 ELSE 0 END,
      CASE WHEN c.account_number = t.q                          THEN 1.0 ELSE 0 END,
      -- full phone digits
      CASE WHEN t.is_numeric AND length(t.qdigits) >= 7
            AND c.search_text LIKE '%' || t.qdigits || '%'      THEN 0.9 ELSE 0 END,
      CASE WHEN t.is_numeric AND length(t.qdigits) >= 3
            AND c.search_text LIKE '%' || t.qdigits || '%'      THEN 0.7 ELSE 0 END,
      -- the whole query, in order: the strongest name signal
      CASE WHEN NOT t.is_numeric
            AND c.search_text LIKE t.q || '%'                   THEN 0.98 ELSE 0 END,
      CASE WHEN NOT t.is_numeric
            AND c.search_text LIKE '%' || t.q || '%'            THEN 0.92 ELSE 0 END,
      -- every token present, any order
      CASE WHEN NOT t.is_numeric AND cardinality(t.tokens) > 1
            AND (SELECT bool_and(c.search_text LIKE '%' || tok || '%')
                 FROM unnest(t.tokens) AS tok)                  THEN 0.85 ELSE 0 END,
      -- every token at least fuzzily present: the misspelling case
      CASE WHEN NOT t.is_numeric
            THEN COALESCE((SELECT min(word_similarity(tok, c.search_text))
                           FROM unnest(t.tokens) AS tok), 0)
            ELSE 0 END
    )::real AS score
  FROM customer c
  CROSS JOIN toks t
  LEFT JOIN address a ON a.id = c.billing_address_id
  WHERE t.q <> ''
    AND c.status <> 'merged'
    AND CASE
          WHEN t.is_numeric THEN
            -- identifiers: exact or substring, never approximate
            c.account_number = t.qdigits
            OR (length(t.qdigits) >= 3 AND c.search_text LIKE '%' || t.qdigits || '%')
          ELSE
            -- EVERY token must match somewhere, exactly or fuzzily. AND rather
            -- than OR: a second word should narrow the list, never widen it.
            (SELECT bool_and(
                      c.search_text LIKE '%' || tok || '%'
                      OR tok <% c.search_text)
             FROM unnest(t.tokens) AS tok)
        END
  ORDER BY score DESC, c.display_name
  LIMIT lim;
$$;
