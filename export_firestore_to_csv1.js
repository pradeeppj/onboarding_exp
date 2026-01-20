// export_firestore_to_csv.js
const admin = require("firebase-admin");
const { Parser } = require("json2csv");
const fs = require("fs");

const SERVICE_ACCOUNT_PATH = "./serviceAccountKey.json";
const COLLECTION = "study_events";

admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
});

const db = admin.firestore();

function safe(v) {
  if (v === undefined || v === null) return "";
  return v;
}

function flattenSession(docId, d) {
  const form = d.form_values || {};
  const survey = d.survey || {};
  const tlx = survey.nasa_tlx_raw_0_20 || {};
  const umux = survey.umux_lite_1_7 || {};

  // Screen visit summaries (useful + compact)
  const visits = Array.isArray(d.screen_visits) ? d.screen_visits : [];
  const totalDwellMs = visits.reduce((acc, s) => acc + (s.dwell_ms || 0), 0);

  // Per-screen dwell columns (fixed order by screen index)
  const dwellByScreen = {};
  visits.forEach(v => {
    if (typeof v.screen_index === "number") {
      dwellByScreen[`screen_${v.screen_index + 1}_dwell_ms`] = v.dwell_ms || 0;
    }
  });

  return {
    // --- identifiers ---
    doc_id: docId,
    participant_id: safe(d.participant_id),
    session_id: safe(d.session_id),
    condition: safe(d.condition),

    // --- timing ---
    started_at_iso: safe(d.started_at_iso),
    submitted_at_iso: safe(d.submitted_at_iso),
    time_to_complete_ms: safe(d.time_to_complete_ms),
    saved_at_iso: safe(d.saved_at_iso),

    // --- behavior ---
    total_edits: safe(d.total_edits),
    back_clicks: safe(d.back_clicks),
    next_clicks: safe(d.next_clicks),
    review_edit_cycles: safe(d.review_edit_cycles),

    screen_visits_count: visits.length,
    total_screen_dwell_ms: totalDwellMs,

    // --- form fields (flattened) ---
    company_legal_name: safe(form.legalName),
    company_dba: safe(form.dba),
    company_address: safe(form.address),
    formation_state: safe(form.formationState),
    formation_date: safe(form.formationDate),

    ein_tin: safe(form.ein),
    company_website: safe(form.website),
    company_social_presence: safe(form.social),

    business_type: safe(form.businessType),
    special_business_category: safe(form.specialCategory),
    intended_use_of_platform: safe(form.intendedUse),

    expected_monthly_volume: safe(form.monthlyVolume),
    expected_monthly_count: safe(form.monthlyCount),
    average_transaction_value: safe(form.avgValue),
    primary_customer_type: safe(form.customerType),
    primary_customer_geography: safe(form.customerGeo),

    business_description: safe(form.description),

    // --- survey fields (flattened) ---
    nasa_tlx_mental_0_20: safe(tlx.mental),
    nasa_tlx_temporal_0_20: safe(tlx.temporal),
    nasa_tlx_effort_0_20: safe(tlx.effort),
    nasa_tlx_frustration_0_20: safe(tlx.frustration),
    nasa_tlx_performance_0_20: safe(tlx.performance),
    nasa_tlx_physical_0_20: safe(tlx.physical),

    effort_single_1_7: safe(survey.effort_single_1_7),

    umux_meets_requirements_1_7: safe(umux.meets_requirements),
    umux_easy_to_use_1_7: safe(umux.easy_to_use),

    trust_automation_1_7: safe(survey.trust_automation_1_7),
    perceived_control_1_7: safe(survey.perceived_control_1_7),

    user_agent: safe(d.user_agent),

    // --- per-screen dwell columns ---
    ...dwellByScreen
  };
}

(async () => {
  const snap = await db.collection(COLLECTION).get();

  if (snap.empty) {
    console.log("No rows found.");
    process.exit(0);
  }

  const rows = [];
  snap.forEach(doc => rows.push(flattenSession(doc.id, doc.data())));

  // Make sure every row has same columns (union of keys)
  const allFields = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r).forEach(k => set.add(k));
      return set;
    }, new Set())
  );

  const parser = new Parser({ fields: allFields });
  const csv = parser.parse(rows);

  fs.writeFileSync("firestore_export_flat.csv", csv, "utf-8");
  console.log(`✅ Exported ${rows.length} rows to firestore_export_flat.csv`);
})();
