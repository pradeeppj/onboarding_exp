/**
 * Business Onboarding Experiment (A/B/C)
 * - Condition A: manual entry
 * - Condition B: AI prefill + per-field confidence (from Firebase HTTPS Function)
 * - Condition C: AI prefill, but ONLY auto-fills fields when confidence >= 60%
 *
 * Storage:
 * - Firebase Firestore ONLY (collection: study_events)
 * - Condition is NOT stored anywhere else (only included inside the Firestore event rows)
 * - Two server writes per session:
 *    1) submit_for_review  (when leaving "Review & Submit")
 *    2) survey_completed   (when leaving "Post-Task Survey")
 *
 * Assets:
 * - cp575.png (preloaded preview)
 * - business-profile.png (reference image)
 */

// -------------------- CONFIG: Assets --------------------
const PRELOADED_CP575_URL = "cp575.png";
const PRELOADED_PROFILE_URL = "business-profile.png";

// -------------------- CONFIG: Deterministic Prefill (Condition B/C) --------------------
// NOTE: No OpenAI calls. Condition B and C use the SAME fixed values + confidence.
const PREFILL_VALUES = {
  legalName: "Connect IQ Labs Inc",
  dba: "Miles",
  address: "4064 Rivermark Parkway, Santa Clara, CA 95054, USA",
  formationState: "California",
  formationDate: "2016-05-02",
  ein: "81-1973626",
  website: "https://www.getmiles.com",
  social: "https://www.linkedin.com/company/connectiq-labs-inc-dba-miles",
  businessType: "Technology Services",
  specialCategory: "SaaS",
  intendedUse: "Customer rewards and incentives",
  monthlyVolume: "$10,000 – $50,000",
  monthlyCount: "50–500",
  avgValue: "$50–$250",
  customerType: "Consumers",
  customerGeo: "US only",
  description:
    "A technology company offering consumer rewards" +
    "and sustainable travel incentives.",
};

const PREFILL_CONFIDENCE = {
  legalName: 1.0,
  dba: 0.70,
  address: 0.95,
  formationState: 0.90,
  formationDate: 0.85,
  ein: 1.0,
  website: 0.65,
  social: 0.6,
  businessType: 0.70,
  specialCategory: 0.60,
  intendedUse: 0.50,
  monthlyVolume: 0.4,
  monthlyCount: 0.4,
  avgValue: 0.4,
  customerType: 0.6,
  customerGeo: 0.8,
  description: 0.8,
};

// Debug: enable Study Log tab with ?debug=1
const DEBUG = new URLSearchParams(window.location.search).get("debug") === "1";

// -------------------- Participant/session identity --------------------
const participantId = getOrCreateParticipantId();
const sessionId = `${participantId}_${Date.now()}`;

// Condition C threshold is kept for historical UI copy, but we no longer gate autofill.
const CONFIDENCE_THRESHOLD_C = 0.6;

// Random A/B/C, persisted per participant (so they stay in same condition)
const condition = getOrCreateConditionABC(); // "A" | "B" | "C"

// -------------------- Timing / step --------------------
let step = 0;
let onboardingStartTs = null;
let onboardingSubmitTs = null;

// -------------------- AI state --------------------
const ai = {
  status: "idle", // idle | running | done | error
  lastRunTsIso: null,
  fields: {}, // key -> { value, confidence }
  error: null,
  meta: null,

  // DEBUG payloads (shown in UI for Condition B)
  lastHttpStatus: null,
  lastResponseJson: null, // raw JSON from function
  lastResponsePretty: null, // JSON.stringify(raw, null, 2)
};

// -------------------- Tracking --------------------
const tracking = {
  participant_id: participantId,
  session_id: sessionId,
  condition,
  started_at_iso: null,
  submitted_at_iso: null,
  completed: false,

  time_to_complete_ms: null,
  completion_screen: null,

  // behavior aggregates
  screen_visits: [],
  events: [],
  field_edits: {},
  total_edits: 0,
  back_clicks: 0,
  next_clicks: 0,
  review_edit_cycles: 0,
  last_touched_field: null,

  // survey
  survey: {
    nasa_tlx_raw_0_20: null,
    effort_single_1_7: null,
    umux_lite_1_7: null, // { meets_requirements, easy_to_use }
    trust_automation_1_7: null,
    perceived_control_1_7: null
  }
};

// -------------------- Form values --------------------
// NOTE: For condition A, these stay empty until the participant fills them.
// For condition B/C, we deterministically set them on Screen 0.
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

const firstSet = {};
let leftReviewViaBack = false;
let currentVisit = null;

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

const DROPDOWN_OPTIONS = {
  formationState: US_STATES,
  businessType: BUSINESS_TYPES,
  specialCategory: SPECIAL_CATS,
  intendedUse: INTENDED_USE,
  monthlyVolume: VOL,
  monthlyCount: COUNT,
  avgValue: AVG,
  customerType: CUST_TYPE,
  customerGeo: CUST_GEO,
};

// -------------------- Screens --------------------
const screenLabels = ["Upload","Identity","Identifiers","Classification","Risk","Description","Review","Survey","Done"];

const screens = [
  {
    name: "Business Verification & Reference",
    title: "Verify your business",
    desc: "Assume you already had the EIN confirmation letter (CP 575) available and uploaded it.",
    render: () => `
      

      <div class="note small">
        <strong>Study instruction: Read carefully before proceeding.</strong>
        <div>
        <strong>Use the Business Profile (Reference) to complete the form.</strong> 
        </div>
        ${(condition === "B" || condition === "C")
          ? `<div class="muted small" style="margin-top:6px;"><p>In this scenario, the system attempts to prefill the form using the EIN confirmation letter (CP 575) along with AI-generated suggestions.</p>
          <p> Please use the business profile information (shown on the right) to complete the form as accurately as possible.</p>
          <strong><p> Each field displays a confidence score for accuracy in its top-right corner. </p> </strong> </div>`
          : ""}
      </div>

      <div class="note" style="margin-top:12px;">
        <div><span class="muted">Document:</span> <strong>cp575.png</strong></div>
        <div class="muted">Pre-provided for this prototype (no action required).</div>
      </div>

      <hr class="sep" />

      <div class="note">
        <div><span class="muted">Participant:</span> <strong>${escapeHtml(participantId)}</strong></div>
        <div><span class="muted">Session:</span> <strong>${escapeHtml(sessionId)}</strong></div>
        <div><span class="muted">Condition:</span> <strong>${escapeHtml(condition)}</strong></div>
      </div>
    `,
    onMount: async () => {
      if (!onboardingStartTs) {
        onboardingStartTs = Date.now();
        tracking.started_at_iso = new Date(onboardingStartTs).toISOString();
        logEvent("onboarding_start", {});
      }

      updateDocPreview(PRELOADED_CP575_URL);
      renderProfile();

      if (condition === "B" || condition === "C") {
        ai.status = "done";
        ai.error = null;
        ai.lastRunTsIso = new Date().toISOString();

        ai.fields = {};
        Object.keys(PREFILL_VALUES).forEach((k) => {
          ai.fields[k] = {
            value: PREFILL_VALUES[k],
            confidence: typeof PREFILL_CONFIDENCE[k] === "number" ? PREFILL_CONFIDENCE[k] : 0.7,
          };
        });

        // ✅ Only prefill immediately for Condition B
        if (condition === "B") {
          Object.keys(PREFILL_VALUES).forEach((k) => {
            values[k] = PREFILL_VALUES[k];
          });
        }

        wireAiBannerControls();
        updateAiBannerUI();
      }

    },
    canNext: () => true
  },

  {
    name: "Company Identity",
    title: "Company identity",
    desc: "Enter legal company information.",
    render: () => formGrid([
      input("Company Legal Name *", "legalName", "e.g., Acme Technologies LLC"),
      input("Company DBA (Optional)", "dba", "e.g., Acme Tech"),
      input("Company Address *", "address", "Street, City, State ZIP", true),
      select("Company Formation State *", "formationState", US_STATES),
      input("Company Formation Date *", "formationDate", "MM/YYYY")
    ]),
    onMount: () => applyAiToFormIfPresent(),
    canNext: () => req(["legalName","address","formationState","formationDate"])
  },

  {
    name: "Business Identifiers & Online Presence",
    title: "Business identifiers",
    desc: "Enter identifiers and online presence.",
    render: () => formGrid([
      input("Company EIN / TIN *", "ein", "XX-XXXXXXX"),
      input("Company Website *", "website", "https://…"),
      input("Company Social Presence (Optional)", "social", "https://…", true)
    ]),
    onMount: () => applyAiToFormIfPresent(),
    canNext: () => req(["ein","website"])
  },

  {
    name: "Business Classification",
    title: "Business classification",
    desc: "Tell us what the business does and how it will be used.",
    render: () => formGrid([
      select("Business Type *", "businessType", BUSINESS_TYPES),
      select("Special Business Category *", "specialCategory", SPECIAL_CATS),
      select("Intended Use of Platform *", "intendedUse", INTENDED_USE, true)
    ]),
    onMount: () => applyAiToFormIfPresent(),
    canNext: () => req(["businessType","specialCategory","intendedUse"])
  },

  {
    name: "Operational & Risk Context",
    title: "Operational context",
    desc: "Share projected usage to support risk review.",
    render: () => formGrid([
      select("Expected Monthly Transaction Volume *", "monthlyVolume", VOL),
      select("Expected Monthly Transaction Count *", "monthlyCount", COUNT),
      select("Average Transaction Value *", "avgValue", AVG),
      select("Primary Customer Type *", "customerType", CUST_TYPE),
      select("Primary Customer Geography *", "customerGeo", CUST_GEO)
    ]),
    onMount: () => applyAiToFormIfPresent(),
    canNext: () => req(["monthlyVolume","monthlyCount","avgValue","customerType","customerGeo"])
  },

  {
    name: "Business Description",
    title: "Business description",
    desc: "Provide a brief description of business activity.",
    render: () => `
      <div class="field full">
        <div class="labelRow">
          <label>Brief Description of Business Activity *</label>
          ${confidencePill("description")}
        </div>
        <textarea id="description" placeholder="Max 250 characters">${escapeHtml(values.description || "")}</textarea>
        <div class="hint">Keep it short and specific.</div>
      </div>
    `,
    onMount: () => {
      const canAutoFillDesc =
        (condition === "B" || condition === "C") &&
        !values.description &&
        ai.fields?.description?.value;

      if (canAutoFillDesc) {
        values.description = String(ai.fields.description.value).slice(0, 250);
        const t = document.getElementById("description");
        if (t) {
          t.value = values.description;
          markAutofilled("description");
          dispatchValueEvents(t);
        }
      }
      updateConfidenceUI("description");

      const t = document.getElementById("description");
      if (!t) return;

      t.addEventListener("focus", () => onFieldFocus("description"));
      t.addEventListener("input", () => {
        const prev = values.description;
        values.description = t.value.slice(0, 250);
        onFieldChange("description", prev, values.description);
        updateNav();
        if (DEBUG) refreshLogPanel();
      });

      updateNav();
    },
    canNext: () => !!values.description.trim()
  },

  {
    name: "Review & Submit",
    title: "Review & submit",
    desc: "Confirm details before submission.",
    render: () => reviewHtml(),
    onMount: () => {
      logEvent("review_screen_shown", {});
      applyAiConfidenceToReview();
    },
    canNext: () => true
  },

  {
    name: "Post-Task Survey",
    title: "Short survey",
    desc: "Answer a few questions about workload and trust.",
    render: () => surveyHtml(),
    onMount: () => wireSurvey(),
    canNext: () => surveyComplete()
  },

  {
    name: "Done",
    title: "Thank you",
    desc: "Complete.",
    render: () => `
      <div class="note">
        <div><strong>Complete.</strong> Thank you for participating.</div>
        <div class="muted small" style="margin-top:6px;">You may close this tab now.</div>
      </div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn btn--ghost" type="button" id="restartBtn">Restart</button>
      </div>
    `,
    onMount: () => {
      document.getElementById("restartBtn")?.addEventListener("click", () => restart());
    },
    canNext: () => true
  }
];

// -------------------- Render / navigation core --------------------
function setScreen() {
  const s = screens[step];

  endScreenVisit();
  startScreenVisit(step, s.name);

  const titleEl = document.getElementById("screenTitle");
  const descEl = document.getElementById("screenDesc");
  const bodyEl = document.getElementById("screenBody");

  if (titleEl) titleEl.textContent = s.title;
  if (descEl) descEl.textContent = s.desc;
  if (bodyEl) bodyEl.innerHTML = s.render();

  wireInputs();
  s.onMount?.();

  renderStepper();
  updateNav();

  if (DEBUG) refreshLogPanel();

  logEvent("screen_enter", { screen_index: step, screen_name: s.name });

  if (step >= 1) activateTab("profile");
  else activateTab("doc");
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
    dwell_ms: currentVisit.dwell_ms
  });
}

// -------------------- Inputs + confidence UI --------------------
function formGrid(inner) {
  const html = Array.isArray(inner) ? inner.join("") : inner;
  return `<div class="fieldgrid">${html}</div>`;
}

function input(labelText, bindKey, placeholder, full = false) {
  const cls = full ? "field full" : "field";
  return `
    <div class="${cls}">
      <div class="labelRow">
        <label>${escapeHtml(labelText)}</label>
        ${confidencePill(bindKey)}
      </div>
      <input data-bind="${bindKey}" type="text" placeholder="${escapeHtml(placeholder)}" />
    </div>
  `;
}

function select(labelText, bindKey, options, full = false) {
  const cls = full ? "field full" : "field";
  const opts = [
    `<option value="">Select…</option>`,
    ...options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
  ].join("");

  return `
    <div class="${cls}">
      <div class="labelRow">
        <label>${escapeHtml(labelText)}</label>
        ${confidencePill(bindKey)}
      </div>
      <select data-bind="${bindKey}">${opts}</select>
    </div>
  `;
}

function confidencePill(key) {
  if (condition !== "B" && condition !== "C") return "";
  return `<span class="conf conf--empty" id="conf-${escapeHtml(key)}">—</span>`;
}

function updateConfidenceUI(key) {
  if (condition !== "B" && condition !== "C") return;
  const el = document.getElementById(`conf-${key}`);
  if (!el) return;

  const c = ai.fields?.[key]?.confidence;
  if (typeof c !== "number") {
    el.textContent = "—";
    el.className = "conf conf--empty";
    return;
  }

  const pct = Math.round(c * 100);
  el.textContent = `${pct}%`;

  if (pct >= 80) el.className = "conf conf--high";
  else if (pct >= 55) el.className = "conf conf--med";
  else el.className = "conf conf--low";
}

function markAutofilled(key) {
  const el = document.querySelector(`[data-bind="${key}"]`);
  if (!el) return;
  el.classList.add("autofilled");
}

function wireInputs() {
  document.querySelectorAll("[data-bind]").forEach(el => {
    const key = el.getAttribute("data-bind");
    if (!key) return;

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") el.value = values[key] ?? "";
    if (el.tagName === "SELECT") el.value = values[key] ?? "";

    updateConfidenceUI(key);

    el.addEventListener("focus", () => onFieldFocus(key));

    const handler = () => {
      const prev = values[key];
      const next = el.value;
      values[key] = next;
      onFieldChange(key, prev, next);
      updateNav();
      if (DEBUG) refreshLogPanel();
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

  if (!firstSet[fieldKey] && String(next ?? "").trim().length > 0) {
    firstSet[fieldKey] = next;
  }

  logEvent("field_change", { field: fieldKey, from: prev ?? "", to: next ?? "" });
}

function req(keys) {
  return keys.every(k => (values[k] ?? "").toString().trim().length > 0);
}

// -------------------- Review --------------------
function reviewHtml() {
  const rows = [
    ["Company Legal Name", values.legalName, "legalName"],
    ["Company DBA", values.dba || "—", "dba"],
    ["Company Address", values.address, "address"],
    ["Formation State", values.formationState, "formationState"],
    ["Formation Date", values.formationDate, "formationDate"],
    ["EIN / TIN", values.ein, "ein"],
    ["Website", values.website, "website"],
    ["Social Presence", values.social || "—", "social"],
    ["Business Type", values.businessType, "businessType"],
    ["Special Category", values.specialCategory, "specialCategory"],
    ["Intended Use", values.intendedUse, "intendedUse"],
    ["Monthly Volume", values.monthlyVolume, "monthlyVolume"],
    ["Monthly Count", values.monthlyCount, "monthlyCount"],
    ["Avg Transaction Value", values.avgValue, "avgValue"],
    ["Customer Type", values.customerType, "customerType"],
    ["Customer Geography", values.customerGeo, "customerGeo"],
    ["Business Description", values.description, "description"]
  ];

  const list = rows
    .map(([k, v, key]) => `
      <div class="reviewRow">
        <div class="k">
          ${escapeHtml(k)}
          ${(condition === "B" || condition === "C") ? `<span class="reviewConf" id="reviewConf-${key}"></span>` : ""}
        </div>
        <div class="v">${escapeHtml(v || "")}</div>
      </div>
    `)
    .join("");

  return `<div class="review">${list}</div>`;
}

function applyAiConfidenceToReview() {
  if (condition !== "B" && condition !== "C") return;
  Object.keys(values).forEach(key => {
    const el = document.getElementById(`reviewConf-${key}`);
    if (!el) return;
    const c = ai.fields?.[key]?.confidence;
    if (typeof c !== "number") {
      el.textContent = "";
      return;
    }
    el.textContent = ` · ${Math.round(c * 100)}%`;
  });
}

// -------------------- Survey --------------------
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
  const opts = [1,2,3,4,5,6,7]
    .map(v => `
      <label class="radioPill">
        <input type="radio" name="${id}" value="${v}"> <span>${v}</span>
      </label>
    `)
    .join("");

  return `
    <div class="field full">
      <label>${escapeHtml(prompt)} <span class="muted">(1–7)</span></label>
      <div class="radioRow">${opts}</div>
    </div>
  `;
}

function wireSurvey() {
  ["tlx_mental","tlx_temporal","tlx_effort","tlx_frustration","tlx_performance","tlx_physical"].forEach(id => {
    const el = document.getElementById(id);
    const out = document.getElementById(`${id}_val`);
    if (!el || !out) return;

    el.addEventListener("input", () => {
      out.textContent = el.value;
      logEvent("survey_range_change", { field: id, value: Number(el.value) });
      updateNav();
      if (DEBUG) refreshLogPanel();
    });
  });

  ["effort_single","umux_req","umux_easy","trust_auto","control"].forEach(name => {
    document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
      r.addEventListener("change", () => {
        logEvent("survey_radio_change", { field: name, value: Number(r.value) });
        updateNav();
        if (DEBUG) refreshLogPanel();
      });
    });
  });
}

function surveyComplete() {
  const required = ["effort_single","umux_req","umux_easy","trust_auto","control"];
  return required.every(n => !!document.querySelector(`input[name="${n}"]:checked`));
}

// -------------------- Firestore writes (events only) --------------------
async function writeStudyEvent(eventName) {
  const fb = window.__FIREBASE__;
  if (!fb?.db || !fb?.auth?.currentUser) {
    logEvent("firebase_not_ready", { event: eventName });
    return;
  }

  const { addDoc, collection } = await import(
    "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js"
  );

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

  await addDoc(collection(fb.db, "study_events"), payload);
  logEvent("firebase_write_ok", { event: eventName });
}

// -------------------- Deterministic Prefill (B/C) --------------------
// Kept as a function so the "Retry" button still works, but it never makes a network call.
async function runAiPrefillIfNeeded(reason) {
  if (condition !== "B" && condition !== "C") return;
  if (ai.status === "running") return;

  // If already done, don't re-run unless explicitly requested.
  if (ai.status === "done" && reason !== "manual_retry") return;

  ai.status = "running";
  ai.error = null;
  ai.lastHttpStatus = null;
  updateAiBannerUI();

  // Synchronously set deterministic fields
  Object.keys(PREFILL_VALUES).forEach((k) => {
    // Only prefill empty fields to preserve participant edits.
    const empty = String(values[k] ?? "").trim().length === 0;
    if (empty) values[k] = PREFILL_VALUES[k];
  });

  ai.fields = {};
  Object.keys(PREFILL_VALUES).forEach((k) => {
    ai.fields[k] = {
      value: PREFILL_VALUES[k],
      confidence: typeof PREFILL_CONFIDENCE[k] === "number" ? PREFILL_CONFIDENCE[k] : 0.7,
    };
  });

  ai.status = "done";
  ai.lastRunTsIso = new Date().toISOString();
  ai.meta = { model: "deterministic" };

  logEvent("ai_prefill_ok", {reason: reason || "deterministic"});

  applyAiToFormIfPresent();
  updateAiBannerUI();
  Object.keys(values).forEach((k) => updateConfidenceUI(k));
}

function dispatchValueEvents(el) {
  try {
    el.dispatchEvent(new Event("input", {bubbles: true}));
    el.dispatchEvent(new Event("change", {bubbles: true}));
  } catch {}
}

function normalizeStr(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bestOptionMatch(options, suggestion) {
  const sug = normalizeStr(suggestion);
  if (!sug) return "";

  // exact (normalized) match first
  for (let i = 0; i < options.length; i += 1) {
    if (normalizeStr(options[i]) === sug) return options[i];
  }

  // contains match
  for (let i = 0; i < options.length; i += 1) {
    const opt = normalizeStr(options[i]);
    if (opt.indexOf(sug) >= 0 || sug.indexOf(opt) >= 0) return options[i];
  }

  // overlap score
  let best = "";
  let bestScore = -1;

  const sugParts = sug.split(" ").filter(Boolean);

  for (let i = 0; i < options.length; i += 1) {
    const optRaw = options[i];
    const opt = normalizeStr(optRaw);
    const optParts = opt.split(" ").filter(Boolean);

    let overlap = 0;
    for (let a = 0; a < sugParts.length; a += 1) {
      for (let b = 0; b < optParts.length; b += 1) {
        if (sugParts[a] === optParts[b]) overlap += 1;
      }
    }

    const denom = Math.max(1, sugParts.length + optParts.length);
    const score = (2 * overlap) / denom;

    if (score > bestScore) {
      bestScore = score;
      best = optRaw;
    }
  }

  return best || "";
}

function chooseSelectValue(selectEl, suggestion, key) {
  const options = Array.from(selectEl.options || [])
    .map(o => ({
      value: o.value,
      label: (o.textContent || o.value || "").trim()
    }))
    .filter(o => o.value && o.value.trim().length > 0);

  if (options.length === 0) return "";

  const raw = String(suggestion || "").trim();
  const rawLower = raw.toLowerCase();

  // ---- FIELD-SPECIFIC NORMALIZATION (this is the magic) ----
  // Map AI outputs -> your actual dropdown labels
  const overrides = {
    businessType: (v) => {
      const x = String(v || "").toLowerCase();
      if (x.includes("tech")) return "Technology Services";
      if (x.includes("software")) return "Technology Services";
      if (x.includes("professional")) return "Professional Services";
      if (x.includes("health")) return "Healthcare";
      if (x.includes("edu")) return "Education";
      if (x.includes("non")) return "Non-profit";
      if (x.includes("market")) return "Marketplace";
      if (x.includes("finance") || x.includes("fintech")) return "Financial Services";
      if (x.includes("hospital")) return "Hospitality";
      if (x.includes("manufact")) return "Manufacturing";
      if (x.includes("retail")) return "Retail";
      return v;
    },

    intendedUse: (v) => {
      const x = String(v || "").toLowerCase();

      // Your dropdown options:
      // ["Employee incentives","Customer rewards and incentives","Marketing promotions",
      //  "Partner payouts","Expense management","Gift cards for events","Other"]

      if (x.includes("employee")) return "Employee incentives";
      if (x.includes("customer") || x.includes("loyalty") || x.includes("rewards")) return "Customer rewards and incentives";
      if (x.includes("marketing") || x.includes("promotion")) return "Marketing promotions";
      if (x.includes("partner") || x.includes("payout")) return "Partner payouts";
      if (x.includes("expense")) return "Expense management";
      if (x.includes("event")) return "Gift cards for events";

      // Common AI phrase
      if (x.includes("software") || x.includes("development")) return "Other";

      return v;
    },

    customerType: (v) => {
      const x = String(v || "").toLowerCase();
      // Your options: ["Consumers","Small businesses","Mid-market","Enterprise","Non-profits","Mixed"]
      if (x === "b2b") return "Enterprise";
      if (x.includes("enterprise")) return "Enterprise";
      if (x.includes("consumer") || x.includes("b2c")) return "Consumers";
      if (x.includes("small")) return "Small businesses";
      if (x.includes("mid")) return "Mid-market";
      if (x.includes("non")) return "Non-profits";
      if (x.includes("mixed")) return "Mixed";
      return v;
    },

    customerGeo: (v) => {
      const x = String(v || "").toLowerCase();
      // Your options: ["US only","US + international","International only"]
      if (x === "usa" || x === "us" || x.includes("united states")) return "US only";
      if (x.includes("international") && x.includes("us")) return "US + international";
      if (x.includes("international")) return "International only";
      return v;
    }
  };

  const normalized = overrides[key] ? overrides[key](raw) : raw;
  const normLower = String(normalized || "").toLowerCase();

  // ---- 1) Exact match by option value ----
  for (const o of options) {
    if (o.value === raw || o.value === normalized) return o.value;
  }

  // ---- 2) Exact match by label ----
  for (const o of options) {
    if (o.label.toLowerCase() === rawLower) return o.value;
    if (o.label.toLowerCase() === normLower) return o.value;
  }

  // ---- 3) Substring match ----
  for (const o of options) {
    const l = o.label.toLowerCase();
    if (l.includes(normLower) || normLower.includes(l)) return o.value;
    if (l.includes(rawLower) || rawLower.includes(l)) return o.value;
  }

  // ---- 4) Fallback: choose first real option ----
  return options[0].value;
}

function dispatchValueEvents(el) {
  try {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    // ignore
  }
}

function normalizeText(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, ""); // remove punctuation
}

function tokenize(s) {
  const n = normalizeText(s);
  if (!n) return [];
  return n.split(" ").filter(Boolean);
}

function abbrevToStateName(v) {
  const x = normalizeText(v).toUpperCase();
  const map = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
    MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
    OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
  };
  return map[x] || "";
}

// Simple Levenshtein (fast enough for small option lists)
function levenshtein(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) dp[j] = j;

  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,       // delete
        dp[j - 1] + 1,   // insert
        prev + cost      // replace
      );
      prev = tmp;
    }
  }
  return dp[n];
}

function tokenOverlapScore(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;

  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter += 1; });
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union; // Jaccard
}

/**
 * Choose the best <option> value for a SELECT given an AI suggestion.
 * Always returns one of the select's option values (or "" if none exist).
 */
function chooseSelectValue(selectEl, suggestion, key) {
  const opts = Array.from(selectEl.options || [])
    .map((o) => ({
      value: o.value,
      label: o.textContent || o.value
    }))
    .filter((o) => String(o.value).trim().length > 0); // ignore placeholder

  if (opts.length === 0) return "";

  const raw = String(suggestion || "").trim();
  const rawN = normalizeText(raw);

  // Field-specific normalization
  let normalized = raw;
  if (key === "formationState") {
    const stateName = abbrevToStateName(raw);
    if (stateName) normalized = stateName;
  }
  if (key === "customerGeo") {
    // Common AI outputs → your dropdown labels
    const n = normalizeText(raw);
    if (n === "usa" || n === "us" || n === "united states" || n === "unitedstates") {
      normalized = "US only";
    }
    if (n.includes("international") && n.includes("us")) normalized = "US + international";
    if (n.includes("international") && !n.includes("us")) normalized = "International only";
  }

  const norm = String(normalized).trim();
  const normN = normalizeText(norm);

  // 1) Exact value match
  for (let i = 0; i < opts.length; i += 1) {
    if (opts[i].value === raw) return opts[i].value;
  }

  // 2) Exact label match (normalized)
  for (let i = 0; i < opts.length; i += 1) {
    if (normalizeText(opts[i].label) === rawN) return opts[i].value;
    if (normalizeText(opts[i].label) === normN) return opts[i].value;
  }

  // 3) Substring match (either way)
  for (let i = 0; i < opts.length; i += 1) {
    const l = normalizeText(opts[i].label);
    if (l.includes(rawN) || rawN.includes(l)) return opts[i].value;
    if (l.includes(normN) || normN.includes(l)) return opts[i].value;
  }

  // 4) Fuzzy score: token overlap + levenshtein
  let best = opts[0];
  let bestScore = -Infinity;

  for (let i = 0; i < opts.length; i += 1) {
    const opt = opts[i];
    const label = opt.label;

    const overlap = tokenOverlapScore(norm, label); // 0..1
    const dist = levenshtein(norm, label);          // 0..inf
    const len = Math.max(normalizeText(norm).length, normalizeText(label).length) || 1;
    const sim = 1 - (dist / len);                   // approx 0..1

    // Weight overlap more for dropdown semantics
    const score = (overlap * 2.0) + (sim * 1.0);

    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }

  if (DEBUG) {
    console.log("[AI SELECT MATCH]", {
      key,
      suggestion: raw,
      normalized: norm,
      chosen: best,
      score: bestScore,
      options: opts.map(o => o.label)
    });
  }

  return best.value;
}


function applyAiToFormIfPresent() {
  if (condition !== "B" && condition !== "C") return;
  if (!ai.fields || typeof ai.fields !== "object") return;

  Object.keys(values).forEach((key) => {
    const suggestionObj = ai.fields?.[key];
    const suggestion = suggestionObj?.value;
    const confidence = suggestionObj?.confidence;

    if (suggestion == null) return;

    // ✅ Confidence gating for Condition C only
    if (condition === "C") {
      const thr = typeof CONFIDENCE_THRESHOLD_C === "number" ? CONFIDENCE_THRESHOLD_C : 0.6;
      const c = typeof confidence === "number" ? confidence : 0;
      if (c < thr) {
        updateConfidenceUI(key);
        return;
      }
    }

    const empty = String(values[key] ?? "").trim().length === 0;
    if (!empty) return;

    const el = document.querySelector(`[data-bind="${key}"]`);

    if (el && el.tagName === "SELECT") {
      const chosen = chooseSelectValue(el, suggestion, key);
      if (chosen) {
        values[key] = String(chosen);
        el.value = values[key];
        markAutofilled(key);
        dispatchValueEvents(el);
      }
      updateConfidenceUI(key);
      return;
    }

    values[key] = String(suggestion);

    if (el) {
      el.value = values[key];
      markAutofilled(key);
      dispatchValueEvents(el);
    }

    updateConfidenceUI(key);
  });

  updateNav();
}



// -------------------- AI banner (Screen 0) --------------------
function aiBannerHtml() {
  return `
    <div id="aiBanner" class="aiBanner" style="margin-bottom:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:600;">AI Prefill</div>
          <div class="muted small" id="aiBannerText">Preparing…</div>
        </div>
        <button class="btn btn--ghost" id="aiRetryBtn" type="button">Retry</button>
      </div>

      <div class="muted small" id="aiBannerErr" style="margin-top:6px; display:none;"></div>

      <details id="aiDebugWrap" style="margin-top:10px;">
        <summary class="muted small">Debug: show raw AI response</summary>
        <div class="note small" style="margin-top:8px;">
          <div><span class="muted">HTTP status:</span> <strong id="aiDbgStatus">—</strong></div>
          <div><span class="muted">Last run:</span> <strong id="aiDbgTs">—</strong></div>
          <div><span class="muted">Model:</span> <strong id="aiDbgModel">—</strong></div>
        </div>
        <pre id="aiDebugPre" style="margin-top:8px; max-height:280px; overflow:auto; background:#0b0b0b; color:#eaeaea; padding:10px; border-radius:10px; white-space:pre-wrap; word-break:break-word;"></pre>
      </details>
    </div>
  `;
}

function wireAiBannerControls() {
  document.getElementById("aiRetryBtn")?.addEventListener("click", async () => {
    await runAiPrefillIfNeeded("manual_retry");
  });
}

function updateAiBannerUI() {
  if (condition !== "B" && condition !== "C") return;
  const banner = document.getElementById("aiBanner");
  const text = document.getElementById("aiBannerText");
  const err = document.getElementById("aiBannerErr");
  const retry = document.getElementById("aiRetryBtn");

  const dbgStatus = document.getElementById("aiDbgStatus");
  const dbgTs = document.getElementById("aiDbgTs");
  const dbgModel = document.getElementById("aiDbgModel");
  const dbgPre = document.getElementById("aiDebugPre");

  if (!banner || !text || !err || !retry) return;

  err.style.display = "none";
  retry.disabled = ai.status === "running";

  if (ai.status === "idle") {
    text.textContent = "Ready to suggest values (CP 575 identity fields are already verified).";
  } else if (ai.status === "running") {
    text.textContent = "Generating suggested values…";
  } else if (ai.status === "done") {
    const n = Object.keys(ai.fields || {}).length;
    text.textContent = `Prefill ready (${n} fields suggested). You can edit anything before submitting.`;
  } else if (ai.status === "error") {
    text.textContent = "Prefill failed. You can retry or continue manually.";
    err.textContent = ai.error || "Unknown error";
    err.style.display = "block";
  }

  // ---- debug UI fill ----
  if (dbgStatus) dbgStatus.textContent = String(ai.lastHttpStatus ?? "—");
  if (dbgTs) dbgTs.textContent = String(ai.lastRunTsIso ?? "—");
  if (dbgModel) dbgModel.textContent = String(ai.meta?.model ?? "—");
  if (dbgPre) dbgPre.textContent = ai.lastResponsePretty || "";
}

// -------------------- Tabs + previews --------------------
function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  if (!DEBUG) {
    const logBtn = document.querySelector(`.tab[data-tab="log"]`);
    const logPane = document.getElementById("tab-log");
    if (logBtn) logBtn.style.display = "none";
    if (logPane) logPane.style.display = "none";
  }
}

function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach(b => b.classList.remove("tab--active"));
  document.querySelectorAll(".tabpane").forEach(p => p.classList.remove("tabpane--active"));

  const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  const tabPane = document.getElementById(`tab-${tabName}`);
  if (tabBtn && tabPane) {
    tabBtn.classList.add("tab--active");
    tabPane.classList.add("tabpane--active");
  }
}

function updateDocPreview(url) {
  const box = document.getElementById("docPreview");
  if (!box) return;
  box.innerHTML = `<img alt="CP 575 preview" src="${url}">`;
}

function renderProfile() {
  const box = document.getElementById("profilePreview");
  if (!box) return;
  box.innerHTML = `<img alt="Business Profile reference" src="${PRELOADED_PROFILE_URL}">`;
  logEvent("profile_preloaded", {});
}

// -------------------- Nav --------------------
function initNav() {
  const backBtn = document.getElementById("backBtn");
  const nextBtn = document.getElementById("nextBtn");
  if (!backBtn || !nextBtn) return;

  backBtn.addEventListener("click", () => {
    tracking.back_clicks += 1;
    logEvent("nav_back", {});

    if (screens[step]?.name === "Review & Submit") leftReviewViaBack = true;

    if (step > 0) {
      step--;
      setScreen();
    }
    if (DEBUG) refreshLogPanel();
  });

  nextBtn.addEventListener("click", async () => {
    tracking.next_clicks += 1;
    nextBtn.disabled = true;

    try {
      const currentName = screens[step]?.name;

      if (currentName === "Review & Submit") {
        finalizeOnboardingSubmit();
        await writeStudyEvent("submit_for_review");
      }

      if (currentName === "Post-Task Survey") {
        finalizeSurvey();
        await writeStudyEvent("survey_completed");
      }

      logEvent("nav_next", {});

      if (step < screens.length - 1) {
        step++;

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
      logEvent("nav_next_error", { message: String(err) });
      if (step < screens.length - 1) {
        step++;
        setScreen();
      }
    } finally {
      updateNav();
      
      if (DEBUG) refreshLogPanel();
    }
  });
}

// -------------------- Dropout snapshot --------------------
function initDropoutTracking() {
  window.addEventListener("beforeunload", () => {
    if (!tracking.completed) {
      logEvent("dropout_beforeunload", {
        last_screen: screens[step]?.name ?? "unknown",
        last_field: tracking.last_touched_field,
        ts_iso: new Date().toISOString()
      });
      try { localStorage.setItem(`study_partial_${sessionId}`, JSON.stringify(tracking)); } catch {}
    } else {
      try { localStorage.removeItem(`study_partial_${sessionId}`); } catch {}
    }
  });
}

// -------------------- Logging --------------------
function logEvent(type, data) {
  tracking.events.push({
    ts_iso: new Date().toISOString(),
    ts_ms: Date.now(),
    type,
    screen_index: step,
    screen_name: screens[step]?.name ?? "unknown",
    ...data
  });
}

function refreshLogPanel() {
  const el = document.getElementById("logPanel");
  if (!el) return;

  const last = tracking.events[tracking.events.length - 1];
  const kvs = [
    ["Participant", participantId],
    ["Session", sessionId],
    ["Condition", condition],
    ["Step", `${step + 1} / ${screens.length}`],
    ["Screen", screens[step]?.name ?? "—"],
    ["Started", tracking.started_at_iso ?? "—"],
    ["Submitted", tracking.submitted_at_iso ?? "—"],
    ["Time to complete (ms)", tracking.time_to_complete_ms ?? "—"],
    ["Total edits", tracking.total_edits],
    ["Back clicks", tracking.back_clicks],
    ["Review cycles", tracking.review_edit_cycles],
    ["Events logged", tracking.events.length],
    ["Last event", last ? `${last.type}` : "—"],
    ["AI status", (condition === "B" || condition === "C") ? ai.status : "n/a"],
    ["AI HTTP status", (condition === "B" || condition === "C") ? (ai.lastHttpStatus ?? "—") : "n/a"]
  ];

  const debugBlock = ((condition === "B" || condition === "C") && ai.lastResponsePretty)
    ? `
      <div class="note small" style="margin-top:12px;">
        <div style="font-weight:600;">AI Debug (raw response)</div>
        <pre style="margin-top:8px; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word;">${escapeHtml(ai.lastResponsePretty)}</pre>
      </div>
    `
    : "";

  el.innerHTML = kvs.map(([k, v]) => `
    <div class="kv">
      <div class="k">${escapeHtml(k)}</div>
      <div class="v">${escapeHtml(String(v))}</div>
    </div>
  `).join("") + debugBlock;
}

// -------------------- Finalize --------------------
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
    physical: Number(document.getElementById("tlx_physical")?.value ?? 0)
  };

  tracking.survey.nasa_tlx_raw_0_20 = tlx;
  tracking.survey.effort_single_1_7 = Number(document.querySelector(`input[name="effort_single"]:checked`)?.value ?? null);
  tracking.survey.umux_lite_1_7 = {
    meets_requirements: Number(document.querySelector(`input[name="umux_req"]:checked`)?.value ?? null),
    easy_to_use: Number(document.querySelector(`input[name="umux_easy"]:checked`)?.value ?? null)
  };
  tracking.survey.trust_automation_1_7 = Number(document.querySelector(`input[name="trust_auto"]:checked`)?.value ?? null);
  tracking.survey.perceived_control_1_7 = Number(document.querySelector(`input[name="control"]:checked`)?.value ?? null);

  logEvent("survey_completed_local", {});
}

// -------------------- Utilities --------------------
function escapeHtml(s) {
  return (s ?? "")
    .toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll("\"","&quot;")
    .replaceAll("'","&#039;");
}

function getOrCreateParticipantId() {
  const key = "study_participant_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;

  const id = `P${Math.floor(10000 + Math.random() * 90000)}`;
  localStorage.setItem(key, id);
  return id;
}

function getOrCreateConditionABC() {
  const key = "study_condition_abc";
  const existing = localStorage.getItem(key);
  if (existing === "A" || existing === "B" || existing === "C") return existing;

  const r = new Uint32Array(1);
  crypto.getRandomValues(r);

  // 3-way split
  const mod = r[0] % 3;
  const assigned = mod === 0 ? "A" : mod === 1 ? "B" : "C";

  localStorage.setItem(key, assigned);
  return assigned;
}

function restart() {
  window.location.href = window.location.pathname + window.location.search;
}

function renderConditionUI() {
  const badge = document.getElementById("condBadge");
  if (badge) badge.textContent = `Condition ${condition}`;
}

// -------------------- Init --------------------
(async function init() {
  renderConditionUI();
  initTabs();
  initNav();
  initDropoutTracking();
  setScreen();
  if (DEBUG) refreshLogPanel();
})();
