const assert = require("node:assert/strict");
const { io } = require("socket.io-client");

const serverUrl = process.env.SERVER_URL || "http://127.0.0.1:3000";
const expectedArchive = process.env.EXPECTED_ARCHIVE || "";
const hostPassword = process.env.HOST_PASSWORD || "";
let authCookie = "";
const tinyPngDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const quiz = {
  title: "Smoke Test",
  subject: "Science",
  level: "Grade 7",
  language: "English",
  folder: "Smoke Library",
  visibility: "public",
  tags: ["smoke", "team"],
  teamMode: true,
  questions: [
    {
      type: "speed",
      text: "Ready?",
      imageUrl: "https://example.com/ready.png",
      answers: ["Yes", "No", "Maybe", "Later"],
      answerImages: [],
      correctIndex: 0,
      timeLimit: 8
    },
    {
      type: "slide",
      text: "New topic",
      subtitle: "A transition slide for the room",
      imageUrl: "",
      answers: [],
      timeLimit: 8
    },
    {
      type: "multiple_select",
      text: "Pick the live parts",
      answers: ["Host", "Phone", "Wallpaper", "Public screen"],
      answerImages: [],
      correctIndexes: [0, 1, 3],
      timeLimit: 8
    }
  ]
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const health = await getJson("/api/health");
  assert.equal(health.ok, true);
  if (expectedArchive) assert.equal(health.archive, expectedArchive);

  await ensureHostAccess();

  const host = createSocket(true);
  const screen = createSocket(false);
  let player = createSocket(false);
  const decliningPlayer = createSocket(false);

  try {
    await Promise.all([waitForConnect(host), waitForConnect(screen), waitForConnect(player), waitForConnect(decliningPlayer)]);
    host.on("room:state", (state) => {
      host.latestState = state;
    });
    screen.on("room:state", (state) => {
      screen.latestState = state;
    });
    screen.on("screen:waiting", () => {
      screen.waitingEvents = (screen.waitingEvents || 0) + 1;
    });
    player.on("room:state", (state) => {
      player.latestState = state;
    });
    decliningPlayer.on("room:state", (state) => {
      decliningPlayer.latestState = state;
    });

    const uploadedMedia = await postJson("/api/media", { file: tinyPngDataUrl, filename: "tiny.png" });
    assert.equal(uploadedMedia.ok, true);
    assert.match(uploadedMedia.url, /^\/api\/media\/media-/);
    const uploadedMediaBinary = await getBinary(uploadedMedia.url);
    assert.ok(uploadedMediaBinary.length > 0);
    quiz.questions[0].imageUrl = uploadedMedia.url;
    quiz.questions[0].imageAlt = "Tiny smoke image";
    quiz.questions[0].imageCredit = "Smoke Photographer";
    quiz.questions[0].imageCreditUrl = "https://www.pexels.com/@smoke";
    quiz.questions[0].imageProvider = "Pexels";
    quiz.questions[0].imagePageUrl = "https://www.pexels.com/photo/smoke-test-123/";
    quiz.questions[0].answerImages = [uploadedMedia.url, "", "", ""];
    quiz.questions[1].imageUrl = uploadedMedia.url;
    quiz.questions[2].answerImages = [uploadedMedia.url, "", "", uploadedMedia.url];

    const imageSearch = await postJsonRaw("/api/images/search", {
      quiz: { subject: "Geografia" },
      question: {
        text: "Quale pianeta e conosciuto come pianeta rosso nel sistema solare?",
        answers: ["Venere", "Marte", "Giove", "Saturno"],
        correctIndex: 1
      }
    });
    assert.match(imageSearch.data.query, /geografia/);
    assert.match(imageSearch.data.query, /pianeta/);
    assert.match(imageSearch.data.query, /marte/);
    if (imageSearch.status === 501) {
      assert.match(imageSearch.data.error, /PEXELS_API_KEY/);
    } else {
      assert.equal(imageSearch.status, 200);
      assert.equal(imageSearch.data.ok, true);
      assert.equal(imageSearch.data.provider, "pexels");
      assert.ok(Array.isArray(imageSearch.data.images));
    }

    const generatedImageDryRun = await postJsonRaw("/api/images/generate", {
      dryRun: true,
      quiz: { subject: "Geografia", level: "Scuola media", language: "Italiano" },
      question: {
        text: "Quale pianeta e conosciuto come pianeta rosso nel sistema solare?",
        answers: ["Venere", "Marte", "Giove", "Saturno"],
        correctIndex: 1
      }
    });
    assert.equal(generatedImageDryRun.status, 200);
    assert.equal(generatedImageDryRun.data.ok, true);
    assert.equal(generatedImageDryRun.data.provider, "cloudflare");
    assert.match(generatedImageDryRun.data.model, /flux-1-schnell/);
    assert.match(generatedImageDryRun.data.prompt, /Geografia/);
    assert.match(generatedImageDryRun.data.prompt, /pianeta rosso/);
    assert.match(generatedImageDryRun.data.prompt, /Marte/);

    const generatedAnswerImageDryRun = await postJsonRaw("/api/images/generate", {
      dryRun: true,
      quiz: { subject: "Geografia", level: "Scuola media", language: "Italiano" },
      question: {
        text: "Quale pianeta e conosciuto come pianeta rosso nel sistema solare?",
        answers: ["Venere", "Marte", "Giove", "Saturno"],
        correctIndex: 1
      },
      answerText: "Marte",
      answerIndex: 1
    });
    assert.equal(generatedAnswerImageDryRun.status, 200);
    assert.equal(generatedAnswerImageDryRun.data.ok, true);
    assert.match(generatedAnswerImageDryRun.data.prompt, /opzione di risposta/i);
    assert.match(generatedAnswerImageDryRun.data.prompt, /Soggetto principale e unico dell'immagine: Marte/);
    assert.match(generatedAnswerImageDryRun.data.prompt, /Opzione del tasto da rappresentare: Marte/);

    const screenWatching = await emitAck(screen, "screen:watch", {});
    assert.equal(screenWatching.ok, true);
    assert.equal(screenWatching.waiting, true);

    const savedQuiz = await postJson("/api/archive/quizzes", { quiz });
    assert.equal(savedQuiz.ok, true);
    assert.equal(savedQuiz.quiz.title, quiz.title);

    const exportedQuizXlsx = await postBinary("/api/quiz/export.xlsx", { quiz });
    assert.ok(exportedQuizXlsx.length > 1000);
    const importedQuiz = await postJson("/api/quiz/import.xlsx", {
      file: exportedQuizXlsx.toString("base64")
    });
    assert.equal(importedQuiz.ok, true);
    assert.equal(importedQuiz.quiz.title, quiz.title);
    assert.equal(importedQuiz.quiz.subject, "Science");
    assert.equal(importedQuiz.quiz.level, "Grade 7");
    assert.equal(importedQuiz.quiz.language, "English");
    assert.equal(importedQuiz.quiz.folder, "Smoke Library");
    assert.equal(importedQuiz.quiz.visibility, "public");
    assert.deepEqual(importedQuiz.quiz.tags, ["smoke", "team"]);
    assert.equal(importedQuiz.quiz.teamMode, true);
    assert.equal(importedQuiz.quiz.questions[0].type, "speed");
    assert.equal(importedQuiz.quiz.questions[0].answers[0], "Yes");
    assert.equal(importedQuiz.quiz.questions[0].answerImages[0], uploadedMedia.url);
    assert.equal(importedQuiz.quiz.questions[0].imageUrl, uploadedMedia.url);
    assert.equal(importedQuiz.quiz.questions[0].imageCredit, "Smoke Photographer");
    assert.equal(importedQuiz.quiz.questions[0].imageProvider, "Pexels");
    assert.equal(importedQuiz.quiz.questions[1].type, "slide");
    assert.equal(importedQuiz.quiz.questions[1].subtitle, "A transition slide for the room");
    assert.equal(importedQuiz.quiz.questions[1].answers.length, 0);
    assert.equal(importedQuiz.quiz.questions[2].type, "multiple_select");
    assert.deepEqual(importedQuiz.quiz.questions[2].correctIndexes, [0, 1, 3]);

    const templateXlsx = await getBinary("/api/quiz-template.xlsx");
    assert.ok(templateXlsx.length > 1000);

    const archive = await getJson("/api/archive/quizzes");
    const archivedQuiz = archive.quizzes.find((item) => item.id === savedQuiz.quiz.id);
    assert.ok(archivedQuiz);
    assert.equal(archivedQuiz.visibility, "public");
    assert.equal(archivedQuiz.folder, "Smoke Library");

    const created = await emitAck(host, "host:create", { quiz });
    assert.equal(created.ok, true);
    assert.match(created.code, /^\d{6}$/);

    await waitForState(host, (state) => state.role === "host" && state.status === "lobby");

    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "lobby" &&
      state.code === created.code &&
      !state.players &&
      !state.exports
    );

    const joined = await emitAck(player, "player:join", {
      code: created.code,
      nickname: "Smoke Player"
    });
    assert.equal(joined.ok, true);
    assert.match(joined.sessionToken, /^[a-f0-9]{48}$/);

    const decliningJoined = await emitAck(decliningPlayer, "player:join", {
      code: created.code,
      nickname: "Smoke Decliner"
    });
    assert.equal(decliningJoined.ok, true);

    await waitForState(host, (state) =>
      state.role === "host" &&
      Array.isArray(state.players) &&
      state.players.some((item) => item.nickname === "Smoke Player") &&
      state.players.some((item) => item.nickname === "Smoke Decliner") &&
      state.players.every((item) => item.team) &&
      Array.isArray(state.teamLeaderboard) &&
      state.teamLeaderboard.length === 2
    );

    const publicPlayerEvent = waitForSocketEvent(player, "live:event");
    const publicScreenEvent = waitForSocketEvent(screen, "live:event");
    const publicLiveSent = await emitAck(host, "host:live-event", {
      type: "message",
      target: "all",
      message: "Occhio al bonus live",
      tone: "spark",
      vibrate: true
    });
    assert.equal(publicLiveSent.ok, true);
    assert.ok(publicLiveSent.delivered >= 2);
    const receivedPublicPlayerEvent = await publicPlayerEvent;
    const receivedPublicScreenEvent = await publicScreenEvent;
    assert.equal(receivedPublicPlayerEvent.message, "Occhio al bonus live");
    assert.equal(receivedPublicPlayerEvent.vibrate, true);
    assert.equal(receivedPublicScreenEvent.message, "Occhio al bonus live");

    const privatePlayerEvent = waitForSocketEvent(player, "live:event");
    const privateLiveSent = await emitAck(host, "host:live-event", {
      type: "message",
      target: "player",
      playerId: joined.playerId,
      message: "Messaggio segreto smoke",
      tone: "secret"
    });
    assert.equal(privateLiveSent.ok, true);
    assert.equal(privateLiveSent.delivered, 1);
    const receivedPrivatePlayerEvent = await privatePlayerEvent;
    assert.equal(receivedPrivatePlayerEvent.private, true);
    assert.equal(receivedPrivatePlayerEvent.message, "Messaggio segreto smoke");

    const started = await emitAck(host, "host:start", {});
    assert.equal(started.ok, true);

    await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "question" &&
      state.question &&
      state.question.type === "speed" &&
      state.question.answers.length === 4 &&
      state.question.answers[0].imageUrl === uploadedMedia.url
    );
    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "question" &&
      state.question &&
      state.question.answers.length === 4 &&
      state.question.answers[0].imageUrl === uploadedMedia.url &&
      state.question.answers.every((answer) => answer.correct === undefined && answer.count === undefined)
    );

    const answered = await emitAck(player, "player:answer", { answerIndex: 0 });
    assert.equal(answered.ok, true);
    assert.equal(answered.correct, true);

    await waitForState(host, (state) => state.status === "question" && state.answerCount === 1);

    player.close();
    await waitForState(host, (state) =>
      state.status === "question" &&
      state.players.some((item) => item.nickname === "Smoke Player" && item.connected === false)
    );

    const rejoinedPlayer = createSocket(false);
    await waitForConnect(rejoinedPlayer);
    rejoinedPlayer.on("room:state", (state) => {
      rejoinedPlayer.latestState = state;
    });
    const rejoined = await emitAck(rejoinedPlayer, "player:join", {
      code: created.code,
      nickname: "Smoke Player",
      sessionToken: joined.sessionToken
    });
    assert.equal(rejoined.ok, true);
    assert.equal(rejoined.rejoined, true);
    assert.notEqual(rejoined.playerId, joined.playerId);
    player = rejoinedPlayer;

    await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "question" &&
      state.question &&
      state.question.answered === true
    );
    await waitForState(host, (state) =>
      state.status === "question" &&
      state.answerCount === 1 &&
      state.players.filter((item) => item.nickname === "Smoke Player").length === 1 &&
      state.players.some((item) => item.nickname === "Smoke Player" && item.connected === true)
    );

    const revealed = await emitAck(host, "host:reveal", {});
    assert.equal(revealed.ok, true);

    const playerReveal = await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "reveal" &&
      state.question &&
      state.question.playerAnswer &&
      state.question.playerAnswer.correct === true
    );
    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "reveal" &&
      state.question &&
      state.question.answers.some((answer) => answer.correct === true && answer.count === 1)
    );

    const wagerOfferEvent = waitForSocketEvent(player, "live:event");
    const wagerOffer = await emitAck(host, "host:wager-offer", {
      playerId: rejoined.playerId,
      stake: 100
    });
    assert.equal(wagerOffer.ok, true);
    assert.equal(wagerOffer.wager.stake, 100);
    assert.equal(wagerOffer.wager.questionNumber, 3);
    const receivedWagerOffer = await wagerOfferEvent;
    assert.equal(receivedWagerOffer.title, "Scommessa live");

    const playerWagerState = await waitForState(player, (state) =>
      state.wagerOffer &&
      state.wagerOffer.id === wagerOffer.wager.id &&
      state.wagerOffer.eligibleTargets.some((item) => item.nickname === "Smoke Decliner")
    );
    const chosenTarget = playerWagerState.wagerOffer.eligibleTargets.find((item) => item.nickname === "Smoke Decliner");
    assert.ok(chosenTarget);

    const wagerAcceptedEvent = waitForSocketEvent(screen, "live:event");
    const acceptedWager = await emitAck(player, "player:wager-response", {
      wagerId: wagerOffer.wager.id,
      accept: true,
      mode: "chosen",
      targetPlayerId: chosenTarget.id
    });
    assert.equal(acceptedWager.ok, true);
    assert.equal(acceptedWager.accepted, true);
    assert.equal(acceptedWager.wager.multiplier, 2);
    const receivedWagerAccepted = await wagerAcceptedEvent;
    assert.equal(receivedWagerAccepted.title, "Scommessa accettata");

    await waitForState(host, (state) =>
      state.wagers &&
      state.wagers.active &&
      state.wagers.active.some((item) => item.bettorNickname === "Smoke Player" && item.targetNickname === "Smoke Decliner")
    );

    const nextSlide = await emitAck(host, "host:next", {});
    assert.equal(nextSlide.ok, true);

    await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "question" &&
      state.question &&
      state.question.type === "slide" &&
      state.question.subtitle === "A transition slide for the room" &&
      state.question.answers.length === 0
    );
    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "question" &&
      state.question &&
      state.question.type === "slide" &&
      state.question.answers.length === 0
    );

    const nextQuestion = await emitAck(host, "host:next", {});
    assert.equal(nextQuestion.ok, true);

    await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "question" &&
      state.question &&
      state.question.type === "multiple_select" &&
      state.question.selectionCount === 3 &&
      state.question.answers[3].imageUrl === uploadedMedia.url
    );

    const incompleteMultiAnswered = await emitAck(player, "player:answer", { answerIndexes: [0, 1] });
    assert.equal(incompleteMultiAnswered.ok, false);

    const multiAnswered = await emitAck(player, "player:answer", { answerIndexes: [0, 1, 3] });
    assert.equal(multiAnswered.ok, true);
    assert.equal(multiAnswered.correct, true);

    const wagerResultEvent = waitForSocketEvent(screen, "live:event");
    const wrongMultiAnswered = await emitAck(decliningPlayer, "player:answer", { answerIndexes: [0, 2, 3] });
    assert.equal(wrongMultiAnswered.ok, true);
    assert.equal(wrongMultiAnswered.correct, false);
    assert.equal(wrongMultiAnswered.partial, true);
    assert.ok(wrongMultiAnswered.points > 0);
    const receivedWagerResult = await wagerResultEvent;
    assert.equal(receivedWagerResult.title, "Scommessa persa");

    await waitForState(host, (state) =>
      state.wagers &&
      state.wagers.active &&
      state.wagers.active.length === 0 &&
      state.wagers.history &&
      state.wagers.history.some((item) =>
        item.bettorNickname === "Smoke Player" &&
        item.delta === -100 &&
        item.questionIndex === 2
      )
    );

    await waitForState(screen, (state) =>
      state.wagerHistory &&
      state.wagerHistory.some((item) =>
        item.bettorNickname === "Smoke Player" &&
        item.targetNickname === "Smoke Decliner" &&
        item.delta === -100 &&
        item.questionIndex === 2
      )
    );

    const fiftyPlayerEvent = waitForSocketEvent(player, "live:event");
    const fiftyDeclinerEvent = waitForSocketEvent(decliningPlayer, "live:event");
    const fiftyStarted = await emitAck(host, "host:fifty-start", {
      stake: 50,
      countdownMs: 300,
      durationMs: 700
    });
    assert.equal(fiftyStarted.ok, true);
    assert.equal(fiftyStarted.challenge.pot, 100);
    assert.equal(fiftyStarted.challenge.status, "intro");
    assert.equal((await fiftyPlayerEvent).title, "50 e 50");
    assert.equal((await fiftyDeclinerEvent).title, "50 e 50");

    const playerReady = await emitAck(player, "player:fifty-ready", {
      challengeId: fiftyStarted.challenge.id
    });
    assert.equal(playerReady.ok, true);

    const declinerReady = await emitAck(decliningPlayer, "player:fifty-ready", {
      challengeId: fiftyStarted.challenge.id
    });
    assert.equal(declinerReady.ok, true);

    await waitForState(screen, (state) =>
      state.activeFifty &&
      state.activeFifty.id === fiftyStarted.challenge.id &&
      state.activeFifty.status === "countdown" &&
      state.activeFifty.players.every((item) => item.ready === true)
    );
    await waitForState(player, (state) =>
      state.fiftyChallenge &&
      state.fiftyChallenge.id === fiftyStarted.challenge.id &&
      state.fiftyChallenge.status === "active"
    );

    const fiftyResultEvent = waitForSocketEvent(screen, "live:event");
    const fiftyHold = await emitAck(player, "player:fifty-hold", {
      challengeId: fiftyStarted.challenge.id,
      holding: true
    });
    assert.equal(fiftyHold.ok, true);

    await waitForState(player, (state) =>
      state.fiftyChallenge &&
      state.fiftyChallenge.id === fiftyStarted.challenge.id &&
      state.fiftyChallenge.status === "active" &&
      state.fiftyChallenge.holding === true
    );

    const fiftyResult = await fiftyResultEvent;
    assert.equal(fiftyResult.title, "50 e 50 risolto");

    await waitForState(host, (state) =>
      state.fifty &&
      state.fifty.history &&
      state.fifty.history.some((item) =>
        item.id === fiftyStarted.challenge.id &&
        item.outcome === "drop_win" &&
        item.winnerNickname === "Smoke Decliner"
      )
    );

    const disconnectFiftyStarted = await emitAck(host, "host:fifty-start", {
      stake: 1,
      countdownMs: 300,
      durationMs: 700
    });
    assert.equal(disconnectFiftyStarted.ok, true);

    const disconnectPlayerReady = await emitAck(player, "player:fifty-ready", {
      challengeId: disconnectFiftyStarted.challenge.id
    });
    assert.equal(disconnectPlayerReady.ok, true);

    const disconnectDeclinerReady = await emitAck(decliningPlayer, "player:fifty-ready", {
      challengeId: disconnectFiftyStarted.challenge.id
    });
    assert.equal(disconnectDeclinerReady.ok, true);

    await waitForState(player, (state) =>
      state.fiftyChallenge &&
      state.fiftyChallenge.id === disconnectFiftyStarted.challenge.id &&
      state.fiftyChallenge.status === "active"
    );

    const disconnectFiftyResultEvent = waitForSocketEvent(screen, "live:event");
    const reconnectHold = await emitAck(player, "player:fifty-hold", {
      challengeId: disconnectFiftyStarted.challenge.id,
      holding: true
    });
    assert.equal(reconnectHold.ok, true);
    decliningPlayer.disconnect();
    await waitForCondition(() => !decliningPlayer.connected, "Timeout waiting for player disconnect");

    const disconnectFiftyResult = await disconnectFiftyResultEvent;
    assert.equal(disconnectFiftyResult.title, "50 e 50 risolto");

    await waitForState(host, (state) =>
      state.fifty &&
      state.fifty.history &&
      state.fifty.history.some((item) =>
        item.id === disconnectFiftyStarted.challenge.id &&
        item.outcome === "forfeit" &&
        item.winnerNickname === "Smoke Player" &&
        item.players.some((playerResult) => playerResult.nickname === "Smoke Decliner" && playerResult.left === true)
      )
    );

    decliningPlayer.connect();
    await waitForConnect(decliningPlayer);
    const rejoinedDecliner = await emitAck(decliningPlayer, "player:join", {
      code: created.code,
      nickname: "Smoke Decliner",
      sessionToken: decliningJoined.sessionToken
    });
    assert.equal(rejoinedDecliner.ok, true);
    assert.equal(rejoinedDecliner.rejoined, true);

    const multiReveal = await emitAck(host, "host:reveal", {});
    assert.equal(multiReveal.ok, true);

    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "reveal" &&
      state.question &&
      state.question.type === "multiple_select" &&
      state.question.answers.filter((answer) => answer.correct === true).length === 3 &&
      state.question.answers.some((answer) => answer.index === 2 && answer.count === 1) &&
      state.question.answers.some((answer) => answer.correct === false)
    );

    const ended = await emitAck(host, "host:next", {});
    assert.equal(ended.ok, true);

    await waitForState(host, (state) =>
      state.status === "ended" &&
      Array.isArray(state.questionSummaries) &&
      state.questionSummaries.length === quiz.questions.length &&
      state.questionSummaries.some((item) => item.stats && item.stats.partialCount === 1)
    );
    await waitForState(screen, (state) => state.status === "ended" && state.leaderboard.length >= 1);

    const liveResultXlsx = await getBinary(`/api/rooms/${created.code}/export/results.xlsx`);
    assert.ok(liveResultXlsx.length > 1000);

    screen.waitingEvents = 0;
    const releasedScreens = await emitAck(host, "host:release-screens", {});
    assert.equal(releasedScreens.ok, true);
    assert.equal(releasedScreens.released, 1);
    await waitForCondition(() => screen.waitingEvents >= 1, "Timeout waiting for screen waiting state");

    const reset = await emitAck(host, "host:reset", {});
    assert.equal(reset.ok, true);
    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "lobby" &&
      state.code === created.code
    );

    await waitForState(player, (state) =>
      state.status === "lobby" &&
      state.player &&
      state.player.rematch === "pending" &&
      state.player.active === false
    );
    await waitForState(decliningPlayer, (state) =>
      state.status === "lobby" &&
      state.player &&
      state.player.rematch === "pending" &&
      state.player.active === false
    );
    await waitForState(host, (state) =>
      state.status === "lobby" &&
      state.playerCount === 0 &&
      state.pendingInviteCount === 2
    );

    const accepted = await emitAck(player, "player:rematch", { accept: true });
    assert.equal(accepted.ok, true);

    const declined = await emitAck(decliningPlayer, "player:rematch", { accept: false });
    assert.equal(declined.ok, true);
    assert.equal(declined.left, true);

    await waitForState(host, (state) =>
      state.status === "lobby" &&
      state.playerCount === 1 &&
      state.pendingInviteCount === 0 &&
      state.players.some((item) => item.nickname === "Smoke Player") &&
      !state.players.some((item) => item.nickname === "Smoke Decliner")
    );

    const resultArchive = await getJson("/api/archive/results");
    const savedResult = resultArchive.results.find((item) => item.code === created.code);
    assert.ok(savedResult);

    const savedResultJson = await getJson(`/api/archive/results/${savedResult.id}.json`);
    assert.equal(savedResultJson.code, created.code);
    assert.ok(savedResultJson.leaderboard.some((item) => item.nickname === "Smoke Player"));

    const savedResultCsv = await getText(`/api/archive/results/${savedResult.id}.csv`);
    assert.match(savedResultCsv, /Smoke Player/);

    const savedResultXlsx = await getBinary(`/api/archive/results/${savedResult.id}.xlsx`);
    assert.ok(savedResultXlsx.length > 1000);

    const deletedResult = await deleteJson(`/api/archive/results/${savedResult.id}`);
    assert.equal(deletedResult.ok, true);

    const replacementQuiz = {
      ...quiz,
      title: "Smoke Replacement",
      questions: [
        {
          type: "multiple",
          text: "Replacement question",
          answers: ["One", "Two", "Three", "Four"],
          correctIndex: 0,
          timeLimit: 10
        }
      ]
    };
    const updatedRoomQuiz = await emitAck(host, "host:update-quiz", { quiz: replacementQuiz });
    assert.equal(updatedRoomQuiz.ok, true);
    assert.equal(updatedRoomQuiz.code, created.code);
    await waitForState(host, (state) =>
      state.status === "lobby" &&
      state.code === created.code &&
      state.title === "Smoke Replacement" &&
      state.totalQuestions === 1 &&
      state.quiz &&
      state.quiz.title === "Smoke Replacement"
    );

    const deletedQuiz = await deleteJson(`/api/archive/quizzes/${savedQuiz.quiz.id}`);
    assert.equal(deletedQuiz.ok, true);

    console.log(JSON.stringify({
      ok: true,
      code: created.code,
      playerScore: playerReveal.player.score
    }, null, 2));
  } finally {
    host.close();
    screen.close();
    player.close();
    decliningPlayer.close();
  }
}

function createSocket(includeHostCookie) {
  const options = {
    transports: ["websocket"],
    forceNew: true
  };
  if (includeHostCookie && authCookie) {
    options.extraHeaders = { Cookie: authCookie };
  }
  return io(serverUrl, options);
}

async function ensureHostAccess() {
  const auth = await getJson("/api/host/auth");
  if (!auth.enabled) return;
  if (!hostPassword) {
    throw new Error("HOST_PASSWORD is required to run smoke tests against a protected host.");
  }

  const lockedResponse = await fetch(new URL("/api/archive/quizzes", serverUrl), { cache: "no-store" });
  assert.equal(lockedResponse.status, 401);

  const unauthorizedHost = createSocket(false);
  try {
    await waitForConnect(unauthorizedHost);
    const deniedCreate = await emitAck(unauthorizedHost, "host:create", { quiz });
    assert.equal(deniedCreate.ok, false);
    assert.match(deniedCreate.error, /Password host/);
  } finally {
    unauthorizedHost.close();
  }

  await loginHost();
}

async function loginHost() {
  const response = await fetch(new URL("/api/host/login", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: hostPassword })
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || "Host login failed");
  authCookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(authCookie);

  const auth = await getJson("/api/host/auth");
  assert.equal(auth.authenticated, true);
}

function emitAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), 4000);
    socket.emit(eventName, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function waitForSocketEvent(socket, eventName, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      reject(new Error(`Timeout waiting for socket event ${eventName}`));
    }, timeoutMs);
    function onEvent(payload) {
      clearTimeout(timeout);
      resolve(payload);
    }
    socket.once(eventName, onEvent);
  });
}

async function getJson(path) {
  const response = await fetch(new URL(path, serverUrl), {
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function getText(path) {
  const response = await fetch(new URL(path, serverUrl), {
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return response.text();
}

async function getBinary(path) {
  const response = await fetch(new URL(path, serverUrl), {
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return Buffer.from(await response.arrayBuffer());
}

async function postJson(path, payload) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function postJsonRaw(path, payload) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return {
    status: response.status,
    data: await response.json()
  };
}

async function postBinary(path, payload) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  assert.equal(response.ok, true);
  return Buffer.from(await response.arrayBuffer());
}

async function deleteJson(path) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "DELETE",
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return response.json();
}

function authHeaders() {
  return authCookie ? { Cookie: authCookie } : {};
}

function waitForConnect(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timeout")), 4000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", reject);
  });
}

function waitForState(socket, predicate) {
  if (socket.latestState && predicate(socket.latestState)) {
    return Promise.resolve(socket.latestState);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("room:state", onState);
      reject(new Error("Timeout waiting for room state"));
    }, 4000);

    function onState(state) {
      socket.latestState = state;
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off("room:state", onState);
      resolve(state);
    }

    socket.on("room:state", onState);
  });
}

function waitForCondition(predicate, message) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 4000) {
        clearInterval(interval);
        reject(new Error(message));
      }
    }, 25);
  });
}
