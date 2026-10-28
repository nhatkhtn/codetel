// codetel dashboard: signs in with an email link, loads daily usage through
// the usage_daily RPC (RLS-protected), and renders tiles, charts, and a table.

const { supabaseUrl, supabaseKey } = window.CODETEL_CONFIG;
const db = window.supabase.createClient(supabaseUrl, supabaseKey);

const TOOL_NAMES = { claude_code: "Claude Code", codex: "Codex" };
const SERIES_SLOTS = 7; // categorical slots; the rest fold into "Other"
const PAGE = 1000;

const state = {
  rows: [], // all-time daily rows from usage_daily
  days: 30,
  group: "tool",
  modelSlots: new Map(), // model -> slot index, fixed by all-time cost
  charts: {},
};

const $ = (id) => document.getElementById(id);

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("codetel-prefs") ?? "{}");
    if (Number.isInteger(p.days)) state.days = p.days;
    if (p.group === "tool" || p.group === "model") state.group = p.group;
    if (p.theme === "light" || p.theme === "dark") document.documentElement.dataset.theme = p.theme;
  } catch { /* storage unavailable */ }
}

function savePrefs() {
  try {
    localStorage.setItem("codetel-prefs", JSON.stringify({
      days: state.days,
      group: state.group,
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

async function fetchRows() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const to = new Date(Date.now() + 864e5).toISOString();
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .rpc("usage_daily", { p_from: "2000-01-01T00:00:00Z", p_to: to, p_tz: tz })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows.map((r) => ({
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
    return { key: row.tool, label: TOOL_NAMES[row.tool] ?? row.tool, slot: row.tool === "codex" ? 1 : 0 };
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

  renderTiles(inRange);
  renderUnpriced(inRange);
  const series = buildSeries(inRange, days);
  renderChart("cost", "cost-chart", days, series, (s) => s.cost, usd);
  renderChart("tokens", "token-chart", days, series, (s) => s.tokens, (v) => compact.format(v));
  renderTable(inRange);
  $("status").textContent = state.rows.length === 0
    ? "No usage recorded yet, or this account is not allowed to read it."
    : "";
}

function renderTiles(rows) {
  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const cost = sum((r) => r.cost);
  const requests = sum((r) => r.requests);
  const unpriced = sum((r) => r.unpriced);
  const uncached = sum((r) => r.input);
  const cached = sum((r) => r.cached);
  const cacheWrite = sum((r) => r.cacheWrite);
  const input = uncached + cached + cacheWrite;
  const output = sum((r) => r.output);
  $("kpi-cost").textContent = usd(cost);
  $("kpi-cost-note").textContent = unpriced ? `excludes ${whole.format(unpriced)} unpriced requests` : "all requests priced";
  $("kpi-requests").textContent = whole.format(requests);
  $("kpi-requests-note").textContent = rangeLabel();
  $("kpi-input").textContent = compact.format(input);
  $("kpi-input-note").textContent = input ? `${Math.round((cached / input) * 100)}% cache reads` : "";
  $("kpi-output").textContent = compact.format(output);
  $("kpi-output-note").textContent = "";
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

function renderChart(name, canvasId, days, series, pick, fmt) {
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
  state.charts[name]?.destroy();
  state.charts[name] = new Chart($(canvasId), config);
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
    state.rows = await fetchRows();
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
