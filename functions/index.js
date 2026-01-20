"use strict";

const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const cors = require("cors")({origin: true});

/**
 * Deterministic prefill (NO OpenAI / NO external calls)
 *
 * Response shape:
 * {
 *   ok: true,
 *   fields: { [key]: { value: string, confidence: number } },
 *   cp575_text: "",
 *   meta: { ts_iso: string, deterministic: true }
 * }
 */

// ---- Deterministic payload (provided by user) ----
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

const FIELD_KEYS = Object.keys(PREFILL_VALUES);
/**
 * Clamp a number to the [0, 1] range.
 * Falls back to a conservative default if invalid.
 *
 * @param {number} n
 * @return {number}
 */
function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return 0.15;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
/**
 * Convert raw values + confidence map into the response "fields" format.
 *
 * @param {Object<string, any>} valuesObj
 * @param {Object<string, number>} confObj
 * @return {Object<string, {value: string, confidence: number}>}
 */
function toFieldMap(valuesObj, confObj) {
  const fields = {};
  FIELD_KEYS.forEach((k) => {
    const v = valuesObj[k];
    const c = clamp01(confObj[k]);
    fields[k] = {value: String(v == null ? "" : v), confidence: c};
  });
  return fields;
}

/**
 * If dropdown options are provided by the client, force deterministic values
 * to be EXACTLY one of the allowed labels.
 *
 * This keeps parity with your previous normalization layer and prevents
 * failures if option labels change.
 */
/**
 * If dropdown options are provided by the client, force deterministic values
 * to be EXACTLY one of the allowed labels.
 *
 * @param {Object<string, {value: string, confidence: number}>} fields
 * @param {Object<string, Array<string>>} dropdowns
 * @return {Object<string, {value: string, confidence: number}>}
 */
function enforceDropdowns(fields, dropdowns) {
  if (!dropdowns || typeof dropdowns !== "object") return fields;

  const out = {...fields};
  const keys = Object.keys(dropdowns);

  /**
   * Normalize a string for fuzzy matching.
   *
   * @param {string} s
   * @return {string}
   */
  function normalizeStr(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
  }

  /**
   * Pick the best matching option label from a list of
   * allowed dropdown options.
   *
   * @param {Array<string>} options
   * @param {string} suggestion
   * @return {string}
   */
  function bestOptionMatch(options, suggestion) {
    const opts = Array.isArray(options) ? options : [];
    const sug = normalizeStr(suggestion);
    if (!sug || opts.length === 0) return "";

    // exact normalized
    for (let i = 0; i < opts.length; i += 1) {
      if (normalizeStr(opts[i]) === sug) return opts[i];
    }

    // contains
    for (let i = 0; i < opts.length; i += 1) {
      const opt = normalizeStr(opts[i]);
      if (opt.includes(sug) || sug.includes(opt)) return opts[i];
    }

    // token overlap score
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

  keys.forEach((k) => {
    const opts = dropdowns[k];
    if (!Array.isArray(opts) || opts.length === 0) return;

    const cur = String((out && out[k] &&
      out[k].value) ? out[k].value : "").trim();
    if (opts.includes(cur)) return;

    const matched = bestOptionMatch(opts, cur);
    if (matched && opts.includes(matched)) {
      out[k] = {
        value: matched,
        confidence: Math.max(clamp01(out &&
          out[k] ? out[k].confidence : undefined), 0.6),
      };
    } else {
      out[k] = {
        value: opts[0],
        confidence: Math.max(clamp01(out &&
         out[k] ? out[k].confidence : undefined), 0.15),
      };
    }
  });

  return out;
}

exports.prefillBusiness = onRequest({region: "us-central1"}, (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ok: false, error: "Use POST"});
      }

      const body = req.body || {};
      const dropdowns =
        body.dropdowns && typeof body.dropdowns === "object" ?
        body.dropdowns : {};

      let fields = toFieldMap(PREFILL_VALUES, PREFILL_CONFIDENCE);
      fields = enforceDropdowns(fields, dropdowns);

      logger.info("prefillBusiness (deterministic) ok", {
        participant_id: body.participant_id || null,
        session_id: body.session_id || null,
      });

      return res.status(200).json({
        ok: true,
        fields,
        cp575_text: "",
        meta: {
          ts_iso: new Date().toISOString(),
          deterministic: true,
        },
      });
    } catch (e) {
      logger.error("prefillBusiness (deterministic) failed", {
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
});
