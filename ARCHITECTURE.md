# 🏗️ PharmaPulse AI — Architecture & Design Document

## 📊 System Architecture

```mermaid
graph TD
    classDef user fill:#63b3ed,stroke:#2b6cb0,stroke-width:2px,color:#000
    classDef frontend fill:#4a5568,stroke:#2d3748,stroke-width:2px,color:#fff
    classDef api fill:#48bb78,stroke:#276749,stroke-width:2px,color:#000
    classDef gemini fill:#b794f4,stroke:#6b46c1,stroke-width:2px,color:#000
    classDef github fill:#f6c90e,stroke:#975a16,stroke-width:2px,color:#000

    User((User)):::user

    subgraph Frontend
        UI[index.html + style.css]:::frontend
        JS[app.js - Orchestrator]:::frontend
        CFG[config.js]:::frontend
    end

    subgraph External Data APIs
        CT[ClinicalTrials.gov v2 API]:::api
        FDA[openFDA Drug API]:::api
    end

    subgraph Gemini AI Engine
        G1["1. Agentic Orchestration"]:::gemini
        G2["2. RAG Data Synthesis"]:::gemini
        G3["3. Text Summarization"]:::gemini
        G4["4. Data Classification"]:::gemini
        G5["5. Multimodal Vision"]:::gemini
        G6["6. Conversational Chat"]:::gemini
        G7["7. Code Generation"]:::gemini
    end

    subgraph GitHub CI/CD
        GH[GitHub Repo]:::github
        GA[GitHub Actions]:::github
        GP[GitHub Pages]:::github
    end

    User -->|Search disease| UI
    User -->|Upload image| UI
    User -->|Chat question| UI
    UI --> JS

    JS -->|REST call| CT
    JS -->|REST call| FDA
    CT -->|Trial JSON| JS
    FDA -->|Approval JSON| JS

    JS -->|Prompt + data| G1
    JS -->|Trial context| G2
    JS -->|Trial text| G3
    JS -->|Phase/status| G4
    JS -->|Base64 image| G5
    JS -->|Chat history| G6
    JS -->|Dataset context| G7

    G1 -.->|Orchestrated flow| JS
    G2 -.->|Grounded overview| JS
    G3 -.->|Card summaries| JS
    G4 -.->|Status labels| JS
    G5 -.->|Image analysis| JS
    G6 -.->|Chat replies| JS
    G7 -.->|Python script| JS

    JS -->|Render| UI
    UI -->|Display| User

    JS -->|git push| GH
    GH -->|Trigger| GA
    GA -->|Deploy| GP
    GP -->|Live URL| User
```

---

## 🔄 Data Flow Sequence

```mermaid
sequenceDiagram
    actor User
    participant UI as Frontend UI
    participant CT as ClinicalTrials.gov
    participant FDA as openFDA
    participant Gemini as Gemini AI

    User->>UI: Enter disease name
    UI->>CT: GET /api/v2/studies?query.cond={disease}
    CT-->>UI: JSON array of trials

    UI->>FDA: GET /drug/drugsfda.json (per trial)
    FDA-->>UI: Approval status data

    UI->>UI: Render trial cards with phase badges

    UI->>Gemini: POST generateContent (overview prompt + trial data)
    Gemini-->>UI: AI Overview paragraph

    loop For each trial card
        UI->>Gemini: POST generateContent (card summary prompt)
        Gemini-->>UI: 1-2 sentence insight
    end

    User->>UI: Click 📸 Upload Image
    UI->>Gemini: POST generateContent (image + context)
    Gemini-->>UI: Multimodal analysis result

    User->>UI: Click 💬 Chat
    UI->>Gemini: POST generateContent (chat history + question)
    Gemini-->>UI: Conversational reply

    User->>UI: Click 💻 Export Script
    UI->>Gemini: POST generateContent (dataset + code prompt)
    Gemini-->>UI: Python pandas/matplotlib script
```

---

## 🧠 7 AI Capabilities — Deep Dive

### 1. Agentic Orchestration
The `runSearch()` function in `app.js` acts as the AI agent — it sequences API calls, manages loading states, handles errors, and triggers parallel AI requests without human intervention.

### 2. RAG (Retrieval-Augmented Generation)
Real-time data from ClinicalTrials.gov and openFDA is injected directly into Gemini prompts. This means Gemini's responses are grounded in live, factual data rather than relying solely on its training data.

### 3. Text Summarization
Each trial card gets a Gemini-generated 1-2 sentence summary, and the overall disease landscape gets a comprehensive AI overview — distilling complex medical jargon into accessible language.

### 4. Data Classification
The system classifies trials by phase (1-4), status (Recruiting/Active/Completed), and FDA approval state. The `filterPhase()` function enables dynamic filtering of classified data.

### 5. Multimodal AI (Vision)
Users can upload medical images (charts, structures, diagrams). The image is converted to Base64 and sent to Gemini's vision endpoint alongside a contextual prompt tied to the current disease search.

### 6. Conversational AI (Chatbot)
A persistent chat sidebar maintains conversation history and sends it with each new message to Gemini, providing context-aware responses about the currently displayed trials.

### 7. Code Generation
Gemini generates a complete Python analysis script using pandas and matplotlib, pre-loaded with the exact trial dataset currently displayed. Users can copy and run it locally.

---

## 📂 File Structure

| File | Purpose | Lines |
|------|---------|-------|
| `index.html` | Page structure, semantic HTML, all UI containers | ~190 |
| `style.css` | Dark glassmorphism theme, animations, responsive layout | ~560 |
| `app.js` | All application logic, API calls, AI integrations | ~680 |
| `config.js` | API endpoints, model name, feature flags | ~15 |
| `deploy.yml` | GitHub Actions workflow for auto-deploy to Pages | ~30 |

---

## 🌐 Deployment Architecture

```mermaid
graph LR
    Dev[Developer Machine] -->|git push| GH[GitHub Repo<br>shaik1972/pharmapulse-ai]
    GH -->|Triggers| GA[GitHub Actions<br>deploy.yml]
    GA -->|Build + Upload| GP[GitHub Pages]
    GP -->|HTTPS| User[End Users<br>via Browser]
```

**URL**: `https://shaik1972.github.io/pharmapulse-ai/`

---

## 🔐 Security

- Gemini API key is stored in `sessionStorage` (browser-only, per-session)
- Key is never committed to source code or environment files
- User is prompted on first visit; key is cleared when browser tab closes
- `.gitignore` excludes any `.env` files as a safety net
