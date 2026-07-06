// ============================================
// PharmaPulse AI — Configuration
// ============================================
// Your Gemini API key is read from the browser
// environment. For local demo, paste it below.
// NEVER commit this file to a public repo.

const CONFIG = {
  // Reads from meta tag OR falls back to prompt
  GEMINI_API_KEY: "", // Leave blank — app will prompt you once

  // Gemini model to use
  GEMINI_MODEL: "gemini-1.5-flash",

  // Gemini API version
  GEMINI_API_VERSION: "v1",

  // Max clinical trials to fetch
  MAX_TRIALS: 12,

  // Show AI summaries (set false to skip API calls during testing)
  ENABLE_AI_SUMMARIES: true,
};
