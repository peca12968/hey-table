WITH settled AS (
    SELECT order_id, currency, SUM(amount_minor) AS received
    FROM postings
    GROUP BY order_id, currency
),
keys AS (
    SELECT order_id, currency FROM orders
    UNION
    SELECT order_id, currency FROM settled
)
SELECT k.order_id, k.currency, o.amount_minor, s.received,
    CASE
        WHEN o.order_id IS NULL THEN 'orphan_posting'
        WHEN s.order_id IS NULL THEN 'missing_posting'
        WHEN o.amount_minor <> s.received THEN 'amount_mismatch'
        ELSE 'matched'
    END AS state
FROM keys k
LEFT JOIN orders o USING (order_id, currency)
LEFT JOIN settled s USING (order_id, currency)
ORDER BY k.currency, k.order_id;
