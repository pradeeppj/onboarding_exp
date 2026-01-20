/**
 * Google Apps Script: Study event collector → appends rows to a Google Sheet
 *
 * What this does:
 * - Accepts POSTed JSON payloads from your study website
 * - Validates: token + origin allowlist + required fields
 * - Appends one row per event to a tab named SHEET_NAME
 *
 * Deployment (Web App):
 * - Execute as: Me
 * - Who has access: Anyone
 *
 * IMPORTANT:
 * - "API_TOKEN" is not a true secret if stored in frontend. It's a lightweight gate.
 * - Keep study data non-sensitive (synthetic business profile).
 */

// -------------------- CONFIG --------------------
const SHEET_NAME = "responses";

// Allow only your study domain(s) (exact match on window.location.origin)
const ALLOWED_ORIGINS = [
  "https://yourdomain.com",
  "https://www.yourdomain.com",
  "http://localhost:5173",
  "http://localhost:3000"
];

// Shared token (prototype-level protection; not a real secret in frontend)
const API_TOKEN = "AKfycbwcZwEzd_rleBN5x1qqbqUPTaL7e3Wrgblo5_sqnYKFr3zNN0QohCaFXS-QlM9QiliK";

// Stable schema (columns)
const COLUMNS = [
  "ts_iso",
  "participant_id",
  "session_id",
  "condition",
  "event",
  "origin",

  // timing
  "started_at_iso",
  "submitted_at_iso",
  "time_to_complete_ms",

  // behavior aggregates
  "total_edits",
  "back_clicks",
  "next_clicks",
  "review_edit_cycles",

  // optional per-screen timing (stringified JSON)
  "screen_visits_json",

  // survey
  "nasa_tlx_json",
  "effort_single_1_7",
  "umux_meets_1_7",
  "umux_easy_1_7",
  "trust_1_7",
  "control_1_7",

  // form values
  "form_values_json"
];

// -------------------- Entry points --------------------
// NOTE: For the recommended frontend fetch (mode: "no-cors", text/plain),
// you do NOT need CORS headers here. Keep doOptions for completeness.

function doOptions(e) {
  return ContentService.createTextOutput("");
}

function doPost(e) {
  // Parse JSON body safely
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : "{}");
  } catch (err) {
    return json_({ ok: false, error: "Invalid JSON" });
  }

  // Validate origin (reliable: passed in the payload)
  if (!body.origin || !isAllowedOrigin_(body.origin)) {
    return json_({ ok: false, error: "Origin not allowed" });
  }

  // Token check
  if (!body.token || body.token !== API_TOKEN) {
    return json_({ ok: false, error: "Unauthorized" });
  }

  // Basic schema validation
  if (!body.participant_id || !body.session_id || !body.condition || !body.event) {
    return json_({ ok: false, error: "Missing required fields" });
  }

  // Append row
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = getOrCreateSheet_(ss, SHEET_NAME);

  ensureHeader_(sheet);

  var row = makeRow_(body);
  sheet.appendRow(row);

  return json_({ ok: true });
}

// -------------------- Row building --------------------

function makeRow_(body) {
  var nowIso = new Date().toISOString();

  var toJson = function (v) {
    try {
      return JSON.stringify(v == null ? null : v);
    } catch (e) {
      return "";
    }
  };

  var map = {
    ts_iso: nowIso,
    participant_id: body.participant_id,
    session_id: body.session_id,
    condition: body.condition,
    event: body.event,
    origin: body.origin,

    started_at_iso: body.started_at_iso || "",
    submitted_at_iso: body.submitted_at_iso || "",
    time_to_complete_ms: (body.time_to_complete_ms != null) ? body.time_to_complete_ms : "",

    total_edits: (body.total_edits != null) ? body.total_edits : 0,
    back_clicks: (body.back_clicks != null) ? body.back_clicks : 0,
    next_clicks: (body.next_clicks != null) ? body.next_clicks : 0,
    review_edit_cycles: (body.review_edit_cycles != null) ? body.review_edit_cycles : 0,

    screen_visits_json: toJson(body.screen_visits),

    nasa_tlx_json: toJson(body.survey && body.survey.nasa_tlx_raw_0_20),
    effort_single_1_7: body.survey ? (body.survey.effort_single_1_7 != null ? body.survey.effort_single_1_7 : "") : "",
    umux_meets_1_7: body.survey && body.survey.umux_lite_1_7 ? (body.survey.umux_lite_1_7.meets_requirements != null ? body.survey.umux_lite_1_7.meets_requirements : "") : "",
    umux_easy_1_7: body.survey && body.survey.umux_lite_1_7 ? (body.survey.umux_lite_1_7.easy_to_use != null ? body.survey.umux_lite_1_7.easy_to_use : "") : "",
    trust_1_7: body.survey ? (body.survey.trust_automation_1_7 != null ? body.survey.trust_automation_1_7 : "") : "",
    control_1_7: body.survey ? (body.survey.perceived_control_1_7 != null ? body.survey.perceived_control_1_7 : "") : "",

    form_values_json: toJson(body.form_values)
  };

  // Return row in stable column order
  return COLUMNS.map(function (c) {
    var v = map[c];
    return (v == null) ? "" : v;
  });
}

// -------------------- Sheet helpers --------------------

function ensureHeader_(sheet) {
  // If the sheet is empty, write headers
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
    return;
  }

  // If first row is blank (rare), write headers
  var firstRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
  var isEmpty = firstRow.every(function (v) { return v === "" || v === null; });

  if (isEmpty) {
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
  }
}

function getOrCreateSheet_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// -------------------- Validation helpers --------------------

function isAllowedOrigin_(origin) {
  // Exact match only (window.location.origin)
  for (var i = 0; i < ALLOWED_ORIGINS.length; i++) {
    if (ALLOWED_ORIGINS[i] === origin) return true;
  }
  return false;
}

// -------------------- Response helper --------------------

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
