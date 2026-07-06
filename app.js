// ============================================
// PharmaPulse AI — Main Application Logic
// ============================================

// ---- State ----
let allCards = [];
let currentDisease = "";
let geminiApiKey = "";
let activeGeminiModel = null; // auto-detected at runtime

// ---- Init ----
window.addEventListener("DOMContentLoaded", () => {
  geminiApiKey = sessionStorage.getItem("pharma_gemini_key") || "";
  if (!geminiApiKey) promptForKey();

  // Enter key triggers search
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
});

// ---- API Key Prompt ----
function promptForKey() {
  const key = prompt(
    "🔑 Enter your Gemini API key to enable AI summaries.\n\nGet one free at: aistudio.google.com/apikey\n\n(You can skip this — trial data will still load without AI)"
  );
  if (key && key.trim().length > 10) {
    geminiApiKey = key.trim();
    sessionStorage.setItem("pharma_gemini_key", geminiApiKey);
  }
}

// ---- Quick Search ----
function quickSearch(disease) {
  document.getElementById("searchInput").value = disease;
  runSearch();
}

// ---- Main Search Orchestrator ----
async function runSearch() {
  const input = document.getElementById("searchInput").value.trim();
  if (!input) {
    document.getElementById("searchInput").focus();
    return;
  }

  currentDisease = input;
  allCards = [];

  showLoadingState();

  try {
    // Step 1: Fetch clinical trials
    setLoadingMsg("🔬 Fetching live clinical trials...");
    const { trials, totalCount } = await fetchClinicalTrials(input);

    if (!trials || trials.length === 0) {
      showEmpty();
      return;
    }

    // Step 2: Update stats
    document.getElementById("statTrials").textContent = totalCount > trials.length ? `${trials.length} (of ${totalCount})` : trials.length;
    document.getElementById("statDisease").textContent =
      input.charAt(0).toUpperCase() + input.slice(1);

    // Step 3: Fetch FDA data concurrently for all trials
    setLoadingMsg("📋 Checking FDA approval database...");
    const fdaResults = await fetchFDABulk(trials);
    document.getElementById("statFDA").textContent = fdaResults.filter(Boolean).length;

    // Step 4: Render cards immediately
    hideLoadingState();
    showStatsBar();
    renderCards(trials, fdaResults);

    // Step 5: Show AI overview panel then fill async
    showAIOverview();
    if (geminiApiKey) {
      generateOverview(input, trials);
      generateCardSummaries(trials);
    } else {
      document.getElementById("aiOverviewLoader").style.display = "none";
      document.getElementById("aiOverviewText").textContent =
        "Add a Gemini API key to unlock AI-powered insights for this disease area.";
    }

  } catch (err) {
    console.error(err);
    showError("Search Failed", err.message || "An unexpected error occurred.");
  }
}

// ---- ClinicalTrials.gov API ----
async function fetchClinicalTrials(disease) {
  const params = new URLSearchParams({
    "query.cond": disease,
    "filter.overallStatus": "RECRUITING,ACTIVE_NOT_RECRUITING,COMPLETED",
    "fields": "NCTId,BriefTitle,Phase,OverallStatus,LeadSponsorName,StartDate,PrimaryCompletionDate,EnrollmentCount,Condition",
    "pageSize": CONFIG.MAX_TRIALS,
    "format": "json",
  });

  const res = await fetch(`https://clinicaltrials.gov/api/v2/studies?${params}&countTotal=true`);
  if (!res.ok) throw new Error(`ClinicalTrials.gov API error: ${res.status}`);
  const data = await res.json();

  const trialsArray = (data.studies || []).map((s) => {
    const p = s.protocolSection || {};
    const id = p.identificationModule || {};
    const status = p.statusModule || {};
    const design = p.designModule || {};
    const sponsor = p.sponsorCollaboratorsModule || {};

    return {
      nctId: id.nctId || "Unknown",
      title: id.briefTitle || "Unnamed Trial",
      phase: extractPhase(design.phases),
      status: status.overallStatus || "Unknown",
      sponsor: sponsor.leadSponsor?.name || "Unknown Sponsor",
      startDate: status.startDateStruct?.date || "—",
      completionDate: status.primaryCompletionDateStruct?.date || "—",
      enrollment: design.enrollmentInfo?.count || "—",
      conditions: (p.conditionsModule?.conditions || []).join(", "),
    };
  });

  return { trials: trialsArray, totalCount: data.totalCount || trialsArray.length };
}

function extractPhase(phases) {
  if (!phases || phases.length === 0) return "N/A";
  const p = phases[0];
  if (p.includes("1")) return "1";
  if (p.includes("2")) return "2";
  if (p.includes("3")) return "3";
  if (p.includes("4")) return "4";
  return "N/A";
}

// ---- openFDA API ----
// Extracts the most likely drug/compound name from a trial title by
// stripping common boilerplate prefixes and returning the first meaningful words.
function extractDrugTermFromTitle(title) {
  return title
    // Strip leading boilerplate phrases common in trial titles
    .replace(/^(A |An |The )?(Phase \d\/?[\dIV]* )?(,? )?(Randomized,? )?(Double-Blind,? )?(Placebo-Controlled,? )?(Open-Label,? )?(Multi[- ]?[Cc]enter,? )?(Study|Trial|Assessment|Evaluation|Investigation) of /i, "")
    .split(/[,\s]+/)   // split on space/comma
    .filter(w => w.length > 3 && !/^(and|with|for|the|of|in|on|to|vs|versus|study|trial)$/i.test(w))
    .slice(0, 2)
    .join(" ")
    .trim();
}

async function fetchFDASingle(trial, disease) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  // Strategy 1: Search by sponsor name (most reliable)
  const strategies = [
    // Sponsor name search
    `https://api.fda.gov/drug/drugsfda.json?search=applicant_full_name:"${encodeURIComponent(trial.sponsor)}"&limit=1`,
    // Drug term extracted from title
    `https://api.fda.gov/drug/drugsfda.json?search=products.brand_name:"${encodeURIComponent(extractDrugTermFromTitle(trial.title))}"&limit=1`,
    // Disease-level generic search
    `https://api.fda.gov/drug/drugsfda.json?search=products.brand_name:${encodeURIComponent(disease.split(" ")[0])}&limit=1`,
  ];

  for (const url of strategies) {
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) continue;                    // silently try next strategy
      const data = await res.json();
      const result = data.results?.[0];
      if (!result) continue;
      clearTimeout(timeout);
      return {
        applicationNumber: result.application_number,
        sponsorName: result.sponsor_name || result.applicant_full_name,
        approved: result.products?.some((p) => p.marketing_status === "Prescription"),
        brandName: result.products?.[0]?.brand_name || null,
      };
    } catch {
      // Silently continue — abort or network error
    }
  }

  clearTimeout(timeout);
  return null; // All strategies failed — expected for experimental drugs
}

async function fetchFDABulk(trials) {
  // Run all FDA lookups concurrently, each with its own silent fallback chain
  return await Promise.all(
    trials.map((trial) => fetchFDASingle(trial, currentDisease).catch(() => null))
  );
}


// ---- Gemini AI — Overview ----
async function generateOverview(disease, trials) {
  const trialSummary = trials
    .slice(0, 6)
    .map((t) => `- ${t.title} (Phase ${t.phase}, ${t.sponsor})`)
    .join("\n");

  const prompt = `You are a pharmaceutical research analyst. In 3-4 concise sentences, summarize the current drug development landscape for "${disease}" based on these active clinical trials:\n\n${trialSummary}\n\nFocus on: overall pipeline maturity, key phases in development, and what this means for patients. Be factual and professional.`;

  const text = await callGemini(prompt);
  if (text) {
    document.getElementById("aiOverviewLoader").style.display = "none";
    document.getElementById("aiOverviewText").textContent = text;
  }
}

// ---- Gemini AI — Card Summaries ----
async function generateCardSummaries(trials) {
  if (!CONFIG.ENABLE_AI_SUMMARIES) return;

  // Process in batches of 3 to avoid rate limits
  const batchSize = 3;
  for (let i = 0; i < Math.min(trials.length, 9); i += batchSize) {
    const batch = trials.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (trial, idx) => {
        const cardIdx = i + idx;
        const prompt = `In 1-2 sentences, describe what this clinical trial is studying and its significance: "${trial.title}" (Phase ${trial.phase}, sponsored by ${trial.sponsor}, status: ${trial.status}). Be concise and patient-friendly.`;
        const text = await callGemini(prompt);
        if (text) updateCardSummary(cardIdx, text);
      })
    );
    // Small delay between batches
    if (i + batchSize < trials.length) await sleep(1000);
  }
}

// ---- Gemini Model Auto-Detect ----
async function detectGeminiModel() {
  if (activeGeminiModel) return activeGeminiModel; // cached

  for (const candidate of CONFIG.GEMINI_MODEL_CANDIDATES) {
    try {
      const url = `https://generativelanguage.googleapis.com/${candidate.version}/models/${candidate.model}:generateContent?key=${geminiApiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Hi" }] }],
          generationConfig: { maxOutputTokens: 5 },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok || res.status === 400) {
        // 400 = bad request (model found but prompt issue) — still means model exists
        console.log(`✅ Gemini model detected: ${candidate.version}/${candidate.model}`);
        activeGeminiModel = candidate;
        return activeGeminiModel;
      }
      const err = await res.json().catch(() => ({}));
      console.warn(`❌ Model ${candidate.model} (${candidate.version}): ${err?.error?.message || res.status}`);
    } catch (e) {
      console.warn(`❌ Timeout/network error for ${candidate.model}`);
    }
  }
  return null;
}

// ---- Gemini API Call ----
async function callGemini(prompt) {
  if (!geminiApiKey) return null;

  // Auto-detect model on first call
  if (!activeGeminiModel) {
    activeGeminiModel = await detectGeminiModel();
    if (!activeGeminiModel) {
      console.error("No working Gemini model found.");
      return "AI unavailable — no compatible Gemini model found for your API key.";
    }
  }

  try {
    const url = `https://generativelanguage.googleapis.com/${activeGeminiModel.version}/models/${activeGeminiModel.model}:generateContent?key=${geminiApiKey}`;
    const res = await fetch(url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!res.ok) {
      const err = await res.json();
      console.warn("Gemini error:", err);
      const errMsg = err.error?.message || "Unknown error";
      if (res.status === 429) return "Rate limit reached — please wait a moment and try again.";
      // If this model stopped working, reset and retry next call
      if (res.status === 404) { activeGeminiModel = null; }
      return null;
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    console.warn("Gemini call failed:", err);
    return null;
  }
}

// ---- Render Cards ----
function renderCards(trials, fdaResults) {
  const grid = document.getElementById("drugGrid");
  grid.innerHTML = "";
  allCards = [];

  document.getElementById("resultsTitle").textContent =
    `${trials.length} Drug Trials — ${currentDisease.charAt(0).toUpperCase() + currentDisease.slice(1)}`;

  trials.forEach((trial, i) => {
    const fda = fdaResults[i];
    const card = createCard(trial, fda, i);
    allCards.push({ el: card, phase: trial.phase, data: trial, fda });
    grid.appendChild(card);
  });

  document.getElementById("resultsSection").style.display = "block";
}

function createCard(trial, fda, idx) {
  const div = document.createElement("div");
  div.className = "drug-card";
  div.style.animationDelay = `${idx * 0.06}s`;
  div.style.opacity = "0";
  div.setAttribute("data-phase", trial.phase);

  const phaseClass = getPhaseBadgeClass(trial.phase);
  const phaseLabel = trial.phase === "N/A" ? "N/A" : `Phase ${trial.phase}`;

  const fdaHtml = getFDAHtml(fda);
  const cardAccent = getPhaseAccent(trial.phase);
  div.style.setProperty("--card-accent", cardAccent);

  div.innerHTML = `
    <div class="card-header">
      <div class="card-title">${escHtml(trial.title)}</div>
      <span class="phase-badge ${phaseClass}">${phaseLabel}</span>
    </div>
    <div class="card-meta">
      <span class="meta-tag">🏢 ${escHtml(trial.sponsor)}</span>
      <span class="meta-tag">📅 ${trial.startDate}</span>
      ${trial.enrollment !== "—" ? `<span class="meta-tag">👥 ${trial.enrollment} enrolled</span>` : ""}
      <span class="meta-tag">⚡ ${formatStatus(trial.status)}</span>
    </div>
    <div class="card-ai-summary" id="summary-${idx}">
      <div class="ai-summary-loading">
        <div class="typing-dots"><span></span><span></span><span></span></div>
        <span>Generating AI insight...</span>
      </div>
    </div>
    <div class="card-footer">
      ${fdaHtml}
      <span class="card-cta">View details →</span>
    </div>
  `;

  // Trigger animation
  requestAnimationFrame(() => {
    div.style.transition = "opacity 0.4s ease, transform 0.4s ease";
    div.style.opacity = "1";
  });

  div.onclick = () => openModal(trial, fda, idx);
  return div;
}

function updateCardSummary(idx, text) {
  const el = document.getElementById(`summary-${idx}`);
  if (el) {
    el.innerHTML = `<span class="gemini-badge" style="font-size:10px;margin-bottom:6px;display:inline-block;">✦ Gemini</span><br>${escHtml(text)}`;
  }
}

// ---- Phase Filter ----
function filterPhase(phase) {
  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
  event.target.classList.add("active");

  allCards.forEach(({ el, phase: p }) => {
    if (phase === "all" || p === phase) {
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  });
}

// ---- Modal ----
function openModal(trial, fda, idx) {
  const content = document.getElementById("modalContent");
  const summaryEl = document.getElementById(`summary-${idx}`);
  const summaryHtml = summaryEl ? summaryEl.innerHTML : "";

  const fdaBadge = getFDAHtml(fda);
  const nctUrl = `https://clinicaltrials.gov/study/${trial.nctId}`;

  content.innerHTML = `
    <div class="modal-drug-title">${escHtml(trial.title)}</div>
    <div class="card-meta" style="margin-bottom:0">
      <span class="phase-badge ${getPhaseBadgeClass(trial.phase)}">${trial.phase === "N/A" ? "N/A" : `Phase ${trial.phase}`}</span>
      ${fdaBadge}
      <span class="meta-tag">⚡ ${formatStatus(trial.status)}</span>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Trial Details</div>
      <div class="modal-detail-grid">
        <div class="modal-detail-item">
          <div class="modal-detail-label">Lead Sponsor</div>
          <div class="modal-detail-value">${escHtml(trial.sponsor)}</div>
        </div>
        <div class="modal-detail-item">
          <div class="modal-detail-label">NCT ID</div>
          <div class="modal-detail-value" style="font-family:'JetBrains Mono',monospace;font-size:12px;">${trial.nctId}</div>
        </div>
        <div class="modal-detail-item">
          <div class="modal-detail-label">Start Date</div>
          <div class="modal-detail-value">${trial.startDate}</div>
        </div>
        <div class="modal-detail-item">
          <div class="modal-detail-label">Primary Completion</div>
          <div class="modal-detail-value">${trial.completionDate}</div>
        </div>
        <div class="modal-detail-item">
          <div class="modal-detail-label">Enrollment</div>
          <div class="modal-detail-value">${trial.enrollment} participants</div>
        </div>
        <div class="modal-detail-item">
          <div class="modal-detail-label">Conditions</div>
          <div class="modal-detail-value" style="font-size:12px;">${escHtml(trial.conditions) || "—"}</div>
        </div>
      </div>
    </div>

    ${fda ? `
    <div class="modal-section">
      <div class="modal-section-title">FDA Record</div>
      <div class="modal-detail-grid">
        <div class="modal-detail-item">
          <div class="modal-detail-label">Application Number</div>
          <div class="modal-detail-value" style="font-family:'JetBrains Mono',monospace;font-size:12px;">${fda.applicationNumber || "—"}</div>
        </div>
        <div class="modal-detail-item">
          <div class="modal-detail-label">Sponsor</div>
          <div class="modal-detail-value">${escHtml(fda.sponsorName || "—")}</div>
        </div>
      </div>
    </div>` : ""}

    <div class="modal-section">
      <div class="modal-section-title">✦ Gemini AI Insight</div>
      <div class="modal-ai-text">${summaryHtml || "AI summary is being generated..."}</div>
    </div>

    <a href="${nctUrl}" target="_blank" class="modal-link">
      🔗 View full trial on ClinicalTrials.gov
    </a>
  `;

  document.getElementById("modalOverlay").classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("active");
  document.body.style.overflow = "";
}

// Close modal on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ---- UI Helpers ----
function showLoadingState() {
  hide("statsBar"); hide("aiOverview"); hide("resultsSection");
  hide("emptyState"); hide("errorState");
  show("loadingState");
  document.getElementById("searchBtn").disabled = true;
  document.getElementById("searchBtnText").textContent = "Analyzing";
}

function hideLoadingState() {
  hide("loadingState");
  document.getElementById("searchBtn").disabled = false;
  document.getElementById("searchBtnText").textContent = "Analyze";
}

function showStatsBar() { show("statsBar"); }

function showAIOverview() {
  show("aiOverview");
  document.getElementById("aiOverviewLoader").style.display = "flex";
  document.getElementById("aiOverviewText").textContent = "";
}

function showEmpty() {
  hideLoadingState();
  show("emptyState");
}

function showError(title, msg) {
  hideLoadingState();
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMsg").textContent = msg;
  show("errorState");
}

function setLoadingMsg(msg) {
  document.getElementById("loadingMsg").textContent = msg;
}

function show(id) { document.getElementById(id).style.display = ""; }
function hide(id) { document.getElementById(id).style.display = "none"; }

// ---- Utility Helpers ----
function getPhaseBadgeClass(phase) {
  const map = { "1": "phase-1", "2": "phase-2", "3": "phase-3", "4": "phase-4" };
  return map[phase] || "phase-unknown";
}

function getPhaseAccent(phase) {
  const map = {
    "1": "linear-gradient(90deg, #63b3ed, #4299e1)",
    "2": "linear-gradient(90deg, #b794f4, #9f7aea)",
    "3": "linear-gradient(90deg, #f6c90e, #e9b308)",
    "4": "linear-gradient(90deg, #68d391, #48bb78)",
  };
  return map[phase] || "linear-gradient(90deg, #4a5568, #718096)";
}

function getFDAHtml(fda) {
  if (!fda) return `<span class="fda-status fda-not-found">📋 FDA: Not found</span>`;
  if (fda.approved) return `<span class="fda-status fda-approved">✅ FDA Approved</span>`;
  return `<span class="fda-status fda-pending">⏳ FDA: On file</span>`;
}

function formatStatus(status) {
  const map = {
    RECRUITING: "Recruiting",
    ACTIVE_NOT_RECRUITING: "Active",
    COMPLETED: "Completed",
    TERMINATED: "Terminated",
    SUSPENDED: "Suspended",
    WITHDRAWN: "Withdrawn",
  };
  return map[status] || status;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// Phase 2: Multimodal, Code Gen, and Chatbot
// ============================================

// ---- 1. Multimodal AI (Image Upload) ----
async function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!geminiApiKey) {
    alert("Please provide a Gemini API key first to use Vision capabilities.");
    return;
  }

  showLoadingState();
  setLoadingMsg("📸 Analyzing medical image...");

  try {
    const base64Data = await readFileAsBase64(file);
    // Remove the data:image/jpeg;base64, prefix for the API
    const base64Image = base64Data.split(",")[1];
    
    const prompt = `You are a medical analyst. The user is currently searching for trials related to "${currentDisease || 'a disease'}". 
    Analyze this uploaded image in that context. What does it show? Be concise and highly informative.`;

    // Use auto-detected model (same as chat/summaries)
    if (!activeGeminiModel) activeGeminiModel = await detectGeminiModel();
    if (!activeGeminiModel) throw new Error("No compatible Gemini model found for your API key.");

    const visionUrl = `https://generativelanguage.googleapis.com/${activeGeminiModel.version}/models/${activeGeminiModel.model}:generateContent?key=${geminiApiKey}`;
    const res = await fetch(visionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: file.type, data: base64Image } }
          ]
        }]
      })
    });

    if (!res.ok) throw new Error("Vision API failed.");
    const data = await res.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Could not analyze image.";

    
    hideLoadingState();
    
    // Show in modal
    const content = document.getElementById("modalContent");
    content.innerHTML = `
      <div class="modal-drug-title">📸 Image Analysis Results</div>
      <div class="modal-ai-text" style="margin-top:20px;">${escHtml(resultText)}</div>
    `;
    document.getElementById("modalOverlay").classList.add("active");

  } catch (err) {
    console.error(err);
    hideLoadingState();
    alert("Failed to analyze image. See console for details.");
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---- 2. Code Generation (Export Script) ----
async function generateAnalysisScript() {
  if (!allCards || allCards.length === 0) {
    alert("Please search for clinical trials first.");
    return;
  }
  if (!geminiApiKey) {
    alert("Gemini API key is required to generate code.");
    return;
  }

  // Create a minimal dataset representation to send to the prompt
  const datasetContext = allCards.map(c => 
    `{title: "${c.data.title}", phase: "${c.data.phase}", sponsor: "${c.data.sponsor}", enrollment: "${c.data.enrollment}"}`
  ).join(",\n");

  const prompt = `Write a Python script using pandas and matplotlib to analyze the following clinical trial dataset for "${currentDisease}".
  
Dataset:
[
${datasetContext}
]

Requirements:
1. Load this exact dataset as a pandas DataFrame.
2. Clean the 'enrollment' column (handle '—' or non-numeric values).
3. Create a bar chart showing the number of trials by Phase.
4. Output only the Python code inside a markdown code block, no other text.`;

  showLoadingState();
  setLoadingMsg("💻 Generating Python analysis script...");

  try {
    const codeResponse = await callGemini(prompt);
    hideLoadingState();
    if (allCards.length > 0) {
      document.getElementById("resultsSection").style.display = "block";
      document.getElementById("statsBar").style.display = "flex";
      document.getElementById("aiOverview").style.display = "block";
    }

    let cleanCode = codeResponse.replace(/```python|```/g, "").trim();
    if (!cleanCode) cleanCode = "# Failed to generate script.";

    const content = document.getElementById("modalContent");
    content.innerHTML = `
      <div class="modal-drug-title">💻 Python Analysis Script</div>
      <p style="color:var(--text-secondary);font-size:13px;margin:12px 0;">Run this script locally to visualize the trial dataset.</p>
      <div class="code-container" id="exportCodeBlock">${escHtml(cleanCode)}</div>
      <button class="chat-send" style="margin-top:16px;" onclick="navigator.clipboard.writeText(document.getElementById('exportCodeBlock').textContent); alert('Copied!')">Copy to Clipboard</button>
    `;
    document.getElementById("modalOverlay").classList.add("active");
  } catch (err) {
    console.error(err);
    hideLoadingState();
    alert("Failed to generate code.");
  }
}

// ---- 3. Conversational AI (Chatbot) ----
let chatHistory = [];

function toggleChat() {
  const panel = document.getElementById("chatPanel");
  panel.style.display = panel.style.display === "none" ? "flex" : "none";
}

async function sendChatMessage() {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (!msg) return;
  
  if (!geminiApiKey) {
    alert("Gemini API key is required to chat.");
    return;
  }

  input.value = "";
  addChatMessage("user", msg);

  // Build context
  const context = `You are PharmaPulse AI. The user is asking about the disease "${currentDisease}". 
  There are ${allCards.length} clinical trials currently displayed on the dashboard. Answer concisely and professionally.
  Current chat history: ${JSON.stringify(chatHistory.slice(-4))}
  User's question: ${msg}`;

  chatHistory.push({ role: "user", text: msg });

  const typingId = "typing-" + Date.now();
  const chatMessages = document.getElementById("chatMessages");
  chatMessages.innerHTML += `<div class="message ai-msg" id="${typingId}">...</div>`;
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const response = await callGemini(context);
    document.getElementById(typingId).remove();
    const reply = response || "I'm sorry, I couldn't process that request.";
    addChatMessage("ai", reply);
    chatHistory.push({ role: "model", text: reply });
  } catch (err) {
    document.getElementById(typingId).remove();
    addChatMessage("ai", "An error occurred.");
  }
}

function addChatMessage(sender, text) {
  const chatMessages = document.getElementById("chatMessages");
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${sender === 'user' ? 'user-msg' : 'ai-msg'}`;
  msgDiv.textContent = text;
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
