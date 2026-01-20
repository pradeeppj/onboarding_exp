// export_firestore_to_csv.js
const admin = require("firebase-admin");
const { Parser } = require("json2csv");
const fs = require("fs");

const SERVICE_ACCOUNT_PATH = "./serviceAccountKey.json"; // <-- put your downloaded key here
const COLLECTION = "study_events"; // <-- your collection name

admin.initializeApp({
  credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
});

const db = admin.firestore();

function flattenRow(docId, d) {
  // Turn nested objects into JSON strings for easy CSV export
  const toJson = (v) => {
    try { return JSON.stringify(v ?? null); } catch { return ""; }
  };

  return {
    doc_id: docId,
    participant_id: d.participant_id ?? "",
    session_id: d.session_id ?? "",
    condition: d.condition ?? "",

    started_at_iso: d.started_at_iso ?? "",
    submitted_at_iso: d.submitted_at_iso ?? "",
    time_to_complete_ms: d.time_to_complete_ms ?? "",

    total_edits: d.total_edits ?? 0,
    back_clicks: d.back_clicks ?? 0,
    next_clicks: d.next_clicks ?? 0,
    review_edit_cycles: d.review_edit_cycles ?? 0,

    completed: d.completed ?? false,
    saved_at_iso: d.saved_at_iso ?? "",

    // Keep complex fields as JSON-in-cells
    screen_visits_json: toJson(d.screen_visits),
    survey_json: toJson(d.survey),
    form_values_json: toJson(d.form_values),

    user_agent: d.user_agent ?? "",
    last_event: d.last_event ?? ""
  };
}

(async () => {
  const snap = await db.collection(COLLECTION).get();
  const rows = [];
  snap.forEach(doc => rows.push(flattenRow(doc.id, doc.data())));

  if (!rows.length) {
    console.log("No rows found.");
    process.exit(0);
  }

  const parser = new Parser({ fields: Object.keys(rows[0]) });
  const csv = parser.parse(rows);

  fs.writeFileSync("firestore_export.csv", csv, "utf-8");
  console.log(`✅ Exported ${rows.length} rows to firestore_export.csv`);
})();
