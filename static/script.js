/* ===========================================================================
   Project Hours EAC Tracker - script.js
   ---------------------------------------------------------------------------
   Everything lives in localStorage under the key STORAGE_KEY.
   Data shape:
   {
     nextProjectNumber: 6,
     projects: [
       {
         id: "p1",
         name: "Project 1",
         notes: "",
         phases: [
           { id: "0", group: "30% Design", task: "Design Drawings",
             bac: 416, ac: 0, pct: 0, etc: "" },
           ...
         ]
       },
       ...
     ]
   }
   =========================================================================== */

const STORAGE_KEY = "eacTrackerData";
let PHASES_TEMPLATE = [];
let GROUPS = [];
let STATE = null;
let currentProjectId = null;

// Project picker state
let pickerCallback = null;  // function(selectedProjects) called after confirm

/* ---------------------------------------------------------------------- */
/* Bootstrapping                                                          */
/* ---------------------------------------------------------------------- */
async function init() {
  await loadPhaseTemplate();
  await loadGroups();
  loadState();
  bindGlobalEvents();
  renderDashboard();
}

async function loadGroups() {
  const res = await fetch("/api/groups");
  GROUPS = await res.json();
  const select = document.getElementById("newRowGroup");
  select.innerHTML = GROUPS.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
}

async function loadPhaseTemplate() {
  const res = await fetch("/api/phases");
  PHASES_TEMPLATE = await res.json();
}

function blankPhasesForProject() {
  return PHASES_TEMPLATE.map(p => ({
    id: p.id,
    group: p.group,
    task: p.task,
    bac: 0,
    ac: 0,
    pct: 0,
    etc: "",
    isCustom: false
  }));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      STATE = JSON.parse(raw);
      // Safety: make sure projects/phase arrays exist
      if (!STATE.projects) STATE.projects = [];
      // Back-fill combinedCells for data saved before this feature existed,
      // and migrate the old "combinedAC" key (partial AC-only merge) name.
      STATE.projects.forEach(p => {
        if (!p.combinedCells) p.combinedCells = p.combinedAC || {};
        delete p.combinedAC;
        if (!p.combineSnapshots) p.combineSnapshots = {};
      });
      return;
    } catch (e) {
      console.warn("Corrupt saved data, resetting.", e);
    }
  }
  // First run -> create 5 default projects
  STATE = { nextProjectNumber: 6, projects: [] };
  for (let i = 1; i <= 5; i++) {
    STATE.projects.push(makeProject(`Project ${i}`));
  }
  saveState();
}

function makeProject(name) {
  return {
    id: "proj_" + Math.random().toString(36).slice(2, 10),
    name: name,
    notes: "",
    phases: blankPhasesForProject(),
    combinedCells: {},  // { "30% Design": true, ... } -> groups where Drawings + Studies are merged into one row
    combineSnapshots: {} // { "30% Design": {bac1,ac1,pct1,etc1,bac2,ac2,pct2,etc2} } -> original split values, so "Split Cells" can restore them exactly
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE));
}

/* ---------------------------------------------------------------------- */
/* EAC Calculations                                                       */
/* ---------------------------------------------------------------------- */
function calcRow(row) {
  const bac = Number(row.bac) || 0;
  const ac = Number(row.ac) || 0;
  const pct = Number(row.pct) || 0;
  const etcRaw = row.etc;
  const hasEtc = etcRaw !== "" && etcRaw !== null && etcRaw !== undefined && !isNaN(etcRaw);
  const etc = hasEtc ? Number(etcRaw) : null;

  const ev = bac * (pct / 100);
  const cpi = ac > 0 ? (ev / ac) : null;

  const eac1 = (cpi && cpi > 0) ? (bac / cpi) : null;
  const eac2 = ac + (bac - ev);
  const eac3 = hasEtc ? (ac + etc) : null;

  let eacMain, method;
  if (hasEtc) {
    eacMain = eac3; method = "Method 3";
  } else if (eac1 !== null) {
    eacMain = eac1; method = "Method 1";
  } else {
    eacMain = eac2; method = "Method 2";
  }

  const variance = eacMain - bac;

  return { ev, cpi, eac1, eac2, eac3, eacMain, method, variance };
}

function statusFor(variance, bac) {
  if (variance <= 0) return "On Track";
  if (bac > 0 && variance <= 0.10 * bac) return "Watch";
  return "Over Budget";
}

function statusClass(status) {
  if (status === "On Track") return "green";
  if (status === "Watch") return "yellow";
  return "red";
}

function projectTotals(project) {
  let totalBac = 0, totalAc = 0, totalEv = 0, totalEac = 0;
  project.phases.forEach(r => {
    const c = calcRow(r);
    totalBac += Number(r.bac) || 0;
    totalAc += Number(r.ac) || 0;
    totalEv += c.ev;
    totalEac += c.eacMain;
  });
  const overallPct = totalBac > 0 ? (totalEv / totalBac * 100) : 0;
  const overallCpi = totalAc > 0 ? (totalEv / totalAc) : null;
  const totalVariance = totalEac - totalBac;
  const status = statusFor(totalVariance, totalBac);
  return { totalBac, totalAc, totalEv, overallPct, overallCpi, totalEac, totalVariance, status };
}

/* Same rollup as projectTotals, but scoped to a single stage/group
   (e.g. "30% Design") - powers the per-stage status chips. */
function groupTotals(project, group) {
  let totalBac = 0, totalAc = 0, totalEv = 0, totalEac = 0;
  project.phases.filter(r => r.group === group).forEach(r => {
    const c = calcRow(r);
    totalBac += Number(r.bac) || 0;
    totalAc += Number(r.ac) || 0;
    totalEv += c.ev;
    totalEac += c.eacMain;
  });
  const variance = totalEac - totalBac;
  const status = statusFor(variance, totalBac);
  return { totalBac, totalAc, totalEv, totalEac, variance, status };
}

/* ---------------------------------------------------------------------- */
/* Number formatting helpers                                              */
/* ---------------------------------------------------------------------- */
const fmt1 = n => (n === null || n === undefined || isNaN(n)) ? "N/A" : n.toFixed(1);
const fmt0 = n => (n === null || n === undefined || isNaN(n)) ? "N/A" : Math.round(n).toString();
const fmt2 = n => (n === null || n === undefined || isNaN(n)) ? "N/A" : n.toFixed(2);
const fmtPct = n => (n === null || n === undefined || isNaN(n)) ? "0.0%" : n.toFixed(1) + "%";
const fmtSigned = n => (n === null || n === undefined || isNaN(n)) ? "N/A" : (n > 0 ? "+" : "") + Math.round(n);

/* ---------------------------------------------------------------------- */
/* Rendering: Dashboard                                                   */
/* ---------------------------------------------------------------------- */
function renderDashboard() {
  showView("dashboard");
  const body = document.getElementById("dashboardBody");
  body.innerHTML = "";

  STATE.projects.forEach(project => {
    const t = projectTotals(project);
    const cls = statusClass(t.status);
    const tr = document.createElement("tr");
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

  body.querySelectorAll("[data-id]").forEach(el => {
    el.addEventListener("click", () => openProject(el.dataset.id));
  });
}

/* ---------------------------------------------------------------------- */
/* Rendering: Project detail view                                         */
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
  document.getElementById("notesArea").value = project.notes || "";

  renderSummaryCards(project);
  renderStageStatus(project);
  renderPhasesTable(project);
}

function renderSummaryCards(project) {
  const t = projectTotals(project);
  const cls = statusClass(t.status);
  const wrap = document.getElementById("summaryCards");
  wrap.innerHTML = `
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
    </div>
  `;
}

/* Per-stage status row - one chip per group (30% Design, 60% Design,
   90%/IFP, IFC, Record, Optional) so progress/status can be tracked
   per stage in addition to the whole-project summary cards above. */
function renderStageStatus(project) {
  const wrap = document.getElementById("stageStatusRow");
  if (!wrap) return;
  const present = new Set(project.phases.map(r => r.group));
  const orderedGroups = GROUPS.filter(g => present.has(g));

  wrap.innerHTML = orderedGroups.map(g => {
    const t = groupTotals(project, g);
    const cls = statusClass(t.status);
    return `
      <div class="stage-chip">
        <div class="stage-chip-name">${escapeHtml(g)}</div>
        <span class="badge ${cls}"><span class="dot ${cls}"></span>${t.status}</span>
        <div class="stage-chip-sub">EAC ${fmt0(t.totalEac)} hrs &middot; Var ${fmtSigned(t.variance)}</div>
      </div>
    `;
  }).join("");
}

function renderPhasesTable(project) {
  const body = document.getElementById("phasesBody");
  body.innerHTML = "";

  let lastGroup = null;

  // Pre-count rows per group so we know which groups are eligible for the
  // "Combine Cells" toggle (only applies to the standard 2-row Drawings +
  // Studies groups - not Optional, and not groups that have had a custom
  // row added to them).
  const groupCounts = {};
  project.phases.forEach(r => { groupCounts[r.group] = (groupCounts[r.group] || 0) + 1; });

  project.phases.forEach((row, idx) => {
    const isFirstOfGroup = row.group !== lastGroup;
    lastGroup = row.group;

    const combinable = row.group !== "Optional" && groupCounts[row.group] === 2;
    const combined = combinable && !!project.combinedCells[row.group];

    // When a group is combined, the SECOND row (e.g. "Design Studies")
    // is fully absorbed into the first row's numbers at toggle-time, so
    // it's simply not rendered at all - the first row becomes the one
    // and only line for that whole stage, and all calculated columns
    // (EV, CPI, EAC 1/2/3, Variance) are computed on those combined
    // totals automatically since calcRow() just reads row.bac/ac/etc.
    if (combinable && combined && !isFirstOfGroup) return;

    const c = calcRow(row);
    const cls = statusClass(statusFor(c.variance, Number(row.bac) || 0));

    const tr = document.createElement("tr");
    tr.dataset.rowIdx = idx; // lookup key for partial updates, robust even when rows are skipped
    if (isFirstOfGroup) tr.classList.add("group-start");

    // ---- Group / combine-toggle cell ----
    let groupCell = "";
    if (isFirstOfGroup) {
      groupCell = `<span class="group-tag">${escapeHtml(row.group)}</span>`;
      if (combinable) {
        groupCell += `<button class="combine-toggle" data-group="${escapeHtml(row.group)}">
          ${combined ? "↔ Split Cells" : "⇄ Combine Cells"}
        </button>`;
      }
    }

    const taskLabel = combined ? `${escapeHtml(row.task)} <span class="combined-pill">combined</span>` : escapeHtml(row.task);

    tr.innerHTML = `
      <td>${groupCell}</td>
      <td>${taskLabel}</td>
      <td><input type="number" min="0" step="1" class="cell-input" data-field="bac" data-idx="${idx}" value="${row.bac ?? 0}"></td>
      <td><input type="number" min="0" step="1" class="cell-input" data-field="ac" data-idx="${idx}" value="${row.ac ?? 0}"></td>
      <td><input type="number" min="0" max="100" step="1" class="cell-input" data-field="pct" data-idx="${idx}" value="${row.pct ?? 0}"></td>
      <td><input type="number" min="0" step="1" class="cell-input" data-field="etc" data-idx="${idx}" value="${row.etc ?? ""}" placeholder="-"></td>
      <td class="num calc-val" data-role="ev">${fmt0(c.ev)}</td>
      <td class="num calc-val" data-role="cpi">${c.cpi !== null ? fmt2(c.cpi) : '<span class="muted">N/A</span>'}</td>
      <td class="num calc-val" data-role="eac1">${c.eac1 !== null ? fmt0(c.eac1) : '<span class="muted">N/A</span>'}</td>
      <td class="num calc-val" data-role="eac2">${fmt0(c.eac2)}</td>
      <td class="num calc-val" data-role="eac3">${c.eac3 !== null ? fmt0(c.eac3) : '<span class="muted">-</span>'}</td>
      <td class="num" data-role="variance"><span class="eac-main badge ${cls}">${fmtSigned(c.variance)}</span></td>
      <td>${row.isCustom ? `<button class="row-delete-btn" data-del-idx="${idx}" title="Remove row">🗑</button>` : ""}</td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll("input.cell-input").forEach(input => {
    input.addEventListener("input", onCellEdit);
    input.addEventListener("blur", onCellBlur);
  });

  body.querySelectorAll(".row-delete-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteRow(Number(btn.dataset.delIdx)));
  });

  body.querySelectorAll(".combine-toggle").forEach(btn => {
    btn.addEventListener("click", () => toggleCombineCells(btn.dataset.group));
  });
}

function getGroupRowIndices(project, group) {
  const idxs = [];
  project.phases.forEach((r, i) => { if (r.group === group) idxs.push(i); });
  return idxs;
}

function toggleCombineCells(group) {
  const project = getCurrentProject();
  const idxs = getGroupRowIndices(project, group);
  if (idxs.length !== 2) return;

  const turningOn = !project.combinedCells[group];
  project.combinedCells[group] = turningOn;

  const r1 = project.phases[idxs[0]];
  const r2 = project.phases[idxs[1]];

  if (turningOn) {
    // Remember exactly what was in each row before merging, so "Split
    // Cells" can put it back later instead of just leaving the second
    // row at zero.
    project.combineSnapshots[group] = {
      bac1: r1.bac, ac1: r1.ac, pct1: r1.pct, etc1: r1.etc,
      bac2: r2.bac, ac2: r2.ac, pct2: r2.pct, etc2: r2.etc,
    };

    const bac1 = Number(r1.bac) || 0, bac2 = Number(r2.bac) || 0;
    const ac1 = Number(r1.ac) || 0, ac2 = Number(r2.ac) || 0;
    const pct1 = Number(r1.pct) || 0, pct2 = Number(r2.pct) || 0;
    const totalBac = bac1 + bac2;
    const combinedPct = totalBac > 0 ? ((bac1 * pct1 + bac2 * pct2) / totalBac) : 0;

    const etc1 = (r1.etc === "" || r1.etc === null) ? null : Number(r1.etc);
    const etc2 = (r2.etc === "" || r2.etc === null) ? null : Number(r2.etc);
    const combinedEtc = (etc1 === null && etc2 === null) ? "" : (etc1 || 0) + (etc2 || 0);

    r1.bac = totalBac;
    r1.ac = ac1 + ac2;
    r1.pct = Math.round(combinedPct * 10) / 10;
    r1.etc = combinedEtc;

    r2.bac = 0; r2.ac = 0; r2.pct = 0; r2.etc = "";

    toast(`${group}: rows combined into one`);
  } else {
    // Restore the original split values if we have them saved. If for
    // some reason there's no snapshot (e.g. old data), fall back to the
    // previous zero-out behavior so the app doesn't break.
    const snap = project.combineSnapshots[group];
    if (snap) {
      r1.bac = snap.bac1; r1.ac = snap.ac1; r1.pct = snap.pct1; r1.etc = snap.etc1;
      r2.bac = snap.bac2; r2.ac = snap.ac2; r2.pct = snap.pct2; r2.etc = snap.etc2;
      delete project.combineSnapshots[group];
      toast(`${group}: rows split back to their original hours`);
    } else {
      toast(`${group}: rows split apart - you'll need to re-enter each one's hours`);
    }
  }

  saveState();
  renderProject();
}

function deleteRow(idx) {
  const project = getCurrentProject();
  const row = project.phases[idx];
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
    group: group,
    task: task,
    bac: 0, ac: 0, pct: 0, etc: "",
    isCustom: true
  };
  // Insert right after the last existing row of the same group so it
  // displays grouped together, instead of always landing at the bottom.
  let insertAt = -1;
  for (let i = 0; i < project.phases.length; i++) {
    if (project.phases[i].group === group) insertAt = i;
  }
  if (insertAt === -1) {
    project.phases.push(newRow);
  } else {
    project.phases.splice(insertAt + 1, 0, newRow);
  }
  saveState();
  renderProject();
  toast(`Row "${task}" added to ${group}`);
}

function onCellBlur(e) {
  const project = getCurrentProject();
  const field = e.target.dataset.field;

  // Clamp/sanitize once the user leaves the field, so typing isn't
  // interrupted but out-of-range values still get corrected.
  const idx = Number(e.target.dataset.idx);
  let val = project.phases[idx][field];

  if (field === "pct") {
    val = Math.max(0, Math.min(100, Number(val) || 0));
  } else if (field === "bac" || field === "ac") {
    val = Math.max(0, Number(val) || 0);
  } else if (field === "etc") {
    val = (val === "" || val === null) ? "" : Math.max(0, Number(val) || 0);
  }
  project.phases[idx][field] = val;
  e.target.value = val;

  saveState();
  updateRowCalculations(idx);
  renderSummaryCards(project);
  renderStageStatus(project);
}

function onCellEdit(e) {
  const project = getCurrentProject();
  const field = e.target.dataset.field;
  const idx = Number(e.target.dataset.idx);
  const rawVal = e.target.value;

  // Store the raw value as typed (don't clamp/round while the user is
  // still typing - that's what was causing focus to drop after 1 digit,
  // since clamping + a full table re-render replaced the input element).
  if (field === "etc") {
    project.phases[idx].etc = rawVal === "" ? "" : Number(rawVal);
  } else {
    project.phases[idx][field] = rawVal === "" ? 0 : Number(rawVal);
  }

  saveState();

  // Update only this row's calculated (read-only) cells + the summary
  // cards, WITHOUT touching any <input> elements, so focus/cursor
  // position is preserved and the user can keep typing uninterrupted.
  updateRowCalculations(idx);
  renderSummaryCards(project);
  renderStageStatus(project);
}

function updateRowCalculations(idx) {
  const project = getCurrentProject();
  const row = project.phases[idx];
  const c = calcRow(row);
  const cls = statusClass(statusFor(c.variance, Number(row.bac) || 0));

  // Looked up via data-row-idx (not positional index) since combined
  // groups skip rendering their second row entirely, so DOM row order
  // no longer lines up 1:1 with the phases array.
  const tr = document.querySelector(`#phasesBody tr[data-row-idx="${idx}"]`);
  if (!tr) return;

  tr.querySelector('[data-role="ev"]').innerHTML = fmt0(c.ev);
  tr.querySelector('[data-role="cpi"]').innerHTML = c.cpi !== null ? fmt2(c.cpi) : '<span class="muted">N/A</span>';
  tr.querySelector('[data-role="eac1"]').innerHTML = c.eac1 !== null ? fmt0(c.eac1) : '<span class="muted">N/A</span>';
  tr.querySelector('[data-role="eac2"]').innerHTML = fmt0(c.eac2);
  tr.querySelector('[data-role="eac3"]').innerHTML = c.eac3 !== null ? fmt0(c.eac3) : '<span class="muted">-</span>';
  tr.querySelector('[data-role="variance"]').innerHTML = `<span class="eac-main badge ${cls}">${fmtSigned(c.variance)}</span>`;
}

/* ---------------------------------------------------------------------- */
/* View switching                                                         */
/* ---------------------------------------------------------------------- */
function showView(view) {
  document.getElementById("dashboardView").classList.toggle("hidden", view !== "dashboard");
  document.getElementById("projectView").classList.toggle("hidden", view !== "project");
  document.getElementById("btnDashboard").classList.toggle("active", view === "dashboard");
}

/* ---------------------------------------------------------------------- */
/* Project CRUD                                                           */
/* ---------------------------------------------------------------------- */
function addProject() {
  const name = `Project ${STATE.nextProjectNumber}`;
  STATE.nextProjectNumber += 1;
  const project = makeProject(name);
  STATE.projects.push(project);
  saveState();
  renderDashboard();
  toast(`${name} added`);
}

function renameProject(newName) {
  const project = getCurrentProject();
  if (!project) return;
  const trimmed = newName.trim();
  project.name = trimmed || project.name;
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
  toast("Project deleted");
}

/* ---------------------------------------------------------------------- */
/* Project Picker                                                         */
/* ---------------------------------------------------------------------- */
function showPicker(title, preselectAll = true, callback) {
  pickerCallback = callback;
  document.getElementById("pickerTitle").textContent = title;

  const list = document.getElementById("pickerList");
  list.innerHTML = STATE.projects.map(p => {
    const t = projectTotals(p);
    const cls = statusClass(t.status);
    return `
      <div class="picker-item">
        <input type="checkbox" id="pick_${p.id}" value="${p.id}" ${preselectAll ? "checked" : ""}>
        <label for="pick_${p.id}">
          ${escapeHtml(p.name)}
          <span class="picker-sub">${fmt0(t.totalBac)} planned hrs &middot; <span class="badge ${cls}" style="font-size:10px;padding:1px 7px;">${t.status}</span></span>
        </label>
      </div>`;
  }).join("");

  // clicking the row toggles the checkbox
  list.querySelectorAll(".picker-item").forEach(item => {
    item.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return;
      const cb = item.querySelector("input");
      cb.checked = !cb.checked;
    });
  });

  toggleModal("pickerModal", true);
}

/* ---------------------------------------------------------------------- */
/* Export / Import                                                        */
/* ---------------------------------------------------------------------- */
async function exportExcel(projects) {
  toast("Generating Excel file...");
  const res = await fetch("/api/export/excel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects })
  });
  await downloadBlob(res, "project_hours_eac.xlsx");
}

async function exportPdf(projects) {
  toast("Generating PDF report...");
  const res = await fetch("/api/export/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects })
  });
  await downloadBlob(res, "project_hours_eac.pdf");
}

async function downloadBlob(res, fallbackName) {
  if (!res.ok) { toast("Export failed."); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Download started");
}

function exportJson(projects) {
  const exportData = { nextProjectNumber: STATE.nextProjectNumber, projects };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "project_hours_eac_data.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`JSON exported (${projects.length} project${projects.length !== 1 ? "s" : ""})`);
}

function resetSelected(projects) {
  const names = projects.map(p => `"${p.name}"`).join(", ");
  if (!confirm(`Reset data for ${names}?\n\nThis will clear all hours and cannot be undone.`)) return;
  const ids = new Set(projects.map(p => p.id));
  STATE.projects = STATE.projects.map(p => {
    if (!ids.has(p.id)) return p;
    return makeProject(p.name);  // reset to blank phases, keep name
  });
  saveState();
  if (currentProjectId && ids.has(currentProjectId)) renderProject();
  renderDashboard();
  toast(`Reset ${projects.length} project${projects.length !== 1 ? "s" : ""}`);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed.projects || !Array.isArray(parsed.projects)) {
        throw new Error("Invalid file format");
      }
      STATE = parsed;
      saveState();
      currentProjectId = null;
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
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

/* ---------------------------------------------------------------------- */
/* Event bindings                                                         */
/* ---------------------------------------------------------------------- */
function bindGlobalEvents() {
  document.getElementById("btnDashboard").addEventListener("click", renderDashboard);
  document.getElementById("btnAddProject").addEventListener("click", addProject);
  document.getElementById("btnBack").addEventListener("click", renderDashboard);
  document.getElementById("btnDeleteProject").addEventListener("click", deleteProject);

  document.getElementById("projectNameInput").addEventListener("input", (e) => {
    renameProject(e.target.value);
    // live-update dashboard name without full re-render
  });
  document.getElementById("projectNameInput").addEventListener("blur", renderDashboard);

  document.getElementById("notesArea").addEventListener("input", (e) => {
    const project = getCurrentProject();
    if (project) { project.notes = e.target.value; saveState(); }
  });

  document.getElementById("btnExportExcel").addEventListener("click", () =>
    showPicker("Export to Excel — select projects", false, (projects) => exportExcel(projects)));

  document.getElementById("btnExportPdf").addEventListener("click", () =>
    showPicker("Export to PDF — select projects", false, (projects) => exportPdf(projects)));

  document.getElementById("btnExportJson").addEventListener("click", () =>
    showPicker("Export JSON — select projects", false, (projects) => exportJson(projects)));

  document.getElementById("btnReset").addEventListener("click", () =>
    showPicker("Reset Data — select projects to reset", false, (projects) => resetSelected(projects)));

  document.getElementById("fileImport").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importJson(file);
    e.target.value = "";
  });

  // Glossary modal
  document.getElementById("btnGlossary").addEventListener("click", () => toggleModal("glossaryModal", true));
  document.getElementById("closeGlossary").addEventListener("click", () => toggleModal("glossaryModal", false));

  // Add Row modal
  document.getElementById("btnAddRow").addEventListener("click", () => {
    document.getElementById("newRowTask").value = "";
    toggleModal("addRowModal", true);
  });
  document.getElementById("closeAddRow").addEventListener("click", () => toggleModal("addRowModal", false));
  document.getElementById("btnConfirmAddRow").addEventListener("click", () => {
    const task = document.getElementById("newRowTask").value.trim();
    const group = document.getElementById("newRowGroup").value;
    if (!task) { alert("Please enter a task name."); return; }
    addRow(task, group);
    toggleModal("addRowModal", false);
  });

  // Close modals by clicking the dark overlay
  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.add("hidden");
    });
  });

  // Project picker
  document.getElementById("closePicker").addEventListener("click", () => toggleModal("pickerModal", false));
  document.getElementById("pickerSelectAll").addEventListener("click", () => {
    document.querySelectorAll("#pickerList input[type=checkbox]").forEach(cb => cb.checked = true);
  });
  document.getElementById("pickerSelectNone").addEventListener("click", () => {
    document.querySelectorAll("#pickerList input[type=checkbox]").forEach(cb => cb.checked = false);
  });
  document.getElementById("btnPickerConfirm").addEventListener("click", () => {
    const selected = [...document.querySelectorAll("#pickerList input[type=checkbox]:checked")]
      .map(cb => STATE.projects.find(p => p.id === cb.value))
      .filter(Boolean);
    if (selected.length === 0) { toast("Please select at least one project."); return; }
    toggleModal("pickerModal", false);
    if (pickerCallback) pickerCallback(selected);
  });
}

function toggleModal(id, show) {
  document.getElementById(id).classList.toggle("hidden", !show);
}

document.addEventListener("DOMContentLoaded", init);
