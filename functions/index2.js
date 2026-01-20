"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const cors = require("cors")({origin: true});

const OPENAI_MODEL = "gpt-4o-mini";

const CP575_EXTRACTED = {
  legalName: "CONNECT IQ LABS INC",
  ein: "81-1973626",
  address: "4064 RIVERMARK PKWY, SANTA CLARA, CA 95054",
};

const FIELD_KEYS = [
  "legalName",
  "dba",
  "address",
  "formationState",
  "formationDate",
  "ein",
  "website",
  "social",
  "businessType",
  "specialCategory",
  "intendedUse",
  "monthlyVolume",
  "monthlyCount",
  "avgValue",
  "customerType",
  "customerGeo",
  "description",
];

const MIN_GUESS_CONFIDENCE = 0.15;
const MAX_GUESS_CONFIDENCE = 0.95;

/**
 * Call fetch() and parse JSON response safely.
 * @param {string} url Target URL.
 * @param {Object} options Fetch options.
 * @return {Promise<Object>} {ok,status,data,text}
 */
async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = {raw: text};
  }

  return {ok: resp.ok, status: resp.status, data: data, text: text};
}

/**
 * Extract output text from OpenAI Responses API response.
 * @param {Object} data Responses API response JSON.
 * @return {string} output text
 */
function extractOutputText(data) {
  if (!data) return "";

  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  const outArr = data.output;
  if (!Array.isArray(outArr)) return "";

  let textOut = "";

  for (let i = 0; i < outArr.length; i += 1) {
    const item = outArr[i];
    const contentArr = item && item.content;

    if (!Array.isArray(contentArr)) continue;

    for (let j = 0; j < contentArr.length; j += 1) {
      const c = contentArr[j];
      if (c && c.type === "output_text" && typeof c.text === "string") {
        textOut += c.text;
      }
    }
  }

  return textOut;
}

/**
 * Attempt to infer a US state name from the verified address.
 * Keeps it simple: if we see " CA " or ", CA " -> California, etc.
 * @param {string} addr Verified address string.
 * @return {string} best guess state (full name) or ""
 */
function inferStateFromAddress(addr) {
  const s = String(addr || "").toUpperCase();
  const map = {
    " AL ": "Alabama",
    " AK ": "Alaska",
    " AZ ": "Arizona",
    " AR ": "Arkansas",
    " CA ": "California",
    " CO ": "Colorado",
    " CT ": "Connecticut",
    " DE ": "Delaware",
    " FL ": "Florida",
    " GA ": "Georgia",
    " HI ": "Hawaii",
    " ID ": "Idaho",
    " IL ": "Illinois",
    " IN ": "Indiana",
    " IA ": "Iowa",
    " KS ": "Kansas",
    " KY ": "Kentucky",
    " LA ": "Louisiana",
    " ME ": "Maine",
    " MD ": "Maryland",
    " MA ": "Massachusetts",
    " MI ": "Michigan",
    " MN ": "Minnesota",
    " MS ": "Mississippi",
    " MO ": "Missouri",
    " MT ": "Montana",
    " NE ": "Nebraska",
    " NV ": "Nevada",
    " NH ": "New Hampshire",
    " NJ ": "New Jersey",
    " NM ": "New Mexico",
    " NY ": "New York",
    " NC ": "North Carolina",
    " ND ": "North Dakota",
    " OH ": "Ohio",
    " OK ": "Oklahoma",
    " OR ": "Oregon",
    " PA ": "Pennsylvania",
    " RI ": "Rhode Island",
    " SC ": "South Carolina",
    " SD ": "South Dakota",
    " TN ": "Tennessee",
    " TX ": "Texas",
    " UT ": "Utah",
    " VT ": "Vermont",
    " VA ": "Virginia",
    " WA ": "Washington",
    " WV ": "West Virginia",
    " WI ": "Wisconsin",
    " WY ": "Wyoming",
  };

  const padded = ` ${s.replace(/,/g, " ")} `;
  const keys = Object.keys(map);

  for (let i = 0; i < keys.length; i += 1) {
    const abbr = keys[i];
    if (padded.includes(abbr)) return map[abbr];
  }
  return "";
}

/**
 * Clamp confidence.
 * @param {number} c candidate
 * @return {number} clamped
 */
function clampConfidence(c) {
  if (typeof c !== "number" || Number.isNaN(c)) return MIN_GUESS_CONFIDENCE;
  if (c < MIN_GUESS_CONFIDENCE) return MIN_GUESS_CONFIDENCE;
  if (c > 1) return 1;
  return c;
}

/**
 * Ensure value is non-empty.
 * @param {string} v value
 * @param {string} fallback fallback
 * @return {string}
 */
function nonEmpty(v, fallback) {
  const s = String(v || "").trim();
  if (s.length > 0) return s;
  return String(fallback || "").trim() || "Unknown";
}

/**
 * Normalize AI payload to expected shape and enforce:
 * - CP575 fields (legalName/ein/address) always 1.0 confidence
 * - Other fields never empty and never confidence 0 (min 0.15)
 * @param {Object} obj Candidate parsed object.
 * @param {string} companyHint Company hint.
 * @param {Object<string, string[]>} dropdowns Allowed dropdown values by key.
 * @return {Object} normalized payload.
 */
function normalizePayload(obj, companyHint, dropdowns) {
  const out = {
    cp575_text: "",
    fields: {},
  };

  if (obj && typeof obj.cp575_text === "string") {
    out.cp575_text = obj.cp575_text;
  }

  let inFields = {};
  if (obj && obj.fields && typeof obj.fields === "object") {
    inFields = obj.fields;
  }

  const inferredState = inferStateFromAddress(CP575_EXTRACTED.address);

  for (let i = 0; i < FIELD_KEYS.length; i += 1) {
    const k = FIELD_KEYS[i];
    const entry = inFields[k];

    let value = "";
    let confidence = MIN_GUESS_CONFIDENCE;

    if (entry && typeof entry === "object") {
      if (typeof entry.value === "string") value = entry.value;
      if (typeof entry.confidence === "number") confidence = entry.confidence;
    }

    // Provide lightweight, non-hardcoded-ish fallbacks
    let fallback = "Unknown";
    if (k === "dba") fallback = String(companyHint || "Unknown");
    if (k === "formationState") fallback = inferredState || "California";
    if (k === "website") fallback = "Unknown";
    if (k === "customerGeo") fallback = "US only";
    if (k === "businessType") fallback = "Technology Services";
    if (k === "specialCategory") fallback = "None";
    if (k === "intendedUse") fallback = "Other";
    if (k === "monthlyVolume") fallback = "Less than $10,000";
    if (k === "monthlyCount") fallback = "Fewer than 50";
    if (k === "avgValue") fallback = "<$50";
    if (k === "customerType") fallback = "Mixed";
    if (k === "description") fallback = "Business services";

    // Enforce "never empty"
    value = nonEmpty(value, fallback);

    // Enforce "never 0" except verified (handled below)
    confidence = clampConfidence(confidence);

    // Also keep guessed fields below 1.0
    if (confidence > MAX_GUESS_CONFIDENCE) confidence = MAX_GUESS_CONFIDENCE;

    out.fields[k] = {value, confidence};
  }

  // Force CP575 verified fields at 1.0
  out.fields.legalName = {value: CP575_EXTRACTED.legalName, confidence: 1};
  out.fields.ein = {value: CP575_EXTRACTED.ein, confidence: 1};
  out.fields.address = {value: CP575_EXTRACTED.address, confidence: 1};

  // If formationState ended up as "CA" or similar, normalize to full name
  if (out.fields.formationState && inferredState) {
    const v = String(out.fields.formationState.value || "").trim();
    if (v.toUpperCase() === "CA") {
      out.fields.formationState.value = inferredState;
      out.fields.formationState.confidence = Math.max(
          out.fields.formationState.confidence,
          0.85,
      );
    }
  }

  // Enforce dropdown fields to be EXACTLY one of the provided options.
  // If the model returns something close-but-not-exact, we normalize it here.
  const allowedDropdowns =
  dropdowns && typeof dropdowns === "object" ? dropdowns : {};

  /**
   * Normalize a string for loose comparison.
   * @param {string} s Input string.
   * @return {string} Normalized string.
   */
  function normalizeStr(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
  }

  /**
   * Pick the closest allowed option label for a suggestion.
   * @param {string[]} options Allowed option labels.
   * @param {string} suggestion Suggested label.
   * @return {string} Best matching option label or "".
   */
  function bestOptionMatch(options, suggestion) {
    const opts = Array.isArray(options) ? options : [];
    const sug = normalizeStr(suggestion);
    if (!sug || opts.length === 0) return "";

    for (let i = 0; i < opts.length; i += 1) {
      if (normalizeStr(opts[i]) === sug) return opts[i];
    }
    for (let i = 0; i < opts.length; i += 1) {
      const opt = normalizeStr(opts[i]);
      if (opt.indexOf(sug) >= 0 || sug.indexOf(opt) >= 0) return opts[i];
    }

    let best = "";
    let bestScore = -1;
    const sugParts = sug.split(" ").filter(Boolean);

    for (let i = 0; i < opts.length; i += 1) {
      const optRaw = opts[i];
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

  const ddKeys = Object.keys(allowedDropdowns);
  for (let i = 0; i < ddKeys.length; i += 1) {
    const k = ddKeys[i];
    const opts = allowedDropdowns[k];
    if (!out.fields[k] || !Array.isArray(opts) || opts.length === 0) continue;

    const current = String(out.fields[k].value || "").trim();
    const exact = opts.includes(current) ? current : "";
    const matched = exact || bestOptionMatch(opts, current);

    if (matched && opts.includes(matched)) {
      if (matched !== current) {
        out.fields[k].value = matched;
        out.fields[k].confidence = Math.max(out.fields[k].confidence, 0.6);
      }
    } else {
      out.fields[k].value = opts[0];
      out.fields[k].confidence = Math.max(out.fields[k].confidence,
          MIN_GUESS_CONFIDENCE);
    }
  }


  return out;
}

/**
 * Build instruction string for the model (NO OCR).
 * Include dossier text for evidence-based reasoning.
 * @param {string} companyHint Company name hint.
 * @param {string} dossierText Raw dossier (already fetched from Google/etc).
 * @param {Object<string, string[]>} dropdowns Allowed dropdown values by key.
 * @return {string} instruction text.
 */
function buildInstruction(companyHint, dossierText, dropdowns) {
  const allowedDropdowns = dropdowns && typeof
  dropdowns === "object" ? dropdowns : {};
  const hint = String(companyHint || "");
  const dossier = String(dossierText || "").trim();

  const header =
    "You are helping prefill business onboarding fields.\n\n";

  const verified =
    "Assume these CP575 fields are already extracted and verified.\n" +
    "Do NOT change them:\n" +
    "- legalName: " + CP575_EXTRACTED.legalName + "\n" +
    "- ein: " + CP575_EXTRACTED.ein + "\n" +
    "- address: " + CP575_EXTRACTED.address + "\n\n";

  const evidence =
    "You are ALSO given a 'company dossier' below.Treat it as raw evidence.\n" +
    "Use it to infer the remaining fields. If there are conflicts, prefer:\n" +
    "1) CP575 verified fields (always)\n" +
    "2) The dossier\n" +
    "3) Your best guess\n\n" +
    "COMPANY DOSSIER (RAW):\n" +
    (dossier.length ? dossier : "[No dossier provided]") +
    "\n\n";

  const allowed =
    "ALLOWED DROPDOWN OPTIONS (YOU MUST CHOOSE"+
    " EXACTLY ONE OF THESE LABELS):\n" +
    (Object.keys(allowedDropdowns).length ?
      Object.keys(allowedDropdowns)
          .map((k) => `${k}: ${JSON.stringify(allowedDropdowns[k] || [])}`)
          .join("\n") :
      "[No dropdown options provided]") +
    "\n\n";

  const rules =
    "Rules:\n" +
    "1) Do NOT do OCR.\n" +
    "2) Fill remaining fields using the dossier.\n" +
    "3) Each field must be {value, confidence}.\n" +
    "4) NEVER leave value empty.\n" +
    "5) NEVER return confidence = 0.\n" +
    "6) If unsure, make a reasonable best guess using" +
    "the company hint and dossier context.\n" +
    "7) Confidence must be between 0.10 and 0.95\n" +
    "8) For dropdown fields, "+
    "   your value MUST match EXACTLY one of the provided\n" +
    "   allowed labels for that field (from the ALLOWED" +
    "   DROPDOWN OPTIONS section).\n" +
    "   If the dossier implies something that isn't listed," +
    "   choose the closest allowed label.\n\n";

  const shape =
    "Return ONLY JSON with this exact shape:\n" +
    "{\n" +
    "  \"cp575_text\": \"\",\n" +
    "  \"fields\": {\n" +
    "    \"legalName\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"dba\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"address\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"formationState\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"formationDate\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"ein\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"website\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"social\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"businessType\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"specialCategory\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"intendedUse\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"monthlyVolume\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"monthlyCount\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"avgValue\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"customerType\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"customerGeo\": {\"value\":\"\", \"confidence\":0},\n" +
    "    \"description\": {\"value\":\"\", \"confidence\":0}\n" +
    "  }\n" +
    "}\n\n";

  const tail =
    "companyHint: " + hint + "\n";

  return header + verified + evidence + allowed + rules + shape + tail;
}

exports.prefillBusiness = onRequest(
    {region: "us-central1", secrets: ["OPENAI_API_KEY"]},
    (req, res) => {
      cors(req, res, async () => {
        try {
          if (req.method !== "POST") {
            return res.status(405).json({ok: false, error: "Use POST"});
          }

          const body = req.body || {};
          const companyHint = body.companyHint || "ConnectIQ Labs";

          const dropdowns =
            body.dropdowns && typeof body.dropdowns === "object" ?
            body.dropdowns : {};

          // ✅ Accept dossier either as:
          // - string (already serialized)
          // - object (we JSON.stringify it)
          let dossierText = "";
          if (typeof body.dossier === "string") {
            dossierText = body.dossier;
          } else if (body.dossier && typeof body.dossier === "object") {
            dossierText = JSON.stringify(body.dossier, null, 2);
          }

          const apiKey = process.env.OPENAI_API_KEY;
          if (!apiKey) {
            return res.status(500).json({
              ok: false,
              error: "Missing OPENAI_API_KEY secret.",
            });
          }

          const instruction = buildInstruction(companyHint,
              dossierText, dropdowns);

          const openaiBody = {
            model: OPENAI_MODEL,
            input: [
              {
                role: "user",
                content: [{type: "input_text", text: instruction}],
              },
            ],
            text: {format: {type: "json_object"}},
            temperature: 0.2,
          };

          logger.info("OpenAI request debug", {
            model: openaiBody.model,
            has_text: Boolean(openaiBody.text),
            text_format: openaiBody.text && openaiBody.text.format ?
            openaiBody.text.format.type :
            null,
            dossier_chars: dossierText ? dossierText.length : 0,
          });

          const startMs = Date.now();

          const result = await fetchJson(
              "https://api.openai.com/v1/responses",
              {
                method: "POST",
                headers: {
                  "Authorization": "Bearer " + apiKey,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(openaiBody),
              },
          );

          if (!result.ok) {
            const data = result && result.data ? result.data : null;
            let err = data;
            if (data && data.error) err = data.error;

            logger.error("OpenAI request failed", {
              status: result.status,
              error: err,
            });

            return res.status(500).json({
              ok: false,
              error: "OpenAI request failed",
              status: result.status,
              detail: err,
            });
          }

          const textOut = extractOutputText(result.data);
          logger.info("OpenAI raw output_text", {raw: textOut});

          let parsed = null;
          try {
            parsed = JSON.parse(textOut);
          } catch (e) {
            logger.error("OpenAI returned non-JSON", {raw: textOut});
            return res.status(500).json({
              ok: false,
              error: "OpenAI returned non-JSON",
              raw: textOut,
            });
          }

          logger.info("OpenAI parsed fields", {
            fields: parsed && parsed.fields ? parsed.fields : null,
          });

          const normalized = normalizePayload(parsed, companyHint, dropdowns);
          const durationMs = Date.now() - startMs;

          return res.status(200).json({
            ok: true,
            fields: normalized.fields,
            cp575_text: "",
            meta: {
              model: OPENAI_MODEL,
              ts_iso: new Date().toISOString(),
              duration_ms: durationMs,
              dossier_chars: dossierText ? dossierText.length : 0,
            },
          });
        } catch (e) {
          logger.error("prefillBusiness failed", {
            message: String(e),
            stack: String(e && e.stack),
          });

          return res.status(500).json({
            ok: false,
            error: "prefillBusiness failed",
            detail: String(e),
          });
        }
      });
    },
);
