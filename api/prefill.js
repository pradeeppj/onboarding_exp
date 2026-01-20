import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { cp575_image_url, participant_id, session_id } = req.body || {};
    if (!cp575_image_url) return res.status(400).json({ error: "cp575_image_url is required" });

    // JSON schema for structured output (includes OCR text for debugging)
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        cp575_text: { type: "string" },
        overall_confidence: { type: "number" },
        fields: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: []
        }
      },
      required: ["cp575_text", "overall_confidence", "fields"]
    };

    const fieldKeys = [
      "legalName","dba","address","formationState","formationDate","ein","website","social",
      "businessType","specialCategory","intendedUse","monthlyVolume","monthlyCount","avgValue",
      "customerType","customerGeo","description"
    ];

    for (const k of fieldKeys) {
      schema.properties.fields.properties[k] = {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "string" },
          confidence: { type: "number" } // 0..1
        },
        required: ["value","confidence"]
      };
      schema.properties.fields.required.push(k);
    }

    const instruction = `
You are extracting business onboarding fields from an IRS EIN confirmation letter (CP 575) image.

TASKS:
1) OCR the image and return the extracted text in cp575_text.
2) Prefill ALL onboarding fields and provide confidence 0..1 per field.
3) Do NOT guess EIN. Only fill EIN if explicitly present in cp575_text.
4) If a field cannot be justified from the CP 575 text, return value="" and confidence=0.0.
5) If CP575 doesn't contain fields like website/social/businessType/etc, leave them blank with low confidence.

IMPORTANT:
- Return ONLY valid JSON matching the schema.
- confidence guidance:
  - 0.95+ if clearly stated in CP575 text
  - 0.6-0.8 if strongly implied but not perfectly explicit
  - 0.0-0.4 if weak/unknown
`;

    // ✅ ONE vision call (OCR + extraction + confidence)
    // Use a vision-capable model.
    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `participant_id: ${participant_id || ""}\nsession_id: ${session_id || ""}\n\n${instruction}` },
            { type: "input_image", image_url: cp575_image_url }
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "cp575_prefill", schema }
      }
    });

    const json = JSON.parse(response.output_text);
    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
