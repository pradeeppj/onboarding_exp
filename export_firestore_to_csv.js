// export_firestore_to_csv.js
const admin = require("firebase-admin");
const { Parser } = require("json2csv");
const fs = require("fs");

const SERVICE_ACCOUNT_PATH = "./serviceAccountKey.json";
const COLLECTION = "study_events3";

admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
});

const db = admin.firestore();

function toJson(v) {
  try {
    return JSON.stringify(v ?? null);
  } catch {
    return "";
  }
}

function flattenRow(docId, d) {
  const fv = d.form_values || {};
  const s = d.survey || {};
  const tlx = s.nasa_tlx_raw_0_20 || {};
  const umux = s.umux_lite_1_7 || {};

  return {
    doc_id: docId,

    // IDs
    participant_id: d.participant_id ?? "",
    session_id: d.session_id ?? "",
    condition: d.condition ?? "",

    // Prolific attribution
    prolific_pid: d.prolific_pid ?? "",
    prolific_study_id: d.prolific_study_id ?? "",
    prolific_session_id: d.prolific_session_id ?? "",

    // Event + timestamp
    event: d.event ?? "",
    ts_iso: d.ts_iso ?? "",

    // Timing
    started_at_iso: d.started_at_iso ?? "",
    submitted_at_iso: d.submitted_at_iso ?? "",
    time_to_complete_ms: d.time_to_complete_ms ?? "",

    // Behavior
    total_edits: d.total_edits ?? 0,
    back_clicks: d.back_clicks ?? 0,
    next_clicks: d.next_clicks ?? 0,
    review_edit_cycles: d.review_edit_cycles ?? 0,

    // Completion
    completion_code: d.completion_code ?? "",
    completion_code_issued_at_iso: d.completion_code_issued_at_iso ?? "",

    // ---- FORM VALUES (expanded columns) ----
    legalName: fv.legalName ?? "",
    dba: fv.dba ?? "",
    address: fv.address ?? "",
    formationState: fv.formationState ?? "",
    formationDate: fv.formationDate ?? "",
    ein: fv.ein ?? "",
    website: fv.website ?? "",
    social: fv.social ?? "",
    businessType: fv.businessType ?? "",
    specialCategory: fv.specialCategory ?? "",
    intendedUse: fv.intendedUse ?? "",
    monthlyVolume: fv.monthlyVolume ?? "",
    monthlyCount: fv.monthlyCount ?? "",
    avgValue: fv.avgValue ?? "",
    customerType: fv.customerType ?? "",
    customerGeo: fv.customerGeo ?? "",
    description: fv.description ?? "",

    // ---- SURVEY (expanded columns) ----
    // NASA-TLX (0–20)
    tlx_mental: Number.isFinite(tlx.mental) ? tlx.mental : (tlx.mental ?? ""),
    tlx_temporal: Number.isFinite(tlx.temporal) ? tlx.temporal : (tlx.temporal ?? ""),
    tlx_effort: Number.isFinite(tlx.effort) ? tlx.effort : (tlx.effort ?? ""),
    tlx_frustration: Number.isFinite(tlx.frustration) ? tlx.frustration : (tlx.frustration ?? ""),
    tlx_performance: Number.isFinite(tlx.performance) ? tlx.performance : (tlx.performance ?? ""),
    tlx_physical: Number.isFinite(tlx.physical) ? tlx.physical : (tlx.physical ?? ""),

    // Single-item effort (1–7)
    effort_single_1_7: s.effort_single_1_7 ?? "",

    // UMUX-Lite (1–7)
    umux_meets_requirements_1_7: umux.meets_requirements ?? "",
    umux_easy_to_use_1_7: umux.easy_to_use ?? "",

    // Trust & control (1–7)
    trust_automation_1_7: s.trust_automation_1_7 ?? "",
    perceived_control_1_7: s.perceived_control_1_7 ?? "",

    // Keep complex fields as JSON-in-cells (still useful)
    screen_visits_json: toJson(d.screen_visits),

    user_agent: d.user_agent ?? "",
  };
}

(async () => {
  const snap = await db.collection(COLLECTION).get();
  const rows = [];
  snap.forEach((doc) => rows.push(flattenRow(doc.id, doc.data())));

  if (!rows.length) {
    console.log("No rows found.");
    process.exit(0);
  }

  const parser = new Parser({ fields: Object.keys(rows[0]) });
  const csv = parser.parse(rows);

  fs.writeFileSync("firestore_export.csv", csv, "utf-8");
  console.log(`✅ Exported ${rows.length} rows to firestore_export.csv`);
})();
