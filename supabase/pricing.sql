-- Model prices, USD per million tokens, standard tier.
-- Sources (checked 2026-10-28):
--   https://platform.claude.com/docs/en/about-claude/pricing
--   https://developers.openai.com/api/docs/pricing
--
-- Current prices apply to all history, including backfilled usage
-- (effective_from 2000-01-01). Past price changes are not tracked.
--
-- Size tiers (min_prompt_tokens = all input tokens, cached or not):
--   Claude Haiku 5.5: prompts over 100,000 tokens.
--   OpenAI: prompts over 272K ("Long context: >272K input tokens").
-- Cache writes: short = Claude 5m / OpenAI 30m, long = Claude 1h / OpenAI 12h.
-- Codex does not say which cache duration it writes; its cache writes are
-- priced at the short rate.
--
-- Claude Code usage exported over OTel carries its own reported cost; these
-- Claude rows price backfilled transcripts only.
--
-- codex-auto-review is free now (it used to be billed at gpt-5.6-luna rates).

insert into public.model_pricing
  (model, effective_from, min_prompt_tokens, input_rate, cached_input_rate, cache_write_short_rate, cache_write_long_rate, output_rate)
values
  ('claude-opus-5-5',   '2000-01-01', 0,      4.00,  0.20,  5.00,   8.00,  20.00),
  ('claude-opus-4-7',   '2000-01-01', 0,      5.00,  0.50,  6.25,  10.00,  25.00),
  ('claude-sonnet-5-5', '2000-01-01', 0,      2.00,  0.10,  2.50,   4.00,  10.00),
  ('claude-sonnet-5',   '2000-01-01', 0,      2.00,  0.20,  2.50,   4.00,  10.00),
  ('claude-haiku-5-5',  '2000-01-01', 0,      0.10,  0.01,  0.125,  0.20,   0.50),
  ('claude-haiku-5-5',  '2000-01-01', 100001, 0.50,  0.05,  0.625,  1.00,   2.50),

  ('gpt-6.1-sol',       '2000-01-01', 0,      2.00,  0.10,  2.50,   5.00,  10.00),
  ('gpt-6.1-sol',       '2000-01-01', 272001, 4.00,  0.20,  5.00,  10.00,  15.00),
  ('gpt-6-astra',       '2000-01-01', 0,     10.00,  1.00, 12.50,  25.00,  50.00),
  ('gpt-6-astra',       '2000-01-01', 272001, 20.00, 2.00, 25.00,  50.00,  75.00),
  ('gpt-6.1-terra',     '2000-01-01', 0,      1.00,  0.05,  1.25,   2.50,   5.00),
  ('gpt-6.1-terra',     '2000-01-01', 272001, 2.00,  0.10,  2.50,   5.00,   7.50),
  ('gpt-6-sol',         '2000-01-01', 0,      2.00,  0.20,  2.50,   5.00,  10.00),
  ('gpt-6-sol',         '2000-01-01', 272001, 4.00,  0.40,  5.00,  10.00,  15.00),
  ('gpt-6-luna',        '2000-01-01', 0,      0.10,  0.01,  0.125,  0.25,   0.50),
  ('gpt-6-luna',        '2000-01-01', 272001, 0.20,  0.02,  0.25,   0.50,   0.75),
  ('gpt-5.6-sol',       '2000-01-01', 0,      4.00,  0.40,  5.00,  10.00,  20.00),
  ('gpt-5.6-sol',       '2000-01-01', 272001, 8.00,  0.80, 10.00,  20.00,  30.00),
  ('gpt-5.6-terra',     '2000-01-01', 0,      2.00,  0.20,  2.50,   5.00,  12.00),
  ('gpt-5.6-terra',     '2000-01-01', 272001, 4.00,  0.40,  5.00,  10.00,  18.00),
  ('gpt-5.6-luna',      '2000-01-01', 0,      0.20,  0.02,  0.25,   0.50,   1.20),
  ('gpt-5.6-luna',      '2000-01-01', 272001, 0.40,  0.04,  0.50,   1.00,   1.80),
  ('codex-auto-review', '2000-01-01', 0,      0.00,  0.00,  0.00,   0.00,   0.00)
on conflict (model, effective_from, min_prompt_tokens) do update set
  input_rate = excluded.input_rate,
  cached_input_rate = excluded.cached_input_rate,
  cache_write_short_rate = excluded.cache_write_short_rate,
  cache_write_long_rate = excluded.cache_write_long_rate,
  output_rate = excluded.output_rate;
