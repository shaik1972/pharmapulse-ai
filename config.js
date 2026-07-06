// ============================================
// PharmaPulse AI — Configuration
// ============================================
// Your Gemini API key is read from the browser
// environment. For local demo, paste it below.
// NEVER commit this file to a public repo.

const CONFIG = {
  // Reads from meta tag OR falls back to prompt
  GEMINI_API_KEY: "", // Leave blank — app will prompt you once

  // Gemini model candidates to try in order (app auto-picks the first working one)
  GEMINI_MODEL_CANDIDATES: [
    { version: "v1beta", model: "gemini-2.0-flash" },
    { version: "v1beta", model: "gemini-2.0-flash-lite" },
    { version: "v1beta", model: "gemini-1.5-flash" },
    { version: "v1",     model: "gemini-1.5-flash" },
    { version: "v1beta", model: "gemini-pro" },
  ],

  // Max clinical trials to fetch
  MAX_TRIALS: 12,

  // Show AI summaries (set false to skip API calls during testing)
  ENABLE_AI_SUMMARIES: true,
};
