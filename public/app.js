const socket = io();

const PLAYER_SESSION_STORAGE_KEY = "quizlive_player_session";
const MAX_IMAGE_UPLOAD_BYTES = 1.5 * 1024 * 1024;
const answerLetters = ["A", "B", "C", "D", "E", "F"];
const answerClasses = ["answer-a", "answer-b", "answer-c", "answer-d", "answer-e", "answer-f"];
const questionTypes = [
  { value: "multiple", label: "Scelta multipla" },
  { value: "true_false", label: "Vero/Falso" },
  { value: "speed", label: "Risposta veloce" },
  { value: "multiple_select", label: "Risposte multiple" },
  { value: "slide", label: "Slide" }
];
let local = {
  mode: initialMode(),
  room: null,
  quiz: defaultQuiz(),
  selectedAnswer: null,
  selectedAnswers: [],
  archiveOpen: false,
  archiveLoading: false,
  hostAuth: {
    checked: false,
    enabled: false,
    authenticated: false,
    loading: false,
    password: ""
  },
  importText: "",
  savedQuizzes: [],
  savedResults: [],
  archiveSearch: "",
  archiveVisibility: "all",
  imageSuggestions: {},
  imageGenerating: {},
  builderQuestionIndex: 0,
  builderEditing: false,
  mediaDialog: null,
  quizSettingsOpen: false,
  hostEditingRoom: false,
  currentQuizId: null,
  joinCode: initialJoinCode(),
  screenCode: initialScreenCode(),
  screenJoining: false,
  screenWaiting: false,
  nickname: initialNickname(),
  playerSession: loadPlayerSession(),
  playerRejoining: false,
  playerBaseUrl: window.location.origin,
  playerAccessMode: "same-origin",
  liveEventMessage: "",
  liveEventTarget: "all",
  liveWagerPlayerId: "",
  liveWagerStake: 100,
  liveFiftyStake: 100,
  wagerTargetId: "",
  fiftyHoldingId: "",
  liveEvent: null
};
let reconnectingForHostAuth = false;
let screenPresentationRequest = null;
let screenPresentationUrl = "";
let screenPresentationConnection = null;
let builderDragIndex = null;
let builderDragAutoScrollFrame = null;
let builderDragAutoScrollSpeed = 0;
let screenPresentationDisconnecting = false;
let liveEventTimer = null;
let liveAudioContext = null;

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

socket.on("connect", () => {
  reconnectingForHostAuth = false;
  autoJoinScreen();
  autoRejoinPlayer();
  render();
});

socket.on("disconnect", () => {
  if (!reconnectingForHostAuth) showToast("Connessione persa");
  render();
});

socket.on("room:state", (room) => {
  local.room = room;
  local.mode = room.role;
  if (room.role === "screen") {
    local.screenCode = room.code;
    window.history.replaceState(null, "", `#screen=${encodeURIComponent(room.code)}`);
  }
  if (room.status !== "question") {
    local.selectedAnswer = null;
    local.selectedAnswers = [];
  }
  render();
});

socket.on("player:removed", (payload) => {
  leaveRoomLocally(payload && payload.message ? payload.message : "Sei fuori dalla nuova partita");
});

socket.on("screen:waiting", () => {
  enterScreenWaiting();
});

socket.on("live:event", (event) => {
  handleLiveEvent(event);
});

loadNetworkConfig();
loadHostAuth();

window.addEventListener("hashchange", () => {
  if (local.room) return;
  local.joinCode = initialJoinCode();
  local.screenCode = initialScreenCode();
  local.mode = initialMode();
  autoJoinScreen();
  autoRejoinPlayer();
  render();
});

setInterval(() => {
  if (!local.room) return;
  if (local.room.status === "question") updateLiveTimers();
  if (local.room.fiftyChallenge || local.room.activeFifty || recentFiftyResult(local.room) || document.querySelector(".screen-fifty-result")) updateFiftyTimers();
}, 250);

window.addEventListener("keydown", handleBuilderKeyboard);
window.addEventListener("pointerdown", primeLiveAudio, { passive: true });
window.addEventListener("keydown", primeLiveAudio);

function render() {
  app.innerHTML = shell(renderMain(), renderTopbar());
  bindEvents();
  syncBuilderDeckScroll();
  updateScreenPresentationRequest();
}

function renderTopbar() {
  const room = local.room;
  const surface = shellSurface();
  const environment = `<span class="status-pill environment-pill environment-${surface}">${escapeHtml(environmentLabel(surface))}</span>`;
  const code = room ? `<span class="room-code">${escapeHtml(room.code)}</span>` : "";
  const status = room ? `<span class="status-pill">${statusLabel(room.status)}</span>` : `<span class="status-pill">${socket.connected ? "Online" : "Offline"}</span>`;
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <div>
          <div class="brand-name">QuizLive</div>
          <p class="subtle">${room ? escapeHtml(room.title) : "Live quiz web"}</p>
        </div>
      </div>
      <div class="toolbar right">${environment}${code}${status}</div>
    </header>
  `;
}

function environmentLabel(surface = shellSurface()) {
  if (surface === "host") return "Ambiente host";
  if (surface === "screen") return "Ambiente monitor";
  return "Ambiente giocatore";
}

function renderMain() {
  if (local.hostEditingRoom && local.room && local.room.role === "host") {
    return hostAccessGranted() ? renderHostHome() : renderHostAccess();
  }
  if (!local.room) {
    if (local.mode === "host") return hostAccessGranted() ? renderHostHome() : renderHostAccess();
    if (local.mode === "screen") return renderScreenHome();
    return renderJoinHome();
  }
  if (local.room.role === "host") return renderHostGame(local.room);
  if (local.room.role === "screen") return renderScreenGame(local.room);
  return renderPlayerGame(local.room);
}

function shell(main, topbar) {
  return `<div class="shell shell-${shellSurface()}">${topbar}<main class="main">${main}</main>${renderLiveEventOverlay()}</div>`;
}

function shellSurface() {
  if (local.hostEditingRoom && local.room && local.room.role === "host") return "host";
  if (local.room && local.room.role === "host") return "host";
  if (local.room && local.room.role === "screen") return "screen";
  if (local.mode === "host") return "host";
  if (local.mode === "screen") return "screen";
  if (local.room && local.room.role === "player") return "player";
  return "join";
}

function renderLiveEventOverlay() {
  const event = local.liveEvent;
  if (!event) return "";
  const privateClass = event.private ? " private" : "";
  const toneClass = ` tone-${escapeAttr(event.tone || "spark")}`;
  const label = event.private ? "Messaggio segreto" : "Evento live";
  return `
    <aside class="live-event-overlay${privateClass}${toneClass}" aria-live="assertive">
      <div class="live-event-card">
        <p class="live-event-kicker">${escapeHtml(label)}</p>
        <strong>${escapeHtml(event.title || "QuizLive")}</strong>
        <span>${escapeHtml(event.message || "")}</span>
      </div>
    </aside>
  `;
}

function renderJoinHome() {
  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Entra in partita</h1>
          <p class="subtle">Inserisci codice e nickname.</p>
          ${renderPlayerSessionHint()}
        </div>
        <label class="stack">
          <span>Codice stanza</span>
          <input data-field="join-code" inputmode="numeric" maxlength="6" placeholder="123456" value="${escapeAttr(local.joinCode)}" />
        </label>
        <label class="stack">
          <span>Nickname</span>
          <input data-field="join-name" maxlength="24" placeholder="Nome" value="${escapeAttr(local.nickname)}" />
        </label>
        <div class="toolbar">
          <button class="btn teal" data-action="join-room" ${local.playerRejoining ? "disabled" : ""}>${local.playerRejoining ? "Rientro..." : "Entra in partita"}</button>
        </div>
      </div>
    </section>
  `;
}

function renderPlayerSessionHint() {
  const session = local.playerSession;
  if (local.playerRejoining) return `<p class="subtle">Rientro automatico in corso...</p>`;
  if (!session || session.code !== local.joinCode) return "";
  return `<p class="subtle">Sessione trovata per ${escapeHtml(session.nickname || "questo telefono")}.</p>`;
}

function renderScreenHome() {
  return `
    <section class="screen-layout">
      <div class="panel screen-panel screen-splash stack">
        <div class="screen-brand">
          <div class="screen-brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <div>
            <p class="screen-kicker">Monitor pubblico</p>
            <h1 class="screen-title">QuizLive</h1>
          </div>
        </div>
        <div class="screen-waiting">
          <span class="status-pill">${local.screenWaiting ? "In attesa della stanza" : "Pronto"}</span>
        </div>
        <div class="screen-code-entry">
          <input data-field="screen-code" inputmode="numeric" maxlength="6" placeholder="Codice stanza" value="${escapeAttr(local.screenCode)}" />
          <button class="btn ghost" data-action="join-screen" ${local.screenJoining ? "disabled" : ""}>Collega codice</button>
          ${renderCastScreenButton()}
        </div>
      </div>
    </section>
  `;
}

function renderCastScreenButton() {
  if (isScreenPresentationConnected()) {
    return `<button class="btn ghost" data-action="disconnect-screen-cast">Scollega TV</button>`;
  }
  return `<button class="btn ghost" data-action="cast-screen">Trasmetti TV</button>`;
}

function renderHostHome() {
  const editingRoom = local.hostEditingRoom && local.room && local.room.role === "host";
  const quizMeta = `${local.quiz.questions.length} domande${local.quiz.folder ? ` - ${escapeHtml(local.quiz.folder)}` : ""}`;
  return `
    <section class="host-builder-shell stack">
      <div class="host-header">
        <div>
          <h1 class="section-title">${editingRoom ? `Cambia quiz stanza ${escapeHtml(local.room.code)}` : "Crea partita"}</h1>
          <p class="subtle">${editingRoom ? "Modifica quiz mantenendo codice, monitor e giocatori." : quizMeta}</p>
        </div>
        <div class="toolbar">
          <button class="btn ghost" data-action="toggle-quiz-settings">Impostazioni</button>
          ${editingRoom ? `<button class="btn ghost" data-action="cancel-room-edit">Torna lobby</button>` : ""}
          <button class="btn ghost" data-action="open-waiting-screen">Apri monitor</button>
          ${renderCastScreenButton()}
          ${local.hostAuth.enabled ? `<button class="btn ghost" data-action="host-logout">Blocca host</button>` : ""}
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
        </div>
      </div>
      ${renderQuizBuilder()}
      ${local.quizSettingsOpen ? renderQuizSettingsDialog() : ""}
      ${local.mediaDialog ? renderMediaDialog() : ""}
    </section>
  `;
}

function renderHostAccess() {
  if (!local.hostAuth.checked) {
    return `
      <section class="join-shell">
        <div class="panel join-panel stack">
          <div>
            <h1 class="section-title">Accesso host</h1>
            <p class="subtle">Controllo accesso...</p>
          </div>
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
        </div>
      </section>
    `;
  }

  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Accesso host</h1>
          <p class="subtle">Inserisci la password host.</p>
        </div>
        <label class="stack">
          <span>Password</span>
          <input data-field="host-password" type="password" autocomplete="current-password" value="${escapeAttr(local.hostAuth.password)}" />
        </label>
        <div class="toolbar">
          <button class="btn primary" data-action="host-login" ${local.hostAuth.loading ? "disabled" : ""}>Sblocca host</button>
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
        </div>
      </div>
    </section>
  `;
}

function renderQuizBuilder() {
  const questionIndex = selectedBuilderQuestionIndex();
  const question = local.quiz.questions[questionIndex];
  const editing = Boolean(local.builderEditing);
  return `
    <div class="builder-studio">
      ${renderQuestionDeck(questionIndex)}
      <section class="builder-preview stack">
        ${question ? editing ? renderQuestionPreviewEditor(question, questionIndex) : renderQuestionHostPreview(question, questionIndex) : `<div class="empty">Aggiungi una domanda</div>`}
      </section>
      ${renderBuilderSidePanel(question, questionIndex, editing)}
    </div>
  `;
}

function selectedBuilderQuestionIndex() {
  const count = local.quiz.questions.length;
  if (!count) return 0;
  const index = Math.min(Math.max(Number(local.builderQuestionIndex) || 0, 0), count - 1);
  local.builderQuestionIndex = index;
  return index;
}

function syncBuilderDeckScroll() {
  if (local.mode !== "host") return;
  requestAnimationFrame(() => {
    const deck = document.querySelector("[data-builder-card-list]");
    const activeCard = deck ? deck.querySelector(".builder-slide.active") : null;
    if (!activeCard || !deck) return;
    const activeBox = activeCard.getBoundingClientRect();
    const deckBox = deck.getBoundingClientRect();
    const margin = 8;
    if (activeBox.top < deckBox.top + margin) {
      deck.scrollTop -= deckBox.top + margin - activeBox.top;
    } else if (activeBox.bottom > deckBox.bottom - margin) {
      deck.scrollTop += activeBox.bottom - (deckBox.bottom - margin);
    }
  });
}

function renderQuestionDeck(selectedIndex) {
  return `
    <aside class="builder-deck panel stack" data-builder-deck>
      <div class="builder-deck-head">
        <div>
          <p class="screen-kicker">Quiz</p>
          <h2 class="mini-title">${escapeHtml(local.quiz.title || "QuizLive")}</h2>
        </div>
        <button class="btn blue builder-add-card" data-action="add-question" type="button">Aggiungi scheda</button>
      </div>
      <div class="builder-card-list" data-builder-card-list>
        ${local.quiz.questions.map((question, index) => renderQuestionSlideCard(question, index, selectedIndex)).join("")}
      </div>
    </aside>
  `;
}

function renderBuilderSidePanel(question, questionIndex, editing) {
  return `
    <aside class="builder-side stack">
      ${renderBuilderRoomActions()}
      ${renderBuilderLiveEventsPreview()}
      ${question ? editing ? renderQuestionProperties(question, questionIndex) : renderQuestionReadOnlyProperties(question, questionIndex) : ""}
    </aside>
  `;
}

function renderBuilderRoomActions() {
  return `
    <section class="builder-actions-panel panel stack">
      <div>
        <h2 class="section-title">Partita</h2>
        <p class="subtle">Crea stanza e salva il quiz.</p>
      </div>
      <button class="btn primary" data-action="create-room">${local.hostEditingRoom ? "Aggiorna stanza" : "Crea stanza"}</button>
      <button class="btn teal" data-action="save-quiz">Salva quiz</button>
    </section>
  `;
}

function renderBuilderLiveEventsPreview() {
  if (local.room && local.room.role === "host") return renderHostLiveEvents(local.room);
  return `
    <section class="live-panel live-panel-preview stack">
      <div>
        <h3 class="mini-title">Eventi live</h3>
        <p class="subtle">Regia live pronta dopo la creazione della stanza.</p>
      </div>
      <div class="live-event-grid">
        <button class="btn gold small" disabled>Colpo</button>
        <button class="btn teal small" disabled>Telefoni</button>
        <button class="btn blue small" disabled>Monitor</button>
      </div>
      <div class="live-preview-note">
        Audio, vibrazione, messaggi pubblici, messaggi segreti e Scommessa live si attivano quando esiste una stanza con telefoni o monitor collegati.
      </div>
      <button class="btn ghost small" data-action="create-room">Crea stanza per attivarli</button>
    </section>
  `;
}

function renderQuestionSlideCard(question, index, selectedIndex) {
  const questionType = normalizeQuestionType(question.type);
  const active = index === selectedIndex;
  return `
    <article class="builder-slide ${active ? "active" : ""} ${active && local.builderEditing ? "editing" : ""}" data-question-index="${index}" draggable="${local.quiz.questions.length > 1 ? "true" : "false"}">
      <div class="builder-slide-actions">
        <button class="builder-icon-btn" data-action="edit-builder-question" data-question-index="${index}" aria-label="Modifica domanda ${index + 1}">&#9998;</button>
        <button class="builder-icon-btn" data-action="move-question" data-question-index="${index}" data-direction="-1" ${index === 0 ? "disabled" : ""} aria-label="Sposta su">&#8593;</button>
        <button class="builder-icon-btn" data-action="move-question" data-question-index="${index}" data-direction="1" ${index >= local.quiz.questions.length - 1 ? "disabled" : ""} aria-label="Sposta giu">&#8595;</button>
      </div>
      <button class="builder-slide-select" data-action="select-builder-question" data-question-index="${index}" aria-label="Domanda ${index + 1}, ${escapeAttr(questionTypeLabel(questionType))}">
        <div class="builder-slide-head">
          <strong>${index + 1}</strong>
          <span>${escapeHtml(questionTypeLabel(questionType))}</span>
        </div>
        ${renderQuestionDeckPreview(questionType)}
      </button>
    </article>
  `;
}

function renderQuestionDeckPreview(questionType) {
  return `
    <div class="builder-slide-preview">
      <div class="builder-slide-preview-content">
        ${renderQuestionTypeSilhouette(questionType)}
      </div>
    </div>
  `;
}

function renderQuestionTypeSilhouette(type) {
  if (type === "true_false") {
    return `<div class="question-silhouette true-false"><span>&#10003;</span><span>&times;</span></div>`;
  }
  if (type === "speed") {
    return `<div class="question-silhouette speed"><span>&#9889;</span></div>`;
  }
  if (type === "multiple_select") {
    return `<div class="question-silhouette multi-select"><span></span><span></span><span></span><span></span></div>`;
  }
  if (type === "slide") {
    return `<div class="question-silhouette slide"><span></span><span></span><span></span></div>`;
  }
  return `<div class="question-silhouette multiple"><span></span><span></span><span></span><span></span></div>`;
}

function renderQuestionPreviewEditor(question, questionIndex) {
  const questionType = normalizeQuestionType(question.type);
  if (questionType === "slide") return renderSlideEditor(question, questionIndex);
  return `
    <article class="builder-live-preview builder-editor-preview">
      <textarea class="builder-question-input" data-question-text data-question-index="${questionIndex}" maxlength="240" placeholder="Inizia a digitare la domanda">${escapeHtml(question.text)}</textarea>
      ${renderBuilderMediaPanel(question, questionIndex)}
      ${renderBuilderAnswerCards(question, questionIndex, questionType)}
    </article>
  `;
}

function renderSlideEditor(question, questionIndex) {
  return `
    <article class="builder-live-preview builder-slide-editor">
      <textarea class="builder-question-input" data-question-text data-question-index="${questionIndex}" maxlength="120" placeholder="Titolo slide">${escapeHtml(question.text)}</textarea>
      <textarea class="builder-slide-subtitle" data-question-subtitle data-question-index="${questionIndex}" maxlength="220" placeholder="Sottotitolo">${escapeHtml(question.subtitle || "")}</textarea>
      ${renderBuilderMediaPanel(question, questionIndex)}
    </article>
  `;
}

function renderBuilderMediaPanel(question, questionIndex) {
  const imageUrl = normalizeImageUrl(question.imageUrl);
  return `
    <div class="builder-media-drop ${imageUrl ? "has-media" : ""}">
      ${imageUrl
        ? `<img src="${escapeAttr(imageUrl)}" alt="Anteprima immagine domanda" />`
        : `<div class="builder-media-empty">
            <button class="builder-media-button" data-action="open-question-image-dialog" data-question-index="${questionIndex}" type="button">Immagine</button>
          </div>`}
      ${imageUrl ? `<button class="builder-media-button floating" data-action="open-question-image-dialog" data-question-index="${questionIndex}" type="button">Immagine</button>` : ""}
    </div>
  `;
}

function renderBuilderAnswerCards(question, questionIndex, questionType) {
  const answers = editableAnswers(question);
  const correctIndexes = correctIndexesForQuestion(question, answers);
  const answerImages = answerImagesForQuestion(question, answers.length);
  const answerLayouts = answerImageLayoutsForQuestion(question, answers.length);
  return `
    <div class="builder-answer-grid">
      ${answers.map((answer, answerIndex) => {
        const correct = correctIndexes.includes(answerIndex);
        const optional = answerIndex > 1 ? " facoltativa" : "";
        const rawImageUrl = answerImages[answerIndex] || "";
        const imageUrl = normalizeImageUrl(rawImageUrl);
        const imageLayout = answerLayouts[answerIndex];
        return `
          <div class="builder-answer-card answer-${letterClass(answerIndex)} ${imageUrl ? "has-answer-image" : ""}">
            ${imageUrl ? renderAnswerImageLayer(imageUrl, imageLayout, "builder-answer-bg") : ""}
            <span class="builder-answer-symbol">${answerShape(answerIndex)}</span>
            <div class="builder-answer-fields">
              <input data-answer-text data-question-index="${questionIndex}" data-answer-index="${answerIndex}" value="${escapeAttr(answer)}" maxlength="160" placeholder="Aggiungi risposta ${answerIndex + 1}${optional}" ${questionType === "true_false" ? "readonly" : ""} />
              <label class="builder-correct-toggle">
                ${questionType === "multiple_select"
                  ? `<input type="checkbox" data-correct-checkbox data-question-index="${questionIndex}" data-answer-index="${answerIndex}" ${correct ? "checked" : ""} />`
                  : `<input type="radio" name="correct-${questionIndex}" data-correct-radio data-question-index="${questionIndex}" data-answer-index="${answerIndex}" ${correct ? "checked" : ""} />`}
                Corretta
              </label>
              ${questionType !== "true_false" ? renderBuilderAnswerImageTools(questionIndex, answerIndex, rawImageUrl, imageUrl) : ""}
              ${questionType !== "true_false" && answers.length > 2 ? `<button class="btn small ghost" data-action="remove-answer" data-question-index="${questionIndex}" data-answer-index="${answerIndex}">Rimuovi</button>` : ""}
            </div>
          </div>
        `;
      }).join("")}
    </div>
    ${questionType !== "true_false" && answers.length < 6 ? `<button class="btn ghost builder-add-answer" data-action="add-answer" data-question-index="${questionIndex}">Aggiungi altre risposte</button>` : ""}
  `;
}

function renderBuilderAnswerImageTools(questionIndex, answerIndex, rawImageUrl, imageUrl) {
  return `
    <button class="builder-answer-image-button ${imageUrl ? "has-image" : ""}" data-action="open-answer-image-dialog" data-question-index="${questionIndex}" data-answer-index="${answerIndex}" type="button">
      ${imageUrl ? `<img src="${escapeAttr(imageUrl)}" alt="" />` : ""}
      <span>Immagine</span>
    </button>
  `;
}

function renderQuestionHostPreview(question, questionIndex) {
  const questionType = normalizeQuestionType(question.type);
  if (questionType === "slide") return renderSlideHostPreview(question, questionIndex);
  const answers = editableAnswers(question);
  const answerImages = answerImagesForQuestion(question, answers.length);
  const answerLayouts = answerImageLayoutsForQuestion(question, answers.length);
  return `
    <article class="builder-live-preview builder-preview-only">
      <div class="builder-preview-question">
        <p class="screen-kicker">Anteprima</p>
        <h2>${escapeHtml(question.text || `Domanda ${questionIndex + 1}`)}</h2>
      </div>
      ${renderBuilderPreviewMedia(question)}
      <div class="answers-grid builder-preview-answers">
        ${answers.map((answer, answerIndex) => renderAnswerDisplay({
          index: answerIndex,
          text: answer || `Risposta ${answerIndex + 1}`,
          imageUrl: normalizeImageUrl(answerImages[answerIndex]),
          imageLayout: answerLayouts[answerIndex]
        })).join("")}
      </div>
    </article>
  `;
}

function renderSlideHostPreview(question, questionIndex) {
  return `
    <article class="builder-live-preview builder-preview-only builder-preview-slide">
      <div class="builder-preview-question">
        <p class="screen-kicker">Slide ${questionIndex + 1}</p>
        <h2>${escapeHtml(question.text || "Nuova slide")}</h2>
        ${question.subtitle ? `<p>${escapeHtml(question.subtitle)}</p>` : ""}
      </div>
      ${renderBuilderPreviewMedia(question)}
    </article>
  `;
}

function renderBuilderPreviewMedia(question) {
  const imageUrl = normalizeImageUrl(question.imageUrl);
  if (!imageUrl) return "";
  return `
    <div class="builder-preview-media">
      <img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(question.imageAlt || "")}" />
    </div>
  `;
}

function renderQuestionReadOnlyProperties(question, questionIndex) {
  const questionType = normalizeQuestionType(question.type);
  const answers = questionType === "slide" ? [] : editableAnswers(question);
  const correctCount = questionType === "slide" ? 0 : correctIndexesForQuestion(question, answers).length;
  return `
    <aside class="builder-properties panel stack preview-properties">
      <div>
        <h2 class="section-title">Anteprima</h2>
        <p class="subtle">${escapeHtml(questionTypeLabel(questionType))}</p>
      </div>
      <div class="readonly-field">${questionType === "slide" ? "Slide" : `${answers.length} risposte`}</div>
      ${questionType !== "slide" ? `<div class="readonly-field">${correctCount} corrette</div>` : ""}
      ${questionType !== "slide" ? `<div class="readonly-field">${Number(question.timeLimit) || 20} secondi</div>` : ""}
      <button class="btn ghost" data-action="edit-builder-question" data-question-index="${questionIndex}">Modifica</button>
    </aside>
  `;
}

function renderQuestionProperties(question, questionIndex) {
  const questionType = normalizeQuestionType(question.type);
  const answers = editableAnswers(question);
  const correctIndexes = correctIndexesForQuestion(question, answers);
  return `
    <aside class="builder-properties panel stack">
      <div class="builder-properties-head">
        <h2 class="section-title">Proprieta domanda</h2>
        <button class="btn small ghost" data-action="remove-question" data-question-index="${questionIndex}" ${local.quiz.questions.length <= 1 ? "disabled" : ""}>Elimina</button>
      </div>
      <label class="stack">
        <span>Tipo di domanda</span>
        <select data-question-type data-question-index="${questionIndex}">
          ${questionTypes.map((type) => `<option value="${type.value}" ${questionType === type.value ? "selected" : ""}>${type.label}</option>`).join("")}
        </select>
      </label>
      ${questionType !== "slide" ? `
        <label class="stack">
          <span>Limite di tempo</span>
          <input data-question-time data-question-index="${questionIndex}" type="number" min="5" max="90" value="${question.timeLimit}" />
        </label>
        <button class="btn small ghost" data-action="apply-time-all" data-question-index="${questionIndex}">Applica a tutte</button>
        <label class="stack">
          <span>Punti</span>
          <select data-question-points data-question-index="${questionIndex}">
            ${pointOptions().map((option) => `<option value="${option.value}" ${Number(question.points || 0) === option.value ? "selected" : ""}>${option.label}</option>`).join("")}
          </select>
        </label>
        <label class="stack">
          <span>${questionType === "multiple_select" ? "Risposte corrette" : "Risposta corretta"}</span>
          ${questionType === "multiple_select"
            ? `<div class="readonly-field">${correctIndexes.length} selezionate</div>`
            : `<select data-question-correct data-question-index="${questionIndex}">
                ${answers.map((answer, answerIndex) => `<option value="${answerIndex}" ${correctIndexes[0] === answerIndex ? "selected" : ""}>${answerLetters[answerIndex]} ${escapeHtml(answer || `Risposta ${answerIndex + 1}`)}</option>`).join("")}
              </select>`}
        </label>
      ` : ""}
      ${questionType !== "slide" ? `
        <label class="stack">
          <span>Video URL</span>
          <input data-question-media="videoUrl" data-question-index="${questionIndex}" value="${escapeAttr(question.videoUrl || "")}" maxlength="500" placeholder="https://..." />
        </label>
      ` : ""}
    </aside>
  `;
}

function renderMediaDialog() {
  const dialog = local.mediaDialog || {};
  const questionIndex = Number(dialog.questionIndex);
  const question = local.quiz.questions[questionIndex];
  if (!question) return "";
  const isAnswer = dialog.target === "answer";
  const answerIndex = Number(dialog.answerIndex);
  const answerCount = editableAnswers(question).length;
  const answerImages = isAnswer ? answerImagesForQuestion(question, answerCount) : [];
  const answerLayouts = isAnswer ? answerImageLayoutsForQuestion(question, answerCount) : [];
  const rawImageUrl = isAnswer ? answerImages[answerIndex] || "" : question.imageUrl || "";
  const imageUrl = normalizeImageUrl(rawImageUrl);
  const answerText = isAnswer ? editableAnswers(question)[answerIndex] || `Risposta ${answerLetters[answerIndex] || answerIndex + 1}` : "";
  const answerLayout = isAnswer ? answerLayouts[answerIndex] : null;
  const title = isAnswer ? `Immagine risposta ${answerLetters[answerIndex] || answerIndex + 1}` : "Immagine principale";
  return `
    <div class="settings-backdrop">
      <section class="settings-dialog media-dialog panel stack">
        <div class="builder-properties-head">
          <div>
            <h2 class="section-title">${escapeHtml(title)}</h2>
            <p class="subtle">${escapeHtml(question.text || local.quiz.title || "QuizLive")}</p>
          </div>
          <button class="btn small ghost" data-action="close-media-dialog">Chiudi</button>
        </div>
        ${isAnswer
          ? renderAnswerImageLayoutPreview(answerIndex, answerText, imageUrl, answerLayout)
          : `<div class="media-dialog-preview">
              ${imageUrl ? `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(question.imageAlt || "")}" />` : `<span>Immagine</span>`}
            </div>`}
        ${isAnswer ? renderAnswerMediaDialogFields(questionIndex, answerIndex, rawImageUrl, imageUrl) : renderQuestionMediaDialogFields(question, questionIndex, imageUrl)}
      </section>
    </div>
  `;
}

function renderQuestionMediaDialogFields(question, questionIndex, imageUrl) {
  return `
    <div class="media-dialog-grid">
      <input class="file-input" data-question-image-upload data-question-index="${questionIndex}" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
      <input data-question-media="imageUrl" data-question-index="${questionIndex}" value="${escapeAttr(question.imageUrl || "")}" maxlength="500" placeholder="https:// immagine" />
    </div>
    <label class="stack">
      <span>Testo immagine</span>
      <input data-question-media="imageAlt" data-question-index="${questionIndex}" value="${escapeAttr(question.imageAlt || "")}" maxlength="160" />
    </label>
    <label class="stack">
      <span>Credito</span>
      <input data-question-media="imageCredit" data-question-index="${questionIndex}" value="${escapeAttr(question.imageCredit || "")}" maxlength="80" />
    </label>
    <div class="media-actions">
      <button class="btn small ghost" data-action="suggest-question-images" data-question-index="${questionIndex}" ${imageSuggestionState(questionIndex).loading ? "disabled" : ""}>${imageSuggestionState(questionIndex).loading ? "Cerco..." : "Suggerisci immagini"}</button>
      <button class="btn small ghost" data-action="generate-question-image" data-question-index="${questionIndex}" ${imageGeneratingState(questionIndex).loading ? "disabled" : ""}>${imageGeneratingState(questionIndex).loading ? "Genero..." : "Genera gratis"}</button>
      ${imageUrl ? `<button class="btn small ghost" data-action="clear-question-image" data-question-index="${questionIndex}">Rimuovi</button>` : ""}
    </div>
    ${renderImageSuggestions(questionIndex)}
  `;
}

function renderAnswerMediaDialogFields(questionIndex, answerIndex, rawImageUrl, imageUrl) {
  const generating = imageGeneratingState(questionIndex, answerIndex);
  const question = local.quiz.questions[questionIndex];
  const layout = answerImageLayoutForQuestion(question, answerIndex);
  return `
    <div class="media-dialog-grid">
      <input class="file-input" data-answer-image-upload data-question-index="${questionIndex}" data-answer-index="${answerIndex}" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
      <input data-answer-image-url data-question-index="${questionIndex}" data-answer-index="${answerIndex}" value="${escapeAttr(rawImageUrl)}" maxlength="500" placeholder="https:// immagine risposta" />
    </div>
    ${imageUrl ? `
      <div class="answer-layout-controls">
        <label class="stack">
          <span>Zoom</span>
          <input data-answer-image-layout="zoom" data-question-index="${questionIndex}" data-answer-index="${answerIndex}" type="range" min="1" max="3" step="0.05" value="${Number(layout.zoom || 1)}" />
        </label>
        <label class="stack">
          <span>Posizione orizzontale</span>
          <input data-answer-image-layout="x" data-question-index="${questionIndex}" data-answer-index="${answerIndex}" type="range" min="0" max="100" step="1" value="${Number(layout.x || 50)}" />
        </label>
        <label class="stack">
          <span>Posizione verticale</span>
          <input data-answer-image-layout="y" data-question-index="${questionIndex}" data-answer-index="${answerIndex}" type="range" min="0" max="100" step="1" value="${Number(layout.y || 50)}" />
        </label>
      </div>
    ` : ""}
    <div class="media-actions">
      <button class="btn small ghost" data-action="generate-answer-image" data-question-index="${questionIndex}" data-answer-index="${answerIndex}" ${generating.loading ? "disabled" : ""}>${generating.loading ? "Genero..." : "Genera gratis"}</button>
      ${imageUrl ? `<button class="btn small ghost" data-action="reset-answer-image-layout" data-question-index="${questionIndex}" data-answer-index="${answerIndex}">Centra</button>` : ""}
      ${imageUrl ? `<button class="btn small ghost" data-action="clear-answer-image" data-question-index="${questionIndex}" data-answer-index="${answerIndex}">Rimuovi</button>` : ""}
    </div>
  `;
}

function renderAnswerImageLayoutPreview(answerIndex, answerText, imageUrl, layout) {
  return `
    <div class="answer-layout-preview">
      <div class="answer-layout-button answer-${letterClass(answerIndex)} ${imageUrl ? "has-answer-image" : ""}">
        ${imageUrl ? renderAnswerImageLayer(imageUrl, layout, "answer-layout-bg") : ""}
        <span class="builder-answer-symbol">${answerShape(answerIndex)}</span>
        <strong>${escapeHtml(answerText)}</strong>
      </div>
    </div>
  `;
}

function renderQuizSettingsDialog() {
  return `
    <div class="settings-backdrop">
      <section class="settings-dialog panel stack">
        <div class="builder-properties-head">
          <div>
            <h2 class="section-title">Impostazioni quiz</h2>
            <p class="subtle">Titolo, descrizione, archivio e visibilita.</p>
          </div>
          <button class="btn small ghost" data-action="close-quiz-settings">Chiudi</button>
        </div>
        <label class="stack">
          <span>Titolo</span>
          <input data-quiz-title value="${escapeAttr(local.quiz.title)}" maxlength="80" />
        </label>
        <label class="stack">
          <span>Descrizione</span>
          <textarea data-quiz-meta="description" maxlength="220" placeholder="Breve descrizione o obiettivo del quiz">${escapeHtml(local.quiz.description || "")}</textarea>
        </label>
        <div class="grid-2">
          <label class="stack">
            <span>Cartella</span>
            <input data-quiz-meta="folder" value="${escapeAttr(local.quiz.folder || "")}" maxlength="40" placeholder="Es. 2B ripasso" />
          </label>
          <label class="stack">
            <span>Visibilita</span>
            <select data-quiz-meta="visibility">
              <option value="private" ${quizVisibility(local.quiz.visibility) === "private" ? "selected" : ""}>Privata</option>
              <option value="public" ${quizVisibility(local.quiz.visibility) === "public" ? "selected" : ""}>Pubblica</option>
            </select>
          </label>
        </div>
        <label class="stack">
          <span>Tag</span>
          <input data-quiz-tags value="${escapeAttr((local.quiz.tags || []).join(", "))}" maxlength="160" placeholder="ripasso, verifica" />
        </label>
        <label class="toggle-row">
          <input data-quiz-team-mode type="checkbox" ${local.quiz.teamMode ? "checked" : ""} />
          <span>Team mode: dividi automaticamente i giocatori in squadre</span>
        </label>
        <section class="settings-tools stack">
          <div>
            <h3 class="mini-title">File e archivio</h3>
            <p class="subtle">Importa, esporta, scarica il modello o apri l'archivio quiz.</p>
          </div>
          <input data-field="import-xlsx" type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" />
          <div class="toolbar">
            <button class="btn teal" data-action="apply-import-xlsx">Importa XLSX</button>
            <button class="btn ghost" data-action="download-template-xlsx">Modello XLSX</button>
            <button class="btn ghost" data-action="download-quiz-xlsx">Export XLSX</button>
            <button class="btn ghost" data-action="toggle-archive">${local.archiveOpen ? "Chiudi archivio" : "Archivio"}</button>
          </div>
        </section>
        ${local.archiveOpen ? renderArchiveBox() : ""}
      </section>
    </div>
  `;
}

function answerShape(index) {
  return ["▲", "◆", "●", "■", "⬟", "★"][index] || "●";
}

function pointOptions() {
  return [
    { value: 0, label: "Standard" },
    { value: 250, label: "250 punti" },
    { value: 500, label: "500 punti" },
    { value: 750, label: "750 punti" },
    { value: 1000, label: "1000 punti" },
    { value: 1500, label: "1500 punti" }
  ];
}

function imageSuggestionState(questionIndex) {
  return local.imageSuggestions[questionIndex] || { loading: false, images: [], query: "", error: "" };
}

function imageGeneratingKey(questionIndex, answerIndex) {
  const normalizedQuestionIndex = Number(questionIndex);
  const normalizedAnswerIndex = Number(answerIndex);
  return Number.isInteger(normalizedAnswerIndex)
    ? `${normalizedQuestionIndex}:${normalizedAnswerIndex}`
    : String(normalizedQuestionIndex);
}

function imageGeneratingState(questionIndex, answerIndex) {
  return local.imageGenerating[imageGeneratingKey(questionIndex, answerIndex)] || { loading: false };
}

function renderImageSuggestions(questionIndex) {
  const state = imageSuggestionState(questionIndex);
  if (state.loading) return `<div class="empty compact">Ricerca immagini...</div>`;
  if (state.error) return `<div class="empty compact">${escapeHtml(state.error)}</div>`;
  if (!state.images || !state.images.length) return "";
  return `
    <div class="image-suggestions">
      <div class="image-suggestion-head">
        <span class="subtle">Query: ${escapeHtml(state.query || "")}</span>
        <a href="https://www.pexels.com" target="_blank" rel="noopener">Pexels</a>
      </div>
      <div class="image-suggestion-grid">
        ${state.images.map((image, imageIndex) => `
          <button class="image-suggestion" data-action="select-suggested-image" data-question-index="${questionIndex}" data-image-index="${imageIndex}" style="${imageThumbStyle(image.avgColor)}">
            <img src="${escapeAttr(image.thumbUrl)}" alt="${escapeAttr(image.alt || "")}" loading="lazy" />
            <span>${escapeHtml(image.photographer || "Pexels")}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function imageThumbStyle(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? `--thumb-color:${escapeAttr(value)}` : "";
}

function renderArchiveBox() {
  return `
    <div class="stack archive-panel">
      <div class="archive-head">
        <div>
          <h2 class="section-title">Archivio</h2>
          <p class="subtle">Quiz salvati e risultati storici.</p>
        </div>
        <button class="btn small ghost" data-action="refresh-archive" ${local.archiveLoading ? "disabled" : ""}>Aggiorna</button>
      </div>
      <input data-archive-search value="${escapeAttr(local.archiveSearch)}" placeholder="Cerca titolo, cartella, visibilita o tag" />
      <div class="segmented">
        ${archiveVisibilityOptions().map((option) => `
          <button class="${local.archiveVisibility === option.value ? "active" : ""}" data-action="set-archive-visibility" data-archive-visibility="${option.value}">
            ${option.label}
          </button>
        `).join("")}
      </div>
      ${local.archiveLoading ? `<div class="empty compact">Caricamento archivio...</div>` : `
        <div class="archive-grid">
          <section class="stack">
            <h3 class="mini-title">Quiz salvati</h3>
            ${renderSavedQuizzes()}
          </section>
          <section class="stack">
            <h3 class="mini-title">Risultati</h3>
            ${renderSavedResults()}
          </section>
        </div>
      `}
    </div>
  `;
}

function renderSavedQuizzes() {
  const quizzes = filteredSavedQuizzes();
  if (!quizzes.length) return `<div class="empty compact">Nessun quiz salvato</div>`;
  return `
    <div class="archive-list">
      ${quizzes.map((item) => `
        <article class="archive-item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <p class="subtle">${renderQuizMetaLine(item.quiz)}${item.questionCount} domande - ${formatDate(item.updatedAt)}</p>
            <div class="meta-row compact">
              ${item.quiz && item.quiz.folder ? `<span class="status-pill compact">${escapeHtml(item.quiz.folder)}</span>` : ""}
              <span class="status-pill compact">${quizVisibilityLabel(item.quiz && item.quiz.visibility)}</span>
            </div>
          </div>
          <div class="toolbar">
            <button class="btn small ghost" data-action="load-saved-quiz" data-quiz-id="${escapeAttr(item.id)}">Carica</button>
            <button class="btn small ghost" data-action="duplicate-saved-quiz" data-quiz-id="${escapeAttr(item.id)}">Duplica</button>
            <button class="btn small ghost danger" data-action="delete-saved-quiz" data-quiz-id="${escapeAttr(item.id)}">Elimina</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderSavedResults() {
  if (!local.savedResults.length) return `<div class="empty compact">Nessun risultato salvato</div>`;
  return `
    <div class="archive-list">
      ${local.savedResults.map((item) => `
        <article class="archive-item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <p class="subtle">Stanza ${escapeHtml(item.code)} - ${item.playerCount} giocatori - ${formatDate(item.endedAt)}</p>
          </div>
          <div class="toolbar">
            <a class="btn small ghost" href="/api/archive/results/${escapeAttr(item.id)}.csv">CSV</a>
            <a class="btn small ghost" href="/api/archive/results/${escapeAttr(item.id)}.json">JSON</a>
            <a class="btn small ghost" href="/api/archive/results/${escapeAttr(item.id)}.xlsx">XLSX</a>
            <button class="btn small ghost danger" data-action="delete-saved-result" data-result-id="${escapeAttr(item.id)}">Elimina</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function filteredSavedQuizzes() {
  const query = normalizeSearch(local.archiveSearch);
  const visibility = local.archiveVisibility || "all";
  return local.savedQuizzes.filter((item) => {
    const quiz = item.quiz || {};
    if (visibility !== "all" && quizVisibility(quiz.visibility) !== visibility) return false;
    if (!query) return true;
    return normalizeSearch([
      item.title,
      quiz.folder,
      quiz.subject,
      quiz.level,
      quiz.language,
      quizVisibilityLabel(quiz.visibility),
      Array.isArray(quiz.tags) ? quiz.tags.join(" ") : ""
    ].join(" ")).includes(query);
  });
}

function archiveVisibilityOptions() {
  return [
    { value: "all", label: "Tutti" },
    { value: "private", label: "Privati" },
    { value: "public", label: "Pubblici" }
  ];
}

function setArchiveVisibility(value) {
  local.archiveVisibility = archiveVisibilityOptions().some((option) => option.value === value) ? value : "all";
  render();
}

function quizVisibility(value) {
  return normalizeSearch(value) === "public" || normalizeSearch(value) === "pubblica" ? "public" : "private";
}

function quizVisibilityLabel(value) {
  return quizVisibility(value) === "public" ? "Pubblica" : "Privata";
}

function renderQuizMetaLine(quiz) {
  const parts = [
    quiz && quiz.folder,
    quiz && quiz.teamMode ? "Team mode" : ""
  ].filter(Boolean);
  const tags = quiz && Array.isArray(quiz.tags) ? quiz.tags : [];
  return `${[...parts, ...tags.map((tag) => `#${tag}`)].map(escapeHtml).join(" - ")}${parts.length || tags.length ? " - " : ""}`;
}

function renderHostGame(room) {
  const question = room.question;
  const pendingText = room.pendingInviteCount
    ? `${room.playerCount} in lobby - ${room.pendingInviteCount} inviti in attesa`
    : `${room.playerCount} in lobby o partita`;
  return `
    <section class="game-layout">
      <div class="stage">
        ${room.status === "lobby" ? renderHostLobby(room) : ""}
        ${room.status === "question" && question ? renderHostQuestion(room) : ""}
        ${room.status === "reveal" && question ? renderReveal(room, true) : ""}
        ${room.status === "ended" ? renderEnded(room, true) : ""}
      </div>
      <aside class="panel stack">
        ${renderHostSideActions(room)}
        <div>
          <h2 class="section-title">Giocatori</h2>
          <p class="subtle">${escapeHtml(pendingText)}</p>
        </div>
        ${renderHostLiveEvents(room)}
        ${renderTeamLeaderboard(room)}
        ${renderHostPlayers(room)}
      </aside>
    </section>
  `;
}

function renderHostSideActions(room) {
  if (room.status !== "ended") return "";
  return `
    <div class="toolbar">
      <button class="btn ghost" data-action="release-screens">Monitor in attesa</button>
      <button class="btn ghost" data-action="back-to-builder">Cambia quiz</button>
    </div>
  `;
}

function renderHostLobby(room) {
  return `
    <div class="panel stack">
      <div>
        <h1 class="section-title">Codice ${escapeHtml(room.code)}</h1>
        <p class="subtle">${room.pendingInviteCount ? `Inviti inviati: ${room.pendingInviteCount} in attesa.` : `Pronto per ${room.totalQuestions} domande.`}</p>
      </div>
      <div class="qr-panel">
        <img class="qr-code" src="${escapeAttr(qrCodeSrc(room.code))}" alt="QR code ingresso giocatori" />
        <div class="qr-meta">
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
          <button class="btn ghost" data-action="open-screen-link">Apri monitor</button>
          ${renderCastScreenButton()}
        </div>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-action="start-game" ${room.totalQuestions < 1 ? "disabled" : ""}>Avvia quiz</button>
        <button class="btn ghost" data-action="back-to-builder">Cambia quiz</button>
      </div>
    </div>
  `;
}

function renderScreenGame(room) {
  const question = room.question;
  const fiftyResult = recentFiftyResult(room);
  return `
    <section class="screen-live-layout">
      ${renderScreenLeaderboardPanel(room)}
      <div class="screen-live-stage">
        ${room.activeFifty ? renderScreenFiftyChallenge(room.activeFifty) : fiftyResult ? renderScreenFiftyResult(fiftyResult) : `
          ${room.status === "lobby" ? renderScreenLobby(room) : ""}
          ${room.status === "question" && question ? renderScreenQuestion(room) : ""}
          ${room.status === "reveal" && question ? renderScreenReveal(room) : ""}
          ${room.status === "ended" ? renderScreenEnded(room) : ""}
        `}
      </div>
    </section>
  `;
}

function renderScreenLeaderboardPanel(room) {
  return `
    <aside class="panel screen-live-sidebar stack">
      <div>
        <p class="screen-kicker">Ambiente monitor</p>
        <h2 class="section-title">Classifica</h2>
        <p class="subtle">${room.playerCount} giocatori - ${statusLabel(room.status)}</p>
      </div>
      ${renderTeamLeaderboard(room)}
      <div class="screen-live-board">
        ${renderLeaderboard(room)}
      </div>
    </aside>
  `;
}

function renderScreenLobby(room) {
  return `
    <div class="panel screen-panel screen-lobby stack">
      <div>
        <p class="screen-kicker">${escapeHtml(room.title)}</p>
        <h1 class="screen-code">${escapeHtml(room.code)}</h1>
        <p class="subtle">Inquadra il QR o entra con il codice stanza.</p>
      </div>
      <div class="screen-lobby-grid">
        <img class="qr-code screen-qr" src="${escapeAttr(qrCodeSrc(room.code))}" alt="QR code ingresso giocatori" />
        <div class="screen-lobby-meta">
          <span class="status-pill ${playerAccessClass()}">${escapeHtml(playerBaseLabel())}</span>
          <span class="status-pill">${room.playerCount} giocatori</span>
          <span class="status-pill">${room.totalQuestions} domande</span>
          ${room.teamMode ? `<span class="status-pill">Team mode</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderScreenFiftyChallenge(challenge) {
  const players = Array.isArray(challenge.players) ? challenge.players : [];
  const first = players[0] || { nickname: "Giocatore 1", ready: false, holding: false };
  const second = players[1] || { nickname: "Giocatore 2", ready: false, holding: false };
  const phase = fiftyPhase(challenge);
  const label = phase === "intro" ? "Pronti?" : phase === "countdown" ? "3-2-1" : "Tieni premuto";
  const timerLabel = fiftyCountdownLabel(challenge, phase);
  return `
    <article class="screen-fifty-show panel">
      <div class="screen-fifty-header">
        <p class="screen-kicker">Mini gioco live</p>
        <h1 class="screen-title">50 e 50</h1>
        <p class="screen-subtitle">Se tieni premuto salvi l'avversario. Se molli alla fine, provi a prendere tutta la posta.</p>
      </div>
      <div class="screen-fifty-match">
        ${renderScreenFiftyPlayer(first, phase)}
        <div class="screen-fifty-center">
          <span class="status-pill">${escapeHtml(label)}</span>
          <strong data-screen-fifty-timer data-press-starts-at="${Number(challenge.pressStartsAt || 0)}" data-ends-at="${Number(challenge.endsAt || 0)}">${escapeHtml(timerLabel)}</strong>
          <span class="status-pill gold-pill">${challenge.pot} pt</span>
        </div>
        ${renderScreenFiftyPlayer(second, phase)}
      </div>
      <div class="fifty-arena ${phase}">
        <div class="fifty-rope"></div>
        <div class="fifty-platform left ${first.holding ? "holding" : ""} ${first.ready ? "ready" : ""}">
          <div class="fifty-puppet"></div>
          <span>${escapeHtml(first.nickname)}</span>
        </div>
        <div class="fifty-chasm">
          <span>${phase === "intro" ? "Accettate la sfida" : phase === "countdown" ? "Prepararsi" : "Ultimi 5 secondi"}</span>
        </div>
        <div class="fifty-platform right ${second.holding ? "holding" : ""} ${second.ready ? "ready" : ""}">
          <div class="fifty-puppet"></div>
          <span>${escapeHtml(second.nickname)}</span>
        </div>
      </div>
    </article>
  `;
}

function renderScreenFiftyPlayer(player, phase) {
  const state = phase === "intro" ? player.ready ? "Pronto" : "Invitato" : player.holding ? "Tiene premuto" : "Mano libera";
  return `
    <div class="screen-fifty-player ${player.ready ? "ready" : ""} ${player.holding ? "holding" : ""}">
      <span class="status-pill compact">${escapeHtml(state)}</span>
      <strong>${escapeHtml(player.nickname)}</strong>
    </div>
  `;
}

function recentFiftyResult(room) {
  const history = room && Array.isArray(room.fiftyHistory) ? room.fiftyHistory : [];
  const result = history[0];
  if (!result || !result.resolvedAt) return null;
  return Date.now() - Number(result.resolvedAt) < 12000 ? result : null;
}

function renderScreenFiftyResult(result) {
  const players = Array.isArray(result.players) ? result.players : [];
  const first = players[0] || { nickname: "Giocatore 1", delta: 0 };
  const second = players[1] || { nickname: "Giocatore 2", delta: 0 };
  return `
    <article class="screen-fifty-show screen-fifty-result panel">
      <div class="screen-fifty-header">
        <p class="screen-kicker">Mini gioco live</p>
        <h1 class="screen-title">${escapeHtml(fiftyResultHeadline(result))}</h1>
        <p class="screen-subtitle">${escapeHtml(fiftyResultMessage(result))}</p>
      </div>
      <div class="screen-fifty-result-board">
        ${renderScreenFiftyResultPlayer(first)}
        <div class="screen-fifty-center">
          <span class="status-pill">Piatto</span>
          <strong>${Number(result.pot || 0)}</strong>
          <span class="status-pill gold-pill">punti</span>
        </div>
        ${renderScreenFiftyResultPlayer(second)}
      </div>
      <div class="fifty-arena result outcome-${escapeAttr(result.outcome || "both_drop")}">
        <div class="fifty-rope"></div>
        <div class="fifty-platform left ${fiftyResultPlatformState(first, result)}">
          <div class="fifty-puppet"></div>
          <span>${escapeHtml(first.nickname)}</span>
        </div>
        <div class="fifty-chasm">
          ${renderScreenFiftyResultDrama(result)}
        </div>
        <div class="fifty-platform right ${fiftyResultPlatformState(second, result)}">
          <div class="fifty-puppet"></div>
          <span>${escapeHtml(second.nickname)}</span>
        </div>
      </div>
    </article>
  `;
}

function renderScreenFiftyResultDrama(result) {
  if (result.outcome === "split") {
    return `
      <div class="fifty-drama fifty-handshake-drama">
        <div class="fifty-handshake" aria-hidden="true">
          <span class="hand left-hand"></span>
          <span class="hand right-hand"></span>
        </div>
        <strong>Stretta di mano</strong>
        <span>Bottino diviso: ${Number(result.stake || 0)} punti restituiti a testa</span>
      </div>
    `;
  }
  if (result.outcome === "drop_win" || result.outcome === "forfeit") {
    return `
      <div class="fifty-drama fifty-drop-drama">
        <span class="points-stream">+${Number(result.pot || 0)} pt</span>
        <span class="drop-arrow" aria-hidden="true"></span>
        <strong>${escapeHtml(result.winnerNickname || "Vincitore")}</strong>
        <span>${escapeHtml(result.loserNickname || "Avversario")} cade: il bottino cambia mano</span>
      </div>
    `;
  }
  if (result.outcome === "cancelled") {
    return `
      <div class="fifty-drama">
        <strong>Sfida annullata</strong>
        <span>Nessun punto assegnato</span>
      </div>
    `;
  }
  return `
    <div class="fifty-drama fifty-drop-drama">
      <span class="drop-arrow double" aria-hidden="true"></span>
      <strong>Doppia caduta</strong>
      <span>Entrambi perdono ${Number(result.stake || 0)} punti</span>
    </div>
  `;
}

function fiftyResultPlatformState(player, result) {
  const classes = [];
  if (result.outcome === "split") classes.push("ready", "handshake-ready");
  if (player && player.saved) classes.push("ready");
  if (player && player.left) classes.push("disconnected");
  if (result.winnerId && player && player.id === result.winnerId) classes.push("winner", "ready");
  if (result.loserId && player && player.id === result.loserId) classes.push("fall");
  if (result.outcome === "both_drop" && player && !player.saved) classes.push("fall");
  if ((result.outcome === "drop_win" || result.outcome === "forfeit") && player && !player.saved && player.id !== result.winnerId) {
    classes.push("fall");
  }
  return Array.from(new Set(classes)).join(" ");
}

function renderScreenFiftyResultPlayer(player) {
  const delta = Number(player.delta || 0);
  const state = player.left ? "Disconnesso" : player.saved ? "Ha salvato" : "Ha mollato";
  return `
    <div class="screen-fifty-player result-card ${delta > 0 ? "winner" : delta < 0 ? "loser" : "even"}">
      <span class="status-pill compact">${escapeHtml(state)}</span>
      <strong>${escapeHtml(player.nickname || "Giocatore")}</strong>
      <span class="result-delta ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${delta > 0 ? "+" : ""}${delta} pt</span>
    </div>
  `;
}

function fiftyResultHeadline(result) {
  if (result.outcome === "split") return "Patto rispettato";
  if (result.outcome === "drop_win") return `${result.winnerNickname || "Vincitore"} prende tutto`;
  if (result.outcome === "forfeit") return `${result.winnerNickname || "Vincitore"} vince per abbandono`;
  if (result.outcome === "cancelled") return "50 e 50 annullato";
  return "Entrambi perdono";
}

function fiftyResultMessage(result) {
  if (result.outcome === "split") return "Entrambi hanno tenuto premuto: stretta di mano e bottino diviso.";
  if (result.outcome === "drop_win") return `${result.winnerNickname || "Un giocatore"} ha lasciato cadere l'avversario al momento giusto.`;
  if (result.outcome === "forfeit") return `${result.loserNickname || "Un giocatore"} e uscito o ha perso connessione prima del controllo finale.`;
  if (result.outcome === "cancelled") return "La sfida non e partita: servono due giocatori pronti.";
  return "Nessuno ha salvato l'avversario: la posta resta persa.";
}

function fiftyResultArenaText(result) {
  if (result.outcome === "split") return "Posta divisa";
  if (result.outcome === "drop_win") return "Tutto al vincitore";
  if (result.outcome === "forfeit") return "Fuori dalla sfida";
  if (result.outcome === "cancelled") return "Annullato";
  return "Doppia caduta";
}

function renderScreenQuestion(room) {
  const question = room.question;
  if (normalizeQuestionType(question.type) === "slide") return renderScreenSlide(room);
  return `
    <article class="question-card screen-question">
      <div class="question-main">
        <p class="screen-kicker">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</p>
        <h1 class="screen-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          ${renderTimer(room)}
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid screen-answers">
        ${question.answers.map(renderAnswerDisplay).join("")}
      </div>
    </article>
  `;
}

function renderScreenSlide(room) {
  const question = room.question;
  return `
    <article class="question-card screen-question slide-card">
      <div class="question-main slide-main">
        <p class="screen-kicker">Slide ${room.currentIndex + 1}/${room.totalQuestions}</p>
        <h1 class="screen-title">${escapeHtml(question.text)}</h1>
        ${question.subtitle ? `<p class="screen-subtitle">${escapeHtml(question.subtitle)}</p>` : ""}
      </div>
      ${renderQuestionMedia(question)}
    </article>
  `;
}

function renderScreenReveal(room) {
  const question = room.question;
  return `
    <article class="question-card screen-question">
      <div class="question-main">
        <p class="screen-kicker">Risultati domanda ${room.currentIndex + 1}/${room.totalQuestions}</p>
        <h1 class="screen-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid screen-answers">
        ${question.answers.map((answer) => renderAnswerStat(answer, room.playerCount)).join("")}
      </div>
      ${renderScreenWagerResults(room)}
      ${renderTopLeaderboardStrip(room)}
    </article>
  `;
}

function renderScreenWagerResults(room) {
  const items = screenWagerResultsForQuestion(room);
  if (!items.length) return "";
  return `
    <section class="screen-wager-results">
      <div>
        <p class="screen-kicker">Scommessa risolta</p>
        <h2>${items.length > 1 ? "Le puntate cambiano la classifica" : "La puntata cambia la classifica"}</h2>
      </div>
      <div class="screen-wager-grid">
        ${items.map(renderScreenWagerResultCard).join("")}
      </div>
    </section>
  `;
}

function screenWagerResultsForQuestion(room) {
  const history = Array.isArray(room && room.wagerHistory) ? room.wagerHistory : [];
  const currentIndex = Number(room && room.currentIndex);
  if (!Number.isFinite(currentIndex)) return [];
  return history
    .filter((item) => Number(item.questionIndex) === currentIndex)
    .slice(0, 3);
}

function renderScreenWagerResultCard(item) {
  const won = item.status === "won";
  const delta = Number(item.delta || 0);
  const amount = Math.abs(delta) || Number(item.stake || 0);
  return `
    <article class="screen-wager-card ${won ? "won" : "lost"}">
      <span class="status-pill compact">${won ? `+${amount} pt` : `-${amount} pt`}</span>
      <strong>${escapeHtml(item.bettorNickname || "Giocatore")}</strong>
      <p>${escapeHtml(wagerResultScreenText(item, won, amount))}</p>
    </article>
  `;
}

function wagerResultScreenText(item, won, amount) {
  const bettor = item.bettorNickname || "Un giocatore";
  const target = item.targetNickname || "un avversario";
  if (won) return `${bettor} ha scommesso su ${target} e vince ${amount} punti.`;
  if (item.reason === "no_answer") return `${bettor} ha scommesso su ${target}, ma non arriva risposta: perde ${amount} punti.`;
  return `${bettor} ha scommesso su ${target} e perde ${amount} punti.`;
}

function renderScreenEnded(room) {
  return `
    <div class="panel screen-panel screen-final stack">
      <div>
        <p class="screen-kicker">${escapeHtml(room.title)}</p>
        <h1 class="screen-title">Classifica finale</h1>
      </div>
      <div class="screen-podium-wrap">
        ${renderPodium(room)}
      </div>
      <div class="screen-final-board">
        <p class="subtle">La classifica completa resta visibile a sinistra.</p>
      </div>
    </div>
  `;
}

function renderQuestionMedia(question) {
  const imageUrl = question && question.imageUrl ? String(question.imageUrl) : "";
  const videoUrl = question && question.videoUrl ? String(question.videoUrl) : "";
  if (!imageUrl && !videoUrl) return "";
  const videoEmbed = videoUrl ? videoEmbedUrl(videoUrl) : "";
  return `
    <div class="question-media">
      ${imageUrl ? `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(question.imageAlt || "")}" loading="lazy" />` : ""}
      ${imageUrl ? renderImageCredit(question) : ""}
      ${videoUrl ? videoEmbed
        ? `<iframe src="${escapeAttr(videoEmbed)}" title="Video domanda" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
        : `<video src="${escapeAttr(videoUrl)}" controls playsinline></video>` : ""}
    </div>
  `;
}

function renderImageCredit(question) {
  if (!question || !question.imageCredit) return "";
  const provider = question.imageProvider || "Pexels";
  const providerKey = provider.toLowerCase();
  if (providerKey === "openai" || providerKey.includes("cloudflare")) {
    return `<p class="media-credit">Immagine generata con ${escapeHtml(provider)}</p>`;
  }
  const credit = question.imageCreditUrl
    ? `<a href="${escapeAttr(question.imageCreditUrl)}" target="_blank" rel="noopener">${escapeHtml(question.imageCredit)}</a>`
    : escapeHtml(question.imageCredit);
  const providerLink = question.imagePageUrl
    ? `<a href="${escapeAttr(question.imagePageUrl)}" target="_blank" rel="noopener">${escapeHtml(provider)}</a>`
    : escapeHtml(provider);
  return `<p class="media-credit">Foto: ${credit} / ${providerLink}</p>`;
}

function videoEmbedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : "";
    }
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.replace(/^\//, "");
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : "";
    }
  } catch (error) {
    return "";
  }
  return "";
}

function renderTimer(room) {
  const left = secondsLeft(room);
  const percent = timeProgressPercent(room);
  return `
    <div class="countdown ${left <= 5 ? "urgent" : ""}" data-countdown data-ends-at="${escapeAttr(room.questionEndsAt || "")}" data-time-limit="${escapeAttr(room.question ? room.question.timeLimit : 0)}">
      <div class="timer" data-timer>${left}</div>
      <div class="time-track" aria-hidden="true"><span data-time-bar style="width:${percent}%"></span></div>
    </div>
  `;
}

function renderSelectionPill(question) {
  if (!question || question.type !== "multiple_select") return "";
  const count = selectionCount(question);
  return `<span class="status-pill">Scegli ${count} risposte</span>`;
}

function renderSubmitMultiple(question) {
  const required = selectionCount(question);
  const selected = local.selectedAnswers.length;
  const missing = Math.max(0, required - selected);
  return `
    <div class="answer-submit stack">
      <div class="multi-helper">
        <strong>${selected}/${required} selezionate</strong>
        <span>${missing ? `Scegline ancora ${missing}` : "Puoi inviare adesso"}</span>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-action="submit-multiple-answer" ${selected !== required ? "disabled" : ""}>Invia risposte</button>
        <span class="subtle">Tocca una risposta selezionata per deselezionarla.</span>
      </div>
    </div>
  `;
}

function renderHostQuestion(room) {
  const question = room.question;
  if (normalizeQuestionType(question.type) === "slide") return renderHostSlide(room);
  return `
    <article class="question-card">
      <div class="question-main">
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          ${renderTimer(room)}
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</span>
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid">
        ${question.answers.map((answer) => renderAnswerStat(answer, room.playerCount)).join("")}
      </div>
    </article>
    <div class="toolbar">
      <button class="btn gold" data-action="reveal-question">Mostra risposta</button>
    </div>
  `;
}

function renderHostSlide(room) {
  const question = room.question;
  return `
    <article class="question-card slide-card">
      <div class="question-main slide-main">
        <p class="screen-kicker">Slide ${room.currentIndex + 1}/${room.totalQuestions}</p>
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        ${question.subtitle ? `<p class="screen-subtitle">${escapeHtml(question.subtitle)}</p>` : ""}
      </div>
      ${renderQuestionMedia(question)}
    </article>
    <div class="toolbar">
      <button class="btn primary" data-action="next-question">${room.currentIndex + 1 >= room.totalQuestions ? "Classifica finale" : "Prossima"}</button>
    </div>
  `;
}

function renderPlayerGame(room) {
  const question = room.question;
  if (room.player && room.player.rematch === "pending") return renderPlayerRematch(room);
  if (room.player && room.player.active === false) return renderPlayerExcluded(room);
  return `
    <section class="game-layout">
      <div class="stage">
        ${renderPlayerWagerOffer(room)}
        ${renderPlayerFiftyChallenge(room)}
        ${room.status === "lobby" ? renderPlayerWaiting(room) : ""}
        ${room.status === "question" && question ? renderPlayerQuestion(room) : ""}
        ${room.status === "reveal" && question ? renderReveal(room, false) : ""}
        ${room.status === "ended" ? renderEnded(room, false) : ""}
      </div>
      <aside class="panel stack">
        <div>
          <h2 class="section-title">${escapeHtml(room.player ? room.player.nickname : "Player")}</h2>
          <p class="subtle">Punti ${room.player ? room.player.score : 0} - Rank ${room.player && room.player.rank ? room.player.rank : "-"}</p>
        </div>
        ${renderLeaderboard(room)}
      </aside>
    </section>
  `;
}

function renderPlayerRematch(room) {
  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Giochi un'altra?</h1>
          <p class="subtle">L'host ha preparato una nuova partita. Conferma per rientrare in lobby.</p>
        </div>
        <div class="toolbar">
          <button class="btn primary" data-action="accept-rematch">Partecipo</button>
          <button class="btn ghost" data-action="decline-rematch">Salto</button>
        </div>
        <p class="subtle">Codice ${escapeHtml(room.code)}</p>
      </div>
    </section>
  `;
}

function renderPlayerExcluded(room) {
  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Non sei in questa partita</h1>
          <p class="subtle">La nuova lobby include solo chi ha accettato l'invito.</p>
        </div>
        <button class="btn teal" data-action="leave-room">Torna all'ingresso</button>
        <p class="subtle">Codice ${escapeHtml(room.code)}</p>
      </div>
    </section>
  `;
}

function renderPlayerWagerOffer(room) {
  const offer = room.wagerOffer;
  if (!offer) return "";
  const targets = Array.isArray(offer.eligibleTargets) ? offer.eligibleTargets : [];
  const selectedTarget = local.wagerTargetId && targets.some((target) => target.id === local.wagerTargetId)
    ? local.wagerTargetId
    : targets[0] && targets[0].id;
  if (selectedTarget && selectedTarget !== local.wagerTargetId) local.wagerTargetId = selectedTarget;
  return `
    <section class="panel live-wager-offer stack">
      <div>
        <p class="screen-kicker">Scommessa live</p>
        <h2 class="section-title">Punti in gioco: ${offer.stake}</h2>
        <p class="subtle">Scommetti sulla prossima risposta: bersaglio casuale x3, bersaglio scelto x2.</p>
      </div>
      <div class="live-wager-actions">
        <button class="btn gold" data-action="accept-wager-random" data-wager-id="${escapeAttr(offer.id)}">Casuale x3</button>
        <button class="btn ghost" data-action="decline-wager" data-wager-id="${escapeAttr(offer.id)}">Rifiuta</button>
      </div>
      <div class="live-target-row">
        <select data-wager-target aria-label="Giocatore bersaglio">
          ${targets.map((target) => `
            <option value="${escapeAttr(target.id)}" ${target.id === selectedTarget ? "selected" : ""}>${escapeHtml(target.nickname)}</option>
          `).join("")}
        </select>
        <button class="btn teal" data-action="accept-wager-chosen" data-wager-id="${escapeAttr(offer.id)}" ${targets.length ? "" : "disabled"}>Scelgo io x2</button>
      </div>
    </section>
  `;
}

function renderPlayerFiftyChallenge(room) {
  const challenge = room.fiftyChallenge;
  if (!challenge) return "";
  const phase = fiftyPhase(challenge);
  const holding = Boolean(challenge.holding);
  const ready = Boolean(challenge.ready);
  const countdownLabel = fiftyCountdownLabel(challenge, phase);
  const pressDisabled = phase !== "active";
  return `
    <section class="panel live-fifty-challenge stack">
      <div>
        <p class="screen-kicker">50 e 50</p>
        <h2 class="section-title">${phase === "intro" ? `Sfidi ${escapeHtml(challenge.opponentNickname)}` : `Salvi ${escapeHtml(challenge.opponentNickname)}?`}</h2>
        <p class="subtle">Posta ${challenge.pot} punti. Se al termine dei 5 secondi tieni premuto, salvi l'avversario. Se non tieni premuto, lo lasci cadere e provi a prendere tutto.</p>
      </div>
      ${phase === "intro" ? `
        <div class="fifty-rules">
          <span>1. Leggi la regola</span>
          <span>2. Premi pronto</span>
          <span>3. Dopo 3-2-1 tieni premuto</span>
        </div>
        <button class="btn gold" data-action="ready-fifty" data-challenge-id="${escapeAttr(challenge.id)}" ${ready ? "disabled" : ""}>${ready ? "Pronto, aspetta l'altro" : "Sono pronto"}</button>
      ` : `
        <div class="fifty-phone-countdown" data-fifty-countdown data-press-starts-at="${Number(challenge.pressStartsAt || 0)}" data-ends-at="${Number(challenge.endsAt || 0)}">
          ${escapeHtml(countdownLabel)}
        </div>
      `}
      <button
        class="fifty-hold-button ${holding ? "holding" : ""}"
        data-fifty-hold
        data-challenge-id="${escapeAttr(challenge.id)}"
        data-press-starts-at="${Number(challenge.pressStartsAt || 0)}"
        data-ends-at="${Number(challenge.endsAt || 0)}"
        ${pressDisabled ? "disabled" : ""}
      >
        ${phase === "intro" ? "Aspetta il via" : phase === "countdown" ? "Preparati..." : holding ? "Stai salvando..." : "Tieni premuto ora"}
      </button>
      <p class="subtle" data-fifty-help>${fiftyPlayerHelpText(challenge, phase)}</p>
    </section>
  `;
}

function fiftyPhase(challenge) {
  if (!challenge) return "idle";
  const status = String(challenge.status || "intro");
  if (status === "intro") return "intro";
  if (status === "active") return "active";
  if (status === "countdown") {
    return Date.now() >= Number(challenge.pressStartsAt || 0) ? "active" : "countdown";
  }
  return status;
}

function fiftyCountdownLabel(challenge, phase = fiftyPhase(challenge)) {
  if (!challenge) return "";
  if (phase === "countdown") {
    const left = Math.max(1, Math.ceil((Number(challenge.pressStartsAt || 0) - Date.now()) / 1000));
    return left > 1 ? String(left) : "Spingi!";
  }
  if (phase === "active") {
    const left = Math.max(0, Math.ceil((Number(challenge.endsAt || 0) - Date.now()) / 1000));
    return `${left}s`;
  }
  return "Pronto?";
}

function fiftyPlayerHelpText(challenge, phase = fiftyPhase(challenge)) {
  if (phase === "intro") {
    return challenge.ready ? "Aspetta che anche l'altro giocatore sia pronto." : "Quando sei pronto, conferma e guarda il countdown.";
  }
  if (phase === "countdown") return "Al via tieni premuto il pulsante grande.";
  if (phase === "active") return "Conta solo lo stato del tuo dito alla fine dei 5 secondi.";
  return "Sfida in corso.";
}

function renderPlayerWaiting(room) {
  return `
    <div class="panel stack">
      <h1 class="section-title">Sei dentro</h1>
      <p class="subtle">Codice ${escapeHtml(room.code)} - in attesa dell'host.</p>
      ${room.player && room.player.team ? `<span class="team-pill">${escapeHtml(room.player.team)}</span>` : ""}
    </div>
  `;
}

function renderPlayerQuestion(room) {
  const question = room.question;
  if (normalizeQuestionType(question.type) === "slide") return renderPlayerSlide(room);
  return `
    <article class="question-card">
      <div class="question-main">
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          ${renderTimer(room)}
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</span>
          ${question.answered ? `<span class="status-pill">Risposta inviata</span>` : ""}
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid">
        ${question.answers.map((answer) => renderAnswerButton(answer, question)).join("")}
      </div>
    </article>
    ${question.type === "multiple_select" && !question.answered ? renderSubmitMultiple(question) : ""}
  `;
}

function renderPlayerSlide(room) {
  const question = room.question;
  return `
    <article class="question-card slide-card">
      <div class="question-main slide-main">
        <p class="screen-kicker">Slide ${room.currentIndex + 1}/${room.totalQuestions}</p>
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        ${question.subtitle ? `<p class="screen-subtitle">${escapeHtml(question.subtitle)}</p>` : ""}
      </div>
      ${renderQuestionMedia(question)}
    </article>
  `;
}

function renderReveal(room, isHost) {
  const question = room.question;
  const playerAnswer = question.playerAnswer;
  const correct = playerAnswer && playerAnswer.correct;
  const partial = playerAnswer && playerAnswer.partial;
  return `
    <article class="question-card">
      <div class="question-main">
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          <span class="status-pill">${correct ? "Corretta" : partial ? "Parziale" : isHost ? "Risultati" : "Risposta mostrata"}</span>
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          ${playerAnswer ? `<span class="status-pill">+${playerAnswer.points} punti</span>` : ""}
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid">
        ${question.answers.map((answer) => isHost ? renderAnswerStat(answer, room.playerCount) : renderAnswerButton(answer, question, true)).join("")}
      </div>
    </article>
    ${isHost ? `<div class="toolbar"><button class="btn primary" data-action="next-question">${room.currentIndex + 1 >= room.totalQuestions ? "Classifica finale" : "Prossima domanda"}</button></div>` : ""}
  `;
}

function renderEnded(room, isHost) {
  return `
    <div class="panel stack">
      <div>
        <h1 class="section-title">Classifica finale</h1>
        <p class="subtle">${escapeHtml(room.title)}</p>
      </div>
      ${renderTeamLeaderboard(room)}
      ${renderPodium(room)}
      ${renderLeaderboard(room)}
      ${isHost ? renderResultsDashboard(room) : ""}
      ${isHost ? `<div class="toolbar"><button class="btn ghost" data-action="reset-room">Nuova partita</button></div>` : ""}
    </div>
  `;
}

function renderResultsDashboard(room) {
  const summaries = Array.isArray(room.questionSummaries) ? room.questionSummaries : [];
  if (!summaries.length) return "";
  const totals = summaries.reduce((acc, item) => {
    const stats = item.stats || {};
    acc.responses += Number(stats.responseCount || 0);
    acc.correct += Number(stats.correctCount || 0);
    acc.partial += Number(stats.partialCount || 0);
    acc.wrong += Number(stats.wrongCount || 0);
    acc.accuracy += Number(stats.accuracy || 0);
    return acc;
  }, { responses: 0, correct: 0, partial: 0, wrong: 0, accuracy: 0 });
  const averageAccuracy = summaries.length ? Math.round(totals.accuracy / summaries.length) : 0;
  return `
    <section class="results-dashboard stack">
      <div>
        <h2 class="section-title">Statistiche partita</h2>
        <p class="subtle">Riepilogo per leggere subito domande forti, parziali e punti critici.</p>
      </div>
      <div class="stat-grid">
        ${renderStatTile("Giocatori", room.leaderboard ? room.leaderboard.length : 0)}
        ${renderStatTile("Risposte", totals.responses)}
        ${renderStatTile("Parziali", totals.partial)}
        ${renderStatTile("Accuracy media", `${averageAccuracy}%`)}
      </div>
      <div class="question-summary-list">
        ${summaries.map((item) => renderQuestionSummary(item)).join("")}
      </div>
    </section>
  `;
}

function renderStatTile(label, value) {
  return `
    <div class="stat-tile">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderQuestionSummary(item) {
  const stats = item.stats || {};
  const correctAnswers = Array.isArray(item.correctAnswers) ? item.correctAnswers : [];
  const accuracy = Number(stats.accuracy || 0);
  return `
    <article class="question-summary">
      <div>
        <div class="summary-head">
          <strong>${item.index + 1}. ${escapeHtml(item.text)}</strong>
          <span class="status-pill compact">${escapeHtml(item.typeLabel || questionTypeLabel(item.type))}</span>
        </div>
        <p class="subtle">Corrette: ${correctAnswers.map((answer) => `${escapeHtml(answer.letter)} ${escapeHtml(answer.text)}`).join(", ")}</p>
      </div>
      <div class="summary-stats">
        <span>${stats.responseCount || 0} risposte</span>
        <span>${stats.correctCount || 0} corrette</span>
        <span>${stats.partialCount || 0} parziali</span>
        <span>${stats.wrongCount || 0} sbagliate</span>
      </div>
      <div class="meter" aria-label="Accuracy ${accuracy}%"><span style="width:${accuracy}%"></span></div>
      <strong>${accuracy}% accuracy</strong>
    </article>
  `;
}

function renderPodium(room) {
  const top = room.leaderboard.slice(0, 3);
  if (!top.length) return `<div class="empty">Nessun giocatore</div>`;
  return `
    <div class="podium">
      ${top.map((player, index) => `
        <div class="podium-place">
          <div class="podium-rank">${index + 1}</div>
          <strong>${escapeHtml(player.nickname)}</strong>
          <span>${player.score} punti</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTopLeaderboardStrip(room) {
  const top = room.leaderboard.slice(0, 3);
  if (!top.length) return "";
  return `
    <div class="screen-strip">
      ${top.map((player, index) => `
        <div class="screen-strip-item">
          <span class="rank">${index + 1}</span>
          <strong>${escapeHtml(player.nickname)}</strong>
          <span>${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHostLiveEvents(room) {
  const players = Array.isArray(room.players) ? room.players : [];
  const selectedTarget = local.liveEventTarget || "all";
  const selected = (value) => selectedTarget === value ? "selected" : "";
  return `
    <section class="live-panel stack">
      <div>
        <h3 class="mini-title">Eventi live</h3>
        <p class="subtle">Messaggi, scommesse, mini-giochi e monitor pubblico.</p>
      </div>
      <div class="live-control-section stack first">
        <h4 class="live-section-title">Messaggi/effetti</h4>
        <div class="live-event-grid">
          <button class="btn gold small" data-action="send-live-effect" data-live-target="all" data-live-tone="drum" data-live-vibrate="true" data-live-message="Colpo di scena in arrivo.">Colpo</button>
          <button class="btn teal small" data-action="send-live-effect" data-live-target="players" data-live-tone="alert" data-live-vibrate="true" data-live-message="Attenzione alla prossima mossa.">Telefoni</button>
          <button class="btn blue small" data-action="send-live-effect" data-live-target="screen" data-live-tone="success" data-live-message="Momento speciale sul monitor.">Monitor</button>
        </div>
        <label class="stack live-message-field">
          <span>Messaggio</span>
          <textarea data-live-event-message maxlength="160" placeholder="Pubblico o segreto">${escapeHtml(local.liveEventMessage || "")}</textarea>
        </label>
        <div class="live-target-row">
          <select data-live-event-target aria-label="Destinatario evento live">
            <option value="all" ${selected("all")}>Tutti + monitor</option>
            <option value="players" ${selected("players")}>Solo telefoni</option>
            <option value="screen" ${selected("screen")}>Solo monitor</option>
            ${players.map((player) => `
              <option value="player:${escapeAttr(player.id)}" ${selected(`player:${player.id}`)}>Segreto: ${escapeHtml(player.nickname)}</option>
            `).join("")}
          </select>
          <button class="btn primary" data-action="send-live-message">Invia</button>
        </div>
      </div>
      <div class="live-control-section">
        ${renderHostWagerPanel(room, players)}
      </div>
      <div class="live-control-section">
        ${renderHostFiftyPanel(room, players)}
      </div>
      <div class="live-control-section stack">
        <h4 class="live-section-title">Impostazioni rapide</h4>
        <div class="live-quick-actions">
          <button class="btn ghost small" data-action="open-waiting-screen">Apri monitor</button>
          ${renderCastScreenButton()}
          <button class="btn ghost small" data-action="release-screens">Monitor in attesa</button>
          <button class="btn ghost small" data-action="copy-screen-link">Copia monitor</button>
        </div>
      </div>
    </section>
  `;
}

function renderHostWagerPanel(room, players) {
  const availablePlayers = players.filter((player) => Number(player.score || 0) > 0 && player.connected);
  const selectedPlayer = availablePlayers.find((player) => player.id === local.liveWagerPlayerId) || availablePlayers[0] || null;
  const selectedPlayerId = selectedPlayer ? selectedPlayer.id : "";
  const maxStake = selectedPlayer ? Math.max(1, Number(selectedPlayer.score || 0)) : 1;
  const stake = Math.min(maxStake, Math.max(1, Number(local.liveWagerStake) || 100));
  return `
    <div class="live-wager-panel stack">
      <div>
        <h4 class="mini-title">Scommessa live</h4>
        <p class="subtle">Invita un giocatore a puntare sulla prossima risposta.</p>
      </div>
      <div class="live-target-row">
        <select data-live-wager-player aria-label="Giocatore scommettitore" ${availablePlayers.length ? "" : "disabled"}>
          ${availablePlayers.length
            ? availablePlayers.map((player) => `
              <option value="${escapeAttr(player.id)}" ${player.id === selectedPlayerId ? "selected" : ""}>${escapeHtml(player.nickname)} - ${player.score} pt</option>
            `).join("")
            : `<option value="">Nessun giocatore con punti</option>`}
        </select>
        <input data-live-wager-stake type="number" min="1" max="${maxStake}" value="${stake}" aria-label="Punti da scommettere" ${selectedPlayer ? "" : "disabled"} />
      </div>
      <button class="btn gold" data-action="send-wager-offer" ${selectedPlayer ? "" : "disabled"}>Invita scommessa</button>
      ${renderHostWagerStatus(room)}
    </div>
  `;
}

function renderHostWagerStatus(room) {
  const wagers = room.wagers || {};
  const offers = Array.isArray(wagers.offers) ? wagers.offers : [];
  const active = Array.isArray(wagers.active) ? wagers.active : [];
  const history = Array.isArray(wagers.history) ? wagers.history : [];
  const items = [
    ...offers.map((item) => ({ label: "In attesa", text: `${item.bettorNickname} - ${item.stake} pt` })),
    ...active.map((item) => ({ label: `x${item.multiplier}`, text: `${item.bettorNickname} su ${item.targetNickname} - ${item.stake} pt` })),
    ...history.slice(0, 3).map((item) => ({ label: item.status === "won" ? "Vinta" : "Persa", text: `${item.bettorNickname} ${item.delta > 0 ? "+" : ""}${item.delta} pt` }))
  ];
  if (!items.length) return "";
  return `
    <div class="live-wager-list">
      ${items.map((item) => `
        <div class="live-wager-row">
          <span class="status-pill compact">${escapeHtml(item.label)}</span>
          <span>${escapeHtml(item.text)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHostFiftyPanel(room, players) {
  const availablePlayers = players.filter((player) => Number(player.score || 0) > 0 && player.connected);
  const maxStake = availablePlayers.length >= 2
    ? Math.max(1, Math.min(...availablePlayers.map((player) => Number(player.score || 0))))
    : 1;
  const stake = Math.min(maxStake, Math.max(1, Number(local.liveFiftyStake) || 100));
  const active = room.fifty && room.fifty.active;
  return `
    <div class="live-fifty-panel stack">
      <div>
        <h4 class="mini-title">50 e 50</h4>
        <p class="subtle">Sceglie due giocatori a caso: salvare o lasciare cadere.</p>
      </div>
      <div class="live-target-row">
        <input data-live-fifty-stake type="number" min="1" max="${maxStake}" value="${stake}" aria-label="Posta 50 e 50" ${availablePlayers.length >= 2 && !active ? "" : "disabled"} />
        <button class="btn gold" data-action="send-fifty-start" ${availablePlayers.length >= 2 && !active ? "" : "disabled"}>Avvia 50 e 50</button>
      </div>
      ${availablePlayers.length < 2 ? `<p class="subtle">Servono almeno due giocatori con punti.</p>` : ""}
      ${renderHostFiftyStatus(room)}
    </div>
  `;
}

function renderHostFiftyStatus(room) {
  const fifty = room.fifty || {};
  const active = fifty.active;
  const history = Array.isArray(fifty.history) ? fifty.history : [];
  const activeItems = active && Array.isArray(active.players)
    ? active.players.map((player) => ({
      label: active.status === "intro" ? player.ready ? "Pronto" : "Invito" : player.holding ? "Premuto" : "Libero",
      text: `${player.nickname} - ${active.stake} pt`
    }))
    : [];
  const historyItems = history.slice(0, 3).map((item) => ({
    label: item.outcome === "cancelled" ? "Annullata" : item.outcome === "split" ? "Divisa" : item.outcome === "drop_win" ? "Presa" : "Persa",
    text: fiftyHistoryText(item)
  }));
  const items = [...activeItems, ...historyItems];
  if (!items.length) return "";
  return `
    <div class="live-wager-list">
      ${items.map((item) => `
        <div class="live-wager-row">
          <span class="status-pill compact">${escapeHtml(item.label)}</span>
          <span>${escapeHtml(item.text)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function fiftyHistoryText(item) {
  if (item.outcome === "cancelled") return "Sfida interrotta";
  if (item.outcome === "split") {
    return item.players && item.players.length >= 2
      ? `${item.players[0].nickname} + ${item.players[1].nickname}: pari`
      : "Posta divisa";
  }
  if (item.outcome === "forfeit") return `${item.winnerNickname} prende ${item.pot} pt`;
  if (item.outcome === "drop_win") return `${item.winnerNickname} prende ${item.pot} pt`;
  return `Entrambi -${item.stake} pt`;
}

function renderHostPlayers(room) {
  if (!room.players || !room.players.length) return `<div class="empty">Nessun giocatore ancora</div>`;
  return `
    <div class="side-list">
      ${room.players.map((player) => `
        <div class="player-row">
          <span class="dot ${player.answered ? "answered" : player.connected ? "on" : ""}"></span>
          <span class="name">${escapeHtml(player.nickname)} ${player.team ? `<span class="team-pill">${escapeHtml(player.team)}</span>` : ""}</span>
          <span class="score">${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderLeaderboard(room) {
  if (!room.leaderboard || !room.leaderboard.length) return `<div class="empty">Classifica vuota</div>`;
  const selfId = room.player && room.player.id;
  return `
    <div class="side-list">
      ${room.leaderboard.map((player, index) => `
        <div class="leader-row ${player.id === selfId ? "self" : ""}">
          <span class="rank">${index + 1}</span>
          <span class="name">${escapeHtml(player.nickname)} ${player.team ? `<span class="team-pill">${escapeHtml(player.team)}</span>` : ""}</span>
          <span class="score">${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTeamLeaderboard(room) {
  if (!room.teamLeaderboard || !room.teamLeaderboard.length) return "";
  return `
    <div class="team-board">
      ${room.teamLeaderboard.map((item, index) => `
        <div class="team-row">
          <span class="rank">${index + 1}</span>
          <span class="name">${escapeHtml(item.team)} <span class="subtle">${item.playerCount} giocatori</span></span>
          <span class="score">${item.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAnswerButton(answer, question, reveal = false) {
  const playerIndexes = question.playerAnswer && Array.isArray(question.playerAnswer.answerIndexes)
    ? question.playerAnswer.answerIndexes
    : question.playerAnswer
      ? [question.playerAnswer.answerIndex]
      : [];
  const selected = local.selectedAnswer === answer.index ||
    local.selectedAnswers.includes(answer.index) ||
    playerIndexes.includes(answer.index);
  const hasMark = reveal && typeof answer.correct === "boolean";
  const correct = hasMark && answer.correct;
  const wrong = hasMark && !answer.correct;
  const hasImage = Boolean(answer.imageUrl);
  return `
    <button class="answer-btn ${answerClasses[answer.index]} ${hasImage ? "has-image" : ""} ${selected ? "selected" : ""} ${hasMark ? "with-mark" : ""} ${correct ? "correct" : ""} ${wrong ? "wrong" : ""}"
      data-action="answer"
      data-answer-index="${answer.index}"
      ${question.answered || reveal ? "disabled" : ""}>
      <span class="letter">${answerLetters[answer.index]}</span>
      ${renderAnswerImage(answer)}
      <span class="answer-text">${escapeHtml(answer.text)}</span>
      ${question.type === "multiple_select" && selected && !reveal ? `<span class="answer-selected-label">Selezionata</span>` : ""}
      ${renderAnswerMark(answer.correct, hasMark)}
    </button>
  `;
}

function renderAnswerDisplay(answer) {
  const hasImage = Boolean(answer.imageUrl);
  return `
    <div class="answer-stat ${answerClasses[answer.index]} ${hasImage ? "has-image" : ""}">
      <span class="letter">${answerLetters[answer.index]}</span>
      ${renderAnswerImage(answer)}
      <span class="answer-text">${escapeHtml(answer.text)}</span>
    </div>
  `;
}

function renderAnswerStat(answer, playerCount) {
  const percent = playerCount ? Math.round((Number(answer.count || 0) / playerCount) * 100) : 0;
  const hasMark = typeof answer.correct === "boolean";
  const hasImage = Boolean(answer.imageUrl);
  return `
    <div class="answer-stat ${answerClasses[answer.index]} ${hasImage ? "has-image" : ""} ${hasMark ? "with-mark" : ""} ${answer.correct ? "correct" : ""} ${hasMark && !answer.correct ? "incorrect" : ""}">
      <span class="letter">${answerLetters[answer.index]}</span>
      ${renderAnswerImage(answer)}
      <span class="answer-text">${escapeHtml(answer.text)} - ${answer.count || 0}</span>
      ${renderAnswerMark(answer.correct, hasMark)}
      <span class="stat-bar"><span style="width:${percent}%"></span></span>
    </div>
  `;
}

function renderAnswerImage(answer) {
  const imageUrl = answer && answer.imageUrl ? String(answer.imageUrl) : "";
  if (!imageUrl) return "";
  return renderAnswerImageLayer(imageUrl, answer.imageLayout, "answer-image");
}

function renderAnswerImageLayer(imageUrl, layout, className) {
  const normalized = normalizeAnswerImageLayout(layout);
  const style = answerImageStyle(imageUrl, normalized);
  return `
    <span class="${escapeAttr(className || "answer-image")}" style="${escapeAttr(style)}" aria-hidden="true">
      <img src="${escapeAttr(imageUrl)}" alt="" loading="lazy" style="${escapeAttr(answerImageImgStyle(normalized))}" />
    </span>
  `;
}

function answerImageStyle(imageUrl, layout) {
  return [
    `--answer-image-url: url('${cssUrlEscape(imageUrl)}')`,
    `--answer-image-x: ${layout.x}%`,
    `--answer-image-y: ${layout.y}%`,
    `--answer-image-zoom: ${layout.zoom}`
  ].join("; ");
}

function answerImageImgStyle(layout) {
  return [
    `object-position: ${layout.x}% ${layout.y}%`,
    `transform: scale(${layout.zoom})`,
    `transform-origin: ${layout.x}% ${layout.y}%`
  ].join("; ");
}

function cssUrlEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function renderAnswerMark(correct, visible) {
  if (!visible) return "";
  return `<span class="answer-mark ${correct ? "ok" : "no"}" aria-label="${correct ? "Corretta" : "Sbagliata"}">${correct ? "&#10003;" : "&times;"}</span>`;
}

function bindEvents() {
  document.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", handleAction);
  });
  bindBuilderDeckDragEvents();
  document.querySelectorAll("[data-quiz-title]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.title = element.value;
    });
  });
  document.querySelectorAll("[data-quiz-meta]").forEach((element) => {
    const updateMeta = () => {
      local.quiz[element.dataset.quizMeta] = element.value;
    };
    element.addEventListener("input", updateMeta);
    element.addEventListener("change", updateMeta);
  });
  document.querySelectorAll("[data-quiz-tags]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.tags = parseTags(element.value);
    });
  });
  document.querySelectorAll("[data-quiz-team-mode]").forEach((element) => {
    element.addEventListener("change", () => {
      local.quiz.teamMode = element.checked;
    });
  });
  document.querySelectorAll("[data-live-event-message]").forEach((element) => {
    element.addEventListener("input", () => {
      local.liveEventMessage = element.value;
    });
  });
  document.querySelectorAll("[data-live-event-target]").forEach((element) => {
    element.addEventListener("change", () => {
      local.liveEventTarget = element.value;
    });
  });
  document.querySelectorAll("[data-live-wager-player]").forEach((element) => {
    element.addEventListener("change", () => {
      local.liveWagerPlayerId = element.value;
    });
  });
  document.querySelectorAll("[data-live-wager-stake]").forEach((element) => {
    element.addEventListener("input", () => {
      local.liveWagerStake = Number(element.value) || 1;
    });
  });
  document.querySelectorAll("[data-live-fifty-stake]").forEach((element) => {
    element.addEventListener("input", () => {
      local.liveFiftyStake = Number(element.value) || 1;
    });
  });
  document.querySelectorAll("[data-wager-target]").forEach((element) => {
    element.addEventListener("change", () => {
      local.wagerTargetId = element.value;
    });
  });
  bindFiftyHoldEvents();
  document.querySelectorAll("[data-question-text]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].text = element.value;
    });
  });
  document.querySelectorAll("[data-question-subtitle]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].subtitle = element.value;
    });
  });
  document.querySelectorAll("[data-question-media]").forEach((element) => {
    element.addEventListener("input", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question[element.dataset.questionMedia] = element.value;
      if (element.dataset.questionMedia === "imageUrl") clearImageCredit(question);
    });
  });
  document.querySelectorAll("[data-question-image-upload]").forEach((element) => {
    element.addEventListener("change", () => uploadQuestionImage(element));
  });
  document.querySelectorAll("[data-answer-image-upload]").forEach((element) => {
    element.addEventListener("change", () => uploadAnswerImage(element));
  });
  document.querySelectorAll("[data-answer-image-url]").forEach((element) => {
    const updateAnswerImage = () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      if (!question) return;
      setAnswerImage(question, Number(element.dataset.answerIndex), element.value);
    };
    element.addEventListener("input", updateAnswerImage);
    element.addEventListener("change", () => {
      updateAnswerImage();
      render();
    });
  });
  document.querySelectorAll("[data-answer-image-layout]").forEach((element) => {
    const updateLayout = () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      if (!question) return;
      updateAnswerImageLayout(question, Number(element.dataset.answerIndex), element.dataset.answerImageLayout, Number(element.value));
      updateAnswerLayoutPreview(question, Number(element.dataset.answerIndex));
    };
    element.addEventListener("input", updateLayout);
    element.addEventListener("change", () => {
      updateLayout();
      render();
    });
  });
  document.querySelectorAll("[data-question-time]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].timeLimit = Number(element.value);
    });
  });
  document.querySelectorAll("[data-question-points]").forEach((element) => {
    element.addEventListener("change", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].points = Number(element.value) || 0;
    });
  });
  document.querySelectorAll("[data-archive-search]").forEach((element) => {
    element.addEventListener("input", () => {
      local.archiveSearch = element.value;
      render();
    });
  });
  document.querySelectorAll("[data-question-type]").forEach((element) => {
    element.addEventListener("change", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question.type = normalizeQuestionType(element.value);
      if (question.type === "true_false") {
        question.answers = ["Vero", "Falso"];
        question.answerImages = [];
        question.answerImageLayouts = [];
        question.correctIndex = Math.min(Number(question.correctIndex) || 0, 1);
        question.correctIndexes = [question.correctIndex];
      } else if (question.type === "slide") {
        question.answers = [];
        question.answerImages = [];
        question.answerImageLayouts = [];
        question.correctIndex = 0;
        question.correctIndexes = [];
        question.points = 0;
        question.videoUrl = "";
      } else if (question.type === "multiple_select") {
        question.answers = question.answers && question.answers.length >= 2 ? question.answers : ["Risposta A", "Risposta B", "Risposta C", "Risposta D"];
        question.answerImages = answerImagesForQuestion(question, editableAnswers(question).length);
        question.answerImageLayouts = answerImageLayoutsForQuestion(question, editableAnswers(question).length);
        question.correctIndexes = correctIndexesForQuestion(question, editableAnswers(question));
      } else if (!question.answers || question.answers.length < 2) {
        question.answers = ["Risposta A", "Risposta B", "Risposta C", "Risposta D"];
        question.answerImages = answerImagesForQuestion(question, editableAnswers(question).length);
        question.answerImageLayouts = answerImageLayoutsForQuestion(question, editableAnswers(question).length);
        question.correctIndexes = [Number(question.correctIndex) || 0];
      } else {
        question.answerImages = answerImagesForQuestion(question, editableAnswers(question).length);
        question.answerImageLayouts = answerImageLayoutsForQuestion(question, editableAnswers(question).length);
      }
      render();
    });
  });
  document.querySelectorAll("[data-answer-text]").forEach((element) => {
    element.addEventListener("input", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question.answers[Number(element.dataset.answerIndex)] = element.value;
    });
  });
  document.querySelectorAll("[data-correct-radio], [data-question-correct]").forEach((element) => {
    element.addEventListener("change", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question.correctIndex = Number(element.dataset.answerIndex || element.value);
      question.correctIndexes = [question.correctIndex];
      render();
    });
  });
  document.querySelectorAll("[data-correct-checkbox]").forEach((element) => {
    element.addEventListener("change", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      const answerIndex = Number(element.dataset.answerIndex);
      const current = correctIndexesForQuestion(question, editableAnswers(question));
      if (element.checked) {
        question.correctIndexes = Array.from(new Set([...current, answerIndex])).sort((a, b) => a - b);
      } else if (current.length > 2) {
        question.correctIndexes = current.filter((index) => index !== answerIndex);
      } else {
        showToast("Servono almeno 2 corrette");
      }
      question.correctIndex = question.correctIndexes[0] || 0;
      render();
    });
  });
  const importField = document.querySelector("[data-field='import-json']");
  if (importField) {
    importField.addEventListener("input", () => {
      local.importText = importField.value;
    });
  }
  const joinCodeField = document.querySelector("[data-field='join-code']");
  if (joinCodeField) {
    joinCodeField.addEventListener("input", () => {
      local.joinCode = joinCodeField.value.replace(/\D/g, "").slice(0, 6);
      joinCodeField.value = local.joinCode;
    });
  }
  const joinNameField = document.querySelector("[data-field='join-name']");
  if (joinNameField) {
    joinNameField.addEventListener("input", () => {
      local.nickname = joinNameField.value;
    });
  }
  const screenCodeField = document.querySelector("[data-field='screen-code']");
  if (screenCodeField) {
    screenCodeField.addEventListener("input", () => {
      local.screenCode = screenCodeField.value.replace(/\D/g, "").slice(0, 6);
      screenCodeField.value = local.screenCode;
    });
    screenCodeField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") joinScreen();
    });
  }
  const hostPasswordField = document.querySelector("[data-field='host-password']");
  if (hostPasswordField) {
    hostPasswordField.addEventListener("input", () => {
      local.hostAuth.password = hostPasswordField.value;
    });
    hostPasswordField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") hostLogin();
    });
  }
}

function bindFiftyHoldEvents() {
  document.querySelectorAll("[data-fifty-hold]").forEach((element) => {
    const challengeId = element.dataset.challengeId;
    const startHold = (event) => {
      event.preventDefault();
      if (element.disabled) return;
      local.fiftyHoldingId = challengeId;
      if (event.pointerId != null && element.setPointerCapture) {
        try {
          element.setPointerCapture(event.pointerId);
        } catch (_error) {
          // Some mobile browsers refuse capture after a scroll gesture.
        }
      }
      sendFiftyHold(challengeId, true);
      element.classList.add("holding");
      element.textContent = "Stai salvando...";
    };
    const stopHold = (event) => {
      event.preventDefault();
      if (element.disabled) return;
      local.fiftyHoldingId = "";
      sendFiftyHold(challengeId, false);
      element.classList.remove("holding");
      element.textContent = "Tieni premuto ora";
    };
    element.addEventListener("pointerdown", startHold);
    element.addEventListener("pointerup", stopHold);
    element.addEventListener("pointercancel", stopHold);
    element.addEventListener("lostpointercapture", stopHold);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
  });
}

function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  const target = event.currentTarget;

  if (action === "add-question") addQuestion();
  if (action === "remove-question") removeQuestion(Number(target.dataset.questionIndex));
  if (action === "select-builder-question") selectBuilderQuestion(Number(target.dataset.questionIndex));
  if (action === "edit-builder-question") editBuilderQuestion(Number(target.dataset.questionIndex));
  if (action === "move-question") moveQuestion(Number(target.dataset.questionIndex), Number(target.dataset.direction));
  if (action === "toggle-quiz-settings") {
    local.quizSettingsOpen = !local.quizSettingsOpen;
    if (!local.quizSettingsOpen) local.archiveOpen = false;
    render();
  }
  if (action === "close-quiz-settings") {
    local.quizSettingsOpen = false;
    local.archiveOpen = false;
    render();
  }
  if (action === "add-answer") addAnswer(Number(target.dataset.questionIndex));
  if (action === "remove-answer") removeAnswer(Number(target.dataset.questionIndex), Number(target.dataset.answerIndex));
  if (action === "apply-time-all") applyTimeToAllQuestions(Number(target.dataset.questionIndex));
  if (action === "suggest-question-images") suggestQuestionImages(Number(target.dataset.questionIndex));
  if (action === "generate-question-image") generateQuestionImage(Number(target.dataset.questionIndex));
  if (action === "generate-answer-image") generateAnswerImage(Number(target.dataset.questionIndex), Number(target.dataset.answerIndex));
  if (action === "select-suggested-image") selectSuggestedImage(Number(target.dataset.questionIndex), Number(target.dataset.imageIndex));
  if (action === "clear-question-image") clearQuestionImage(Number(target.dataset.questionIndex));
  if (action === "clear-answer-image") clearAnswerImage(Number(target.dataset.questionIndex), Number(target.dataset.answerIndex));
  if (action === "reset-answer-image-layout") resetAnswerImageLayout(Number(target.dataset.questionIndex), Number(target.dataset.answerIndex));
  if (action === "open-question-image-dialog") openQuestionImageDialog(Number(target.dataset.questionIndex));
  if (action === "open-answer-image-dialog") openAnswerImageDialog(Number(target.dataset.questionIndex), Number(target.dataset.answerIndex));
  if (action === "close-media-dialog") closeMediaDialog();
  if (action === "toggle-archive") toggleArchive();
  if (action === "set-archive-visibility") setArchiveVisibility(target.dataset.archiveVisibility);
  if (action === "refresh-archive") loadArchive();
  if (action === "apply-import") applyImport();
  if (action === "apply-import-xlsx") importQuizXlsx();
  if (action === "save-quiz") saveQuiz();
  if (action === "load-saved-quiz") loadSavedQuiz(target.dataset.quizId);
  if (action === "duplicate-saved-quiz") duplicateSavedQuiz(target.dataset.quizId);
  if (action === "delete-saved-quiz") deleteSavedQuiz(target.dataset.quizId);
  if (action === "delete-saved-result") deleteSavedResult(target.dataset.resultId);
  if (action === "download-quiz") downloadJson("quizlive-quiz.json", cleanQuiz(local.quiz));
  if (action === "download-template-xlsx") downloadQuizTemplate();
  if (action === "download-quiz-xlsx") downloadQuizXlsx();
  if (action === "switch-host") {
    switchMode("host");
    loadHostAuth();
  }
  if (action === "switch-join") switchMode("join");
  if (action === "host-login") hostLogin();
  if (action === "host-logout") hostLogout();
  if (action === "copy-player-link") copyPlayerLink();
  if (action === "open-player-link") openPlayerLink();
  if (action === "open-waiting-screen") openWaitingScreen();
  if (action === "copy-screen-link") copyScreenLink();
  if (action === "open-screen-link") openScreenLink();
  if (action === "cast-screen") castScreenToTv();
  if (action === "disconnect-screen-cast") disconnectScreenFromTv();
  if (action === "join-screen") joinScreen();
  if (action === "create-room") createRoom();
  if (action === "join-room") joinRoom();
  if (action === "start-game") emitHost("host:start");
  if (action === "reveal-question") emitHost("host:reveal");
  if (action === "next-question") emitHost("host:next");
  if (action === "reset-room") emitHost("host:reset");
  if (action === "back-to-builder") editCurrentRoomQuiz();
  if (action === "cancel-room-edit") cancelRoomEdit();
  if (action === "release-screens") releaseScreens();
  if (action === "send-live-effect") sendLiveEffect(target);
  if (action === "send-live-message") sendLiveMessage();
  if (action === "send-wager-offer") sendWagerOffer();
  if (action === "send-fifty-start") sendFiftyStart();
  if (action === "ready-fifty") readyFifty(target.dataset.challengeId);
  if (action === "accept-wager-random") respondWager(target.dataset.wagerId, true, "random");
  if (action === "accept-wager-chosen") respondWager(target.dataset.wagerId, true, "chosen");
  if (action === "decline-wager") respondWager(target.dataset.wagerId, false, "chosen");
  if (action === "answer") answer(Number(target.dataset.answerIndex));
  if (action === "submit-multiple-answer") submitMultipleAnswer();
  if (action === "accept-rematch") respondRematch(true);
  if (action === "decline-rematch") respondRematch(false);
  if (action === "leave-room") leaveRoomLocally("Puoi rientrare con codice e nickname");
}

function addQuestion() {
  local.quiz.questions.push({
    type: "multiple",
    text: "Nuova domanda",
    answers: ["Risposta A", "Risposta B", "Risposta C", "Risposta D"],
    answerImages: [],
    answerImageLayouts: [],
    correctIndex: 0,
    points: 0,
    timeLimit: 20
  });
  local.builderQuestionIndex = local.quiz.questions.length - 1;
  local.builderEditing = true;
  render();
}

function removeQuestion(index) {
  if (local.quiz.questions.length <= 1) return;
  local.quiz.questions.splice(index, 1);
  local.imageSuggestions = {};
  local.imageGenerating = {};
  local.builderQuestionIndex = Math.min(Math.max(0, index - 1), local.quiz.questions.length - 1);
  local.builderEditing = false;
  render();
}

function selectBuilderQuestion(index) {
  if (index < 0 || index >= local.quiz.questions.length) return;
  local.builderQuestionIndex = index;
  local.builderEditing = false;
  render();
}

function editBuilderQuestion(index) {
  if (index < 0 || index >= local.quiz.questions.length) return;
  local.builderQuestionIndex = index;
  local.builderEditing = true;
  render();
}

function navigateBuilderQuestion(direction) {
  const count = local.quiz.questions.length;
  if (!count) return;
  const nextIndex = Math.min(Math.max(selectedBuilderQuestionIndex() + direction, 0), count - 1);
  if (nextIndex === local.builderQuestionIndex && !local.builderEditing) return;
  local.builderQuestionIndex = nextIndex;
  local.builderEditing = false;
  render();
}

function moveQuestion(index, direction) {
  const questions = local.quiz.questions;
  const targetIndex = index + (direction < 0 ? -1 : 1);
  if (index < 0 || index >= questions.length || targetIndex < 0 || targetIndex >= questions.length) return;
  const selected = selectedBuilderQuestionIndex();
  const [question] = questions.splice(index, 1);
  questions.splice(targetIndex, 0, question);
  if (selected === index) {
    local.builderQuestionIndex = targetIndex;
  } else if (selected === targetIndex) {
    local.builderQuestionIndex = index;
  }
  local.imageSuggestions = {};
  local.imageGenerating = {};
  render();
}

function reorderQuestion(fromIndex, insertIndex) {
  const questions = local.quiz.questions;
  if (!Array.isArray(questions) || questions.length <= 1) return;
  if (fromIndex < 0 || fromIndex >= questions.length) return;
  const boundedInsertIndex = Math.min(Math.max(insertIndex, 0), questions.length);
  if (boundedInsertIndex === fromIndex || boundedInsertIndex === fromIndex + 1) return;
  const selectedQuestion = questions[selectedBuilderQuestionIndex()];
  const [question] = questions.splice(fromIndex, 1);
  const finalIndex = boundedInsertIndex > fromIndex ? boundedInsertIndex - 1 : boundedInsertIndex;
  questions.splice(finalIndex, 0, question);
  local.builderQuestionIndex = Math.max(0, questions.indexOf(selectedQuestion));
  local.imageSuggestions = {};
  local.imageGenerating = {};
  render();
}

function bindBuilderDeckDragEvents() {
  const deckList = document.querySelector("[data-builder-card-list]");
  if (deckList) {
    deckList.addEventListener("dragover", handleBuilderDeckDragOver);
    deckList.addEventListener("drop", handleBuilderDeckDrop);
    deckList.addEventListener("dragleave", handleBuilderDeckDragLeave);
  }
  document.querySelectorAll(".builder-slide[draggable='true']").forEach((card) => {
    card.addEventListener("dragstart", handleBuilderDragStart);
    card.addEventListener("dragover", handleBuilderDragOver);
    card.addEventListener("dragleave", handleBuilderDragLeave);
    card.addEventListener("drop", handleBuilderDrop);
    card.addEventListener("dragend", handleBuilderDragEnd);
  });
}

function handleBuilderDragStart(event) {
  if (!isHostBuilderVisible()) {
    event.preventDefault();
    return;
  }
  if (event.target && event.target.closest && event.target.closest(".builder-icon-btn")) {
    event.preventDefault();
    return;
  }
  builderDragIndex = Number(event.currentTarget.dataset.questionIndex);
  event.currentTarget.classList.add("dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(builderDragIndex));
  }
}

function handleBuilderDragOver(event) {
  if (builderDragIndex === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const card = event.currentTarget;
  const index = Number(card.dataset.questionIndex);
  clearBuilderDragIndicators(card);
  updateBuilderDragAutoScroll(event.clientY);
  if (index === builderDragIndex) return;
  const box = card.getBoundingClientRect();
  const before = event.clientY < box.top + box.height / 2;
  card.classList.add(before ? "drag-over-before" : "drag-over-after");
}

function handleBuilderDragLeave(event) {
  event.currentTarget.classList.remove("drag-over-before", "drag-over-after");
}

function handleBuilderDrop(event) {
  if (builderDragIndex === null) return;
  event.preventDefault();
  event.stopPropagation();
  const card = event.currentTarget;
  const targetIndex = Number(card.dataset.questionIndex);
  const box = card.getBoundingClientRect();
  const before = event.clientY < box.top + box.height / 2;
  const fromIndex = builderDragIndex;
  builderDragIndex = null;
  stopBuilderDragAutoScroll();
  clearBuilderDragIndicators();
  reorderQuestion(fromIndex, before ? targetIndex : targetIndex + 1);
}

function handleBuilderDragEnd() {
  builderDragIndex = null;
  stopBuilderDragAutoScroll();
  clearBuilderDragIndicators();
}

function handleBuilderDeckDragOver(event) {
  if (builderDragIndex === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  updateBuilderDragAutoScroll(event.clientY);
  if (event.target && event.target.closest && event.target.closest(".builder-slide")) return;
  clearBuilderDragIndicators();
}

function handleBuilderDeckDrop(event) {
  if (builderDragIndex === null) return;
  if (event.target && event.target.closest && event.target.closest(".builder-slide")) return;
  event.preventDefault();
  const fromIndex = builderDragIndex;
  const deckList = event.currentTarget;
  const cards = Array.from(deckList.querySelectorAll(".builder-slide"));
  const firstCard = cards[0];
  const lastCard = cards[cards.length - 1];
  const insertIndex = firstCard && event.clientY < firstCard.getBoundingClientRect().top
    ? 0
    : lastCard && event.clientY > lastCard.getBoundingClientRect().bottom
      ? local.quiz.questions.length
      : local.quiz.questions.length;
  builderDragIndex = null;
  stopBuilderDragAutoScroll();
  clearBuilderDragIndicators();
  reorderQuestion(fromIndex, insertIndex);
}

function handleBuilderDeckDragLeave(event) {
  const deckList = event.currentTarget;
  const nextTarget = event.relatedTarget;
  if (nextTarget && deckList.contains(nextTarget)) return;
  stopBuilderDragAutoScroll();
}

function clearBuilderDragIndicators(exceptCard) {
  document.querySelectorAll(".builder-slide").forEach((card) => {
    if (card === exceptCard) return;
    card.classList.remove("dragging", "drag-over-before", "drag-over-after");
  });
}

function updateBuilderDragAutoScroll(clientY) {
  const deckList = document.querySelector("[data-builder-card-list]");
  if (!deckList) return;
  const box = deckList.getBoundingClientRect();
  const threshold = Math.min(96, Math.max(48, box.height * 0.18));
  let speed = 0;
  if (clientY < box.top + threshold) {
    speed = -Math.ceil(((box.top + threshold - clientY) / threshold) * 18);
  } else if (clientY > box.bottom - threshold) {
    speed = Math.ceil(((clientY - (box.bottom - threshold)) / threshold) * 18);
  }
  builderDragAutoScrollSpeed = Math.max(-22, Math.min(22, speed));
  if (builderDragAutoScrollSpeed) startBuilderDragAutoScroll();
  else stopBuilderDragAutoScroll();
}

function startBuilderDragAutoScroll() {
  if (builderDragAutoScrollFrame) return;
  const step = () => {
    const deckList = document.querySelector("[data-builder-card-list]");
    if (!deckList || !builderDragAutoScrollSpeed || builderDragIndex === null) {
      builderDragAutoScrollFrame = null;
      return;
    }
    deckList.scrollTop += builderDragAutoScrollSpeed;
    builderDragAutoScrollFrame = requestAnimationFrame(step);
  };
  builderDragAutoScrollFrame = requestAnimationFrame(step);
}

function stopBuilderDragAutoScroll() {
  builderDragAutoScrollSpeed = 0;
  if (!builderDragAutoScrollFrame) return;
  cancelAnimationFrame(builderDragAutoScrollFrame);
  builderDragAutoScrollFrame = null;
}

function handleBuilderKeyboard(event) {
  if (!isHostBuilderVisible() || isTypingTarget(event.target)) return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    if (event.shiftKey) moveQuestion(selectedBuilderQuestionIndex(), direction);
    else navigateBuilderQuestion(direction);
  }
  if (event.key === "Enter") {
    event.preventDefault();
    editBuilderQuestion(selectedBuilderQuestionIndex());
  }
  if (event.key === "Escape" && local.builderEditing) {
    event.preventDefault();
    local.builderEditing = false;
    render();
  }
}

function isHostBuilderVisible() {
  if (local.mode !== "host") return false;
  if (local.room && local.room.role !== "host") return false;
  if (local.mediaDialog || local.quizSettingsOpen) return false;
  return Boolean(local.quiz && Array.isArray(local.quiz.questions));
}

function isTypingTarget(target) {
  const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
  return tag === "input" || tag === "textarea" || tag === "select" || Boolean(target && target.isContentEditable);
}

function addAnswer(questionIndex) {
  const question = local.quiz.questions[questionIndex];
  if (!question || normalizeQuestionType(question.type) === "true_false") return;
  question.answers = editableAnswers(question).slice(0, 6);
  if (question.answers.length >= 6) return;
  question.answers.push("");
  question.answerImages = answerImagesForQuestion(question, question.answers.length);
  question.answerImageLayouts = answerImageLayoutsForQuestion(question, question.answers.length);
  render();
}

function removeAnswer(questionIndex, answerIndex) {
  const question = local.quiz.questions[questionIndex];
  if (!question || normalizeQuestionType(question.type) === "true_false") return;
  const answers = editableAnswers(question);
  if (answers.length <= 2) return;
  const previousCorrect = correctIndexesForQuestion(question, answers);
  answers.splice(answerIndex, 1);
  question.answers = answers;
  question.answerImages = answerImagesForQuestion(question, answers.length + 1);
  question.answerImages.splice(answerIndex, 1);
  question.answerImageLayouts = answerImageLayoutsForQuestion(question, answers.length + 1);
  question.answerImageLayouts.splice(answerIndex, 1);
  const current = previousCorrect
    .filter((index) => index !== answerIndex)
    .map((index) => index > answerIndex ? index - 1 : index)
    .filter((index) => index >= 0 && index < answers.length);
  question.correctIndexes = current.length ? Array.from(new Set(current)).sort((a, b) => a - b) : [0];
  question.correctIndex = question.correctIndexes[0] || 0;
  render();
}

function applyTimeToAllQuestions(questionIndex) {
  const source = local.quiz.questions[questionIndex];
  if (!source) return;
  const timeLimit = Math.min(90, Math.max(5, Math.round(Number(source.timeLimit) || 20)));
  local.quiz.questions.forEach((question) => {
    question.timeLimit = timeLimit;
  });
  showToast("Tempo applicato a tutte");
  render();
}

async function uploadAnswerImage(input) {
  const questionIndex = Number(input.dataset.questionIndex);
  const answerIndex = Number(input.dataset.answerIndex);
  const question = local.quiz.questions[questionIndex];
  const file = input.files && input.files[0];
  if (!question || !file || normalizeQuestionType(question.type) === "true_false") return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type || "")) {
    showToast("Carica PNG, JPG, WebP o GIF");
    input.value = "";
    return;
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    showToast("Immagine troppo grande: massimo 1.5 MB");
    input.value = "";
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const response = await fetch("/api/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ file: dataUrl, filename: file.name })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Upload non riuscito");
    setAnswerImage(question, answerIndex, data.url);
    showToast("Immagine risposta caricata");
    render();
  } catch (error) {
    showToast(error.message || "Upload non riuscito");
    input.value = "";
  }
}

async function uploadQuestionImage(input) {
  const questionIndex = Number(input.dataset.questionIndex);
  const question = local.quiz.questions[questionIndex];
  const file = input.files && input.files[0];
  if (!question || !file) return;
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type || "")) {
    showToast("Carica PNG, JPG, WebP o GIF");
    input.value = "";
    return;
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    showToast("Immagine troppo grande: massimo 1.5 MB");
    input.value = "";
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const response = await fetch("/api/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ file: dataUrl, filename: file.name })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Upload non riuscito");
    question.imageUrl = data.url;
    clearImageCredit(question);
    showToast("Immagine caricata");
    render();
  } catch (error) {
    showToast(error.message || "Upload non riuscito");
    input.value = "";
  }
}

async function suggestQuestionImages(index) {
  const question = local.quiz.questions[index];
  if (!question) return;
  local.imageSuggestions[index] = { loading: true, images: [], query: "", error: "" };
  render();

  try {
    const response = await fetch("/api/images/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        quiz: cleanQuiz(local.quiz),
        question
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Ricerca immagini non riuscita");
    local.imageSuggestions[index] = {
      loading: false,
      images: Array.isArray(data.images) ? data.images : [],
      query: data.query || "",
      error: ""
    };
    if (!local.imageSuggestions[index].images.length) showToast("Nessuna immagine trovata");
  } catch (error) {
    local.imageSuggestions[index] = {
      loading: false,
      images: [],
      query: "",
      error: error.message || "Ricerca immagini non riuscita"
    };
    showToast(local.imageSuggestions[index].error);
  }
  render();
}

async function generateQuestionImage(index) {
  const question = local.quiz.questions[index];
  if (!question) return;
  const key = imageGeneratingKey(index);
  local.imageGenerating[key] = { loading: true };
  render();

  try {
    const response = await fetch("/api/images/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        quiz: cleanQuiz(local.quiz),
        question
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Generazione immagine non riuscita");
    question.imageUrl = data.url || "";
    question.imageAlt = `Immagine generata per: ${question.text || "domanda"}`.slice(0, 160);
    question.imageCredit = data.providerLabel || "Cloudflare Workers AI";
    question.imageCreditUrl = "";
    question.imageProvider = data.providerLabel || "Cloudflare Workers AI";
    question.imagePageUrl = "";
    local.imageSuggestions[index] = { loading: false, images: [], query: "", error: "" };
    showToast("Immagine generata");
  } catch (error) {
    showToast(error.message || "Generazione immagine non riuscita");
  } finally {
    local.imageGenerating[key] = { loading: false };
    render();
  }
}

async function generateAnswerImage(questionIndex, answerIndex) {
  const question = local.quiz.questions[questionIndex];
  if (!question || normalizeQuestionType(question.type) === "true_false") return;
  const answers = editableAnswers(question);
  if (answerIndex < 0 || answerIndex >= answers.length) return;
  const answerText = String(answers[answerIndex] || `Risposta ${answerLetters[answerIndex] || answerIndex + 1}`).trim();
  const key = imageGeneratingKey(questionIndex, answerIndex);
  local.imageGenerating[key] = { loading: true };
  render();

  try {
    const response = await fetch("/api/images/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        quiz: cleanQuiz(local.quiz),
        question,
        answerText,
        answerIndex
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Generazione immagine non riuscita");
    setAnswerImage(question, answerIndex, data.url || "");
    showToast("Immagine risposta generata");
  } catch (error) {
    showToast(error.message || "Generazione immagine non riuscita");
  } finally {
    local.imageGenerating[key] = { loading: false };
    render();
  }
}

function selectSuggestedImage(questionIndex, imageIndex) {
  const question = local.quiz.questions[questionIndex];
  const state = imageSuggestionState(questionIndex);
  const image = state.images && state.images[imageIndex];
  if (!question || !image) return;
  question.imageUrl = image.imageUrl || "";
  question.imageAlt = image.alt || "";
  question.imageCredit = image.photographer || "";
  question.imageCreditUrl = image.photographerUrl || "";
  question.imageProvider = image.provider || "Pexels";
  question.imagePageUrl = image.pageUrl || "";
  showToast("Immagine selezionata");
  render();
}

function clearQuestionImage(index) {
  const question = local.quiz.questions[index];
  if (!question) return;
  question.imageUrl = "";
  clearImageCredit(question);
  render();
}

function clearAnswerImage(questionIndex, answerIndex) {
  const question = local.quiz.questions[questionIndex];
  if (!question || normalizeQuestionType(question.type) === "true_false") return;
  setAnswerImage(question, answerIndex, "");
  resetAnswerImageLayout(questionIndex, answerIndex);
  render();
}

function openQuestionImageDialog(questionIndex) {
  if (!local.quiz.questions[questionIndex]) return;
  local.mediaDialog = { target: "question", questionIndex };
  render();
}

function openAnswerImageDialog(questionIndex, answerIndex) {
  const question = local.quiz.questions[questionIndex];
  if (!question || normalizeQuestionType(question.type) === "true_false") return;
  local.mediaDialog = { target: "answer", questionIndex, answerIndex };
  render();
}

function closeMediaDialog() {
  local.mediaDialog = null;
  render();
}

function clearImageCredit(question) {
  if (!question) return;
  question.imageAlt = "";
  question.imageCredit = "";
  question.imageCreditUrl = "";
  question.imageProvider = "";
  question.imagePageUrl = "";
}

function applyImport() {
  try {
    const parsed = JSON.parse(local.importText);
    local.quiz = cleanQuiz(parsed);
    local.currentQuizId = null;
    local.quizSettingsOpen = false;
    showToast("Quiz importato");
    render();
  } catch (error) {
    showToast("JSON non valido");
  }
}

async function importQuizXlsx() {
  const input = document.querySelector("[data-field='import-xlsx']");
  const file = input && input.files && input.files[0];
  if (!file) {
    showToast("Scegli un file XLSX");
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const response = await fetch("/api/quiz/import.xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ file: dataUrl })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Import non riuscito");
    local.quiz = cleanQuiz(data.quiz);
    local.currentQuizId = null;
    local.quizSettingsOpen = false;
    local.archiveOpen = false;
    local.builderQuestionIndex = 0;
    local.builderEditing = false;
    showToast("Quiz XLSX importato");
    render();
  } catch (error) {
    showToast(error.message || "Import XLSX non riuscito");
  }
}

async function downloadQuizTemplate() {
  await downloadUrl("/api/quiz-template.xlsx", "quizlive-modello.xlsx", "Modello XLSX scaricato");
}

async function downloadQuizXlsx() {
  const quiz = cleanQuiz(local.quiz);
  if (!quiz.questions.length) {
    showToast("Aggiungi almeno una domanda");
    return;
  }

  try {
    const response = await fetch("/api/quiz/export.xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ quiz })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Export non riuscito");
    }
    await downloadBlobResponse(response, "quizlive.xlsx");
    showToast("Quiz XLSX esportato");
  } catch (error) {
    showToast(error.message || "Export XLSX non riuscito");
  }
}

async function downloadUrl(url, fallbackName, successMessage) {
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Download non riuscito");
    await downloadBlobResponse(response, fallbackName);
    showToast(successMessage);
  } catch (error) {
    showToast(error.message || "Download non riuscito");
  }
}

async function downloadBlobResponse(response, fallbackName) {
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File non leggibile"));
    reader.readAsDataURL(file);
  });
}

function toggleArchive() {
  local.archiveOpen = !local.archiveOpen;
  render();
  if (local.archiveOpen) loadArchive();
}

async function loadArchive() {
  local.archiveLoading = true;
  render();
  try {
    const [quizResponse, resultResponse] = await Promise.all([
      fetch("/api/archive/quizzes", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/archive/results", { cache: "no-store", credentials: "same-origin" })
    ]);
    if (!quizResponse.ok || !resultResponse.ok) throw new Error("Archivio non disponibile");
    const quizData = await quizResponse.json();
    const resultData = await resultResponse.json();
    local.savedQuizzes = Array.isArray(quizData.quizzes) ? quizData.quizzes : [];
    local.savedResults = Array.isArray(resultData.results) ? resultData.results : [];
  } catch (error) {
    showToast("Archivio non disponibile");
  } finally {
    local.archiveLoading = false;
    render();
  }
}

async function saveQuiz() {
  const quiz = cleanQuiz(local.quiz);
  if (!quiz.questions.length) {
    showToast("Aggiungi almeno una domanda");
    return;
  }

  try {
    const response = await fetch("/api/archive/quizzes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id: local.currentQuizId, quiz })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Salvataggio non riuscito");
    local.currentQuizId = data.quiz.id;
    local.quiz = cleanQuiz(data.quiz.quiz);
    showToast("Quiz salvato");
    if (local.archiveOpen) loadArchive();
  } catch (error) {
    showToast(error.message || "Salvataggio non riuscito");
  }
}

function loadSavedQuiz(id) {
  const item = local.savedQuizzes.find((quiz) => quiz.id === id);
  if (!item || !item.quiz) {
    showToast("Quiz non trovato");
    return;
  }
  local.quiz = cleanQuiz(item.quiz);
  local.currentQuizId = item.id;
  showToast("Quiz caricato");
  render();
}

function duplicateSavedQuiz(id) {
  const item = local.savedQuizzes.find((quiz) => quiz.id === id);
  if (!item || !item.quiz) {
    showToast("Quiz non trovato");
    return;
  }
  local.quiz = cleanQuiz({
    ...item.quiz,
    title: `${item.quiz.title || item.title} copia`
  });
  local.currentQuizId = null;
  showToast("Quiz duplicato come bozza");
  render();
}

async function deleteSavedQuiz(id) {
  if (!id) return;
  try {
    const response = await fetch(`/api/archive/quizzes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Eliminazione non riuscita");
    if (local.currentQuizId === id) local.currentQuizId = null;
    showToast("Quiz eliminato");
    loadArchive();
  } catch (error) {
    showToast(error.message || "Eliminazione non riuscita");
  }
}

async function deleteSavedResult(id) {
  if (!id) return;
  try {
    const response = await fetch(`/api/archive/results/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Eliminazione non riuscita");
    showToast("Risultato eliminato");
    loadArchive();
  } catch (error) {
    showToast(error.message || "Eliminazione non riuscita");
  }
}

function editCurrentRoomQuiz() {
  if (!local.room || local.room.role !== "host") return;
  local.quiz = roomToEditableQuiz(local.room);
  local.currentQuizId = null;
  local.selectedAnswer = null;
  local.selectedAnswers = [];
  local.archiveOpen = true;
  local.hostEditingRoom = true;
  local.mode = "host";
  window.history.replaceState(null, "", "#host");
  showToast("Builder pronto");
  loadArchive();
  render();
}

function cancelRoomEdit() {
  local.hostEditingRoom = false;
  render();
}

function createRoom(quickStart = false) {
  if (!hostAccessGranted()) {
    showToast("Password host richiesta");
    render();
    return;
  }

  const quiz = cleanQuiz(local.quiz);
  if (!quiz.questions.length) {
    showToast("Aggiungi almeno una domanda");
    return;
  }
  if (local.hostEditingRoom && local.room && local.room.role === "host") {
    updateCurrentRoomQuiz(quiz, quickStart);
    return;
  }
  socket.emit("host:create", { quiz }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Errore creazione stanza");
      return;
    }
    switchMode("host", true);
    local.hostEditingRoom = false;
    showToast(`Stanza ${response.code} creata`);
    if (quickStart) emitHost("host:start");
  });
}

function updateCurrentRoomQuiz(quiz, quickStart) {
  socket.emit("host:update-quiz", { quiz }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Aggiornamento stanza non riuscito");
      return;
    }
    local.hostEditingRoom = false;
    showToast("Stanza aggiornata");
    if (quickStart) emitHost("host:start");
    render();
  });
}

function joinRoom() {
  const codeField = document.querySelector("[data-field='join-code']");
  const nameField = document.querySelector("[data-field='join-name']");
  const code = codeField ? codeField.value : local.joinCode;
  const nickname = nameField ? nameField.value : local.nickname;
  const sessionToken = sessionTokenForCode(code);
  socket.emit("player:join", { code, nickname, sessionToken }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Impossibile entrare");
      return;
    }
    savePlayerSession(response.code || code, nickname, response.sessionToken);
    showToast(response.rejoined ? "Rientrato" : "Entrato");
  });
}

function joinScreen() {
  const codeField = document.querySelector("[data-field='screen-code']");
  const code = codeField ? codeField.value : local.screenCode;
  const normalizedCode = String(code || "").replace(/\D/g, "").slice(0, 6);
  if (normalizedCode.length !== 6) {
    showToast("Inserisci codice stanza");
    return;
  }

  local.screenCode = normalizedCode;
  local.screenJoining = true;
  local.screenWaiting = false;
  switchMode("screen", true);
  socket.emit("screen:join", { code: normalizedCode }, (response) => {
    local.screenJoining = false;
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Monitor non disponibile");
      render();
      return;
    }
    showToast("Monitor collegato");
  });
  render();
}

function watchScreen() {
  if (local.screenJoining || local.screenWaiting || !socket.connected) return;
  local.screenJoining = true;
  socket.emit("screen:watch", {}, (response) => {
    local.screenJoining = false;
    local.screenWaiting = Boolean(response && response.ok && response.waiting);
    if (!response || !response.ok) showToast("Monitor non disponibile");
    render();
  });
  render();
}

function enterScreenWaiting() {
  local.room = null;
  local.mode = "screen";
  local.screenCode = "";
  local.screenJoining = false;
  local.screenWaiting = true;
  local.selectedAnswer = null;
  window.history.replaceState(null, "", "#screen");
  render();
}

function switchMode(mode, silent = false) {
  local.mode = mode;
  if (mode === "host") {
    window.history.replaceState(null, "", "#host");
  } else if (mode === "screen") {
    const code = local.screenCode ? `=${encodeURIComponent(local.screenCode)}` : "";
    window.history.replaceState(null, "", `#screen${code}`);
  } else {
    const code = local.joinCode ? `=${encodeURIComponent(local.joinCode)}` : "";
    window.history.replaceState(null, "", `#join${code}`);
  }
  if (!silent) render();
}

async function copyPlayerLink() {
  const link = playerLink(local.room && local.room.code);
  const message = local.playerAccessMode === "local" ? "Link locale copiato" : "Link copiato";
  try {
    await navigator.clipboard.writeText(link);
    showToast(message);
  } catch (error) {
    const copied = fallbackCopy(link);
    showToast(copied ? message : "Copia non riuscita");
  }
}

function openPlayerLink() {
  const link = local.room && local.room.code
    ? playerLink(local.room.code)
    : `${playerBaseUrl()}/#join`;
  window.open(link, "_blank", "noopener,noreferrer");
}

async function copyScreenLink() {
  const link = screenLink(local.room && local.room.code);
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link monitor copiato");
  } catch (error) {
    const copied = fallbackCopy(link);
    showToast(copied ? "Link monitor copiato" : "Copia non riuscita");
  }
}

function openScreenLink() {
  const link = screenLink(local.room && local.room.code);
  window.open(link, "_blank", "noopener,noreferrer");
}

async function castScreenToTv() {
  const link = screenLink(local.room && local.room.code);
  if (!supportsScreenPresentation()) {
    showToast("Usa Chrome: menu Trasmetti");
    return;
  }
  if (isScreenPresentationConnected()) {
    showToast("TV collegata");
    return;
  }

  try {
    const request = createScreenPresentationRequest(link);
    const connection = await request.start();
    setScreenPresentationConnection(connection);
    showToast("Monitor inviato alla TV");
    render();
  } catch (error) {
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "AbortError") {
      showToast("Trasmissione annullata");
      return;
    }
    showToast("TV non trovata o non supportata");
  }
}

function disconnectScreenFromTv() {
  const connection = screenPresentationConnection;
  if (!connection) {
    showToast("Nessuna TV collegata");
    render();
    return;
  }

  screenPresentationDisconnecting = true;
  try {
    if (typeof connection.terminate === "function") {
      connection.terminate();
    } else if (typeof connection.close === "function") {
      connection.close();
    }
    showToast("TV scollegata");
  } catch (error) {
    showToast("Connessione TV chiusa");
  } finally {
    clearScreenPresentationConnection();
    screenPresentationDisconnecting = false;
    render();
  }
}

function openWaitingScreen() {
  window.open(`${playerBaseUrl()}/#screen`, "_blank", "noopener,noreferrer");
}

function updateScreenPresentationRequest() {
  if (!supportsScreenPresentation()) return;
  try {
    const link = screenLink(local.room && local.room.code);
    if (link === screenPresentationUrl) return;
    screenPresentationRequest = createScreenPresentationRequest(link);
    screenPresentationUrl = link;
    navigator.presentation.defaultRequest = screenPresentationRequest;
  } catch (error) {
    screenPresentationRequest = null;
    screenPresentationUrl = "";
  }
}

function createScreenPresentationRequest(link) {
  return new PresentationRequest([link]);
}

function supportsScreenPresentation() {
  return typeof window.PresentationRequest === "function" && Boolean(navigator.presentation);
}

function setScreenPresentationConnection(connection) {
  screenPresentationConnection = connection || null;
  screenPresentationDisconnecting = false;
  if (connection && typeof connection.addEventListener === "function") {
    connection.addEventListener("close", handleScreenPresentationEnded);
    connection.addEventListener("terminate", handleScreenPresentationEnded);
  }
}

function clearScreenPresentationConnection() {
  screenPresentationConnection = null;
}

function handleScreenPresentationEnded() {
  const wasConnected = Boolean(screenPresentationConnection);
  clearScreenPresentationConnection();
  if (wasConnected && !screenPresentationDisconnecting) showToast("TV scollegata");
  screenPresentationDisconnecting = false;
  render();
}

function isScreenPresentationConnected() {
  if (!screenPresentationConnection) return false;
  return !screenPresentationConnection.state || screenPresentationConnection.state === "connected";
}

async function loadNetworkConfig() {
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    local.playerBaseUrl = choosePlayerBaseUrl(config);
    local.playerAccessMode = choosePlayerAccessMode(config);
    render();
  } catch (error) {
    local.playerBaseUrl = window.location.origin;
    local.playerAccessMode = accessModeForOrigin(window.location.origin);
  }
}

function autoJoinScreen() {
  if (local.mode !== "screen" || local.room || local.screenJoining || !socket.connected) return;
  if (local.screenCode) {
    joinScreen();
    return;
  }
  watchScreen();
}

function autoRejoinPlayer() {
  const playerRoomCode = local.room && local.room.role === "player" ? local.room.code : "";
  const playerView = local.mode === "join" || Boolean(playerRoomCode);
  if (!playerView || local.playerRejoining || !socket.connected) return;
  const session = local.playerSession;
  const code = playerRoomCode || local.joinCode || (session && session.code);
  if (!session || !session.sessionToken || !code || session.code !== code) return;

  local.playerRejoining = true;
  socket.emit("player:join", {
    code,
    nickname: session.nickname,
    sessionToken: session.sessionToken
  }, (response) => {
    local.playerRejoining = false;
    if (!response || !response.ok) {
      clearPlayerSession();
      if (playerRoomCode) local.room = null;
      render();
      return;
    }
    savePlayerSession(response.code || code, session.nickname, response.sessionToken);
    showToast("Rientrato");
  });
}

async function loadHostAuth() {
  try {
    const response = await fetch("/api/host/auth", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error("Accesso host non disponibile");
    const data = await response.json();
    local.hostAuth.checked = true;
    local.hostAuth.enabled = Boolean(data.enabled);
    local.hostAuth.authenticated = !data.enabled || Boolean(data.authenticated);
  } catch (error) {
    local.hostAuth.checked = true;
    local.hostAuth.enabled = true;
    local.hostAuth.authenticated = false;
    if (local.mode === "host") showToast("Accesso host non verificato");
  } finally {
    render();
  }
}

async function hostLogin() {
  if (local.hostAuth.loading) return;
  const field = document.querySelector("[data-field='host-password']");
  const password = field ? field.value : local.hostAuth.password;
  if (!String(password || "").trim()) {
    showToast("Inserisci password host");
    return;
  }

  local.hostAuth.loading = true;
  render();
  try {
    const response = await fetch("/api/host/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Password non corretta");
    local.hostAuth.checked = true;
    local.hostAuth.enabled = Boolean(data.enabled);
    local.hostAuth.authenticated = true;
    local.hostAuth.password = "";
    reconnectSocketForHost();
    showToast("Area host sbloccata");
  } catch (error) {
    local.hostAuth.authenticated = false;
    showToast(error.message || "Password non corretta");
  } finally {
    local.hostAuth.loading = false;
    render();
  }
}

async function hostLogout() {
  try {
    await fetch("/api/host/logout", {
      method: "POST",
      credentials: "same-origin"
    });
  } catch (error) {
    // The local lock still happens even if the network request fails.
  }
  local.hostAuth.authenticated = !local.hostAuth.enabled;
  local.hostAuth.password = "";
  reconnectSocketForHost();
  showToast("Area host bloccata");
  render();
}

function hostAccessGranted() {
  return local.hostAuth.checked && (!local.hostAuth.enabled || local.hostAuth.authenticated);
}

function reconnectSocketForHost() {
  reconnectingForHostAuth = true;
  if (socket.connected) socket.disconnect();
  socket.connect();
}

function emitHost(eventName) {
  socket.emit(eventName, {}, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Comando non riuscito");
    }
  });
}

function releaseScreens() {
  socket.emit("host:release-screens", {}, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Monitor non aggiornato");
      return;
    }
    showToast(response.released ? "Monitor in attesa" : "Nessun monitor collegato");
  });
}

function sendLiveEffect(element) {
  sendLiveEvent({
    type: "effect",
    target: element.dataset.liveTarget || "all",
    tone: element.dataset.liveTone || "spark",
    vibrate: element.dataset.liveVibrate === "true",
    message: element.dataset.liveMessage || ""
  });
}

function sendLiveMessage() {
  const message = String(local.liveEventMessage || "").trim();
  if (!message) {
    showToast("Scrivi un messaggio live");
    return;
  }
  const parsedTarget = parseLiveEventTarget(local.liveEventTarget);
  sendLiveEvent({
    type: "message",
    target: parsedTarget.target,
    playerId: parsedTarget.playerId,
    tone: parsedTarget.target === "player" ? "secret" : "spark",
    vibrate: true,
    message
  }, () => {
    local.liveEventMessage = "";
    render();
  });
}

function parseLiveEventTarget(value) {
  const target = String(value || "all");
  if (target.startsWith("player:")) {
    return { target: "player", playerId: target.slice("player:".length) };
  }
  if (target === "players" || target === "screen" || target === "all") {
    return { target, playerId: "" };
  }
  return { target: "all", playerId: "" };
}

function sendLiveEvent(payload, onSuccess) {
  socket.emit("host:live-event", payload, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Evento non inviato");
      return;
    }
    const delivered = Number(response.delivered) || 0;
    showToast(delivered ? `Evento inviato a ${delivered}` : "Nessun destinatario collegato");
    if (onSuccess) onSuccess(response);
  });
}

function sendWagerOffer() {
  const room = local.room;
  const players = room && Array.isArray(room.players) ? room.players.filter((player) => Number(player.score || 0) > 0 && player.connected) : [];
  const selectedPlayer = players.find((player) => player.id === local.liveWagerPlayerId) || players[0];
  if (!selectedPlayer) {
    showToast("Nessun giocatore con punti");
    return;
  }
  const stake = Math.max(1, Math.floor(Number(local.liveWagerStake) || 1));
  socket.emit("host:wager-offer", {
    playerId: selectedPlayer.id,
    stake
  }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Scommessa non inviata");
      return;
    }
    showToast(response.delivered ? "Scommessa inviata" : "Giocatore non raggiunto");
  });
}

function sendFiftyStart() {
  const stake = Math.max(1, Math.floor(Number(local.liveFiftyStake) || 1));
  socket.emit("host:fifty-start", { stake }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "50 e 50 non avviato");
      return;
    }
    showToast("50 e 50 avviato");
  });
}

function readyFifty(challengeId) {
  socket.emit("player:fifty-ready", { challengeId }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Pronto non registrato");
      return;
    }
    showToast("Pronto");
  });
}

function sendFiftyHold(challengeId, holding) {
  socket.emit("player:fifty-hold", {
    challengeId,
    holding
  }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Sfida non aggiornata");
      return;
    }
    if (!holding) showToast("Hai lasciato cadere");
  });
}

function respondWager(wagerId, accept, mode) {
  const offer = local.room && local.room.wagerOffer;
  const targetPlayerId = mode === "chosen"
    ? local.wagerTargetId || (offer && offer.eligibleTargets && offer.eligibleTargets[0] && offer.eligibleTargets[0].id) || ""
    : "";
  socket.emit("player:wager-response", {
    wagerId,
    accept,
    mode,
    targetPlayerId
  }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Scommessa non valida");
      return;
    }
    local.wagerTargetId = "";
    showToast(accept ? "Scommessa accettata" : "Scommessa rifiutata");
  });
}

function answer(answerIndex) {
  const question = local.room && local.room.question;
  if (question && question.type === "multiple_select" && !question.answered) {
    const required = selectionCount(question);
    const selected = new Set(local.selectedAnswers);
    if (selected.has(answerIndex)) {
      selected.delete(answerIndex);
    } else if (selected.size < required) {
      selected.add(answerIndex);
    } else {
      showToast(`Scegli solo ${required} risposte`);
    }
    local.selectedAnswers = Array.from(selected).sort((a, b) => a - b);
    render();
    return;
  }

  local.selectedAnswer = answerIndex;
  render();
  socket.emit("player:answer", { answerIndex }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Risposta non inviata");
    }
  });
}

function submitMultipleAnswer() {
  const question = local.room && local.room.question;
  if (!question || question.type !== "multiple_select") return;
  const required = selectionCount(question);
  if (local.selectedAnswers.length !== required) {
    showToast(`Seleziona ${required} risposte`);
    return;
  }
  socket.emit("player:answer", { answerIndexes: local.selectedAnswers }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Risposte non inviate");
      return;
    }
    local.selectedAnswers = [];
  });
}

function respondRematch(accept) {
  socket.emit("player:rematch", { accept }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Invito non valido");
      return;
    }
    if (response.left) {
      leaveRoomLocally("Hai saltato la nuova partita");
      return;
    }
    showToast("Confermato");
  });
}

function leaveRoomLocally(message) {
  const code = local.room && local.room.code;
  local.room = null;
  local.selectedAnswer = null;
  local.selectedAnswers = [];
  clearPlayerSession();
  if (code) local.joinCode = code;
  switchMode("join", true);
  showToast(message);
  render();
}

function cleanQuiz(input) {
  const source = input && typeof input === "object" ? input : defaultQuiz();
  const questions = Array.isArray(source.questions) ? source.questions : [];
  return {
    title: String(source.title || "QuizLive").trim().slice(0, 80) || "QuizLive",
    description: String(source.description || "").trim().slice(0, 220),
    subject: String(source.subject || "").trim().slice(0, 40),
    level: String(source.level || "").trim().slice(0, 40),
    language: String(source.language || "Italiano").trim().slice(0, 32) || "Italiano",
    folder: String(source.folder || "").trim().slice(0, 40),
    visibility: quizVisibility(source.visibility),
    tags: parseTags(source.tags),
    teamMode: Boolean(source.teamMode),
    questions: questions.map((question, index) => {
      const type = normalizeQuestionType(question.type);
      const answers = (type === "slide" ? [] : type === "true_false" ? ["Vero", "Falso"] : paddedAnswers(question.answers))
        .map((answer) => String(answer || "").trim())
        .filter(Boolean)
        .slice(0, 6);
      const correctIndexes = type === "slide" ? [] : normalizeCorrectIndexes(question, answers, type);
      const answerImages = type === "true_false" ? [] : normalizeAnswerImages(question.answerImages, answers.length);
      const answerImageLayouts = type === "true_false" || type === "slide" ? [] : normalizeAnswerImageLayouts(question.answerImageLayouts, answers.length);
      return {
        type,
        text: String(question.text || `Domanda ${index + 1}`).trim().slice(0, 240),
        subtitle: String(question.subtitle || "").trim().slice(0, 220),
        imageUrl: normalizeImageUrl(question.imageUrl),
        imageAlt: String(question.imageAlt || "").trim().slice(0, 160),
        imageCredit: String(question.imageCredit || "").trim().slice(0, 80),
        imageCreditUrl: normalizeMediaUrl(question.imageCreditUrl),
        imageProvider: String(question.imageProvider || "").trim().slice(0, 32),
        imagePageUrl: normalizeMediaUrl(question.imagePageUrl),
        videoUrl: type === "slide" ? "" : normalizeMediaUrl(question.videoUrl),
        answers,
        answerImages,
        answerImageLayouts,
        correctIndex: correctIndexes[0] || 0,
        correctIndexes,
        points: type === "slide" ? 0 : normalizeQuestionPoints(question.points),
        timeLimit: Math.min(90, Math.max(5, Math.round(Number(question.timeLimit) || 20)))
      };
    }).filter((question) => question.type === "slide"
      ? Boolean(question.text || question.subtitle || question.imageUrl)
      : question.text && question.answers.length >= 2)
  };
}

function roomToEditableQuiz(room) {
  if (room && room.quiz) return cleanQuiz(room.quiz);
  return cleanQuiz(local.quiz);
}

function paddedAnswers(answers) {
  const result = Array.isArray(answers) ? answers.slice(0, 6) : [];
  while (result.length < 4) result.push("");
  return result;
}

function editableAnswers(question) {
  if (normalizeQuestionType(question.type) === "slide") return [];
  if (normalizeQuestionType(question.type) === "true_false") return ["Vero", "Falso"];
  return paddedAnswers(question.answers);
}

function answerImagesForQuestion(question, count) {
  const source = Array.isArray(question && question.answerImages) ? question.answerImages : [];
  return Array.from({ length: Math.max(0, count) }, (_item, index) => String(source[index] || "").trim().slice(0, 500));
}

function setAnswerImage(question, answerIndex, value) {
  const count = editableAnswers(question).length;
  question.answerImages = answerImagesForQuestion(question, count);
  question.answerImageLayouts = answerImageLayoutsForQuestion(question, count);
  if (answerIndex >= 0 && answerIndex < count) question.answerImages[answerIndex] = String(value || "").trim().slice(0, 500);
}

function answerImageLayoutsForQuestion(question, count) {
  const source = Array.isArray(question && question.answerImageLayouts) ? question.answerImageLayouts : [];
  return Array.from({ length: Math.max(0, count) }, (_item, index) => normalizeAnswerImageLayout(source[index]));
}

function answerImageLayoutForQuestion(question, answerIndex) {
  return answerImageLayoutsForQuestion(question, answerIndex + 1)[answerIndex] || defaultAnswerImageLayout();
}

function updateAnswerImageLayout(question, answerIndex, key, value) {
  const count = editableAnswers(question).length;
  if (answerIndex < 0 || answerIndex >= count) return;
  question.answerImageLayouts = answerImageLayoutsForQuestion(question, count);
  const layout = normalizeAnswerImageLayout(question.answerImageLayouts[answerIndex]);
  if (key === "x") layout.x = clampNumber(value, 0, 100, 50);
  if (key === "y") layout.y = clampNumber(value, 0, 100, 50);
  if (key === "zoom") layout.zoom = clampNumber(value, 1, 3, 1);
  question.answerImageLayouts[answerIndex] = layout;
}

function resetAnswerImageLayout(questionIndex, answerIndex) {
  const question = local.quiz.questions[questionIndex];
  if (!question) return;
  const count = editableAnswers(question).length;
  question.answerImageLayouts = answerImageLayoutsForQuestion(question, count);
  if (answerIndex >= 0 && answerIndex < count) question.answerImageLayouts[answerIndex] = defaultAnswerImageLayout();
  render();
}

function updateAnswerLayoutPreview(question, answerIndex) {
  const imageUrl = normalizeImageUrl(answerImagesForQuestion(question, answerIndex + 1)[answerIndex]);
  if (!imageUrl) return;
  const layout = answerImageLayoutForQuestion(question, answerIndex);
  document.querySelectorAll(".media-dialog .answer-layout-bg").forEach((layer) => {
    layer.setAttribute("style", answerImageStyle(imageUrl, layout));
    const image = layer.querySelector("img");
    if (image) image.setAttribute("style", answerImageImgStyle(layout));
  });
}

function normalizeAnswerImageLayout(layout) {
  const source = layout && typeof layout === "object" ? layout : {};
  return {
    fit: source.fit === "contain" ? "contain" : "cover",
    x: clampNumber(source.x, 0, 100, 50),
    y: clampNumber(source.y, 0, 100, 50),
    zoom: clampNumber(source.zoom, 1, 3, 1)
  };
}

function normalizeAnswerImageLayouts(layouts, count) {
  const source = Array.isArray(layouts) ? layouts : [];
  return Array.from({ length: Math.max(0, count) }, (_item, index) => normalizeAnswerImageLayout(source[index]));
}

function defaultAnswerImageLayout() {
  return { fit: "cover", x: 50, y: 50, zoom: 1 };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeAnswerImages(images, count) {
  const source = Array.isArray(images) ? images : [];
  return Array.from({ length: Math.max(0, count) }, (_item, index) => normalizeImageUrl(source[index]));
}

function normalizeCorrectIndexes(question, answers, type) {
  if (type === "slide") return [];
  const source = Array.isArray(question.correctIndexes) && question.correctIndexes.length
    ? question.correctIndexes
    : [question.correctIndex];
  let indexes = Array.from(new Set(source
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < answers.length)))
    .sort((a, b) => a - b);
  if (!indexes.length) indexes = [0];
  if (type === "multiple_select" && indexes.length < 2 && answers.length >= 2) {
    const fallback = answers.findIndex((_answer, index) => !indexes.includes(index));
    indexes = Array.from(new Set([...indexes, fallback >= 0 ? fallback : 0])).sort((a, b) => a - b);
  }
  return type === "multiple_select" ? indexes : [indexes[0]];
}

function correctIndexesForQuestion(question, answers) {
  return normalizeCorrectIndexes(question, answers, normalizeQuestionType(question.type));
}

function normalizeQuestionPoints(value) {
  const points = Math.round(Number(value) || 0);
  return [0, 250, 500, 750, 1000, 1500].includes(points) ? points : 0;
}

function selectionCount(question) {
  if (normalizeQuestionType(question.type) === "slide") return 0;
  if (Number.isInteger(question.selectionCount) && question.selectionCount > 0) return question.selectionCount;
  const answers = Array.isArray(question.answers) ? question.answers : [];
  return normalizeQuestionType(question.type) === "multiple_select"
    ? correctIndexesForQuestion(question, answers).length
    : 1;
}

function parseTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,;]+/);
  return Array.from(new Set(raw
    .map((tag) => String(tag || "").trim().slice(0, 24))
    .filter(Boolean)))
    .slice(0, 8);
}

function normalizeImageUrl(value) {
  const raw = String(value || "").trim().slice(0, 500);
  if (!raw) return "";
  if (/^\/api\/media\/[a-zA-Z0-9_-]{8,80}$/.test(raw)) return raw;
  return normalizeMediaUrl(raw);
}

function normalizeMediaUrl(value) {
  const raw = String(value || "").trim().slice(0, 500);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch (error) {
    return "";
  }
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeQuestionType(type) {
  const key = String(type || "multiple").trim().toLowerCase().replace(/[\/\s]+/g, "_").replace(/-/g, "_");
  if (key === "vero_falso" || key === "verofalso" || key === "true_false" || key === "truefalse") return "true_false";
  if (key === "veloce" || key === "risposta_veloce" || key === "speed" || key === "fast") return "speed";
  if (key === "risposte_multiple" || key === "risposta_multipla" || key === "multiple_select" || key === "multi_select" || key === "multiple_correct") return "multiple_select";
  if (key === "slide" || key === "diapositiva" || key === "titolo") return "slide";
  if (key === "multipla" || key === "scelta_multipla") return "multiple";
  return "multiple";
}

function questionTypeLabel(type) {
  const found = questionTypes.find((item) => item.value === normalizeQuestionType(type));
  return found ? found.label : "Scelta multipla";
}

function secondsLeft(room) {
  if (!room.questionEndsAt) return 0;
  return Math.max(0, Math.ceil((room.questionEndsAt - Date.now()) / 1000));
}

function timeProgressPercent(room) {
  return countdownPercent(room.questionEndsAt, room.question ? room.question.timeLimit : 0);
}

function countdownPercent(endsAt, timeLimit) {
  const duration = Math.max(1, Number(timeLimit) || 1) * 1000;
  const remaining = Math.max(0, Number(endsAt || 0) - Date.now());
  return Math.max(0, Math.min(100, Math.round((remaining / duration) * 1000) / 10));
}

function updateLiveTimers() {
  document.querySelectorAll("[data-countdown]").forEach((element) => {
    const endsAt = Number(element.dataset.endsAt || 0);
    const timeLimit = Number(element.dataset.timeLimit || 0);
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const percent = countdownPercent(endsAt, timeLimit);
    const timer = element.querySelector("[data-timer]");
    const bar = element.querySelector("[data-time-bar]");
    if (timer && timer.textContent !== String(left)) timer.textContent = String(left);
    if (bar) bar.style.width = `${percent}%`;
    element.classList.toggle("urgent", left <= 5);
  });
}

function updateFiftyTimers() {
  if (document.querySelector(".screen-fifty-result") && local.room && !recentFiftyResult(local.room)) {
    render();
    return;
  }

  document.querySelectorAll("[data-fifty-countdown]").forEach((element) => {
    const pressStartsAt = Number(element.dataset.pressStartsAt || 0);
    const endsAt = Number(element.dataset.endsAt || 0);
    const now = Date.now();
    if (pressStartsAt && now < pressStartsAt) {
      const left = Math.max(1, Math.ceil((pressStartsAt - now) / 1000));
      element.textContent = left > 1 ? String(left) : "Spingi!";
      element.classList.remove("active");
      return;
    }
    const left = Math.max(0, Math.ceil((endsAt - now) / 1000));
    element.textContent = `${left}s`;
    element.classList.add("active");
  });

  document.querySelectorAll("[data-fifty-hold]").forEach((button) => {
    const pressStartsAt = Number(button.dataset.pressStartsAt || 0);
    const endsAt = Number(button.dataset.endsAt || 0);
    const now = Date.now();
    const active = pressStartsAt && endsAt && now >= pressStartsAt && now <= endsAt;
    button.disabled = !active;
    if (!active && now < pressStartsAt) {
      button.textContent = "Preparati...";
    } else if (active && !button.classList.contains("holding")) {
      button.textContent = "Tieni premuto ora";
    }
    const help = button.parentElement ? button.parentElement.querySelector("[data-fifty-help]") : null;
    if (help && active) help.textContent = "Conta solo lo stato del tuo dito alla fine dei 5 secondi.";
  });

  document.querySelectorAll("[data-screen-fifty-timer]").forEach((element) => {
    const pressStartsAt = Number(element.dataset.pressStartsAt || 0);
    const endsAt = Number(element.dataset.endsAt || 0);
    const now = Date.now();
    if (pressStartsAt && now < pressStartsAt) {
      const left = Math.max(1, Math.ceil((pressStartsAt - now) / 1000));
      element.textContent = left > 1 ? String(left) : "Spingi!";
      return;
    }
    element.textContent = `${Math.max(0, Math.ceil((endsAt - now) / 1000))}s`;
  });
}

function statusLabel(status) {
  const labels = {
    lobby: "Lobby",
    question: "Domanda",
    reveal: "Risultati",
    ended: "Finale"
  };
  return labels[status] || status;
}

function initialMode() {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("host")) return "host";
  if (hash.startsWith("screen")) return "screen";
  return "join";
}

function initialJoinCode() {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("join") || params.get("code") || "";
  const fromHash = hash.startsWith("join=") ? hash.slice(5) : "";
  return String(fromHash || fromQuery).replace(/\D/g, "").slice(0, 6);
}

function initialNickname() {
  const session = loadPlayerSession();
  return session && session.nickname ? session.nickname : "";
}

function loadPlayerSession() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PLAYER_SESSION_STORAGE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    const code = String(parsed.code || "").replace(/\D/g, "").slice(0, 6);
    const sessionToken = String(parsed.sessionToken || "").trim();
    if (code.length !== 6 || !/^[a-f0-9]{48}$/i.test(sessionToken)) return null;
    return {
      code,
      sessionToken: sessionToken.toLowerCase(),
      nickname: String(parsed.nickname || "").trim().slice(0, 24)
    };
  } catch (error) {
    return null;
  }
}

function savePlayerSession(code, nickname, sessionToken) {
  const normalizedCode = String(code || "").replace(/\D/g, "").slice(0, 6);
  const normalizedToken = String(sessionToken || "").trim().toLowerCase();
  if (normalizedCode.length !== 6 || !/^[a-f0-9]{48}$/i.test(normalizedToken)) return;
  local.playerSession = {
    code: normalizedCode,
    nickname: String(nickname || local.nickname || "").trim().slice(0, 24),
    sessionToken: normalizedToken
  };
  local.joinCode = normalizedCode;
  local.nickname = local.playerSession.nickname;
  try {
    window.localStorage.setItem(PLAYER_SESSION_STORAGE_KEY, JSON.stringify(local.playerSession));
  } catch (error) {
    // Session restore is optional when storage is unavailable.
  }
}

function clearPlayerSession() {
  local.playerSession = null;
  try {
    window.localStorage.removeItem(PLAYER_SESSION_STORAGE_KEY);
  } catch (error) {
    // Nothing else to do.
  }
}

function sessionTokenForCode(code) {
  const normalizedCode = String(code || "").replace(/\D/g, "").slice(0, 6);
  return local.playerSession && local.playerSession.code === normalizedCode
    ? local.playerSession.sessionToken
    : "";
}

function initialScreenCode() {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("screen") || "";
  const fromHash = hash.startsWith("screen=") ? hash.slice(7) : "";
  return String(fromHash || fromQuery).replace(/\D/g, "").slice(0, 6);
}

function playerLink(code) {
  return `${playerBaseUrl()}/#join=${encodeURIComponent(code || "")}`;
}

function screenLink(code) {
  return `${playerBaseUrl()}/#screen=${encodeURIComponent(code || "")}`;
}

function qrCodeSrc(code) {
  return `/api/qr.svg?url=${encodeURIComponent(playerLink(code))}`;
}

function playerBaseUrl() {
  return local.playerBaseUrl || window.location.origin;
}

function playerBaseLabel() {
  try {
    const url = new URL(playerBaseUrl());
    const prefix = local.playerAccessMode === "public" ? "Pubblico" : "Solo Wi-Fi";
    return `${prefix}: ${url.host}`;
  } catch (error) {
    return "Telefono";
  }
}

function playerAccessNotice() {
  if (local.playerAccessMode === "public") {
    return "Questo QR usa un URL pubblico.";
  }
  return "Questo QR funziona solo sulla stessa Wi-Fi.";
}

function playerAccessClass() {
  return local.playerAccessMode === "public" ? "public" : "local";
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch (error) {
    return "-";
  }
}

function choosePlayerBaseUrl(config) {
  if (config && config.publicOrigin) {
    return config.publicOrigin;
  }
  if (isLoopbackHost(window.location.hostname) && config && config.preferredOrigin) {
    return config.preferredOrigin;
  }
  return window.location.origin;
}

function choosePlayerAccessMode(config) {
  if (config && config.accessMode) return config.accessMode;
  return accessModeForOrigin(playerBaseUrl());
}

function accessModeForOrigin(origin) {
  try {
    const hostname = new URL(origin).hostname;
    if (isLoopbackHost(hostname) || isPrivateIPv4(hostname) || hostname.endsWith(".local")) {
      return "local";
    }
    return "public";
  } catch (error) {
    return "same-origin";
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateIPv4(address) {
  return /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function fallbackCopy(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "readonly");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    copied = false;
  }
  document.body.removeChild(field);
  return copied;
}

function letterClass(index) {
  return ["a", "b", "c", "d", "e", "f"][index] || "a";
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function handleLiveEvent(event) {
  if (!event || typeof event !== "object") return;
  clearTimeout(liveEventTimer);
  local.liveEvent = {
    private: Boolean(event.private),
    title: String(event.title || "QuizLive").slice(0, 80),
    message: String(event.message || "").slice(0, 180),
    tone: String(event.tone || "spark").slice(0, 24),
    vibrate: Boolean(event.vibrate),
    vibrationPattern: Array.isArray(event.vibrationPattern) ? event.vibrationPattern : []
  };
  playLiveSound(local.liveEvent.tone);
  if (local.liveEvent.vibrate) runLiveVibration(local.liveEvent.vibrationPattern);
  render();
  liveEventTimer = setTimeout(() => {
    local.liveEvent = null;
    render();
  }, local.liveEvent.private ? 5600 : 4300);
}

function primeLiveAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    if (!liveAudioContext) liveAudioContext = new AudioContextClass();
    if (liveAudioContext.state === "suspended") {
      liveAudioContext.resume().catch(() => {});
    }
    return liveAudioContext;
  } catch (error) {
    return null;
  }
}

function playLiveSound(tone) {
  const context = primeLiveAudio();
  if (!context) return;
  try {
    const master = context.createGain();
    master.gain.value = 0.11;
    master.connect(context.destination);
    const now = context.currentTime + 0.025;
    liveToneSequence(tone).forEach((note) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = note.type || "sine";
      oscillator.frequency.setValueAtTime(note.frequency, now + note.start);
      gain.gain.setValueAtTime(0.001, now + note.start);
      gain.gain.linearRampToValueAtTime(note.volume || 0.2, now + note.start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.001, now + note.start + note.duration);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(now + note.start);
      oscillator.stop(now + note.start + note.duration + 0.05);
    });
    setTimeout(() => master.disconnect(), 1400);
  } catch (error) {
    // Audio can be blocked by the browser until the user taps the page.
  }
}

function liveToneSequence(tone) {
  if (tone === "drum") {
    return [
      { frequency: 124, start: 0, duration: 0.16, volume: 0.34, type: "triangle" },
      { frequency: 82, start: 0.18, duration: 0.24, volume: 0.32, type: "triangle" }
    ];
  }
  if (tone === "success") {
    return [
      { frequency: 523, start: 0, duration: 0.12, volume: 0.18 },
      { frequency: 659, start: 0.13, duration: 0.12, volume: 0.18 },
      { frequency: 784, start: 0.26, duration: 0.18, volume: 0.2 }
    ];
  }
  if (tone === "alert") {
    return [
      { frequency: 880, start: 0, duration: 0.12, volume: 0.17, type: "square" },
      { frequency: 660, start: 0.15, duration: 0.12, volume: 0.16, type: "square" },
      { frequency: 880, start: 0.3, duration: 0.15, volume: 0.17, type: "square" }
    ];
  }
  if (tone === "secret") {
    return [
      { frequency: 392, start: 0, duration: 0.14, volume: 0.13 },
      { frequency: 523, start: 0.16, duration: 0.2, volume: 0.12 }
    ];
  }
  return [
    { frequency: 740, start: 0, duration: 0.13, volume: 0.15 },
    { frequency: 988, start: 0.14, duration: 0.18, volume: 0.16 }
  ];
}

function runLiveVibration(pattern) {
  if (!navigator.vibrate) return;
  const normalized = (Array.isArray(pattern) ? pattern : [70, 35, 110])
    .map((item) => Math.min(600, Math.max(20, Math.round(Number(item) || 0))))
    .filter(Boolean)
    .slice(0, 8);
  if (normalized.length) navigator.vibrate(normalized);
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function defaultQuiz() {
  return {
    title: "Demo QuizLive",
    description: "Quiz dimostrativo per provare host, telefoni e monitor pubblico.",
    subject: "Tecnologia",
    level: "Demo",
    language: "Italiano",
    folder: "Demo",
    visibility: "private",
    tags: ["demo", "live"],
    teamMode: false,
    questions: [
      {
        type: "multiple",
        text: "Quale tecnologia permette risposte live tra host e telefoni?",
        answers: ["WebSocket", "Solo email", "PDF", "Bluetooth spento"],
        correctIndex: 0,
        timeLimit: 20
      },
      {
        type: "speed",
        text: "Quale formato e comodo per esportare risultati in un foglio di calcolo?",
        answers: ["XLSX", "PNG", "MP3", "MOV"],
        correctIndex: 0,
        timeLimit: 12
      },
      {
        type: "true_false",
        text: "I giocatori entrano con codice stanza e nickname.",
        answers: ["Vero", "Falso"],
        correctIndex: 0,
        timeLimit: 15
      },
      {
        type: "multiple_select",
        text: "Quali schermate sono pensate per il pubblico?",
        answers: ["Monitor", "Classifica", "Password host", "Domanda live"],
        correctIndexes: [0, 1, 3],
        timeLimit: 18
      }
    ]
  };
}
