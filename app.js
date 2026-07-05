// ============================================
// PharmaPulse AI — Main Application Logic
// ============================================

// ---- State ----
let allCards = [];
let currentDisease = "";
let geminiApiKey = "";

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
    const trials = await fetchClinicalTrials(input);

    if (!trials || trials.length === 0) {
      showEmpty();
      return;
    }

    // Step 2: Update stats
    document.getElementById("statTrials").textContent = trials.length;
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

  const res = await fetch(`https://clinicaltrials.gov/api/v2/studies?${params}`);
  if (!res.ok) throw new Error(`ClinicalTrials.gov API error: ${res.status}`);
  const data = await res.json();

  return (data.studies || []).map((s) => {
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
async function fetchFDABulk(trials) {
  return await Promise.all(
    trials.map(async (trial) => {
      try {
        const query = encodeURIComponent(
          trial.title.split(" ").slice(0, 4).join(" ")
        );
        const res = await fetch(
          `https://api.fda.gov/drug/drugsfda.json?search=products.brand_name:"${query}"&limit=1`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const result = data.results?.[0];
        if (!result) return null;
        return {
          applicationNumber: result.application_number,
          sponsorName: result.sponsor_name,
          approved: result.products?.some((p) =>
            p.marketing_status === "Prescription"
          ),
          brandName: result.products?.[0]?.brand_name || null,
        };
      } catch {
        return null;
      }
    })
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

// ---- Gemini API Call ----
async function callGemini(prompt) {
  if (!geminiApiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!res.ok) {
      const err = await res.json();
      console.warn("Gemini error:", err);
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
