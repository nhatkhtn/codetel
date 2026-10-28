// codetel dashboard: signs in with an email link, loads daily usage through
// the usage_daily and usage_hourly RPCs (RLS-protected), and renders tiles, a
// chart, a calendar heatmap, weekday and hour-of-day charts, and a table.

const { supabaseUrl, supabaseKey } = window.CODETEL_CONFIG;
const db = window.supabase.createClient(supabaseUrl, supabaseKey);

const TOOL_NAMES = { claude_code: "Claude Code", codex: "Codex" };
// Claude Code is orange, Codex green.
const TOOL_SLOTS = { claude_code: 1, codex: 2 };
const SERIES_SLOTS = 7; // categorical slots; the rest fold into "Other"
const PAGE = 1000;

const state = {
  rows: [], // all-time daily rows from usage_daily
  hourly: [], // all-time (day, hour) rows from usage_hourly
  days: 30,
  group: "tool",
  metric: "cost", // "cost" or "tokens"
  breakdown: null, // open tile breakdown: "cost", "requests", "input", "output"
  modelSlots: new Map(), // model -> slot index, fixed by all-time cost
  charts: {},
};

const $ = (id) => document.getElementById(id);

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("codetel-prefs") ?? "{}");
    if (Number.isInteger(p.days)) state.days = p.days;
    if (p.group === "tool" || p.group === "model") state.group = p.group;
    if (p.metric === "cost" || p.metric === "tokens") state.metric = p.metric;
    if (p.theme === "light" || p.theme === "dark") document.documentElement.dataset.theme = p.theme;
  } catch { /* storage unavailable */ }
}

function savePrefs() {
  try {
    localStorage.setItem("codetel-prefs", JSON.stringify({
      days: state.days,
      group: state.group,
      metric: state.metric,
      theme: document.documentElement.dataset.theme,
    }));
  } catch { /* storage unavailable */ }
}

// ---------- formatting ----------

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();

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
    cost: Number(r.cost_usd),
    unpriced: Number(r.unpriced_requests),
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

// Slots follow the entity: ranked once by all-time cost (then tokens), so
// changing the range never repaints a model.
function assignModelSlots(rows) {
  const totals = new Map();
  for (const r of rows) {
    const t = totals.get(r.model) ?? { cost: 0, tokens: 0 };
    t.cost += r.cost;
    t.tokens += r.input + r.cached + r.cacheWrite + r.output;
    totals.set(r.model, t);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
  state.modelSlots = new Map(ranked.slice(0, SERIES_SLOTS).map(([m], i) => [m, i]));
}

function seriesOf(row) {
  if (state.group === "tool") {
    return { key: row.tool, label: TOOL_NAMES[row.tool] ?? row.tool, slot: TOOL_SLOTS[row.tool] ?? null };
  }
  const slot = state.modelSlots.get(row.model);
  return slot == null
    ? { key: "__other", label: "Other models", slot: null }
    : { key: row.model, label: row.model, slot };
}

function seriesColor(slot) {
  return cssVar(slot == null ? "--series-other" : `--series-${slot + 1}`);
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
  $("chart-note").hidden = !tokens;
  renderChart("usage-chart", days, series, tokens ? (s) => s.tokens : (s) => s.cost, tokens ? (v) => compact.format(v) : usd);
  renderCalendar();
  renderPatterns(days);
  renderTable(inRange);
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

// Pie of what makes up the open tile's total. Cost, requests and output split
// by tool or model (the "Group by" switch); input splits by token type.
const BREAKDOWNS = {
  cost: { title: "Estimated cost", fmt: (v) => usd(v), pick: (r) => r.cost },
  requests: { title: "Requests", fmt: (v) => whole.format(v), pick: (r) => r.requests },
  output: { title: "Output tokens", fmt: (v) => compact.format(v), pick: (r) => r.output },
  input: { title: "Input tokens", fmt: (v) => compact.format(v), byType: true },
};
const INPUT_TYPES = [
  { key: "cached", label: "Cache reads", slot: 0 },
  { key: "input", label: "Uncached input", slot: 3 },
  { key: "cacheWrite", label: "Cache writes", slot: 6 },
];

function breakdownSlices(rows, b) {
  if (b.byType) {
    return INPUT_TYPES.map((t) => ({ label: t.label, slot: t.slot, value: rows.reduce((s, r) => s + r[t.key], 0) }));
  }
  const slices = new Map();
  for (const r of rows) {
    const s = seriesOf(r);
    const e = slices.get(s.key) ?? { label: s.label, slot: s.slot, value: 0 };
    e.value += b.pick(r);
    slices.set(s.key, e);
  }
  return [...slices.values()];
}

function renderBreakdown(rows) {
  for (const t of document.querySelectorAll(".tile[data-kpi]")) {
    t.setAttribute("aria-expanded", String(t.dataset.kpi === state.breakdown));
  }
  const panel = $("breakdown");
  panel.hidden = !state.breakdown;
  if (!state.breakdown) {
    state.charts.breakdown?.destroy();
    delete state.charts.breakdown;
    return;
  }
  const b = BREAKDOWNS[state.breakdown];
  // Largest first; "Other models" stays last.
  const slices = breakdownSlices(rows, b)
    .filter((x) => x.value > 0)
    .sort((x, y) => (x.slot == null) - (y.slot == null) || y.value - x.value);
  const total = slices.reduce((s, x) => s + x.value, 0);
  const by = b.byType ? "by token type" : state.group === "tool" ? "by tool" : "by model";
  $("bd-title").textContent = `${b.title} ${by}, ${rangeLabel()}`;
  const pct = (v) => (total ? `${((v / total) * 100).toFixed(v / total < 0.1 ? 1 : 0)}%` : "");

  const body = $("bd-rows");
  body.replaceChildren();
  for (const x of slices) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = seriesColor(x.slot);
    name.append(sw, x.label);
    const val = document.createElement("td");
    val.className = "num";
    val.textContent = b.fmt(x.value);
    const p = document.createElement("td");
    p.className = "num pct";
    p.textContent = pct(x.value);
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
        backgroundColor: slices.map((x) => seriesColor(x.slot)),
        hoverBackgroundColor: slices.map((x) => seriesColor(x.slot)),
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
        tooltip: { callbacks: { label: (item) => ` ${b.fmt(item.raw)} (${pct(item.raw)})` } },
      },
    },
  };
  $("bd-chart").setAttribute("aria-label", $("bd-title").textContent);
  state.charts.breakdown?.destroy();
  state.charts.breakdown = new Chart($("bd-chart"), config);
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
  return [...series.values()].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
}

function renderChart(canvasId, days, series, pick, fmt) {
  const surface = cssVar("--surface");
  const ink = cssVar("--text-secondary");
  const grid = cssVar("--grid");
  const datasets = series.map((s, i) => ({
    label: s.label,
    data: pick(s),
    backgroundColor: seriesColor(s.slot),
    hoverBackgroundColor: seriesColor(s.slot),
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

function cellTip(head, c, note) {
  return { head, lines: [`Cost: ${usd(c.cost)}`, `Tokens: ${compact.format(c.tokens)}`, `Requests: ${whole.format(c.requests)}`], note };
}

// GitHub-style calendar of the last year, one square per local day; ignores
// the range filter.
function renderCalendar() {
  const pick = metricPick();
  const byDay = new Map();
  for (const r of state.rows) {
    const c = byDay.get(r.day) ?? { requests: 0, tokens: 0, cost: 0 };
    c.requests += r.requests;
    c.tokens += r.input + r.cached + r.cacheWrite + r.output;
    c.cost += r.cost;
    byDay.set(r.day, c);
  }
  const today = new Date();
  const yearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1);
  const start = new Date(yearAgo.getFullYear(), yearAgo.getMonth(), yearAgo.getDate() - ((yearAgo.getDay() + 6) % 7));
  const days = [];
  for (let d = start; d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(d);
  const empty = { requests: 0, tokens: 0, cost: 0 };
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
  grid.setAttribute("aria-label", `${metricName()} per day over the last 12 months`);
  $("cal-sub").textContent = `${metricName()} per day.`;
  $("cal-summary").textContent = `${metricFmt()(total)} in total, ${active} active days.`;
  const wrap = $("cal-wrap");
  wrap.scrollLeft = wrap.scrollWidth;
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
  $("dow-sub").textContent = any ? `${per}. Busiest: ${weekdayName(WEEKDAYS[peakDow], "long")}.` : `${per}.`;
  $("hour-sub").textContent = any ? `${per}, ${TZ} time. Busiest: ${hourSpan(peakHour)}.` : `${per}, ${TZ} time.`;

  renderBars("dow", "dow-chart", WEEKDAYS.map((d) => weekdayName(d, "short")), dowAvg, any ? peakDow : -1, fmt,
    (i) => weekdayName(WEEKDAYS[i], "long"));
  renderBars("hour", "hour-chart", Array.from({ length: 24 }, (_, h) => hourLabel(h)), hourAvg, any ? peakHour : -1, fmt,
    (i) => hourSpan(i));
}

// One-series bar chart; the peak bar is full strength, the rest lighter.
function renderBars(name, canvasId, labels, cells, peak, fmt, title) {
  const pick = metricPick();
  const ink = cssVar("--text-secondary");
  const color = cssVar("--series-1");
  const colors = cells.map((_, i) => (i === peak ? color : color + "73"));
  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: metricName(),
        data: cells.map(pick),
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
            label: (item) => ` ${fmt(item.raw)} per day`,
            afterLabel: (item) => ` ${whole.format(Math.round(cells[item.dataIndex].requests))} requests per day`,
          },
        },
      },
    },
  };
  $(canvasId).setAttribute("aria-label", `${metricName()} per day on average, by ${name === "dow" ? "weekday" : "hour of day"}`);
  state.charts[name]?.destroy();
  state.charts[name] = new Chart($(canvasId), config);
}

function tipFor(target) {
  const day = target.closest(".cal-cell");
  if (day) {
    const label = new Date(day.dataset.day + "T00:00:00")
      .toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
    return cellTip(label, state.calCells.get(day.dataset.day), "");
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
    const slot = state.modelSlots.get(m.model);
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
        sw.style.background = seriesColor(slot ?? null);
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

// ---------- auth & wiring ----------

async function load() {
  $("status").textContent = "Loading…";
  try {
    [state.rows, state.hourly] = await Promise.all([fetchRows(), fetchHourly()]);
    assignModelSlots(state.rows);
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

$("refresh").addEventListener("click", load);

$("theme").addEventListener("click", () => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const current = document.documentElement.dataset.theme ?? (dark ? "dark" : "light");
  document.documentElement.dataset.theme = current === "dark" ? "light" : "dark";
  savePrefs();
  if (state.rows.length || !$("dashboard").hidden) render();
});

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
