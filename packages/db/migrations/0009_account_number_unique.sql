-- One account number, one customer.
--
-- createCustomer checked for a clash with a SELECT before its INSERT, which is
-- a friendly message rather than a guarantee: two people creating the same
-- account number from two terminals both pass the check and both rows land.
--
-- That matters more here than the usual race, because search_customers scores
-- an exact account-number match at 1.0. Two customers sharing 14032 come back
-- tied at the top with nothing to tell them apart, and someone at the counter
-- charges whichever sorted first. It is the same class of failure as the
-- Sprint 1 phone-search bug: a near-miss identifier belongs to somebody else.
--
-- Partial, because most Evosus-era records and every walk-in created without
-- one have a NULL account number, and NULLs must stay unconstrained.
--
-- If this migration fails, the database already holds duplicates. Find them:
--
--   SELECT account_number, count(*), array_agg(display_name)
--     FROM customer WHERE account_number IS NOT NULL
--    GROUP BY account_number HAVING count(*) > 1;
--
-- Merge or renumber those records first - a duplicate account number is a data
-- quality defect worth seeing rather than a constraint worth relaxing.
CREATE UNIQUE INDEX customer_account_number_unique_idx
  ON customer (account_number)
  WHERE account_number IS NOT NULL;
