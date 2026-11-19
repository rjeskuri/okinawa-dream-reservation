// The staff Dashboard: a home sidebar and step-by-step panels, opened from the Okinawa Dream menu. Each panel is
// PanelShell.html followed by its own HTML file, joined as plain text with no template scriptlets. A panel reaches the
// script through google.script.run, which can call only global functions whose names do not end in `_`.

const DASHBOARD_TAB_ = "Dashboard";
const DASHBOARD_TITLE_ = "Okinawa Dream";
const PANEL_WIDTH_ = 720;
const PANEL_HEIGHT_ = 640;

/**
 * The `{ label, fn }` actions the menu, the home and the Dashboard tab list, in order. Each panel adds its line here,
 * and `fn` is a global function that opens it with openPanel_. Read at call time, so file load order never matters.
 */
const DASHBOARD_ACTIONS_ = [
  { label: "Add a bike", fn: "openAddBike" },
  { label: "Block a bike", fn: "openBlockBike" },
];

function openDashboard() {
  SpreadsheetApp.getUi().showSidebar(panelHtml_("Dashboard").setTitle(DASHBOARD_TITLE_));
}

/** What the home sidebar shows. It makes no request: a missing Script Property is listed, not tried. */
function dashboardHome() {
  return { actions: DASHBOARD_ACTIONS_.map(({ label, fn }) => ({ label, fn })), missing: missingProperties_() };
}

function openPanel_(file, title) {
  SpreadsheetApp.getUi().showModalDialog(panelHtml_(file).setWidth(PANEL_WIDTH_).setHeight(PANEL_HEIGHT_), title);
}

/** The shell first, so the callServer its script defines exists when the panel's own script runs. */
function panelHtml_(file) {
  const shell = HtmlService.createHtmlOutputFromFile("PanelShell").getContent();
  const panel = HtmlService.createHtmlOutputFromFile(file).getContent();
  return HtmlService.createHtmlOutput(shell + panel);
}

/**
 * A signed request for a panel. The payload carries the signed-in user as `requestedBy`, whatever the panel sent.
 * Answers `{ ok: true, result }` or `{ ok: false, message }` for staff to read, and never throws.
 */
function staffPost_(path, payload) {
  try {
    const missing = missingProperties_();
    if (missing.length > 0) {
      return { ok: false, message: `Set ${missing.join(" and ")} in Project Settings, under Script Properties.` };
    }
    return { ok: true, result: signedPost_(path, { ...payload, requestedBy: currentUser_() }) };
  } catch (error) {
    const reason = typeof error?.message === "string" ? error.message : String(error);
    return { ok: false, message: `The request failed: ${reason}` };
  }
}

/** Creates the Dashboard tab when it is missing and answers whether it did. A tab already there is left as it is. */
function setupDashboardTab_() {
  const workbook = SpreadsheetApp.getActive();
  if (workbook.getSheetByName(DASHBOARD_TAB_) !== null) return false;

  const rows = [
    [`${DASHBOARD_TITLE_} dashboard`, ""],
    [`Open it from the menu: ${DASHBOARD_TITLE_} > Open dashboard. Menus show in a computer browser only.`, ""],
    ["", ""],
    ["Action", "Function, for a drawing's Assign script"],
    ...DASHBOARD_ACTIONS_.map(({ label, fn }) => [label, fn]),
  ];
  const tab = workbook.insertSheet(DASHBOARD_TAB_);
  tab.getRange(1, 1, rows.length, 2).setValues(rows);
  tab.getRange(1, 1).setFontSize(16).setFontWeight("bold");
  tab.getRange(4, 1, 1, 2).setFontWeight("bold");
  tab.setColumnWidth(1, 320).setColumnWidth(2, 320);
  return true;
}
