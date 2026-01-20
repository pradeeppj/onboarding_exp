/**
 * Tracking overview:
 * - Full screen visit timing (enter/exit + dwell time)
 * - Nav clicks (back/next), review-edit cycles
 * - Field focus + changes (total edits + per-field edits)
 * - Completion vs dropout (beforeunload snapshot)
 * - Post-task survey: raw NASA-TLX + effort + UMUX-Lite + trust + perceived control
 *
 * ✅ IMPORTANT CHANGE:
 * - Only ONE server call to Firestore per session.
 * - We write once when the participant finishes the survey (i.e., navigates from "Post-Task Survey" → "Done").
 * - "Submit for review" still finalizes timing, but does NOT write to Firestore.
 */

// -------------------- CONFIG: Preloaded CP 575 --------------------
const PRELOADED_CP575_URL = "cp575.png"; // Put cp575.png next to index.html (or change to .jpg)
const PRELOADED_CP575_META = { name: "cp575.png", type: "image/png", size: null };


// -------------------- State --------------------
let step = 0;
let cp575File = null; // will be populated with PRELOADED_CP575_META
let cp575PreviewUrl = null; // not needed for preloaded URL, but kept for compatibility

const PRELOADED_PROFILE_URL = "business-profile.png"; // put file next to index.html
const PRELOADED_PROFILE_META = { name: "business-profile.png", type: "image/png", size: null };

// participant/session identity
const participantId = getOrCreateParticipantId();
const assignedCondition = getConditionFromUrl() || "unspecified"; // e.g., ?cond=manual|semi|auto
const sessionId = `${participantId}_${Date.now()}`;

// timing
let onboardingStartTs = null;
let onboardingSubmitTs = null;

// ✅ single-write guard
let firebaseWriteDone = false;

// tracking aggregates
const tracking = {
  participant_id: participantId,
  session_id: sessionId,
  condition: assignedCondition,
  started_at_iso: null,
  submitted_at_iso: null,
  completed: false,

  // primary metrics
  time_to_complete_ms: null,
  completion_screen: null,
  dropout: null, // if not completed: { last_screen, last_field, ts_iso }

  // behavioral logs
  screen_visits: [], // {screen_index, screen_name, enter_ts, exit_ts, dwell_ms}
  events: [], // event stream: {ts, type, screen, ...}
  field_edits: {}, // per-field edit counts
  total_edits: 0,
  back_clicks: 0,
  next_clicks: 0,
  review_edit_cycles: 0,
  last_touched_field: null,

  // survey instruments
  survey: {
    nasa_tlx_raw_0_20: null,
    effort_single_1_7: null,
    umux_lite_1_7: null, // {meets_requirements, easy_to_use}
    trust_automation_1_7: null,
    perceived_control_1_7: null,
  },

  cp575: null,
  form_values: null,
};

// form values
const values = {
  legalName: "",
  dba: "",
  address: "",
  formationState: "",
  formationDate: "",
  ein: "",
  website: "",
  social: "",
  businessType: "",
  specialCategory: "",
  intendedUse: "",
  monthlyVolume: "",
  monthlyCount: "",
  avgValue: "",
  customerType: "",
  customerGeo: "",
  description: "",
};

// keep first-seen values
const firstSet = {};
let leftReviewViaBack = false;

// -------------------- Options --------------------
const US_STATES = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"
];
const BUSINESS_TYPES = ["Retail","Technology Services","Professional Services","Manufacturing","Healthcare","Education","Non-profit","Marketplace","Financial Services","Hospitality"];
const SPECIAL_CATS = ["SaaS","E-commerce","Gig economy","Crypto/Blockchain","Gaming","Travel","Adult content","Gambling","Pharma/regulated","None"];
const INTENDED_USE = ["Employee incentives","Customer rewards and incentives","Marketing promotions","Partner payouts","Expense management","Gift cards for events","Other"];
const VOL = ["Less than $10,000","$10,000 – $50,000","$50,000 – $250,000","$250,000+"];
const COUNT = ["Fewer than 50","50–500","500–5,000","5,000+"];
const AVG = ["<$50","$50–$250","$250–$1,000","$1,000+"];
const CUST_TYPE = ["Consumers","Small businesses","Mid-market","Enterprise","Non-profits","Mixed"];
const CUST_GEO = ["US only","US + international","International only"];

// -------------------- Screens --------------------
const screenLabels = ["Upload","Identity","Identifiers","Classification","Risk","Description","Review","Survey","Done"];

const screens = [
  {
    name: "Business Verification & Reference",
    title: "Verify your business",
    desc: "Assume you already had the CP 575 available and uploaded it.",
    render: () => `
      <div class="note small">
        <strong>Study instruction:</strong> Imagine you had the CP 575 document with you and you already uploaded it.
        Use the Business Profile (Reference) to complete the form.
      </div>

      <div class="note small" style="margin-top:12px;">
        <div><span class="muted">Document:</span> <strong>${escapeHtml(PRELOADED_CP575_META.name)}</strong></div>
        <div class="muted">Pre-uploaded for this prototype (no action required).</div>
      </div>

      <hr class="sep" />

      <div class="note small">
        <div><span class="muted">Participant:</span> <strong>${escapeHtml(participantId)}</strong></div>
        <div><span class="muted">Condition:</span> <strong>${escapeHtml(assignedCondition)}</strong>
          <span class="muted">(set with <code>?cond=manual|semi|auto</code>)</span>
        </div>
      </div>
    `,
    onMount: () => {
      // Start timing at first screen render
      if (!onboardingStartTs) {
        onboardingStartTs = Date.now();
        tracking.started_at_iso = new Date(onboardingStartTs).toISOString();
        logEvent("onboarding_start", {});
      }

      // Auto-load preuploaded CP 575 exactly once
      if (!cp575File) {
        cp575File = PRELOADED_CP575_META;
        tracking.cp575 = { ...PRELOADED_CP575_META };

        updateDocPreview(cp575File, PRELOADED_CP575_URL);

        logEvent("file_preuploaded", { field: "cp575", file: tracking.cp575 });
        refreshLogPanel();
      }
    },
    canNext: () => true,
  },
  {
    name: "Company Identity",
    title: "Company identity",
    desc: "Enter legal company information.",
    render: () =>
      formGrid([
        input("Company Legal Name *", "legalName", "e.g., Acme Technologies LLC"),
        input("Company DBA (Optional)", "dba", "e.g., Acme Tech"),
        input("Company Address *", "address", "Street, City, State ZIP", true),
        select("Company Formation State *", "formationState", US_STATES),
        input("Company Formation Date *", "formationDate", "MM/YYYY"),
      ]),
    canNext: () => req(["legalName", "address", "formationState", "formationDate"]),
  },
  {
    name: "Business Identifiers & Online Presence",
    title: "Business identifiers",
    desc: "Enter identifiers and online presence.",
    render: () =>
      formGrid([
        input("Company EIN / TIN *", "ein", "XX-XXXXXXX"),
        input("Company Website *", "website", "https://…"),
        input("Company Social Presence (Optional)", "social", "https://…", true),
      ]),
    canNext: () => req(["ein", "website"]),
  },
  {
    name: "Business Classification",
    title: "Business classification",
    desc: "Tell us what the business does and how the platform will be used.",
    render: () =>
      formGrid([
        select("Business Type *", "businessType", BUSINESS_TYPES),
        select("Special Business Category *", "specialCategory", SPECIAL_CATS),
        select("Intended Use of Platform *", "intendedUse", INTENDED_USE, true),
      ]),
    canNext: () => req(["businessType", "specialCategory", "intendedUse"]),
  },
  {
    name: "Operational & Risk Context",
    title: "Operational context",
    desc: "Share projected usage to support risk review.",
    render: () =>
      formGrid([
        select("Expected Monthly Transaction Volume *", "monthlyVolume", VOL),
        select("Expected Monthly Transaction Count *", "monthlyCount", COUNT),
        select("Average Transaction Value *", "avgValue", AVG),
        select("Primary Customer Type *", "customerType", CUST_TYPE),
        select("Primary Customer Geography *", "customerGeo", CUST_GEO),
      ]),
    canNext: () => req(["monthlyVolume", "monthlyCount", "avgValue", "customerType", "customerGeo"]),
  },
  {
    name: "Business Description",
    title: "Business description",
    desc: "Provide a brief description of business activity.",
    render: () => `
      <div class="field">
        <label>Brief Description of Business Activity *</label>
        <textarea id="description" placeholder="Max 250 characters">${escapeHtml(values.description || "")}</textarea>
        <div class="hint">Keep it short and specific.</div>
      </div>
    `,
    onMount: () => {
      const t = document.getElementById("description");
      if (!t) return;

      t.addEventListener("focus", () => onFieldFocus("description"));
      t.addEventListener("input", () => {
        const prev = values.description;
        values.description = t.value.slice(0, 250);
        onFieldChange("description", prev, values.description);
        updateNav();
        refreshLogPanel();
      });
    },
    canNext: () => !!values.description?.trim(),
  },
  {
    name: "Review & Submit",
    title: "Review & submit",
    desc: "Confirm details before submission.",
    render: () => reviewHtml(),
    onMount: () => {
      document.getElementById("exportBtn")?.addEventListener("click", () => exportStudyData("manual_export"));
      logEvent("review_screen_shown", {});
    },
    canNext: () => true,
  },
  {
    name: "Post-Task Survey",
    title: "Short survey",
    desc: "Answer a few questions about workload and trust.",
    render: () => surveyHtml(),
    onMount: () => wireSurvey(),
    canNext: () => surveyComplete(),
  },
  {
    name: "Done",
    title: "Thank you",
    desc: "You can export your study data now.",
    render: () => `
      <div class="note">
        <div><strong>Complete.</strong> Thank you for participating.</div>
        <div class="muted small" style="margin-top:6px;">Click “Export data” to download the JSON log for analysis.</div>
      </div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn" type="button" id="exportDoneBtn">Export data</button>
        <button class="btn btn--ghost" type="button" id="restartBtn">Restart</button>
      </div>
    `,
    onMount: () => {
      document.getElementById("exportDoneBtn")?.addEventListener("click", () => exportStudyData("done_export"));
      document.getElementById("restartBtn")?.addEventListener("click", () => restart());
    },
    canNext: () => true,
  },
];

// -------------------- Core rendering + navigation --------------------
let currentVisit = null;

function setScreen() {
  const s = screens[step];

  endScreenVisit();
  startScreenVisit(step, s.name);

  document.getElementById("screenTitle").textContent = s.title;
  document.getElementById("screenDesc").textContent = s.desc;
  document.getElementById("screenBody").innerHTML = s.render();

  wireInputs();
  s.onMount?.();

  renderStepper();
  updateNav();
  refreshLogPanel();

  logEvent("screen_enter", { screen_index: step, screen_name: s.name });

  // ✅ Doc/Profile tab logic
  if (step >= 1) activateTab("profile");
  else activateTab("doc");
}

function startScreenVisit(idx, name) {
  const ts = Date.now();
  currentVisit = { screen_index: idx, screen_name: name, enter_ts: ts, exit_ts: null, dwell_ms: null };
  tracking.screen_visits.push(currentVisit);
}

function endScreenVisit() {
  if (!currentVisit || currentVisit.exit_ts) return;
  const ts = Date.now();
  currentVisit.exit_ts = ts;
  currentVisit.dwell_ms = ts - currentVisit.enter_ts;

  logEvent("screen_exit", {
    screen_index: currentVisit.screen_index,
    screen_name: currentVisit.screen_name,
    dwell_ms: currentVisit.dwell_ms,
  });
}

function updateNav() {
  const backBtn = document.getElementById("backBtn");
  const nextBtn = document.getElementById("nextBtn");

  if (!backBtn || !nextBtn) return;

  backBtn.disabled = step === 0 || step === screens.length - 1;
  nextBtn.style.display = step === screens.length - 1 ? "none" : "inline-block";

  if (step === 6) nextBtn.textContent = "Submit for review";
  else if (step === 7) nextBtn.textContent = "Finish";
  else nextBtn.textContent = "Continue";

  const ok = screens[step].canNext ? screens[step].canNext() : true;
  nextBtn.disabled = !ok;
}

function renderStepper() {
  const el = document.getElementById("stepper");
  if (!el) return;

  el.innerHTML = screenLabels
    .map((l, i) => {
      const cls = i === step ? "pill pill--active" : i < step ? "pill pill--done" : "pill";
      return `<span class="${cls}">${i + 1}. ${l}</span>`;
    })
    .join("");
}

// -------------------- Input binding + edit logging --------------------
function wireInputs() {
  document.querySelectorAll("[data-bind]").forEach((el) => {
    const key = el.getAttribute("data-bind");
    if (!key) return;

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.value = values[key] ?? "";
    if (el.tagName === "SELECT") el.value = values[key] ?? "";

    el.addEventListener("focus", () => onFieldFocus(key));

    const handler = () => {
      const prev = values[key];
      const next = el.value;
      values[key] = next;
      onFieldChange(key, prev, next);
      updateNav();
      refreshLogPanel();
    };

    el.addEventListener("input", handler);
    el.addEventListener("change", handler);
  });
}

function onFieldFocus(fieldKey) {
  tracking.last_touched_field = fieldKey;
  logEvent("field_focus", { field: fieldKey });
}

function onFieldChange(fieldKey, prev, next) {
  tracking.last_touched_field = fieldKey;
  if ((prev ?? "") === (next ?? "")) return;

  tracking.field_edits[fieldKey] = (tracking.field_edits[fieldKey] || 0) + 1;
  tracking.total_edits += 1;

  if (!firstSet[fieldKey] && (next ?? "").toString().trim().length > 0) {
    firstSet[fieldKey] = next;
  }

  logEvent("field_change", { field: fieldKey, from: prev ?? "", to: next ?? "" });
}

// -------------------- Form components --------------------
function formGrid(inner) {
  const html = Array.isArray(inner) ? inner.join("") : inner;
  return `<div class="fieldgrid">${html}</div>`;
}

function input(labelText, bindKey, placeholder, full = false) {
  const cls = full ? "field full" : "field";
  return `
    <div class="${cls}">
      <label>${labelText}</label>
      <input data-bind="${bindKey}" type="text" placeholder="${escapeHtml(placeholder)}" />
    </div>
  `;
}

function select(labelText, bindKey, options, full = false) {
  const cls = full ? "field full" : "field";
  const opts = [
    `<option value="">Select…</option>`,
    ...options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`),
  ].join("");

  return `
    <div class="${cls}">
      <label>${labelText}</label>
      <select data-bind="${bindKey}">${opts}</select>
    </div>
  `;
}

function req(keys) {
  return keys.every((k) => (values[k] ?? "").toString().trim().length > 0);
}

function escapeHtml(s) {
  return (s ?? "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.remove("tab--active"));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("tabpane--active"));

  const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  const tabPane = document.getElementById(`tab-${tabName}`);

  if (tabBtn && tabPane) {
    tabBtn.classList.add("tab--active");
    tabPane.classList.add("tabpane--active");
  }
}

// -------------------- Review / Survey --------------------
function reviewHtml() {
  const rows = [
    ["Company Legal Name", values.legalName],
    ["Company DBA", values.dba || "—"],
    ["Company Address", values.address],
    ["Formation State", values.formationState],
    ["Formation Date", values.formationDate],
    ["EIN / TIN", values.ein],
    ["Website", values.website],
    ["Social Presence", values.social || "—"],
    ["Business Type", values.businessType],
    ["Special Category", values.specialCategory],
    ["Intended Use", values.intendedUse],
    ["Monthly Volume", values.monthlyVolume],
    ["Monthly Count", values.monthlyCount],
    ["Avg Transaction Value", values.avgValue],
    ["Customer Type", values.customerType],
    ["Customer Geography", values.customerGeo],
    ["Business Description", values.description],
  ];

  const list = rows
    .map(
      ([k, v]) => `
    <div class="reviewRow">
      <div class="k">${escapeHtml(k)}</div>
      <div class="v">${escapeHtml(v || "")}</div>
    </div>
  `
    )
    .join("");

  return `
    <div class="review">${list}</div>
    <hr class="sep" />
    <div class="small muted">You can export a JSON log for analysis.</div>
    <div style="margin-top:10px; display:flex; gap:10px;">
      <button class="btn btn--ghost" id="exportBtn" type="button">Export data</button>
    </div>
  `;
}

function surveyHtml() {
  return `
    <div class="note small">
      <strong>Instructions:</strong> Answer based on the onboarding task you just completed.
    </div>

    <h2 style="margin:14px 0 8px; font-size:16px;">NASA-TLX (raw)</h2>
    <div class="scaleRow">
      ${range("Mental Demand", "tlx_mental", 0, 20, 10)}
      ${range("Temporal Demand", "tlx_temporal", 0, 20, 10)}
      ${range("Effort", "tlx_effort", 0, 20, 10)}
      ${range("Frustration", "tlx_frustration", 0, 20, 10)}
      ${range("Performance (higher = worse)", "tlx_performance", 0, 20, 10)}
      ${range("Physical Demand", "tlx_physical", 0, 20, 0)}
    </div>

    <hr class="sep" />

    <h2 style="margin:14px 0 8px; font-size:16px;">Perceived effort</h2>
    ${likert7("How effortful was this onboarding process?", "effort_single")}

    <hr class="sep" />

    <h2 style="margin:14px 0 8px; font-size:16px;">Usability (UMUX-Lite)</h2>
    ${likert7("This system’s capabilities meet my requirements.", "umux_req")}
    ${likert7("This system is easy to use.", "umux_easy")}

    <hr class="sep" />

    <h2 style="margin:14px 0 8px; font-size:16px;">Trust & control</h2>
    ${likert7("I trust the system to complete onboarding correctly.", "trust_auto")}
    ${likert7("I felt in control of what information was submitted.", "control")}
  `;
}

function range(label, id, min, max, value) {
  return `
    <div class="rangeWrap">
      <div class="label"><span>${escapeHtml(label)}</span><span>${min}–${max}</span></div>
      <input type="range" id="${id}" min="${min}" max="${max}" value="${value}" />
      <div class="rangeVal">Value: <span id="${id}_val">${value}</span></div>
    </div>
  `;
}

function likert7(prompt, id) {
  const opts = [1, 2, 3, 4, 5, 6, 7]
    .map(
      (v) => `
    <label style="display:inline-flex;align-items:center;gap:6px;margin-right:10px;">
      <input type="radio" name="${id}" value="${v}"> <span>${v}</span>
    </label>
  `
    )
    .join("");

  return `
    <div class="field">
      <label>${escapeHtml(prompt)} <span class="muted">(1–7)</span></label>
      <div style="margin-top:8px;">${opts}</div>
    </div>
  `;
}

function wireSurvey() {
  ["tlx_mental", "tlx_temporal", "tlx_effort", "tlx_frustration", "tlx_performance", "tlx_physical"].forEach((id) => {
    const el = document.getElementById(id);
    const out = document.getElementById(`${id}_val`);
    if (!el || !out) return;

    el.addEventListener("input", () => {
      out.textContent = el.value;
      logEvent("survey_range_change", { field: id, value: Number(el.value) });
      refreshLogPanel();
      updateNav();
    });
  });

  ["effort_single", "umux_req", "umux_easy", "trust_auto", "control"].forEach((name) => {
    document.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
      r.addEventListener("change", () => {
        logEvent("survey_radio_change", { field: name, value: Number(r.value) });
        refreshLogPanel();
        updateNav();
      });
    });
  });
}

function surveyComplete() {
  const required = ["effort_single", "umux_req", "umux_easy", "trust_auto", "control"];
  return required.every((n) => !!document.querySelector(`input[name="${n}"]:checked`));
}

// -------------------- Export / finalize --------------------
function finalizeOnboardingSubmit() {
  if (onboardingSubmitTs) return;

  onboardingSubmitTs = Date.now();
  tracking.submitted_at_iso = new Date(onboardingSubmitTs).toISOString();
  tracking.time_to_complete_ms = onboardingSubmitTs - onboardingStartTs;
  tracking.completion_screen = "Review & Submit";

  logEvent("onboarding_submit_clicked", { time_to_complete_ms: tracking.time_to_complete_ms });
}

function finalizeSurvey() {
  const tlx = {
    mental: Number(document.getElementById("tlx_mental")?.value ?? 0),
    temporal: Number(document.getElementById("tlx_temporal")?.value ?? 0),
    effort: Number(document.getElementById("tlx_effort")?.value ?? 0),
    frustration: Number(document.getElementById("tlx_frustration")?.value ?? 0),
    performance: Number(document.getElementById("tlx_performance")?.value ?? 0),
    physical: Number(document.getElementById("tlx_physical")?.value ?? 0),
  };

  tracking.survey.nasa_tlx_raw_0_20 = tlx;
  tracking.survey.effort_single_1_7 = Number(document.querySelector(`input[name="effort_single"]:checked`)?.value ?? null);
  tracking.survey.umux_lite_1_7 = {
    meets_requirements: Number(document.querySelector(`input[name="umux_req"]:checked`)?.value ?? null),
    easy_to_use: Number(document.querySelector(`input[name="umux_easy"]:checked`)?.value ?? null),
  };
  tracking.survey.trust_automation_1_7 = Number(document.querySelector(`input[name="trust_auto"]:checked`)?.value ?? null);
  tracking.survey.perceived_control_1_7 = Number(document.querySelector(`input[name="control"]:checked`)?.value ?? null);

  logEvent("survey_completed", { survey: tracking.survey });
}

function exportStudyData(reason = "export") {
  endScreenVisit();
  tracking.form_values = { ...values };
  logEvent("export_data", { reason });

  const payload = structuredClone(tracking);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `study_${participantId}_${assignedCondition}_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);

  refreshLogPanel();
}

// -------------------- Logging --------------------
function logEvent(type, data) {
  tracking.events.push({
    ts_iso: new Date().toISOString(),
    ts_ms: Date.now(),
    type,
    screen_index: step,
    screen_name: screens[step]?.name ?? "unknown",
    ...data,
  });
}

function refreshLogPanel() {
  const el = document.getElementById("logPanel");
  if (!el) return; // safe when log tab is hidden

  const last = tracking.events[tracking.events.length - 1];
  const kvs = [
    ["Participant", participantId],
    ["Condition", assignedCondition],
    ["Step", `${step + 1} / ${screens.length}`],
    ["Screen", screens[step]?.name ?? "—"],
    ["Started", tracking.started_at_iso ?? "—"],
    ["Submitted", tracking.submitted_at_iso ?? "—"],
    ["Time to complete (ms)", tracking.time_to_complete_ms ?? "—"],
    ["Total edits", tracking.total_edits],
    ["Back clicks", tracking.back_clicks],
    ["Review→edit→review cycles", tracking.review_edit_cycles],
    ["Last touched field", tracking.last_touched_field ?? "—"],
    ["Events logged", tracking.events.length],
    ["Last event", last ? `${last.type}` : "—"],
  ];

  el.innerHTML = kvs
    .map(
      ([k, v]) => `
    <div class="kv">
      <div class="k">${escapeHtml(k)}</div>
      <div class="v">${escapeHtml(String(v))}</div>
    </div>
  `
    )
    .join("");
}

// -------------------- Tabs --------------------
function initTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("tab--active"));
      document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("tabpane--active"));
      btn.classList.add("tab--active");
      document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add("tabpane--active");
    });
  });
}

// -------------------- Nav --------------------
function initNav() {
  const backBtn = document.getElementById("backBtn");
  const nextBtn = document.getElementById("nextBtn");

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      tracking.back_clicks += 1;
      logEvent("nav_back", {});

      if (screens[step]?.name === "Review & Submit") leftReviewViaBack = true;

      if (step > 0) {
        step--;
        setScreen();
      }
      refreshLogPanel();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", async () => {
      tracking.next_clicks += 1;

      // prevent double click spam while writing
      nextBtn.disabled = true;

      try {
        const screenName = screens[step]?.name;

        // 1) Review submit event (server call #1)
        if (screens[step]?.name === "Review & Submit") {
          finalizeOnboardingSubmit();
          await sendToFirebase("submit_for_review"); // ✅ call #1
        }

        if (screens[step]?.name === "Post-Task Survey") {
          finalizeSurvey();
          await sendToFirebase("survey_completed"); // ✅ call #2
        }
        logEvent("nav_next", {});

        if (step < screens.length - 1) {
          step++;

          // review → edit → review cycle tracking
          if (screens[step]?.name === "Review & Submit" && leftReviewViaBack) {
            tracking.review_edit_cycles += 1;
            leftReviewViaBack = false;
            logEvent("review_edit_cycle", {});
          }

          if (screens[step]?.name === "Done") {
            tracking.completed = true;
            logEvent("completed", {});
          }

          setScreen();
        }
      } catch (err) {
        // Don’t block the user; log and continue
        logEvent("nav_next_error", { message: String(err) });

        // still advance screens even if Firestore fails
        if (step < screens.length - 1) {
          step++;
          setScreen();
        }
      } finally {
        updateNav();
        refreshLogPanel();
      }
    });
  }
}

// -------------------- Doc preview --------------------
function updateDocPreview(_file, url) {
  const box = document.getElementById("docPreview");
  if (!box) return;
  box.innerHTML = `<img alt="CP 575 preview" src="${url}">`;
}

// -------------------- Business Profile (Reference) --------------------
function renderProfile() {
  const box = document.getElementById("profilePreview");
  if (!box) return;

  box.innerHTML = `<img alt="Business Profile reference" src="${PRELOADED_PROFILE_URL}">`;
  logEvent("profile_preloaded", { file: PRELOADED_PROFILE_META });
}

// -------------------- Dropout tracking --------------------
function initDropoutTracking() {
  window.addEventListener("beforeunload", () => {
    if (!tracking.completed) {
      tracking.dropout = {
        last_screen: screens[step]?.name ?? "unknown",
        last_field: tracking.last_touched_field,
        ts_iso: new Date().toISOString(),
      };
      logEvent("dropout_beforeunload", tracking.dropout);

      try {
        localStorage.setItem(`study_partial_${sessionId}`, JSON.stringify(tracking));
      } catch {}
    } else {
      try {
        localStorage.removeItem(`study_partial_${sessionId}`);
      } catch {}
    }
  });
}

// -------------------- Utilities --------------------
function getOrCreateParticipantId() {
  const key = "study_participant_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;

  const id = `P${Math.floor(10000 + Math.random() * 90000)}`;
  localStorage.setItem(key, id);
  return id;
}

function getConditionFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const c = p.get("cond");
  if (!c) return null;
  return c;
}

function restart() {
  const base = window.location.pathname + window.location.search;
  window.location.href = base;
}

// -------------------- Firestore (ONE call) --------------------
async function sendToFirebase(eventName) {
  const fb = window.__FIREBASE__;
  if (!fb?.db || !fb?.auth?.currentUser) {
    logEvent("firebase_not_ready", { event: eventName });
    return;
  }

  try {
    const { doc, setDoc } = await import(
      "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
    );

    // ✅ UNIQUE doc id every time => CREATE (not UPDATE)
    const docId = `${tracking.session_id}_${eventName}_${Date.now()}`;

    // ✅ ONLY allowed keys per your rules
    const payload = {
      ts_iso: new Date().toISOString(),
      participant_id: tracking.participant_id,
      session_id: tracking.session_id,
      condition: tracking.condition,
      event: eventName,

      started_at_iso: tracking.started_at_iso,
      submitted_at_iso: tracking.submitted_at_iso,
      time_to_complete_ms: tracking.time_to_complete_ms,

      total_edits: tracking.total_edits,
      back_clicks: tracking.back_clicks,
      next_clicks: tracking.next_clicks,
      review_edit_cycles: tracking.review_edit_cycles,

      screen_visits: tracking.screen_visits,
      survey: tracking.survey,
      form_values: { ...values },

      user_agent: navigator.userAgent
    };

    // IMPORTANT: merge must be FALSE (or omitted) so it stays a CREATE.
    await setDoc(doc(fb.db, "study_events", docId), payload);

    logEvent("firebase_write_ok", { event: eventName, doc_id: docId });
  } catch (e) {
    logEvent("firebase_write_failed", { event: eventName, message: String(e) });
    throw e;
  }
}


// -------------------- Init --------------------
renderProfile();
initTabs();
initNav();
initDropoutTracking();
setScreen();
refreshLogPanel();
