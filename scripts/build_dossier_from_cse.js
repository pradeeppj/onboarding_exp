/**
 * Build a clean "company dossier" JSON by:
 * - running multiple targeted Google CSE queries
 * - filtering noisy results using trusted anchors (legal name / EIN / address tokens)
 * - writing company_dossier.json for OpenAI extraction later
 *
 * Usage:
 *   node build_dossier_from_cse.js
 *
 * Env:
 *   export GOOGLE_CSE_API_KEY="..."
 *   export GOOGLE_CSE_CX="97c6dcd94b3264e15"
 */

"use strict";

const fs = require("fs");

const CX = process.env.GOOGLE_CSE_CX;
const API_KEY = process.env.GOOGLE_CSE_API_KEY;

if (!CX || !API_KEY) {
  console.error("Missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX");
  process.exit(1);
}

// Verified anchors (Condition B)
const VERIFIED = {
  legalName: "CONNECT IQ LABS INC",
  ein: "81-1973626",
  address: "4064 RIVERMARK PKWY, SANTA CLARA, CA 95054",
};

// Build anchor tokens for filtering
function buildAnchors() {
  const tokens = [];

  tokens.push("connect iq labs");
  tokens.push("connectiq labs");
  tokens.push("81-1973626");

  // address tokens
  tokens.push("rivermark");
  tokens.push("santa clara");
  tokens.push("95054");

  return tokens;
}

const ANCHORS = buildAnchors();

function norm(s) {
  return String(s || "").toLowerCase();
}

function hasAnchor(item) {
  const hay = norm(
    (item.title || "") + " " +
    (item.snippet || "") + " " +
    (item.link || "") + " " +
    (item.displayLink || "")
  );

  return ANCHORS.some((a) => hay.includes(a));
}

function mapItem(it) {
  return {
    title: it.title || "",
    url: it.link || "",
    displayLink: it.displayLink || "",
    snippet: it.snippet || "",
  };
}

async function cseSearch(q) {
  const url =
    "https://www.googleapis.com/customsearch/v1" +
    "?key=" + encodeURIComponent(API_KEY) +
    "&cx=" + encodeURIComponent(CX) +
    "&q=" + encodeURIComponent(q);

  const resp = await fetch(url);
  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(
      "CSE error HTTP " + resp.status + ": " +
      (data && data.error && data.error.message ? data.error.message : JSON.stringify(data))
    );
  }

  const items = Array.isArray(data.items) ? data.items : [];
  return items.map(mapItem);
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.url) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

async function main() {
  const now = new Date().toISOString();

  const queries = [
    `"${VERIFIED.legalName}" "${VERIFIED.address}"`,
    `"${VERIFIED.legalName}" "${VERIFIED.ein}"`,
    `"${VERIFIED.legalName}" Santa Clara`,
    `"ConnectIQ Labs" "Rivermark"`,
    `"ConnectIQ Labs" dba`,
  ];

  const runs = [];
  let all = [];

  for (const q of queries) {
    console.log("Searching:", q);
    const items = await cseSearch(q);

    // Keep both raw and filtered for transparency
    const filtered = items.filter(hasAnchor);

    runs.push({
      source_type: "google_cse",
      fetched_at: now,
      query: q,
      raw_count: items.length,
      kept_count: filtered.length,
      raw_items: items.slice(0, 10),
      kept_items: filtered.slice(0, 10),
    });

    all = all.concat(filtered);
  }

  all = dedupeByUrl(all);

  // Rank: how many anchors match?
  const ranked = all
    .map((it) => {
      const hay = norm(it.title + " " + it.snippet + " " + it.url);
      let score = 0;
      for (const a of ANCHORS) {
        if (hay.includes(a)) score += 1;
      }
      return { ...it, anchor_score: score };
    })
    .sort((a, b) => b.anchor_score - a.anchor_score);

  const dossier = {
    schema_version: 1,
    created_at: now,
    verified_cp575: VERIFIED,
    anchors: ANCHORS,
    summary: {
      total_queries: queries.length,
      total_kept_unique_urls: ranked.length,
    },
    sources: runs,
    best_hits: ranked.slice(0, 25), // top evidence you pass to OpenAI
  };

  fs.writeFileSync("company_dossier.json", JSON.stringify(dossier, null, 2), "utf8");
  console.log("Wrote: company_dossier.json");
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
