/* ===========================================================================
   Project Hours EAC Tracker — script.js
   ---------------------------------------------------------------------------
   Data is saved to TWO places simultaneously:
     1. Browser localStorage  (instant, works offline)
     2. Server  POST /api/state  (shared — any device with server access
                                   sees the same data)
   On load: server is tried first; localStorage is the fallback.

   New features in this version:
     - TEAM_MEMBERS fetched from /api/team
     - STATE.timeLogs[] stores individual hour log entries
     - Time Log view: log hours per member / date / project / stage / type
     - Each log entry automatically increments the matching phase's AC
     - Log entries can be deleted (this reduces AC by that entry's hours)
   =========================================================================== */

const STORAGE_KEY = "eacTrackerData";
let PHASES_TEMPLATE = [];
let GROUPS          = [];
let TEAM_MEMBERS    = [];
let STATE           = null;
let currentProjectId = null;
let pickerCallback   = null;

/* ---------------------------------------------------------------------- */
/* Bootstrapping                                                          */
/* ---------------------------------------------------------------------- */
async function init() {
  await loadPhaseTemplate();
  await loadGroups();
  await loadTeamMembers();
  await loadState();          // async: tries server first
  bindGlobalEvents();
  populateTimeLogForm();
  renderDashboard();
}

async function loadPhaseTemplate() {
  const res = await fetch("/api/phases");
  PHASES_TEMPLATE = await res.json();
}

async function loadGroups() {
  const res = await fetch("/api/groups");
  GROUPS = await res.json();
  document.getElementById("newRowGroup").innerHTML =
    GROUPS.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
}

async function loadTeamMembers() {
  try {
    const res = await fetch("/api/team");
    TEAM_MEMBERS = await res.json();
  } catch (e) {
    TEAM_MEMBERS = [];
  }
}

/* ---------------------------------------------------------------------- */
/* State persistence — localStorage + server                             */
/* ---------------------------------------------------------------------- */
async function loadState() {
  // 1. Try server first so any shared edits from other machines are visible
  try {
    const res  = await fetch("/api/state");
    const data = await res.json();
    if (data && data.projects) {
      STATE = data;
      backfillState();
      showStorageBanner("🌐 Loaded from server", "info");
      return;
    }
  } catch (e) {
    console.warn("Server state unavailable, falling back to localStorage.", e);
  }

  // 2. Fall back to localStorage
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      STATE = JSON.parse(raw);
      backfillState();
      showStorageBanner("💾 Loaded from browser storage (server unavailable)", "warn");
      return;
    } catch (e) {
      console.warn("Corrupt localStorage data, resetting.", e);
    }
  }

  // 3. First run — create 5 default projects
  STATE = { nextProjectNumber: 6, projects: [], timeLogs: [] };
  for (let i = 1; i <= 5; i++) STATE.projects.push(makeProject(`Project ${i}`));
  saveState();
}

function backfillState() {
  if (!STATE.projects)  STATE.projects  = [];
  if (!STATE.timeLogs)  STATE.timeLogs  = [];
  if (STATE.tlSyncDelete === undefined) STATE.tlSyncDelete = true; // ON by default
  STATE.projects.forEach(p => {
    if (!p.combinedCells)    p.combinedCells    = p.combinedAC || {};
    if (!p.combineSnapshots) p.combineSnapshots = {};
    delete p.combinedAC;
  });
}

function saveState() {
  // Always save to localStorage immediately (synchronous, no network needed)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE));

  // Also save to server asynchronously — fire and forget, don't block the UI
  fetch("/api/state", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(STATE),
  }).catch(err => console.warn("Server save failed (data still in localStorage):", err));
}

function showStorageBanner(msg, type) {
  const el = document.getElementById("storageBanner");
  el.textContent = msg;
  el.className = `storage-banner ${type}`;
  setTimeout(() => el.classList.add("hidden"), 4000);
}

/* ---------------------------------------------------------------------- */
/* Project factory                                                        */
/* ---------------------------------------------------------------------- */
function makeProject(name) {
  return {
    id: "proj_" + Math.random().toString(36).slice(2, 10),
    name,
    notes: "",
    phases:          blankPhasesForProject(),
    combinedCells:   {},
    combineSnapshots: {},
  };
}

function blankPhasesForProject() {
  return PHASES_TEMPLATE.map(p => ({
    id: p.id, group: p.group, task: p.task,
    bac: 0, ac: 0, pct: 0, etc: "", isCustom: false,
  }));
}

/* ---------------------------------------------------------------------- */
/* EAC Calculations                                                       */
/* ---------------------------------------------------------------------- */
function calcRow(row) {
  const bac    = Number(row.bac) || 0;
  const ac     = Number(row.ac)  || 0;
  const pct    = Number(row.pct) || 0;
  const etcRaw = row.etc;
  const hasEtc = etcRaw !== "" && etcRaw !== null && etcRaw !== undefined && !isNaN(etcRaw);
  const etc    = hasEtc ? Number(etcRaw) : null;

  const ev   = bac * (pct / 100);
  const cpi  = ac > 0 ? (ev / ac) : null;
  const eac1 = (cpi && cpi > 0) ? (bac / cpi) : null;
  const eac2 = ac + (bac - ev);
  const eac3 = hasEtc ? (ac + etc) : null;

  let eacMain, method;
  if (hasEtc)         { eacMain = eac3; method = "Method 3"; }
  else if (eac1 !== null) { eacMain = eac1; method = "Method 1"; }
  else                { eacMain = eac2; method = "Method 2"; }

  return { ev, cpi, eac1, eac2, eac3, eacMain, method, variance: eacMain - bac };
}

function statusFor(variance, bac) {
  if (variance <= 0)                        return "On Track";
  if (bac > 0 && variance <= 0.10 * bac)   return "Watch";
  return "Over Budget";
}

function statusClass(status) {
  if (status === "On Track") return "green";
  if (status === "Watch")    return "yellow";
  return "red";
}

function projectTotals(project) {
  let totalBac = 0, totalAc = 0, totalEv = 0, totalEac = 0;
  project.phases.forEach(r => {
    const c = calcRow(r);
    totalBac += Number(r.bac) || 0;
    totalAc  += Number(r.ac)  || 0;
    totalEv  += c.ev;
    totalEac += c.eacMain;
  });
  const overallPct = totalBac > 0 ? (totalEv / totalBac * 100) : 0;
  const overallCpi = totalAc  > 0 ? (totalEv / totalAc)        : null;
  const totalVariance = totalEac - totalBac;
  return { totalBac, totalAc, totalEv, overallPct, overallCpi,
           totalEac, totalVariance, status: statusFor(totalVariance, totalBac) };
}

function groupTotals(project, group) {
  let totalBac = 0, totalAc = 0, totalEv = 0, totalEac = 0;
  project.phases.filter(r => r.group === group).forEach(r => {
    const c = calcRow(r);
    totalBac += Number(r.bac) || 0; totalAc += Number(r.ac) || 0;
    totalEv  += c.ev;               totalEac += c.eacMain;
  });
  const variance = totalEac - totalBac;
  return { totalBac, totalAc, totalEv, totalEac, variance, status: statusFor(variance, totalBac) };
}

/* ---------------------------------------------------------------------- */
/* Formatting helpers                                                     */
/* ---------------------------------------------------------------------- */
const fmt0      = n => (n == null || isNaN(n)) ? "N/A" : Math.round(n).toString();
const fmt2      = n => (n == null || isNaN(n)) ? "N/A" : n.toFixed(2);
const fmtPct    = n => (n == null || isNaN(n)) ? "0.0%" : n.toFixed(1) + "%";
const fmtSigned = n => (n == null || isNaN(n)) ? "N/A" : (n > 0 ? "+" : "") + Math.round(n);

/* ---------------------------------------------------------------------- */
/* View switching                                                         */
/* ---------------------------------------------------------------------- */
function showView(view) {
  ["dashboard","project","timeLog"].forEach(v => {
    document.getElementById(v + "View").classList.toggle("hidden", view !== v);
  });
  document.getElementById("btnDashboard").classList.toggle("active", view === "dashboard");
  document.getElementById("btnTimeLog").classList.toggle("active",   view === "timeLog");
}

/* ---------------------------------------------------------------------- */
/* Dashboard                                                              */
/* ---------------------------------------------------------------------- */
function renderDashboard() {
  showView("dashboard");
  const body = document.getElementById("dashboardBody");
  body.innerHTML = "";
  STATE.projects.forEach(project => {
    const t   = projectTotals(project);
    const cls = statusClass(t.status);
    const tr  = document.createElement("tr");
    tr.className = "row-" + cls;
    tr.innerHTML = `
      <td class="proj-name" data-id="${project.id}">${escapeHtml(project.name)}</td>
      <td class="num">${fmt0(t.totalBac)}</td>
      <td class="num">${fmt0(t.totalAc)}</td>
      <td class="num">${fmtPct(t.overallPct)}</td>
      <td class="num">${fmt0(t.totalEac)}</td>
      <td class="num">${fmtSigned(t.totalVariance)}</td>
      <td><span class="badge ${cls}"><span class="dot ${cls}"></span>${t.status}</span></td>
      <td><span class="open-link" data-id="${project.id}">Open →</span></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll("[data-id]").forEach(el =>
    el.addEventListener("click", () => openProject(el.dataset.id)));
}

/* ---------------------------------------------------------------------- */
/* Project detail                                                         */
/* ---------------------------------------------------------------------- */
function openProject(id) {
  currentProjectId = id;
  showView("project");
  renderProject();
}

function getCurrentProject() {
  return STATE.projects.find(p => p.id === currentProjectId);
}

function renderProject() {
  const project = getCurrentProject();
  if (!project) { renderDashboard(); return; }
  document.getElementById("projectNameInput").value = project.name;
  document.getElementById("notesArea").value         = project.notes || "";
  renderSummaryCards(project);
  renderStageStatus(project);
  renderPhasesTable(project);
}

function renderSummaryCards(project) {
  const t   = projectTotals(project);
  const cls = statusClass(t.status);
  document.getElementById("summaryCards").innerHTML = `
    <div class="card"><div class="label">Total Planned Hours</div><div class="value">${fmt0(t.totalBac)}</div></div>
    <div class="card"><div class="label">Total Actual Hours</div><div class="value">${fmt0(t.totalAc)}</div></div>
    <div class="card"><div class="label">Overall % Complete</div><div class="value">${fmtPct(t.overallPct)}</div></div>
    <div class="card"><div class="label">Total EV</div><div class="value">${fmt0(t.totalEv)}</div></div>
    <div class="card"><div class="label">Overall CPI</div><div class="value">${t.overallCpi ? fmt2(t.overallCpi) : "N/A"}</div></div>
    <div class="card"><div class="label">Total EAC</div><div class="value">${fmt0(t.totalEac)}</div></div>
    <div class="card"><div class="label">Total Variance</div><div class="value">${fmtSigned(t.totalVariance)}</div></div>
    <div class="card status-card">
      <div class="label">Status</div>
      <div class="value"><span class="badge ${cls}"><span class="dot ${cls}"></span>${t.status}</span></div>
    </div>`;
}

function renderStageStatus(project) {
  const wrap = document.getElementById("stageStatusRow");
  if (!wrap) return;
  const present = new Set(project.phases.map(r => r.group));
  wrap.innerHTML = GROUPS.filter(g => present.has(g)).map(g => {
    const t   = groupTotals(project, g);
    const cls = statusClass(t.status);
    return `<div class="stage-chip">
      <div class="stage-chip-name">${escapeHtml(g)}</div>
      <span class="badge ${cls}"><span class="dot ${cls}"></span>${t.status}</span>
      <div class="stage-chip-sub">EAC ${fmt0(t.totalEac)} hrs &middot; Var ${fmtSigned(t.variance)}</div>
    </div>`;
  }).join("");
}

function renderPhasesTable(project) {
  const body = document.getElementById("phasesBody");
  body.innerHTML = "";
  let lastGroup = null;
  const groupCounts = {};
  project.phases.forEach(r => { groupCounts[r.group] = (groupCounts[r.group] || 0) + 1; });

  project.phases.forEach((row, idx) => {
    const isFirstOfGroup = row.group !== lastGroup;
    lastGroup = row.group;
    const combinable = row.group !== "Optional" && groupCounts[row.group] === 2;
    const combined   = combinable && !!project.combinedCells[row.group];
    if (combinable && combined && !isFirstOfGroup) return;

    const c   = calcRow(row);
    const cls = statusClass(statusFor(c.variance, Number(row.bac) || 0));
    const tr  = document.createElement("tr");
    tr.dataset.rowIdx = idx;
    if (isFirstOfGroup) tr.classList.add("group-start");

    let groupCell = "";
    if (isFirstOfGroup) {
      groupCell = `<span class="group-tag">${escapeHtml(row.group)}</span>`;
      if (combinable)
        groupCell += `<button class="combine-toggle" data-group="${escapeHtml(row.group)}">
          ${combined ? "↔ Split Cells" : "⇄ Combine Cells"}
        </button>`;
    }

    const taskLabel = combined
      ? `${escapeHtml(row.task)} <span class="combined-pill">combined</span>`
      : escapeHtml(row.task);

    tr.innerHTML = `
      <td>${groupCell}</td>
      <td>${taskLabel}</td>
      <td><input type="number" min="0" step="1" class="cell-input" data-field="bac" data-idx="${idx}" value="${row.bac ?? 0}"></td>
      <td><input type="number" min="0" step="1" class="cell-input" data-field="ac"  data-idx="${idx}" value="${row.ac  ?? 0}"></td>
      <td><input type="number" min="0" max="100" step="1" class="cell-input" data-field="pct" data-idx="${idx}" value="${row.pct ?? 0}"></td>
      <td><input type="number" min="0" step="1" class="cell-input" data-field="etc" data-idx="${idx}" value="${row.etc ?? ""}" placeholder="-"></td>
      <td class="num calc-val" data-role="ev">${fmt0(c.ev)}</td>
      <td class="num calc-val" data-role="cpi">${c.cpi !== null ? fmt2(c.cpi) : '<span class="muted">N/A</span>'}</td>
      <td class="num calc-val" data-role="eac1">${c.eac1 !== null ? fmt0(c.eac1) : '<span class="muted">N/A</span>'}</td>
      <td class="num calc-val" data-role="eac2">${fmt0(c.eac2)}</td>
      <td class="num calc-val" data-role="eac3">${c.eac3 !== null ? fmt0(c.eac3) : '<span class="muted">-</span>'}</td>
      <td class="num" data-role="variance"><span class="eac-main badge ${cls}">${fmtSigned(c.variance)}</span></td>
      <td>${row.isCustom ? `<button class="row-delete-btn" data-del-idx="${idx}" title="Remove row">🗑</button>` : ""}</td>`;
    body.appendChild(tr);
  });

  body.querySelectorAll("input.cell-input").forEach(inp => {
    inp.addEventListener("input", onCellEdit);
    inp.addEventListener("blur",  onCellBlur);
  });
  body.querySelectorAll(".row-delete-btn").forEach(btn =>
    btn.addEventListener("click", () => deleteRow(Number(btn.dataset.delIdx))));
  body.querySelectorAll(".combine-toggle").forEach(btn =>
    btn.addEventListener("click", () => toggleCombineCells(btn.dataset.group)));
}

/* ---------------------------------------------------------------------- */
/* Cell edit handlers                                                     */
/* ---------------------------------------------------------------------- */
function onCellEdit(e) {
  const project = getCurrentProject();
  const idx     = Number(e.target.dataset.idx);
  const field   = e.target.dataset.field;
  const rawVal  = e.target.value;
  if (field === "etc") project.phases[idx].etc = rawVal === "" ? "" : Number(rawVal);
  else                 project.phases[idx][field] = rawVal === "" ? 0  : Number(rawVal);
  saveState();
  updateRowCalculations(idx);
  renderSummaryCards(project);
  renderStageStatus(project);
}

function onCellBlur(e) {
  const project = getCurrentProject();
  const idx     = Number(e.target.dataset.idx);
  const field   = e.target.dataset.field;
  let val = project.phases[idx][field];
  if      (field === "pct")             val = Math.max(0, Math.min(100, Number(val) || 0));
  else if (field === "bac" || field === "ac") val = Math.max(0, Number(val) || 0);
  else if (field === "etc")             val = (val === "" || val === null) ? "" : Math.max(0, Number(val) || 0);
  project.phases[idx][field] = val;
  e.target.value = val;
  saveState();
  updateRowCalculations(idx);
  renderSummaryCards(project);
  renderStageStatus(project);
}

function updateRowCalculations(idx) {
  const project = getCurrentProject();
  const row = project.phases[idx];
  const c   = calcRow(row);
  const cls = statusClass(statusFor(c.variance, Number(row.bac) || 0));
  const tr  = document.querySelector(`#phasesBody tr[data-row-idx="${idx}"]`);
  if (!tr) return;
  tr.querySelector('[data-role="ev"]').innerHTML       = fmt0(c.ev);
  tr.querySelector('[data-role="cpi"]').innerHTML      = c.cpi !== null ? fmt2(c.cpi) : '<span class="muted">N/A</span>';
  tr.querySelector('[data-role="eac1"]').innerHTML     = c.eac1 !== null ? fmt0(c.eac1) : '<span class="muted">N/A</span>';
  tr.querySelector('[data-role="eac2"]').innerHTML     = fmt0(c.eac2);
  tr.querySelector('[data-role="eac3"]').innerHTML     = c.eac3 !== null ? fmt0(c.eac3) : '<span class="muted">-</span>';
  tr.querySelector('[data-role="variance"]').innerHTML = `<span class="eac-main badge ${cls}">${fmtSigned(c.variance)}</span>`;
}

/* ---------------------------------------------------------------------- */
/* Combine / Split cells                                                  */
/* ---------------------------------------------------------------------- */
function getGroupRowIndices(project, group) {
  const idxs = [];
  project.phases.forEach((r, i) => { if (r.group === group) idxs.push(i); });
  return idxs;
}

/* Force-commit any value the user has typed but hasn't clicked away from.
   Without this, clicking Combine/Split while an input still has focus
   causes the snapshot to read the old (pre-edit) value from STATE. */
function commitAllPendingInputs() {
  const project = getCurrentProject();
  if (!project) return;
  document.querySelectorAll("#phasesBody input.cell-input").forEach(inp => {
    const idx   = Number(inp.dataset.idx);
    const field = inp.dataset.field;
    if (isNaN(idx) || !field) return;
    const val = inp.value;
    if (field === "etc") {
      project.phases[idx].etc = val === "" ? "" : Number(val);
    } else if (field === "pct") {
      project.phases[idx][field] = Math.max(0, Math.min(100, Number(val) || 0));
    } else {
      project.phases[idx][field] = Math.max(0, Number(val) || 0);
    }
  });
}

function toggleCombineCells(group) {
  // Commit any pending typed values BEFORE reading them into the snapshot
  commitAllPendingInputs();

  const project = getCurrentProject();
  const idxs = getGroupRowIndices(project, group);
  if (idxs.length !== 2) return;
  const turningOn = !project.combinedCells[group];
  project.combinedCells[group] = turningOn;
  const r1 = project.phases[idxs[0]];
  const r2 = project.phases[idxs[1]];

  if (turningOn) {
    project.combineSnapshots[group] = {
      bac1: r1.bac, ac1: r1.ac, pct1: r1.pct, etc1: r1.etc,
      bac2: r2.bac, ac2: r2.ac, pct2: r2.pct, etc2: r2.etc,
      combineTime: new Date().toISOString(), // mark when we combined so split
                                             // only counts entries logged AFTER this
    };
    const bac1 = Number(r1.bac)||0, bac2 = Number(r2.bac)||0;
    const ac1  = Number(r1.ac) ||0, ac2  = Number(r2.ac) ||0;
    const totalBac = bac1 + bac2;
    const combinedPct = totalBac > 0
      ? ((bac1*(Number(r1.pct)||0) + bac2*(Number(r2.pct)||0)) / totalBac) : 0;
    const etc1 = (r1.etc===""||r1.etc===null) ? null : Number(r1.etc);
    const etc2 = (r2.etc===""||r2.etc===null) ? null : Number(r2.etc);
    r1.bac = totalBac;
    r1.ac  = ac1 + ac2;
    r1.pct = Math.round(combinedPct * 10) / 10;
    r1.etc = (etc1===null && etc2===null) ? "" : (etc1||0)+(etc2||0);
    r2.bac = 0; r2.ac = 0; r2.pct = 0; r2.etc = "";
    toast(`${group}: rows combined — BAC ${totalBac}, AC ${ac1 + ac2}`);
  } else {
    const snap = project.combineSnapshots[group];
    if (snap) {
      const currentBac = Number(r1.bac) || 0;
      const currentAc  = Number(r1.ac)  || 0;
      const currentPct = Number(r1.pct) || 0;
      const currentEtc = r1.etc;

      const snapBac1 = Number(snap.bac1)||0, snapBac2 = Number(snap.bac2)||0;
      const snapAc1  = Number(snap.ac1) ||0, snapAc2  = Number(snap.ac2) ||0;
      const snapBacTotal = snapBac1 + snapBac2;
      const snapAcTotal  = snapAc1  + snapAc2;

      // ---- BAC: distribute by original ratio; all to row 1 if no original ----
      if (snapBacTotal > 0) {
        r1.bac = Math.round(currentBac * (snapBac1 / snapBacTotal));
        r2.bac = currentBac - r1.bac;
      } else {
        r1.bac = currentBac;
        r2.bac = 0;
      }

      // ---- AC: use time-log intendedType to route hours to the right row ----
      // IMPORTANT: only count entries logged AFTER we combined (snap.combineTime).
      // Entries logged BEFORE combining have the same phaseRowId (r1.id) but
      // their hours are already accounted for in snap.ac1 — counting them again
      // is what caused hours to multiply on every combine/split cycle.
      const drawingsTask   = group === "Record" ? "Record Drawings" : "Design Drawings";
      const combineTime    = snap.combineTime || new Date(0).toISOString();
      const logsWhileCombined = (STATE.timeLogs || []).filter(e =>
        e.projectId === project.id &&
        e.stage     === group &&
        e.phaseRowId === r1.id &&
        (e.addedAt || "") > combineTime);   // ← only entries added AFTER combining

      const drawingsLogged = logsWhileCombined
        .filter(e => (e.intendedType || e.type || "").replace(" (combined)", "") === drawingsTask)
        .reduce((s, e) => s + Number(e.hours || 0), 0);
      const studiesLogged = logsWhileCombined
        .filter(e => (e.intendedType || e.type || "").replace(" (combined)", "") === "Design Studies")
        .reduce((s, e) => s + Number(e.hours || 0), 0);

      const timeLoggedTotal = drawingsLogged + studiesLogged;
      const manualExtra     = Math.max(0, currentAc - snapAcTotal - timeLoggedTotal);

      r1.ac = snapAc1 + drawingsLogged + manualExtra;
      r2.ac = snapAc2 + studiesLogged;

      // Re-point studies log entries to r2 now it's a separate row again
      logsWhileCombined
        .filter(e => (e.intendedType || e.type || "").replace(" (combined)", "") === "Design Studies")
        .forEach(e => { e.phaseRowId = r2.id; });

      // ---- PCT: if snapshot was 0/0 and user set a % while combined, apply to both ----
      if ((Number(snap.pct1)||0) === 0 && (Number(snap.pct2)||0) === 0 && currentPct > 0) {
        r1.pct = currentPct;
        r2.pct = currentPct;
      } else {
        r1.pct = Number(snap.pct1)||0;
        r2.pct = Number(snap.pct2)||0;
      }

      // ---- ETC: distribute by BAC ratio ----
      const etcVal = (currentEtc===""||currentEtc===null) ? null : Number(currentEtc);
      if (etcVal !== null && snapBacTotal > 0) {
        r1.etc = Math.round(etcVal * (snapBac1 / snapBacTotal));
        r2.etc = etcVal - r1.etc;
      } else {
        r1.etc = snap.etc1;
        r2.etc = snap.etc2;
      }

      delete project.combineSnapshots[group];
      toast(`${group}: split — Drawings AC ${r1.ac}, Studies AC ${r2.ac}`);
    } else {
      toast(`${group}: rows split`);
    }
  }
  saveState();
  renderProject();
}

/* ---------------------------------------------------------------------- */
/* Row add / delete                                                       */
/* ---------------------------------------------------------------------- */
function deleteRow(idx) {
  const project = getCurrentProject();
  const row     = project.phases[idx];
  if (!row || !row.isCustom) return;
  if (!confirm(`Remove row "${row.task}"?`)) return;
  project.phases.splice(idx, 1);
  saveState();
  renderProject();
}

function addRow(task, group) {
  const project = getCurrentProject();
  if (!project) return;
  const newRow = {
    id: "custom_" + Math.random().toString(36).slice(2, 10),
    group, task, bac: 0, ac: 0, pct: 0, etc: "", isCustom: true,
  };
  let insertAt = -1;
  for (let i = 0; i < project.phases.length; i++)
    if (project.phases[i].group === group) insertAt = i;
  if (insertAt === -1) project.phases.push(newRow);
  else                 project.phases.splice(insertAt + 1, 0, newRow);
  saveState();
  renderProject();
  toast(`Row "${task}" added to ${group}`);
}

/* ---------------------------------------------------------------------- */
/* Project CRUD                                                           */
/* ---------------------------------------------------------------------- */
function addProject() {
  const name = `Project ${STATE.nextProjectNumber++}`;
  STATE.projects.push(makeProject(name));
  saveState();
  renderDashboard();
  populateTimeLogForm();
  toast(`${name} added`);
}

function renameProject(newName) {
  const project = getCurrentProject();
  if (!project) return;
  project.name = newName.trim() || project.name;
  saveState();
}

function deleteProject() {
  const project = getCurrentProject();
  if (!project) return;
  if (!confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
  STATE.projects = STATE.projects.filter(p => p.id !== project.id);
  saveState();
  currentProjectId = null;
  renderDashboard();
  populateTimeLogForm();
  toast("Project deleted");
}

/* ---------------------------------------------------------------------- */
/* TIME LOG                                                               */
/* ---------------------------------------------------------------------- */

// Types per stage - Optional has its own task list, others get Drawings/Studies
const STAGE_TYPES = {
  "Optional": ["BOM Generation", "Construction Support", "Commissioning Support"],
  "__default": ["Design Drawings", "Design Studies"],
};

function populateTimeLogForm() {
  // Team member dropdown
  const tlMember = document.getElementById("tlMember");
  tlMember.innerHTML = TEAM_MEMBERS.map(m =>
    `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  // Default date to today
  document.getElementById("tlDate").value = new Date().toISOString().split("T")[0];

  // Project dropdown
  refreshTimeLogProjectDropdown();

  // Stage dropdown
  const tlStage = document.getElementById("tlStage");
  tlStage.innerHTML = GROUPS.map(g =>
    `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");

  // Update type dropdown when stage changes
  tlStage.addEventListener("change", refreshTypeDropdown);
  refreshTypeDropdown();

  // Filter dropdowns in history panel
  const filterMember = document.getElementById("tlFilterMember");
  filterMember.innerHTML = `<option value="">All Members</option>` +
    TEAM_MEMBERS.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");

  // Team member list display
  const teamList = document.getElementById("teamMemberList");
  teamList.innerHTML = TEAM_MEMBERS.map(m => `
    <div class="team-member-chip">
      <span class="team-avatar">${m.charAt(0)}</span>
      <span>${escapeHtml(m)}</span>
    </div>`).join("");
}

function refreshTimeLogProjectDropdown() {
  const tlProject = document.getElementById("tlProject");
  const filterProject = document.getElementById("tlFilterProject");
  const opts = STATE.projects.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  tlProject.innerHTML = opts;
  filterProject.innerHTML = `<option value="">All Projects</option>` + opts;
}

function refreshTypeDropdown() {
  const stage = document.getElementById("tlStage").value;
  const types = STAGE_TYPES[stage] || STAGE_TYPES["__default"];
  document.getElementById("tlType").innerHTML =
    types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
}

function renderTimeLogView() {
  showView("timeLog");
  updateSyncToggleUI();

  // Apply filters
  const filterMember  = document.getElementById("tlFilterMember").value;
  const filterProject = document.getElementById("tlFilterProject").value;

  const logs = (STATE.timeLogs || []).filter(entry => {
    if (filterMember  && entry.member    !== filterMember)  return false;
    if (filterProject && entry.projectId !== filterProject) return false;
    return true;
  });

  const body = document.getElementById("timeLogBody");
  body.innerHTML = "";

  if (logs.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">
      No entries yet. Use the form on the left to log hours.</td></tr>`;
  } else {
    logs.forEach(entry => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${entry.date}</td>
        <td><span class="team-avatar sm">${(entry.member||"?").charAt(0)}</span> ${escapeHtml(entry.member)}</td>
        <td class="num"><strong>${entry.hours}</strong></td>
        <td>${escapeHtml(entry.projectName)}</td>
        <td><span class="group-tag">${escapeHtml(entry.stage)}</span></td>
        <td>${escapeHtml(entry.type)}</td>
        <td><button class="row-delete-btn" data-log-id="${entry.id}" title="Delete entry">🗑</button></td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll("[data-log-id]").forEach(btn =>
      btn.addEventListener("click", () => deleteLogEntry(btn.dataset.logId)));
  }

  // Totals row
  const totalHours = logs.reduce((s, e) => s + Number(e.hours || 0), 0);
  document.getElementById("tlTotalsRow").innerHTML =
    logs.length > 0
      ? `<span>Showing <strong>${logs.length}</strong> entries &nbsp;|&nbsp; Total: <strong>${totalHours.toFixed(1)} hrs</strong></span>`
      : "";
}

function addTimeLogEntry() {
  const member    = document.getElementById("tlMember").value;
  const date      = document.getElementById("tlDate").value;
  const hours     = Number(document.getElementById("tlHours").value);
  const projectId = document.getElementById("tlProject").value;
  const stage     = document.getElementById("tlStage").value;
  const type      = document.getElementById("tlType").value;

  if (!member || !date || !hours || hours <= 0 || !projectId || !stage || !type) {
    toast("Please fill in all fields with valid values.");
    return;
  }

  const project = STATE.projects.find(p => p.id === projectId);
  if (!project) { toast("Project not found."); return; }

  // Find the matching phase row to add AC hours to.
  // For Record stage "Design Drawings" maps to "Record Drawings" in the data.
  let taskName = type;
  if (type === "Design Drawings" && stage === "Record") taskName = "Record Drawings";

  // If this group has combine active, all hours go to the first (combined) row
  const combined = !!project.combinedCells[stage];
  let targetRow;
  if (combined) {
    targetRow = project.phases.find(r => r.group === stage);
  } else {
    targetRow = project.phases.find(r => r.group === stage && r.task === taskName);
  }

  if (!targetRow) {
    toast(`Could not find "${stage} → ${taskName}" in this project. Check the project has that stage.`);
    return;
  }

  // Increment AC on the matching phase row
  targetRow.ac = (Number(targetRow.ac) || 0) + hours;

  // Store the log entry in STATE.timeLogs
  if (!STATE.timeLogs) STATE.timeLogs = [];
  STATE.timeLogs.unshift({
    id:           "log_" + Math.random().toString(36).slice(2, 10),
    date,
    member,
    hours,
    projectId,
    projectName:  project.name,
    stage,
    type:         combined ? `${taskName} (combined)` : taskName,
    intendedType: taskName,   // always the clean task name, used by split to route AC correctly
    phaseRowId:   targetRow.id,
    addedAt:      new Date().toISOString(),
  });

  saveState();

  // Refresh whatever is currently visible:
  // - If on the project view for this project, refresh the full project
  // - Always refresh the dashboard row for this project so totals update
  //   instantly even if the user is on the Time Log or Dashboard tab
  if (currentProjectId === projectId) renderProject();
  refreshDashboardRow(project);

  // Reset hours field, keep everything else for quick repeated entries
  document.getElementById("tlHours").value = "";

  renderTimeLogView();
  toast(`✅ ${hours} hrs added to ${project.name} → ${stage} → ${combined ? taskName + " (combined)" : taskName}`);
}

/* Update just the one row in the dashboard table for a project, without
   re-rendering the whole dashboard (which would cause a flash). */
function refreshDashboardRow(project) {
  const row = document.querySelector(`#dashboardBody tr td.proj-name[data-id="${project.id}"]`);
  if (!row) return;  // dashboard not visible, nothing to do
  const tr  = row.closest("tr");
  const t   = projectTotals(project);
  const cls = statusClass(t.status);
  tr.className = "row-" + cls;
  const cells = tr.querySelectorAll("td");
  if (cells.length < 7) return;
  cells[1].textContent = fmt0(t.totalBac);
  cells[2].textContent = fmt0(t.totalAc);
  cells[3].textContent = fmtPct(t.overallPct);
  cells[4].textContent = fmt0(t.totalEac);
  cells[5].textContent = fmtSigned(t.totalVariance);
  cells[6].innerHTML   = `<span class="badge ${cls}"><span class="dot ${cls}"></span>${t.status}</span>`;
}

function deleteLogEntry(logId) {
  const idx   = STATE.timeLogs.findIndex(e => e.id === logId);
  if (idx === -1) return;
  const entry = STATE.timeLogs[idx];

  const syncOn = STATE.tlSyncDelete !== false;
  const confirmMsg = syncOn
    ? `Remove ${entry.hours} hrs logged by ${entry.member} on ${entry.date}?\n\nSync Delete is ON — those hours will also be deducted from the project's Actual Hours.`
    : `Remove ${entry.hours} hrs logged by ${entry.member} on ${entry.date}?\n\nSync Delete is OFF — the log entry will be removed but the project's Actual Hours will NOT change.`;

  if (!confirm(confirmMsg)) return;

  if (syncOn) {
    // Subtract from the matching phase's AC
    const project = STATE.projects.find(p => p.id === entry.projectId);
    if (project) {
      const row = project.phases.find(r => r.id === entry.phaseRowId);
      if (row) row.ac = Math.max(0, (Number(row.ac) || 0) - entry.hours);
      if (currentProjectId === project.id) renderProject();
      refreshDashboardRow(project);
    }
  }

  STATE.timeLogs.splice(idx, 1);
  saveState();
  renderTimeLogView();
  toast(syncOn ? "Log entry removed and hours deducted" : "Log entry removed (hours kept in project)");
}

/* ---------------------------------------------------------------------- */
/* Sync Delete toggle                                                     */
/* ---------------------------------------------------------------------- */
function updateSyncToggleUI() {
  const btn = document.getElementById("btnSyncToggle");
  if (!btn) return;
  const on = STATE.tlSyncDelete !== false;
  btn.textContent = on ? "🔗 Sync Delete: ON" : "🔗 Sync Delete: OFF";
  btn.className   = `btn small sync-toggle ${on ? "sync-on" : "sync-off"}`;
  btn.title = on
    ? "ON: deleting a log entry also subtracts hours from the project's Actual Hours"
    : "OFF: deleting a log entry only removes the record — project hours are unchanged";
}

/* ---------------------------------------------------------------------- */
/* Export / Import                                                        */
/* ---------------------------------------------------------------------- */
async function exportExcel(projects) {
  toast("Generating Excel file...");
  const res = await fetch("/api/export/excel", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects, timeLogs: STATE.timeLogs || [] }),
  });
  await downloadBlob(res, "project_hours_eac.xlsx");
}

async function exportProjectPdf(projects) {
  toast("Generating Project PDF...");
  const res = await fetch("/api/export/pdf", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  await downloadBlob(res, "project_hours_eac.pdf");
}

async function exportTimeLogPdf() {
  const logs = STATE.timeLogs || [];
  if (logs.length === 0) { toast("No time log entries to export."); return; }
  toast("Generating Time Log PDF...");
  const res = await fetch("/api/export/pdf/timelog", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeLogs: logs }),
  });
  await downloadBlob(res, "time_log.pdf");
}
function showPicker(title, preselectAll, callback) {
  pickerCallback = callback;
  document.getElementById("pickerTitle").textContent = title;
  const list = document.getElementById("pickerList");
  list.innerHTML = STATE.projects.map(p => {
    const t = projectTotals(p), cls = statusClass(t.status);
    return `<div class="picker-item">
      <input type="checkbox" id="pick_${p.id}" value="${p.id}" ${preselectAll ? "checked" : ""}>
      <label for="pick_${p.id}">
        ${escapeHtml(p.name)}
        <span class="picker-sub">${fmt0(t.totalBac)} planned hrs &middot;
          <span class="badge ${cls}" style="font-size:10px;padding:1px 7px;">${t.status}</span>
        </span>
      </label>
    </div>`;
  }).join("");
  list.querySelectorAll(".picker-item").forEach(item =>
    item.addEventListener("click", e => {
      if (e.target.tagName === "INPUT") return;
      const cb = item.querySelector("input"); cb.checked = !cb.checked;
    }));
  toggleModal("pickerModal", true);
}

/* ---------------------------------------------------------------------- */
/* Export / Import                                                        */
/* ---------------------------------------------------------------------- */
async function exportExcel(projects) {
  toast("Generating Excel file...");
  // Include timeLogs in the payload so the server can add a Time Log sheet
  const res = await fetch("/api/export/excel", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects, timeLogs: STATE.timeLogs || [] }),
  });
  await downloadBlob(res, "project_hours_eac.xlsx");
}

async function exportPdf(projects) {
  toast("Generating PDF report...");
  const res = await fetch("/api/export/pdf", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  await downloadBlob(res, "project_hours_eac.pdf");
}

async function downloadBlob(res, fallbackName) {
  if (!res.ok) { toast("Export failed."); return; }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = fallbackName;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast("Download started");
}

function exportJson(projects) {
  const exportData = { nextProjectNumber: STATE.nextProjectNumber, projects, timeLogs: STATE.timeLogs || [] };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = "project_hours_eac_data.json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(`JSON exported (${projects.length} project${projects.length !== 1 ? "s" : ""})`);
}

function resetSelected(projects) {
  const names = projects.map(p => `"${p.name}"`).join(", ");
  if (!confirm(`Reset data for ${names}?\n\nThis will clear all hours and cannot be undone.`)) return;
  const ids = new Set(projects.map(p => p.id));
  STATE.projects = STATE.projects.map(p => ids.has(p.id) ? makeProject(p.name) : p);
  // Also remove time log entries for reset projects
  STATE.timeLogs = (STATE.timeLogs || []).filter(e => !ids.has(e.projectId));
  saveState();
  if (currentProjectId && ids.has(currentProjectId)) renderProject();
  renderDashboard();
  toast(`Reset ${projects.length} project${projects.length !== 1 ? "s" : ""}`);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.projects || !Array.isArray(parsed.projects)) throw new Error("Invalid file format");
      STATE = parsed;
      backfillState();
      saveState();
      currentProjectId = null;
      populateTimeLogForm();
      renderDashboard();
      toast("Data imported successfully");
    } catch (err) {
      alert("Could not import file: " + err.message);
    }
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------- */
/* Misc helpers                                                           */
/* ---------------------------------------------------------------------- */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
}

function toggleModal(id, show) {
  document.getElementById(id).classList.toggle("hidden", !show);
}

/* ---------------------------------------------------------------------- */
/* Event bindings                                                         */
/* ---------------------------------------------------------------------- */
function bindGlobalEvents() {
  // Nav
  document.getElementById("btnDashboard").addEventListener("click", renderDashboard);
  document.getElementById("btnTimeLog").addEventListener("click", () => {
    refreshTimeLogProjectDropdown();
    renderTimeLogView();
  });
  document.getElementById("btnAddProject").addEventListener("click", addProject);

  // Project view
  document.getElementById("btnBack").addEventListener("click", renderDashboard);
  document.getElementById("btnDeleteProject").addEventListener("click", deleteProject);
  document.getElementById("projectNameInput").addEventListener("input", e => renameProject(e.target.value));
  document.getElementById("projectNameInput").addEventListener("blur", renderDashboard);
  document.getElementById("notesArea").addEventListener("input", e => {
    const p = getCurrentProject();
    if (p) { p.notes = e.target.value; saveState(); }
  });

  // Add Row modal
  document.getElementById("btnAddRow").addEventListener("click", () => {
    document.getElementById("newRowTask").value = "";
    toggleModal("addRowModal", true);
  });
  document.getElementById("closeAddRow").addEventListener("click", () => toggleModal("addRowModal", false));
  document.getElementById("btnConfirmAddRow").addEventListener("click", () => {
    const task  = document.getElementById("newRowTask").value.trim();
    const group = document.getElementById("newRowGroup").value;
    if (!task) { alert("Please enter a task name."); return; }
    addRow(task, group);
    toggleModal("addRowModal", false);
  });

  // Time Log
  document.getElementById("btnAddLog").addEventListener("click", addTimeLogEntry);
  document.getElementById("tlFilterMember").addEventListener("change", renderTimeLogView);
  document.getElementById("tlFilterProject").addEventListener("change", renderTimeLogView);
  document.getElementById("btnClearFilter").addEventListener("click", () => {
    document.getElementById("tlFilterMember").value  = "";
    document.getElementById("tlFilterProject").value = "";
    renderTimeLogView();
  });

  // Export buttons
  document.getElementById("btnExportExcel").addEventListener("click", () =>
    showPicker("Export to Excel — select projects", false, projects => exportExcel(projects)));
  document.getElementById("btnExportProjectPdf").addEventListener("click", () =>
    showPicker("Project PDF — select projects", false, projects => exportProjectPdf(projects)));
  document.getElementById("btnExportTimeLogPdf").addEventListener("click", exportTimeLogPdf);
  document.getElementById("btnExportJson").addEventListener("click", () =>
    showPicker("Export JSON — select projects", false, projects => exportJson(projects)));
  document.getElementById("btnReset").addEventListener("click", () =>
    showPicker("Reset Data — select projects to reset", false, projects => resetSelected(projects)));

  // Sync Delete toggle
  document.getElementById("btnSyncToggle").addEventListener("click", () => {
    STATE.tlSyncDelete = STATE.tlSyncDelete === false ? true : false;
    saveState();
    updateSyncToggleUI();
    toast(`Sync Delete: ${STATE.tlSyncDelete ? "ON — deletes will deduct hours" : "OFF — deletes keep project hours"}`);
  });
  document.getElementById("fileImport").addEventListener("change", e => {
    const file = e.target.files[0];
    if (file) importJson(file);
    e.target.value = "";
  });

  // Glossary
  document.getElementById("btnGlossary").addEventListener("click", () => toggleModal("glossaryModal", true));
  document.getElementById("closeGlossary").addEventListener("click", () => toggleModal("glossaryModal", false));

  // Picker
  document.getElementById("closePicker").addEventListener("click", () => toggleModal("pickerModal", false));
  document.getElementById("pickerSelectAll").addEventListener("click", () =>
    document.querySelectorAll("#pickerList input[type=checkbox]").forEach(cb => cb.checked = true));
  document.getElementById("pickerSelectNone").addEventListener("click", () =>
    document.querySelectorAll("#pickerList input[type=checkbox]").forEach(cb => cb.checked = false));
  document.getElementById("btnPickerConfirm").addEventListener("click", () => {
    const selected = [...document.querySelectorAll("#pickerList input[type=checkbox]:checked")]
      .map(cb => STATE.projects.find(p => p.id === cb.value)).filter(Boolean);
    if (selected.length === 0) { toast("Please select at least one project."); return; }
    toggleModal("pickerModal", false);
    if (pickerCallback) pickerCallback(selected);
  });

  // Close modals on backdrop click
  document.querySelectorAll(".modal-overlay").forEach(overlay =>
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.add("hidden"); }));
}

document.addEventListener("DOMContentLoaded", init);
