// codetel dashboard: signs in with an email link, loads daily usage through
// the usage_daily and usage_hourly RPCs, hourly prompt counts through
// prompt_hourly, and the latest rows of usage_with_cost (all RLS-protected),
// and renders tiles, a chart, a calendar of your prompts, weekday and
// hour-of-day charts, and tables.

const { supabaseUrl, supabaseKey } = window.CODETEL_CONFIG;
const db = window.supabase.createClient(supabaseUrl, supabaseKey);

const TOOL_NAMES = { claude_code: "Claude Code", codex: "Codex" };
// Claude Code is orange, Codex green. By model, each tool's models get that
// tool's color family (warm for Claude, greens for Codex): three colors each,
// the rest fold into "Other <tool> models".
const TOOL_COLORS = { claude_code: "--series-2", codex: "--series-3" };
const FAMILY = { claude_code: "--claude-", codex: "--codex-" };
const FAMILY_SIZE = 3;
const TOOL_ORDER = { claude_code: 0, codex: 1 };
const PAGE = 1000;

const state = {
  rows: [], // all-time daily rows from usage_daily
  hourly: [], // all-time (day, hour) rows from usage_hourly
  latest: [], // the 10 most recent requests
  prompts: [], // all-time (day, hour, tool) counts of your prompts from prompt_hourly
  calOpen: false, // calendar's weekday and hour-of-day breakdown shown
  days: 30,
  group: "tool",
  metric: "cost", // "cost" or "tokens"
  breakdown: null, // open tile breakdown: "cost", "requests", "input", "output"
  modelSeries: new Map(), // model -> { key, label, color, order }, fixed by all-time cost
  charts: {},
};

const $ = (id) => document.getElementById(id);

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("codetel-prefs") ?? "{}");
    if (Number.isInteger(p.days)) state.days = p.days;
    if (p.group === "tool" || p.group === "model") state.group = p.group;
    if (p.metric === "cost" || p.metric === "tokens") state.metric = p.metric;
  } catch { /* storage unavailable */ }
}

function savePrefs() {
  try {
    localStorage.setItem("codetel-prefs", JSON.stringify({
      days: state.days,
      group: state.group,
      metric: state.metric,
    }));
  } catch { /* storage unavailable */ }
}

// ---------- formatting ----------

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();
const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function usd(v) {
  if (v === 0) return "$0.00";
  if (Math.abs(v) < 0.01) return "$" + v.toFixed(4);
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(v);
}

function localDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- data ----------

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchAll(fn) {
  const to = new Date(Date.now() + 864e5).toISOString();
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .rpc(fn, { p_from: "2000-01-01T00:00:00Z", p_to: to, p_tz: TZ })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function fetchRows() {
  return (await fetchAll("usage_daily")).map((r) => ({
    day: r.day,
    tool: r.tool,
    model: r.model,
    requests: Number(r.requests),
    input: Number(r.input_tokens),
    cached: Number(r.cached_input_tokens),
    cacheWrite: Number(r.cache_write_tokens),
    output: Number(r.output_tokens),
    reasoning: Number(r.reasoning_output_tokens),
    cost: Number(r.cost_usd),
    unpriced: Number(r.unpriced_requests),
    inputCost: Number(r.input_cost_usd),
    cachedCost: Number(r.cache_read_cost_usd),
    cacheWriteCost: Number(r.cache_write_cost_usd),
    outputCost: Number(r.output_cost_usd),
  }));
}

async function fetchPrompts() {
  return (await fetchAll("prompt_hourly")).map((r) => ({
    day: r.day,
    hour: Number(r.hour),
    tool: r.tool,
    prompts: Number(r.prompts),
  }));
}

async function fetchHourly() {
  return (await fetchAll("usage_hourly")).map((r) => ({
    day: r.day,
    hour: Number(r.hour),
    requests: Number(r.requests),
    tokens: Number(r.tokens),
    cost: Number(r.cost_usd),
  }));
}

async function fetchLatest() {
  const { data, error } = await db
    .from("usage_with_cost")
    .select("occurred_at, tool, model, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, estimated_cost_usd")
    .order("occurred_at", { ascending: false })
    .limit(10);
  if (error) throw error;
  return data;
}

// Colors follow the entity: models are ranked once within their tool by
// all-time cost (then tokens), so changing the range never repaints a model.
function assignModelSeries(rows) {
  const totals = new Map();
  for (const r of rows) {
    const t = totals.get(r.model) ?? { tool: r.tool, cost: 0, tokens: 0 };
    t.cost += r.cost;
    t.tokens += r.input + r.cached + r.cacheWrite + r.output;
    totals.set(r.model, t);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
  const rank = {};
  state.modelSeries = new Map();
  for (const [model, { tool }] of ranked) {
    const i = (rank[tool] = (rank[tool] ?? -1) + 1);
    const base = (TOOL_ORDER[tool] ?? 2) * 10;
    state.modelSeries.set(model, i < FAMILY_SIZE && FAMILY[tool]
      ? { key: model, label: model, color: FAMILY[tool] + (i + 1), order: base + i }
      : { key: "__other_" + tool, label: `Other ${TOOL_NAMES[tool] ?? tool} models`, color: "--series-other", order: base + 9, other: true });
  }
}

function seriesOf(row) {
  if (state.group === "tool") {
    return { key: row.tool, label: TOOL_NAMES[row.tool] ?? row.tool, color: TOOL_COLORS[row.tool] ?? "--series-other", order: TOOL_ORDER[row.tool] ?? 9 };
  }
  return state.modelSeries.get(row.model);
}

function seriesColor(name) {
  return cssVar(name);
}

function rangeDays() {
  const today = new Date();
  let start;
  if (state.days > 0) {
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (state.days - 1));
  } else {
    const first = state.rows.map((r) => r.day).sort()[0];
    start = first ? new Date(first + "T00:00:00") : today;
  }
  const days = [];
  for (let d = start; localDay(d) <= localDay(today); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    days.push(localDay(d));
  }
  return days;
}

// ---------- rendering ----------

function render() {
  const days = rangeDays();
  const inRange = state.rows.filter((r) => r.day >= days[0] && r.day <= days[days.length - 1]);

  for (const b of $("range").querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.days) === state.days));
  for (const b of $("group").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.group === state.group));
  for (const b of $("metric").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.metric === state.metric));

  renderTiles(inRange);
  renderBreakdown(inRange);
  renderUnpriced(inRange);
  const series = buildSeries(inRange, days);
  const tokens = state.metric === "tokens";
  const title = tokens ? "Tokens per day" : "Estimated cost per day";
  $("chart-title").textContent = title;
  $("usage-chart").setAttribute("aria-label", title);
  $("chart-info").hidden = !tokens;
  renderChart("usage-chart", days, series, tokens ? (s) => s.tokens : (s) => s.cost, tokens ? (v) => compact.format(v) : usd);
  renderCalendar();
  renderPromptPatterns();
  renderPatterns(days);
  renderTable(inRange);
  renderLatest();
  $("status").textContent = state.rows.length === 0
    ? "No usage recorded yet, or this account is not allowed to read it."
    : "";
}

function renderTiles(rows) {
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const cost = sum((r) => r.cost);
  const requests = sum((r) => r.requests);
  const uncached = sum((r) => r.input);
  const cached = sum((r) => r.cached);
  const cacheWrite = sum((r) => r.cacheWrite);
  const input = uncached + cached + cacheWrite;
  const output = sum((r) => r.output);
  $("kpi-cost").textContent = usd(cost);
  $("kpi-requests").textContent = whole.format(requests);
  $("kpi-input").textContent = compact.format(input);
  $("kpi-input-note").textContent = input ? `${Math.round((cached / input) * 100)}% cache reads` : "";
  $("kpi-output").textContent = compact.format(output);
}

// Cost and requests: a pie split by tool or model (the "Group by" switch).
// Input and output: one full-width bar per tool or model, sliced by token type,
// in tokens or in cost (the Cost / Tokens switch).
const reasoningShare = (r) => (r.output ? r.reasoning / r.output : 0);
const BREAKDOWNS = {
  cost: { title: "Estimated cost", fmt: (v) => usd(v), pick: (r) => r.cost },
  requests: { title: "Requests", fmt: (v) => whole.format(v), pick: (r) => r.requests },
  input: { title: "Input", types: [
    { label: "Cache reads", color: "--series-1", tokens: (r) => r.cached, cost: (r) => r.cachedCost },
    { label: "Uncached input", color: "--series-5", tokens: (r) => r.input, cost: (r) => r.inputCost },
    { label: "Cache writes", color: "--series-7", tokens: (r) => r.cacheWrite, cost: (r) => r.cacheWriteCost },
  ] },
  // Claude Code does not report reasoning separately, so its output stays whole.
  // Reasoning is billed as output, so its cost is its share of the output cost.
  output: { title: "Output", types: [
    { label: "Response", color: "--series-1",
      tokens: (r) => (r.tool === "claude_code" ? 0 : r.output - r.reasoning),
      cost: (r) => (r.tool === "claude_code" ? 0 : r.outputCost * (1 - reasoningShare(r))) },
    { label: "Reasoning", color: "--series-5",
      tokens: (r) => (r.tool === "claude_code" ? 0 : r.reasoning),
      cost: (r) => (r.tool === "claude_code" ? 0 : r.outputCost * reasoningShare(r)) },
    { label: "Not split (Claude)", color: "--series-other",
      tokens: (r) => (r.tool === "claude_code" ? r.output : 0),
      cost: (r) => (r.tool === "claude_code" ? r.outputCost : 0) },
  ] },
};

function share(v, total) {
  return total ? `${((v / total) * 100).toFixed(v / total < 0.1 ? 1 : 0)}%` : "";
}

// Groups rows by tool or model; largest first, "Other ... models" last.
function groupSeries(rows, pick) {
  const groups = new Map();
  for (const r of rows) {
    const s = seriesOf(r);
    const e = groups.get(s.key) ?? { label: s.label, color: s.color, other: s.other, rows: [], value: 0 };
    e.rows.push(r);
    e.value += pick(r);
    groups.set(s.key, e);
  }
  return [...groups.values()]
    .filter((x) => x.value > 0)
    .sort((x, y) => !!x.other - !!y.other || y.value - x.value);
}

function renderBreakdown(rows) {
  for (const t of document.querySelectorAll(".tile[data-kpi]")) {
    t.setAttribute("aria-expanded", String(t.dataset.kpi === state.breakdown));
  }
  $("breakdown").hidden = !state.breakdown;
  const b = BREAKDOWNS[state.breakdown];
  if (!b?.types) {
    state.charts.breakdown?.destroy();
    delete state.charts.breakdown;
  }
  if (!b) return;
  const by = state.group === "tool" ? "tool" : "model";
  const what = b.types ? `${b.title} ${state.metric === "tokens" ? "tokens" : "cost"} by type and` : `${b.title} by`;
  $("bd-title").textContent = `${what} ${by}, ${rangeLabel()}`;
  $("bd-pie-view").hidden = !!b.types;
  $("bd-bar-view").hidden = !b.types;
  if (b.types) renderSlicedBars(rows, b);
  else renderPie(rows, b);
}

function renderPie(rows, b) {
  const slices = groupSeries(rows, b.pick);
  const total = slices.reduce((s, x) => s + x.value, 0);

  const body = $("bd-rows");
  body.replaceChildren();
  for (const x of slices) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = seriesColor(x.color);
    name.append(sw, x.label);
    const val = document.createElement("td");
    val.className = "num";
    val.textContent = b.fmt(x.value);
    const p = document.createElement("td");
    p.className = "num pct";
    p.textContent = share(x.value, total);
    tr.append(name, val, p);
    body.append(tr);
  }
  if (!slices.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "muted";
    td.textContent = "Nothing in this range.";
    tr.append(td);
    body.append(tr);
  }

  const config = {
    type: "doughnut",
    data: {
      labels: slices.map((x) => x.label),
      datasets: [{
        data: slices.map((x) => x.value),
        backgroundColor: slices.map((x) => seriesColor(x.color)),
        hoverBackgroundColor: slices.map((x) => seriesColor(x.color)),
        borderColor: cssVar("--surface"),
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: "55%",
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => ` ${b.fmt(item.raw)} (${share(item.raw, total)})` } },
      },
    },
  };
  $("bd-chart").setAttribute("aria-label", $("bd-title").textContent);
  state.charts.breakdown?.destroy();
  state.charts.breakdown = new Chart($("bd-chart"), config);
}

// Every bar is full width, so the bars compare the mix of token types, not size;
// the row total sits beside each bar.
function renderSlicedBars(rows, b) {
  const tokens = state.metric === "tokens";
  const picks = b.types.map((t) => (tokens ? t.tokens : t.cost));
  const fmt = tokens ? (v) => compact.format(v) : usd;
  const sumTypes = (rs) => picks.map((pick) => rs.reduce((s, r) => s + pick(r), 0));
  const groups = groupSeries(rows, (r) => picks.reduce((s, pick) => s + pick(r), 0));
  const lines = [{ label: "Total", total: true, parts: sumTypes(rows) }, ...groups.map((g) => ({ ...g, parts: sumTypes(g.rows) }))];
  const used = b.types.map((_, i) => lines[0].parts[i] > 0);
  state.bdLines = lines;
  state.bdTypes = b.types;
  state.bdFmt = tokens ? (v) => `${whole.format(v)} tokens` : usd;

  const legend = $("bd-legend");
  legend.replaceChildren();
  b.types.forEach((t, i) => {
    if (!used[i]) return;
    const item = document.createElement("span");
    const sw = document.createElement("i");
    sw.style.background = seriesColor(t.color);
    item.append(sw, `${t.label} ${share(lines[0].parts[i], lines[0].parts.reduce((a, c) => a + c, 0))}`);
    legend.append(item);
  });

  const list = $("bd-bars");
  list.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Nothing in this range.";
    list.append(empty);
    return;
  }
  lines.forEach((line, li) => {
    const total = line.parts.reduce((a, c) => a + c, 0);
    const row = document.createElement("div");
    row.className = line.total ? "bd-line bd-total" : "bd-line";
    const name = document.createElement("div");
    name.className = "bd-name";
    if (!line.total) {
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = seriesColor(line.color);
      name.append(sw);
    }
    name.append(line.label);
    name.title = line.label;
    const val = document.createElement("div");
    val.className = "bd-val";
    val.textContent = fmt(total);
    const bar = document.createElement("div");
    bar.className = "bd-bar";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${line.label}: ` + b.types
      .map((t, i) => (line.parts[i] ? `${t.label} ${share(line.parts[i], total)}` : null))
      .filter(Boolean).join(", "));
    b.types.forEach((t, i) => {
      if (!line.parts[i]) return;
      const seg = document.createElement("span");
      seg.className = "bd-seg";
      seg.style.flexGrow = String((line.parts[i] / total) * 100);
      seg.style.background = seriesColor(t.color);
      seg.dataset.line = String(li);
      seg.dataset.type = String(i);
      bar.append(seg);
    });
    row.append(name, bar, val);
    list.append(row);
  });
}

function rangeLabel() {
  return state.days > 0 ? `last ${state.days} days` : "all time";
}

function renderUnpriced(rows) {
  const models = [...new Set(rows.filter((r) => r.unpriced > 0).map((r) => r.model))].sort();
  const el = $("unpriced");
  el.hidden = models.length === 0;
  el.textContent = models.length
    ? `Incomplete pricing: no price for ${models.join(", ")}. Their tokens are counted but their cost is not included.`
    : "";
}

function buildSeries(rows, days) {
  const index = new Map(days.map((d, i) => [d, i]));
  const series = new Map();
  for (const r of rows) {
    const s = seriesOf(r);
    let entry = series.get(s.key);
    if (!entry) {
      entry = { ...s, cost: days.map(() => 0), tokens: days.map(() => 0), total: 0 };
      series.set(s.key, entry);
    }
    const i = index.get(r.day);
    entry.cost[i] += r.cost;
    entry.tokens[i] += r.input + r.cached + r.cacheWrite + r.output;
    entry.total += r.cost;
  }
  return [...series.values()].sort((a, b) => a.order - b.order);
}

function renderChart(canvasId, days, series, pick, fmt) {
  const surface = cssVar("--surface");
  const ink = cssVar("--text-secondary");
  const grid = cssVar("--grid");
  const datasets = series.map((s, i) => ({
    label: s.label,
    data: pick(s),
    backgroundColor: seriesColor(s.color),
    hoverBackgroundColor: seriesColor(s.color),
    // A surface-colored top edge leaves a 2px gap between stacked segments.
    borderColor: surface,
    borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
    borderSkipped: "start",
    // Round only the topmost nonzero segment of each day's stack.
    borderRadius: (ctx) =>
      series.slice(i + 1).every((above) => pick(above)[ctx.dataIndex] === 0) ? { topLeft: 4, topRight: 4 } : 0,
    maxBarThickness: 24,
    stack: "s",
  }));
  const labels = days.map((d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const config = {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: cssVar("--axis") }, ticks: { color: ink, maxRotation: 0, autoSkipPadding: 12 } },
        y: { stacked: true, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: ink, callback: (v) => fmt(v) } },
      },
      plugins: {
        legend: {
          display: series.length > 1,
          position: "top",
          align: "start",
          labels: { color: cssVar("--text-primary"), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 },
        },
        tooltip: {
          filter: (item) => item.raw !== 0,
          itemSort: (a, b) => b.raw - a.raw,
          callbacks: {
            label: (item) => ` ${item.dataset.label}: ${fmt(item.raw)}`,
            footer: (items) => (items.length > 1 ? `Total: ${fmt(items.reduce((s, i) => s + i.raw, 0))}` : ""),
          },
        },
      },
    },
  };
  state.charts.usage?.destroy();
  state.charts.usage = new Chart($(canvasId), config);
}

// ---------- activity patterns ----------

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday first, as Date.getDay() numbers
const weekdayName = (dow, style) =>
  new Date(2024, 0, 7 + dow).toLocaleDateString(undefined, { weekday: style }); // 2024-01-07 is a Sunday
const hour12 = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle?.startsWith("h1");

function hourLabel(h) {
  if (!hour12) return String(h);
  return `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
}

function hourSpan(h) {
  const fmt = (x) => new Date(2024, 0, 1, x).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${fmt(h)}–${fmt((h + 1) % 24)}`;
}

const argmax = (a) => a.reduce((best, v, i) => (v > a[best] ? i : best), 0);

// Four shades by quartile of the nonzero values, as on GitHub.
function levelOf(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  const t = nz.length ? [q(0.25), q(0.5), q(0.75)] : [];
  return (v) => (v <= 0 ? 0 : v <= t[0] ? 1 : v <= t[1] ? 2 : v <= t[2] ? 3 : 4);
}

function metricPick() {
  return state.metric === "tokens" ? (c) => c.tokens : (c) => c.cost;
}

function metricName() {
  return state.metric === "tokens" ? "Tokens" : "Estimated cost";
}

function metricFmt() {
  return state.metric === "tokens" ? (v) => compact.format(v) : usd;
}

const plural = (n, word) => `${whole.format(n)} ${word}${n === 1 ? "" : "s"}`;

function cellTip(head, c) {
  const lines = c.total
    ? Object.entries(TOOL_NAMES).filter(([t]) => c[t]).map(([t, name]) => `${name}: ${whole.format(c[t])}`)
    : [];
  return { head, lines: [plural(c.total, "prompt"), ...(lines.length > 1 ? lines : [])], note: "" };
}

// GitHub-style calendar of your prompts over the last year, one square per
// local day; ignores the range filter and the Cost / Tokens switch.
function renderCalendar() {
  const pick = (c) => c.total;
  const byDay = new Map();
  for (const r of state.prompts) {
    const c = byDay.get(r.day) ?? { total: 0 };
    c.total += r.prompts;
    c[r.tool] = (c[r.tool] ?? 0) + r.prompts;
    byDay.set(r.day, c);
  }
  const { today, yearAgo } = calendarWindow();
  const start = new Date(yearAgo.getFullYear(), yearAgo.getMonth(), yearAgo.getDate() - ((yearAgo.getDay() + 6) % 7));
  const days = [];
  for (let d = start; d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d);
  const empty = { total: 0 };
  const level = levelOf(days.map((d) => pick(byDay.get(localDay(d)) ?? empty)));

  const grid = $("calendar");
  grid.replaceChildren();
  // Square cells sized to fill the card, with a floor; narrow screens scroll.
  const weeks = Math.ceil(days.length / 7);
  const size = Math.max(10, Math.min(18, Math.floor(($("cal-wrap").clientWidth - 36) / weeks) - 3));
  grid.style.gridTemplateColumns = `32px repeat(${weeks}, ${size}px)`;
  grid.style.gridTemplateRows = `auto repeat(7, ${size}px)`;
  const place = (el, row, col) => {
    el.style.gridRow = String(row);
    el.style.gridColumn = String(col);
    grid.append(el);
  };
  // Weekday labels (Mon, Wed, Fri) in a column that stays put while it scrolls.
  for (let i = -1; i < 7; i++) {
    const el = document.createElement("div");
    el.className = "cal-day";
    el.textContent = [0, 2, 4].includes(i) ? weekdayName(i + 1, "short") : "";
    place(el, i + 2, 1);
  }
  state.calCells = new Map();
  let total = 0, active = 0;
  days.forEach((d, i) => {
    const week = Math.floor(i / 7);
    const key = localDay(d);
    if (d.getDate() <= 7 && i % 7 === 0) {
      const m = document.createElement("div");
      m.className = "cal-month";
      m.textContent = d.toLocaleDateString(undefined, { month: "short" });
      place(m, 1, week + 2);
    }
    const c = byDay.get(key) ?? empty;
    const v = pick(c);
    if (d >= yearAgo) {
      total += v;
      if (v > 0) active++;
    }
    const el = document.createElement("div");
    el.className = `cal-cell cal-${level(v)}`;
    el.dataset.day = key;
    state.calCells.set(key, c);
    place(el, (i % 7) + 2, week + 2);
  });
  grid.setAttribute("aria-label", "Your prompts per day over the last 12 months");
  $("cal-sub").textContent = "Prompts you sent per day, in Claude Code and Codex.";
  $("cal-summary").textContent = `${plural(total, "prompt")} in total, ${plural(active, "active day")}.`;
  const wrap = $("cal-wrap");
  wrap.scrollLeft = wrap.scrollWidth;
}

// The calendar's 12 months: from a year ago tomorrow through today, local time.
function calendarWindow() {
  const today = new Date();
  return { today, yearAgo: new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1) };
}

// Your prompts per day on average by weekday and by hour over the calendar's
// 12 months, shown under the calendar when its heading is pressed.
function renderPromptPatterns() {
  $("cal-toggle").setAttribute("aria-expanded", String(state.calOpen));
  $("cal-patterns").hidden = !state.calOpen;
  if (!state.calOpen) return;
  const { today, yearAgo } = calendarWindow();
  const first = localDay(yearAgo), last = localDay(today);
  const dowCount = Array(7).fill(0);
  let nDays = 0;
  for (let d = yearAgo; d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    dowCount[d.getDay()]++;
    nDays++;
  }
  const byDow = Array(7).fill(0), byHour = Array(24).fill(0);
  for (const r of state.prompts) {
    if (r.day < first || r.day > last) continue;
    byDow[new Date(r.day + "T00:00:00").getDay()] += r.prompts;
    byHour[r.hour] += r.prompts;
  }
  const dowAvg = WEEKDAYS.map((dow) => byDow[dow] / Math.max(1, dowCount[dow]));
  const hourAvg = byHour.map((n) => n / nDays);
  const any = dowAvg.some((v) => v > 0);
  const tip = (v) => [` ${oneDecimal.format(v)} prompts per day`];
  $("cal-hour-sub").textContent = `Prompts per day on average, last 12 months, ${TZ} time.`;
  renderBars("cal-dow", "cal-dow-chart", {
    labels: WEEKDAYS.map((d) => weekdayName(d, "short")), values: dowAvg, peak: any ? argmax(dowAvg) : -1,
    fmt: compact.format, label: "Prompts", aria: "Your prompts per day on average, by weekday",
    title: (i) => weekdayName(WEEKDAYS[i], "long"), tip: (i) => tip(dowAvg[i]),
  });
  renderBars("cal-hour", "cal-hour-chart", {
    labels: Array.from({ length: 24 }, (_, h) => hourLabel(h)), values: hourAvg, peak: any ? argmax(hourAvg) : -1,
    fmt: compact.format, label: "Prompts", aria: "Your prompts per day on average, by hour of day",
    title: (i) => hourSpan(i), tip: (i) => tip(hourAvg[i]),
  });
}

// Average per day by weekday and by hour, from the hourly rows in range.
// Weekdays are averaged over how often each occurs in the range.
function renderPatterns(days) {
  const pick = metricPick();
  const fmt = metricFmt();
  const zero = () => ({ requests: 0, tokens: 0, cost: 0 });
  const byDow = Array.from({ length: 7 }, zero);
  const byHour = Array.from({ length: 24 }, zero);
  const first = days[0], last = days[days.length - 1];
  for (const r of state.hourly) {
    if (r.day < first || r.day > last) continue;
    for (const c of [byDow[new Date(r.day + "T00:00:00").getDay()], byHour[r.hour]]) {
      c.requests += r.requests;
      c.tokens += r.tokens;
      c.cost += r.cost;
    }
  }
  const dowCount = Array(7).fill(0);
  for (const d of days) dowCount[new Date(d + "T00:00:00").getDay()]++;
  const avg = (c, n) => ({ requests: c.requests / n, tokens: c.tokens / n, cost: c.cost / n });
  const dowAvg = WEEKDAYS.map((dow) => avg(byDow[dow], Math.max(1, dowCount[dow])));
  const hourAvg = byHour.map((c) => avg(c, days.length));

  const any = dowAvg.some((c) => pick(c) > 0);
  const peakDow = argmax(dowAvg.map(pick)), peakHour = argmax(hourAvg.map(pick));
  const per = `${metricName()} per day on average, ${rangeLabel()}`;
  $("dow-sub").textContent = `${per}.`;
  $("hour-sub").textContent = `${per}, ${TZ} time.`;

  const tip = (c) => [` ${fmt(pick(c))} per day`, ` ${whole.format(Math.round(c.requests))} requests per day`];
  const aria = (by) => `${metricName()} per day on average, by ${by}`;
  renderBars("dow", "dow-chart", {
    labels: WEEKDAYS.map((d) => weekdayName(d, "short")), values: dowAvg.map(pick), peak: any ? peakDow : -1,
    fmt, label: metricName(), aria: aria("weekday"),
    title: (i) => weekdayName(WEEKDAYS[i], "long"), tip: (i) => tip(dowAvg[i]),
  });
  renderBars("hour", "hour-chart", {
    labels: Array.from({ length: 24 }, (_, h) => hourLabel(h)), values: hourAvg.map(pick), peak: any ? peakHour : -1,
    fmt, label: metricName(), aria: aria("hour of day"),
    title: (i) => hourSpan(i), tip: (i) => tip(hourAvg[i]),
  });
}

// One-series bar chart; the peak bar is full strength, the rest lighter.
// tip(i) gives the tooltip's lines for bar i.
function renderBars(name, canvasId, { labels, values, peak, fmt, label, aria, title, tip }) {
  const ink = cssVar("--text-secondary");
  const color = cssVar("--series-1");
  const colors = values.map((_, i) => (i === peak ? color : color + "73"));
  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label,
        data: values,
        backgroundColor: colors,
        hoverBackgroundColor: color,
        borderRadius: { topLeft: 4, topRight: 4 },
        borderSkipped: "start",
        maxBarThickness: 40,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: cssVar("--axis") }, ticks: { color: ink, maxRotation: 0, autoSkipPadding: 6 } },
        y: { beginAtZero: true, grid: { color: cssVar("--grid") }, border: { display: false }, ticks: { color: ink, maxTicksLimit: 5, callback: (v) => fmt(v) } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => title(items[0].dataIndex),
            label: (item) => tip(item.dataIndex),
          },
        },
      },
    },
  };
  $(canvasId).setAttribute("aria-label", aria);
  state.charts[name]?.destroy();
  state.charts[name] = new Chart($(canvasId), config);
}

function tipFor(target) {
  const seg = target.closest(".bd-seg");
  if (seg) {
    const line = state.bdLines[Number(seg.dataset.line)];
    const i = Number(seg.dataset.type);
    const total = line.parts.reduce((a, c) => a + c, 0);
    return {
      head: `${line.label} · ${state.bdTypes[i].label}`,
      lines: [state.bdFmt(line.parts[i]), `${share(line.parts[i], total)} of this row`],
      note: "",
    };
  }
  const day = target.closest(".cal-cell");
  if (day) {
    const label = new Date(day.dataset.day + "T00:00:00")
      .toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    return cellTip(label, state.calCells.get(day.dataset.day));
  }
  return null;
}

function showTip(e) {
  const tip = $("heat-tip");
  const t = tipFor(e.target);
  if (!t) {
    tip.hidden = true;
    return;
  }
  const div = (text, cls) => {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = text;
    return d;
  };
  tip.replaceChildren(div(t.head, "tip-head"), ...t.lines.map((l) => div(l)));
  if (t.note) tip.append(div(t.note, "tip-dim"));
  tip.hidden = false;
  const pad = 12;
  const { width, height } = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + width > innerWidth - 4) x = e.clientX - width - pad;
  if (y + height > innerHeight - 4) y = e.clientY - height - pad;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

function renderTable(rows) {
  const byModel = new Map();
  for (const r of rows) {
    const key = `${r.tool}\t${r.model}`;
    const m = byModel.get(key) ?? { tool: r.tool, model: r.model, requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, cost: 0, unpriced: 0 };
    for (const f of ["requests", "input", "cached", "cacheWrite", "output", "cost", "unpriced"]) m[f] += r[f];
    byModel.set(key, m);
  }
  const body = $("model-table");
  body.replaceChildren();
  const sorted = [...byModel.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests);
  for (const m of sorted) {
    const tr = document.createElement("tr");
    const cells = [
      [m.model, false], [TOOL_NAMES[m.tool] ?? m.tool, false], [whole.format(m.requests), true],
      [whole.format(m.input), true], [whole.format(m.cached), true], [whole.format(m.cacheWrite), true],
      [whole.format(m.output), true],
    ];
    cells.forEach(([text, num], i) => {
      const td = document.createElement("td");
      if (num) td.className = "num";
      // Swatches match the chart only when it is grouped by model.
      if (i === 0 && state.group === "model") {
        const sw = document.createElement("span");
        sw.className = "swatch";
        sw.style.background = seriesColor(state.modelSeries.get(m.model)?.color ?? "--series-other");
        td.append(sw);
      }
      td.append(text);
      tr.append(td);
    });
    const cost = document.createElement("td");
    cost.className = "num";
    if (m.unpriced === m.requests) cost.textContent = "no price";
    else {
      cost.textContent = usd(m.cost);
      if (m.unpriced > 0) {
        cost.classList.add("partial");
        cost.title = `${m.unpriced} requests without a price`;
        cost.textContent += " (partial)";
      }
    }
    tr.append(cost);
    body.append(tr);
  }
  if (sorted.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "muted";
    td.textContent = "No usage in this range.";
    tr.append(td);
    body.append(tr);
  }
}

function renderLatest() {
  const body = $("latest-table");
  body.replaceChildren();
  const time = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  for (const r of state.latest) {
    const tr = document.createElement("tr");
    const when = new Date(r.occurred_at);
    const cost = r.estimated_cost_usd == null ? "no price" : usd(Number(r.estimated_cost_usd));
    const cells = [
      [time.format(when), false], [TOOL_NAMES[r.tool] ?? r.tool, false], [r.model, false],
      [whole.format(r.input_tokens), true], [whole.format(r.cached_input_tokens), true],
      [whole.format(r.cache_write_tokens), true], [whole.format(r.output_tokens), true], [cost, true],
    ];
    for (const [text, num] of cells) {
      const td = document.createElement("td");
      if (num) td.className = "num";
      td.textContent = text;
      tr.append(td);
    }
    tr.firstChild.title = when.toString();
    body.append(tr);
  }
  if (state.latest.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "muted";
    td.textContent = "No requests yet.";
    tr.append(td);
    body.append(tr);
  }
}

// ---------- auth & wiring ----------

async function load() {
  $("status").textContent = "Loading…";
  try {
    [state.rows, state.hourly, state.latest, state.prompts] = await Promise.all([
      fetchRows(), fetchHourly(), fetchLatest(), fetchPrompts(),
    ]);
    assignModelSeries(state.rows);
    render();
  } catch (e) {
    $("status").textContent = `Could not load usage: ${e.message ?? e}`;
  }
}

function showSignedIn(session) {
  $("login").hidden = true;
  $("dashboard").hidden = false;
  $("sign-out").hidden = false;
  $("who").textContent = session.user.email ?? "";
  load();
}

function showSignedOut() {
  $("login").hidden = false;
  $("dashboard").hidden = true;
  $("sign-out").hidden = true;
  $("who").textContent = "";
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("login-status");
  status.textContent = "Sending…";
  const { error } = await db.auth.signInWithOtp({
    email: $("email").value.trim(),
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  status.textContent = error ? `Could not send the link: ${error.message}` : "Check your email for the sign-in link.";
});

$("sign-out").addEventListener("click", () => db.auth.signOut());

$("range").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.days = Number(b.dataset.days);
  savePrefs();
  render();
});

$("group").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.group = b.dataset.group;
  savePrefs();
  render();
});

$("metric").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.metric = b.dataset.metric;
  savePrefs();
  render();
});

$("calendar").addEventListener("pointermove", showTip);
$("calendar").addEventListener("pointerleave", () => { $("heat-tip").hidden = true; });
$("bd-bars").addEventListener("pointermove", showTip);
$("bd-bars").addEventListener("pointerleave", () => { $("heat-tip").hidden = true; });

let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$("dashboard").hidden && state.rows.length) renderCalendar(); }, 150);
});

function toggleBreakdown(tile) {
  state.breakdown = state.breakdown === tile.dataset.kpi ? null : tile.dataset.kpi;
  render();
}

for (const tile of document.querySelectorAll(".tile[data-kpi]")) {
  tile.addEventListener("click", () => toggleBreakdown(tile));
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleBreakdown(tile);
    }
  });
}

$("cal-toggle").addEventListener("click", () => {
  state.calOpen = !state.calOpen;
  renderPromptPatterns();
});

$("refresh").addEventListener("click", load);

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!$("dashboard").hidden) render();
});

loadPrefs();
let signedIn = false;
db.auth.onAuthStateChange((_event, session) => {
  if (session && !signedIn) {
    signedIn = true;
    showSignedIn(session);
  } else if (!session) {
    signedIn = false;
    showSignedOut();
  }
});
