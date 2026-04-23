// Vercel serverless function — Claude cohort insights for Booster CLM.
//
// Cost control:
//   • Single call per user click (opt-in UI button, not automatic)
//   • Aggregated cohort stats only (no raw student rows sent)
//   • thinking: disabled (no reasoning tokens)
//   • Prompt caching on the system instruction (persistent prefix)
//   • max_tokens: 800 (short bullet insights)
//
// Expected per-call cost on Opus 4.7:
//   First call  (cache write): ~$0.012
//   Subsequent  (cache read):  ~$0.005

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a CLM (Customer Lifecycle Marketing) analyst for Vedantu's Booster Course Funnel — a 3-day trial that converts leads to paid courses.

You'll receive aggregated cohort statistics. Your job is to return exactly 5 concise, actionable bullet insights for the sales + CLM ops team.

Focus on:
• Anomalies (regions, tiers, or templates performing unusually high/low)
• Conversion risk (dropoffs between days, attendance vs HW gaps)
• Sales handoff priorities (hot leads to action, warm leads worth nurturing)
• Template performance signals (which messages are working)
• Next-cohort tweaks (what to change for the next batch)

Rules:
• 5 bullets. Start each with an emoji + 2-3 word label, then 1 sentence of insight.
• Reference specific numbers from the stats.
• Be specific and actionable — no generic advice.
• No preamble, no headers, no closing summary. Just the 5 bullets.
• Each bullet max 30 words.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed — POST required" });
    return;
  }

  try {
    const { cohort_stats } = req.body || {};

    if (!cohort_stats || typeof cohort_stats !== "object") {
      res.status(400).json({ error: "Missing cohort_stats object in request body" });
      return;
    }

    // Truncate payload to keep input tokens predictable
    const payload = JSON.stringify(cohort_stats, null, 2).slice(0, 4000);

    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 800,
      thinking: { type: "disabled" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Analyze this cohort and return 5 bullet insights:\n\n${payload}`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    res.status(200).json({
      insights: text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      res.status(401).json({ error: "ANTHROPIC_API_KEY missing or invalid on Vercel" });
      return;
    }
    if (err instanceof Anthropic.RateLimitError) {
      res.status(429).json({ error: "Rate limited — try again in a moment" });
      return;
    }
    res.status(500).json({ error: err?.message || "Unknown error" });
  }
}
