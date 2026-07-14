"""
Project Hours EAC Tracker
==========================
Flask backend.

Responsibilities of this file:
  1. Serve the single-page app (index.html / style.css / script.js).
  2. Define the FIXED list of design phases (used to seed new projects
     on the frontend - see PHASES below, also exposed via /api/phases).
  3. Provide export endpoints:
       POST /api/export/excel  -> returns an .xlsx workbook (openpyxl)
       POST /api/export/pdf    -> returns a .pdf report (reportlab)
     Both endpoints receive the *current* project data (as JSON) from
     the browser's localStorage, build the file in-memory, and stream
     it back. No data is persisted server-side - localStorage in the
     browser is the single source of truth, per the spec.

All EAC math is duplicated (intentionally, simply) in script.js for the
live UI and again here for the exported files, so exports always match
what the user currently sees on screen.
"""

from flask import Flask, render_template, request, send_file, jsonify
from io import BytesIO
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

app = Flask(__name__)

# ---------------------------------------------------------------------------
# FIXED PHASE LIST
# ---------------------------------------------------------------------------
# Every project uses this exact same set of phases (taken from the
# Sun Lasso style estimate breakdown). Each entry is a (group, task) pair.
# This is sent to the frontend once via /api/phases so the JS only has to
# keep ONE copy of the list (here) instead of duplicating it.
# ---------------------------------------------------------------------------
PHASES = [
    # group                 task
    # Design phases (30%/60%/90%/IFC/Record) are each collapsed down to just
    # two rows: the drawings effort, and a single combined "Design Studies"
    # row covering all the engineering studies for that phase (ampacity,
    # grounding, load flow, short circuit, etc.) - no need to track every
    # individual study line separately.
    ("30% Design", "Design Drawings"),
    ("30% Design", "Design Studies"),

    ("60% Design", "Design Drawings"),
    ("60% Design", "Design Studies"),

    ("90% / IFP", "Design Drawings"),
    ("90% / IFP", "Design Studies"),

    ("IFC", "Design Drawings"),
    ("IFC", "Design Studies"),

    ("Record", "Record Drawings"),
    ("Record", "Design Studies"),

    # Optional items are not part of the Design/Studies split - each stays
    # its own line item.
    ("Optional", "BOM Generation"),
    ("Optional", "Construction Support"),
    ("Optional", "Commissioning Support"),
]

# Ordered list of valid groups - used to populate the "assign to phase"
# dropdown when a user adds a custom row.
GROUPS = ["30% Design", "60% Design", "90% / IFP", "IFC", "Record", "Optional"]


def phases_payload():
    """Return phases as a list of dicts, with a stable id per row."""
    return [
        {"id": f"{i}", "group": g, "task": t}
        for i, (g, t) in enumerate(PHASES)
    ]


# ---------------------------------------------------------------------------
# Shared calc helpers (mirrors script.js logic) - used for export accuracy
# ---------------------------------------------------------------------------
def calc_row(row):
    """Given a phase row dict with bac/ac/pct/etc, compute ev/cpi/eac1-3/eac/variance."""
    bac = float(row.get("bac") or 0)
    ac = float(row.get("ac") or 0)
    pct = float(row.get("pct") or 0)
    etc = row.get("etc", None)
    etc = float(etc) if etc not in (None, "",) else None

    ev = bac * (pct / 100.0)
    cpi = (ev / ac) if ac > 0 else None

    eac1 = (bac / cpi) if cpi else None
    eac2 = ac + (bac - ev)
    eac3 = (ac + etc) if etc is not None else None

    if etc is not None:
        eac_main = eac3
        method = "Method 3"
    elif eac1 is not None:
        eac_main = eac1
        method = "Method 1"
    else:
        eac_main = eac2
        method = "Method 2"

    variance = eac_main - bac

    return {
        "ev": ev, "cpi": cpi, "eac1": eac1, "eac2": eac2, "eac3": eac3,
        "eac_main": eac_main, "method": method, "variance": variance,
    }


def status_for(variance, bac):
    if variance <= 0:
        return "On Track"
    if bac > 0 and variance <= 0.10 * bac:
        return "Watch"
    return "Over Budget"


def project_totals(project):
    rows = project.get("phases", [])
    total_bac = sum(float(r.get("bac") or 0) for r in rows)
    total_ac = sum(float(r.get("ac") or 0) for r in rows)
    total_ev = 0.0
    total_eac = 0.0
    for r in rows:
        c = calc_row(r)
        total_ev += c["ev"]
        total_eac += c["eac_main"]
    overall_pct = (total_ev / total_bac * 100.0) if total_bac > 0 else 0.0
    overall_cpi = (total_ev / total_ac) if total_ac > 0 else None
    total_variance = total_eac - total_bac
    status = status_for(total_variance, total_bac)
    return {
        "total_bac": total_bac, "total_ac": total_ac, "overall_pct": overall_pct,
        "total_ev": total_ev, "overall_cpi": overall_cpi, "total_eac": total_eac,
        "total_variance": total_variance, "status": status,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/phases")
def api_phases():
    return jsonify(phases_payload())


@app.route("/api/groups")
def api_groups():
    return jsonify(GROUPS)


@app.route("/api/export/excel", methods=["POST"])
def export_excel():
    data = request.get_json(force=True)
    projects = data.get("projects", [])

    wb = Workbook()
    wb.remove(wb.active)

    header_fill = PatternFill(start_color="1F4E78", end_color="1F4E78", fill_type="solid")
    header_font = Font(color="FFFFFF", bold=True)
    group_fill = PatternFill(start_color="D9E1F2", end_color="D9E1F2", fill_type="solid")
    thin = Side(style="thin", color="CCCCCC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    summary_ws = wb.create_sheet("Dashboard")
    summary_headers = ["Project Name", "Total Planned Hours", "Total Actual Hours",
                        "Percent Complete", "Total EAC", "Variance", "Status"]
    summary_ws.append(summary_headers)
    for c in range(1, len(summary_headers) + 1):
        cell = summary_ws.cell(row=1, column=c)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

    for project in projects:
        t = project_totals(project)
        summary_ws.append([
            project.get("name", ""), round(t["total_bac"], 1), round(t["total_ac"], 1),
            f'{t["overall_pct"]:.1f}%', round(t["total_eac"], 1),
            round(t["total_variance"], 1), t["status"],
        ])
    for col in range(1, len(summary_headers) + 1):
        summary_ws.column_dimensions[get_column_letter(col)].width = 20

    cols = ["Group", "Task", "Planned (BAC)", "Actual (AC)", "% Complete",
            "ETC", "Earned (EV)", "CPI", "EAC Method 1", "EAC Method 2",
            "EAC Method 3", "EAC (used)", "Variance"]

    for project in projects:
        name = (project.get("name") or "Project")[:28]
        ws = wb.create_sheet(name)
        ws.append(cols)
        for c in range(1, len(cols) + 1):
            cell = ws.cell(row=1, column=c)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center")

        for r in project.get("phases", []):
            c = calc_row(r)
            row_vals = [
                r.get("group", ""), r.get("task", ""),
                r.get("bac") or 0, r.get("ac") or 0, r.get("pct") or 0,
                r.get("etc") if r.get("etc") not in (None, "") else "",
                round(c["ev"], 1),
                round(c["cpi"], 2) if c["cpi"] is not None else "N/A",
                round(c["eac1"], 1) if c["eac1"] is not None else "N/A",
                round(c["eac2"], 1),
                round(c["eac3"], 1) if c["eac3"] is not None else "",
                round(c["eac_main"], 1),
                round(c["variance"], 1),
            ]
            ws.append(row_vals)

        last_row = ws.max_row
        for row in ws.iter_rows(min_row=1, max_row=last_row, min_col=1, max_col=len(cols)):
            for cell in row:
                cell.border = border

        t = project_totals(project)
        ws.append([])
        ws.append(["TOTAL", "", round(t["total_bac"], 1), round(t["total_ac"], 1),
                   f'{t["overall_pct"]:.1f}%', "", round(t["total_ev"], 1),
                   round(t["overall_cpi"], 2) if t["overall_cpi"] else "N/A",
                   "", "", "", round(t["total_eac"], 1), round(t["total_variance"], 1)])
        total_row = ws.max_row
        for cell in ws[total_row]:
            cell.font = Font(bold=True)
            cell.fill = group_fill

        for col in range(1, len(cols) + 1):
            ws.column_dimensions[get_column_letter(col)].width = 18

        notes = project.get("notes", "")
        if notes:
            ws.append([])
            ws.append(["Notes:", notes])

    out = BytesIO()
    wb.save(out)
    out.seek(0)
    fname = f"project_hours_eac_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return send_file(out, as_attachment=True, download_name=fname,
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.route("/api/export/pdf", methods=["POST"])
def export_pdf():
    data = request.get_json(force=True)
    projects = data.get("projects", [])

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(letter),
                             leftMargin=0.4 * inch, rightMargin=0.4 * inch,
                             topMargin=0.4 * inch, bottomMargin=0.4 * inch)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("TitleX", parent=styles["Title"], fontSize=18)
    h2 = ParagraphStyle("H2", parent=styles["Heading2"], spaceBefore=10)
    normal = styles["Normal"]

    elements = []
    elements.append(Paragraph("Project Hours EAC Tracker - Report", title_style))
    elements.append(Paragraph(datetime.now().strftime("Generated %B %d, %Y %H:%M"), normal))
    elements.append(Spacer(1, 14))

    # Dashboard table
    elements.append(Paragraph("Dashboard Summary", h2))
    dash_data = [["Project", "Planned Hrs", "Actual Hrs", "% Complete", "Total EAC", "Variance", "Status"]]
    status_colors = {"On Track": colors.HexColor("#16a34a"),
                      "Watch": colors.HexColor("#ca8a04"),
                      "Over Budget": colors.HexColor("#dc2626")}
    row_status = []
    for project in projects:
        t = project_totals(project)
        dash_data.append([
            project.get("name", ""), f'{t["total_bac"]:.0f}', f'{t["total_ac"]:.0f}',
            f'{t["overall_pct"]:.1f}%', f'{t["total_eac"]:.0f}',
            f'{t["total_variance"]:+.0f}', t["status"],
        ])
        row_status.append(t["status"])

    dash_table = Table(dash_data, repeatRows=1)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E78")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
    ]
    for i, st in enumerate(row_status, start=1):
        style_cmds.append(("TEXTCOLOR", (6, i), (6, i), status_colors.get(st, colors.black)))
        style_cmds.append(("FONTNAME", (6, i), (6, i), "Helvetica-Bold"))
    dash_table.setStyle(TableStyle(style_cmds))
    elements.append(dash_table)
    elements.append(PageBreak())

    cols = ["Group", "Task", "BAC", "AC", "%Comp", "ETC", "EV", "CPI",
            "EAC-1", "EAC-2", "EAC-3", "EAC(used)", "Var"]

    for project in projects:
        elements.append(Paragraph(project.get("name", "Project"), h2))
        t = project_totals(project)
        elements.append(Paragraph(
            f'Overall % Complete: {t["overall_pct"]:.1f}% | Overall CPI: '
            f'{(f"{t['overall_cpi']:.2f}" if t["overall_cpi"] else "N/A")} | '
            f'Total EAC: {t["total_eac"]:.0f} hrs | Variance: {t["total_variance"]:+.0f} hrs | '
            f'Status: {t["status"]}', normal))
        elements.append(Spacer(1, 6))

        table_data = [cols]
        for r in project.get("phases", []):
            c = calc_row(r)
            table_data.append([
                r.get("group", ""), r.get("task", ""),
                f'{(r.get("bac") or 0):.0f}', f'{(r.get("ac") or 0):.0f}',
                f'{(r.get("pct") or 0):.0f}%',
                f'{r.get("etc"):.0f}' if r.get("etc") not in (None, "") else "-",
                f'{c["ev"]:.0f}',
                f'{c["cpi"]:.2f}' if c["cpi"] is not None else "N/A",
                f'{c["eac1"]:.0f}' if c["eac1"] is not None else "N/A",
                f'{c["eac2"]:.0f}',
                f'{c["eac3"]:.0f}' if c["eac3"] is not None else "-",
                f'{c["eac_main"]:.0f}',
                f'{c["variance"]:+.0f}',
            ])
        ptable = Table(table_data, repeatRows=1)
        ptable.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E78")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#dddddd")),
            ("FONTSIZE", (0, 0), (-1, -1), 7.5),
            ("ALIGN", (2, 0), (-1, -1), "CENTER"),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f5f7fa")]),
        ]))
        elements.append(ptable)

        notes = project.get("notes", "")
        if notes:
            elements.append(Spacer(1, 6))
            elements.append(Paragraph(f"<b>Notes:</b> {notes}", normal))

        elements.append(PageBreak())

    if elements and isinstance(elements[-1], PageBreak):
        elements.pop()

    doc.build(elements)
    buf.seek(0)
    fname = f"project_hours_eac_{datetime.now().strftime('%Y%m%d_%H%M')}.pdf"
    return send_file(buf, as_attachment=True, download_name=fname, mimetype="application/pdf")


if __name__ == "__main__":
    app.run(debug=True, port=5000)
