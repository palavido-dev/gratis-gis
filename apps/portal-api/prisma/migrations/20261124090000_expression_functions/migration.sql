-- Hand-written. Read helpers for the expression language's SQL
-- compiler (packages/shared-types/src/expr/sql.ts). Each one has a
-- JavaScript twin in packages/shared-types/src/expr/values.ts, and
-- expr-parity.pg.spec.ts runs both against the same inputs. Change
-- them together.
--
-- None of these raise: a value that does not read as the type
-- becomes NULL, so one bad row cannot fail a whole query.

-- A number, only when the whole text is one.
CREATE OR REPLACE FUNCTION gg_expr_num(value text)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value ~ '^-?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
      AND pg_input_is_valid(value, 'double precision')
    THEN value::double precision
  END
$$;

-- true/t/yes/y/1 and false/f/no/n/0, any case, trimmed.
CREATE OR REPLACE FUNCTION gg_expr_bool(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE lower(btrim(value))
    WHEN 'true' THEN TRUE WHEN 't' THEN TRUE WHEN 'yes' THEN TRUE
    WHEN 'y' THEN TRUE WHEN '1' THEN TRUE
    WHEN 'false' THEN FALSE WHEN 'f' THEN FALSE WHEN 'no' THEN FALSE
    WHEN 'n' THEN FALSE WHEN '0' THEN FALSE
  END
$$;

-- An ISO 8601 date or date-time. Text with no offset is UTC.
CREATE OR REPLACE FUNCTION gg_expr_ts(value text)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN v !~ '^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|z|[+-]\d{2}(:?\d{2})?)?$'
      THEN NULL
    WHEN v ~ '(Z|z|[+-]\d{2}(:?\d{2})?)$' AND v !~ '^\d{4}-\d{2}-\d{2}$'
      THEN CASE WHEN pg_input_is_valid(v, 'timestamptz') THEN v::timestamptz END
    ELSE CASE WHEN pg_input_is_valid(v, 'timestamp') THEN v::timestamp AT TIME ZONE 'UTC' END
  END
  FROM (SELECT btrim(value) AS v) s
$$;

-- A date as text: YYYY-MM-DD on UTC midnight, otherwise
-- YYYY-MM-DDTHH:MM:SSZ.
CREATE OR REPLACE FUNCTION gg_expr_ts_text(value timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN NULL
    WHEN (value AT TIME ZONE 'UTC')::time = '00:00'
      THEN to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    ELSE to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  END
$$;

-- A multi-select value as text[]. A plain string is a one-item list.
CREATE OR REPLACE FUNCTION gg_expr_list(value jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN value IS NULL THEN NULL ELSE CASE jsonb_typeof(value)
    WHEN 'array' THEN ARRAY(
      SELECT x FROM jsonb_array_elements_text(value) WITH ORDINALITY AS t(x, n)
      WHERE x IS NOT NULL ORDER BY n
    )
    WHEN 'string' THEN CASE WHEN value #>> '{}' = '' THEN '{}'::text[] ELSE ARRAY[value #>> '{}'] END
    WHEN 'null' THEN NULL
    ELSE ARRAY[value #>> '{}']
  END END
$$;

-- Whole calendar months from b to a; a month counts once it has
-- fully passed. Twin of monthDiff in expr/dates.ts.
CREATE OR REPLACE FUNCTION gg_expr_month_diff(a timestamptz, b timestamptz)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN m > 0 AND ta < tb THEN m - 1
    WHEN m < 0 AND ta > tb THEN m + 1
    ELSE m
  END
  FROM (
    SELECT
      ((extract(year from ua) * 12 + extract(month from ua))
        - (extract(year from ub) * 12 + extract(month from ub)))::int AS m,
      (extract(day from ua) * 86400 + extract(epoch from ua::time)) AS ta,
      (extract(day from ub) * 86400 + extract(epoch from ub::time)) AS tb
    FROM (SELECT a AT TIME ZONE 'UTC' AS ua, b AT TIME ZONE 'UTC' AS ub) u
  ) s
$$;
