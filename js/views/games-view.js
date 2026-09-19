/* VaultDex — Games hub, Higher or Lower, Card Quiz, Card of the Day.
 * All games are public (signed-out visitors play against the owner's stored
 * collection via listPublic). Zero live pricing: only stored market_price. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};
  var G = function () { return App.games; };

  function notConfigured() {
    return {
      title: "Supabase isn't configured",
      body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload.",
      actionHtml: '<a class="btn btn-ghost" href="/">Home</a>'
    };
  }

  async function loadRows() {
    var readOnly = !App.auth.isOwner();
    var items = readOnly ? await App.collection.listPublic() : await App.collection.list();
    return { items: items || [], readOnly: readOnly };
  }

  function head(title, sub) {
    return '<div class="games-head">' +
      '<h1 class="games-title">' + App.esc(title) + "</h1>" +
      '<p class="games-sub">' + App.esc(sub) + "</p>" +
    "</div>";
  }

  function cardName(row) { return row.card_name || "Unknown card"; }
  function cardSet(row) { return row.set_name || ""; }

  function cotdCard(rows) {
    var dateStr = G().todayStr();
    var card = G().pickForDate(rows, dateStr);
    return card ? { card: card, dateStr: dateStr } : null;
  }

  function funLine(card, rows) {
    var rank = G().valueRank(card, rows);
    if (rank !== null) {
      return "The #" + rank + " most valuable card in the vault.";
    }
    return "A treasure from the vault.";
  }

  /* ---------------- Games hub (/games) ---------------- */

  App.views.games = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState(notConfigured());
      return;
    }
    root.innerHTML = head("Games", "Three ways to play with the vault.") +
      '<div data-games-body><p class="games-loading">Loading the vault…</p></div>';
    var body = root.querySelector("[data-games-body]");
    var items;
    try {
      items = (await loadRows()).items;
    } catch (e) {
      body.innerHTML = App.ui.emptyState({ title: "Couldn't load the vault", body: (e && e.message) || "Something went wrong." });
      return;
    }
    if (!items.length) {
      body.innerHTML = App.ui.emptyState({ title: "The vault is empty", body: "Add some cards and the games will be ready to play." });
      return;
    }

    var hero = "";
    var daily = cotdCard(items);
    if (daily) {
      var c = daily.card;
      hero =
        '<a class="cotd-hero" href="/games/card-of-the-day">' +
          '<div class="cotd-hero-text">' +
            '<span class="home-kicker">Card of the Day</span>' +
            '<span class="cotd-hero-name">' + App.esc(cardName(c)) + "</span>" +
            '<span class="cotd-hero-meta">' + App.esc(cardSet(c)) + "</span>" +
            '<span class="cotd-hero-line">' + App.esc(funLine(c, items)) + "</span>" +
            '<span class="cotd-hero-cta">See today\u2019s card →</span>' +
          "</div>" +
          (c.image_small ? '<img class="cotd-hero-art" loading="lazy" src="' + App.esc(c.image_small) + '" alt="' + App.esc(cardName(c)) + '">' : "") +
        "</a>";
    }

    body.innerHTML = hero +
      '<div class="game-tiles">' +
        '<a class="game-tile" href="/games/higher-lower">' +
          '<span class="game-tile-icon" aria-hidden="true">⚖️</span>' +
          '<span class="game-tile-title">Higher or Lower</span>' +
          '<span class="game-tile-desc">Two cards, one question: which is worth more? Build a streak.</span>' +
        "</a>" +
        '<a class="game-tile" href="/games/quiz">' +
          '<span class="game-tile-icon" aria-hidden="true">🔍</span>' +
          '<span class="game-tile-title">Card Quiz</span>' +
          '<span class="game-tile-desc">Name the card from a cropped slice of its art. Ten rounds.</span>' +
        "</a>" +
        '<a class="game-tile" href="/games/card-of-the-day">' +
          '<span class="game-tile-icon" aria-hidden="true">🃏</span>' +
          '<span class="game-tile-title">Card of the Day</span>' +
          '<span class="game-tile-desc">One card picked fresh every day. Same card for everyone, all day.</span>' +
        "</a>" +
      "</div>";
    App.ui.reveal(root);
  };

  /* ---------------- Higher or Lower (/games/higher-lower) ---------------- */

  function hlCardHtml(row, i) {
    return '<button type="button" class="hl-card" data-hl-pick="' + i + '">' +
      (row.image_small ? '<img class="hl-art" loading="lazy" src="' + App.esc(row.image_small) + '" alt="' + App.esc(cardName(row)) + '">' : "") +
      '<span class="hl-name">' + App.esc(cardName(row)) + "</span>" +
      '<span class="hl-set">' + App.esc(cardSet(row)) + "</span>" +
      '<span class="hl-price" data-hl-price hidden></span>' +
    "</button>";
  }

  App.views.gameHigherLower = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState(notConfigured());
      return;
    }
    var best = G().getBest(G().HL_BEST_KEY, 0);
    var streak = 0;
    root.innerHTML = head("Higher or Lower", "Which card is worth more? Tap your pick.") +
      '<div class="hl-score"><span data-hl-streak>Streak: 0</span><span data-hl-best>Best: ' + best + "</span></div>" +
      '<div data-hl-stage><p class="games-loading">Shuffling the vault…</p></div>';

    var stage = root.querySelector("[data-hl-stage]");
    var streakEl = root.querySelector("[data-hl-streak]");
    var bestEl = root.querySelector("[data-hl-best]");
    var items;
    try {
      items = (await loadRows()).items;
    } catch (e) {
      stage.innerHTML = App.ui.emptyState({ title: "Couldn't load the vault", body: (e && e.message) || "Something went wrong." });
      return;
    }

    function paintScore() {
      streakEl.textContent = "Streak: " + streak;
      bestEl.textContent = "Best: " + best;
    }

    function renderRound() {
      var pair = G().pickHigherLowerPair(items);
      if (!pair) {
        stage.innerHTML = App.ui.emptyState({
          title: "Not enough priced cards",
          body: "Higher or Lower needs at least two cards with prices in the vault."
        });
        return;
      }
      var pa = G().priceOf(pair[0]), pb = G().priceOf(pair[1]);
      stage.innerHTML =
        '<div class="hl-duel">' +
          hlCardHtml(pair[0], 0) +
          '<span class="hl-vs" aria-hidden="true">VS</span>' +
          hlCardHtml(pair[1], 1) +
        "</div>" +
        '<p class="hl-result" data-hl-result hidden></p>' +
        '<div class="hl-actions" hidden><button type="button" class="btn" data-hl-next>Next round</button></div>';

      var resultEl = stage.querySelector("[data-hl-result]");
      var actionsEl = stage.querySelector(".hl-actions");
      var cards = stage.querySelectorAll("[data-hl-pick]");

      function reveal(pickedIdx) {
        var prices = [pa, pb];
        var win = prices[pickedIdx] > prices[1 - pickedIdx];
        cards.forEach(function (btn, i) {
          btn.disabled = true;
          var priceEl = btn.querySelector("[data-hl-price]");
          priceEl.hidden = false;
          priceEl.textContent = App.ui.money(prices[i]);
          btn.classList.add(i === pickedIdx ? (win ? "hl-win" : "hl-lose") : "hl-dim");
        });
        if (win) {
          streak++;
          if (streak > best) { best = streak; G().setBest(G().HL_BEST_KEY, best); }
          resultEl.textContent = "Nice! " + App.ui.money(prices[pickedIdx]) + " beats " + App.ui.money(prices[1 - pickedIdx]) + ".";
        } else {
          streak = 0;
          resultEl.textContent = "Nope — " + App.ui.money(prices[1 - pickedIdx]) + " beats " + App.ui.money(prices[pickedIdx]) + ".";
        }
        resultEl.classList.add(win ? "hl-result-win" : "hl-result-lose");
        resultEl.hidden = false;
        actionsEl.hidden = false;
        paintScore();
      }

      cards.forEach(function (btn) {
        btn.addEventListener("click", function () {
          reveal(parseInt(btn.getAttribute("data-hl-pick"), 10));
        });
      });
      stage.querySelector("[data-hl-next]").addEventListener("click", renderRound);
    }

    renderRound();
    App.ui.reveal(root);
  };

  /* ---------------- Card Quiz (/games/quiz) ---------------- */

  App.views.gameQuiz = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState(notConfigured());
      return;
    }
    root.innerHTML = head("Card Quiz", "Name the card from a cropped slice of its art.") +
      '<div data-quiz-stage><p class="games-loading">Picking cards…</p></div>';

    var stage = root.querySelector("[data-quiz-stage]");
    var items, round = 0, score = 0;
    var best = G().getBest(G().QUIZ_BEST_KEY, 0);
    var ROUNDS = G().QUIZ_ROUNDS;
    try {
      items = (await loadRows()).items;
    } catch (e) {
      stage.innerHTML = App.ui.emptyState({ title: "Couldn't load the vault", body: (e && e.message) || "Something went wrong." });
      return;
    }

    function renderRound() {
      if (round >= ROUNDS) { renderDone(); return; }
      var answer = G().pickQuizAnswer(items);
      var options = answer && G().buildQuizOptions(answer, items);
      if (!options) {
        stage.innerHTML = App.ui.emptyState({
          title: "Not enough cards",
          body: "The quiz needs at least four different cards with art in the vault."
        });
        return;
      }
      /* CSS-only crop: oversized art at a random offset inside the frame. */
      var scale = 2.2 + Math.random() * 1.4;
      var maxOff = (scale - 1) * 100;
      var imgStyle = "width:" + (scale * 100).toFixed(1) + "%;" +
        "left:" + (-(Math.random() * maxOff)).toFixed(1) + "%;" +
        "top:" + (-(Math.random() * maxOff)).toFixed(1) + "%;";
      stage.innerHTML =
        '<div class="quiz-progress"><span>Round ' + (round + 1) + " of " + ROUNDS + "</span><span>Score: " + score + "</span></div>" +
        '<div class="quiz-crop" aria-label="Cropped card art">' +
          '<img src="' + App.esc(answer.image_small) + '" alt="" style="' + imgStyle + '">' +
        "</div>" +
        '<div class="quiz-options">' +
          options.map(function (o, i) {
            return '<button type="button" class="quiz-opt" data-quiz-opt="' + i + '">' + App.esc(o.row.card_name) + "</button>";
          }).join("") +
        "</div>" +
        '<p class="quiz-feedback" data-quiz-feedback hidden></p>' +
        '<div class="hl-actions" hidden><button type="button" class="btn" data-quiz-next>' + (round + 1 === ROUNDS ? "See score" : "Next") + "</button></div>";

      var feedback = stage.querySelector("[data-quiz-feedback]");
      var nextWrap = stage.querySelector(".hl-actions");
      var btns = stage.querySelectorAll("[data-quiz-opt]");
      btns.forEach(function (btn) {
        btn.addEventListener("click", function () {
          var i = parseInt(btn.getAttribute("data-quiz-opt"), 10);
          var picked = options[i];
          btns.forEach(function (b, j) {
            b.disabled = true;
            if (options[j].correct) b.classList.add("quiz-right");
          });
          if (picked.correct) {
            score++;
            feedback.textContent = "Correct!";
            feedback.className = "quiz-feedback quiz-feedback-right";
          } else {
            btn.classList.add("quiz-wrong");
            feedback.textContent = "That was " + cardName(answer) + ".";
            feedback.className = "quiz-feedback quiz-feedback-wrong";
          }
          feedback.hidden = false;
          nextWrap.hidden = false;
        });
      });
      stage.querySelector("[data-quiz-next]").addEventListener("click", function () {
        round++;
        renderRound();
      });
    }

    function renderDone() {
      if (score > best) { best = score; G().setBest(G().QUIZ_BEST_KEY, best); }
      var verdict = score === ROUNDS ? "A perfect vault run! 🏆"
        : score >= ROUNDS * 0.7 ? "Sharp eyes. 👀"
        : score >= ROUNDS * 0.4 ? "Not bad — the vault is deep." : "The vault keeps its secrets… for now.";
      stage.innerHTML =
        '<div class="quiz-done">' +
          '<p class="quiz-done-score">' + score + " / " + ROUNDS + "</p>" +
          '<p class="quiz-done-verdict">' + App.esc(verdict) + "</p>" +
          '<p class="quiz-done-best">Best score: ' + best + " / " + ROUNDS + "</p>" +
          '<button type="button" class="btn" data-quiz-again>Play again</button>' +
        "</div>";
      stage.querySelector("[data-quiz-again]").addEventListener("click", function () {
        round = 0; score = 0; renderRound();
      });
    }

    renderRound();
    App.ui.reveal(root);
  };

  /* ---------------- Card of the Day (/games/card-of-the-day) ---------------- */

  App.views.gameCardOfDay = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState(notConfigured());
      return;
    }
    root.innerHTML = head("Card of the Day", "One card, picked fresh every day.") +
      '<div data-cotd-body><p class="games-loading">Revealing today\u2019s card…</p></div>';
    var body = root.querySelector("[data-cotd-body]");
    var items;
    try {
      items = (await loadRows()).items;
    } catch (e) {
      body.innerHTML = App.ui.emptyState({ title: "Couldn't load the vault", body: (e && e.message) || "Something went wrong." });
      return;
    }
    var daily = cotdCard(items);
    if (!daily) {
      body.innerHTML = App.ui.emptyState({ title: "The vault is empty", body: "Add some cards and the Card of the Day will appear." });
      return;
    }
    var c = daily.card;
    var price = G().priceOf(c);
    body.innerHTML =
      '<div class="cotd-card">' +
        (c.image_small ? '<img class="cotd-art" src="' + App.esc(c.image_small) + '" alt="' + App.esc(cardName(c)) + '">' : "") +
        '<div class="cotd-info">' +
          '<p class="cotd-date">' + App.esc(daily.dateStr) + "</p>" +
          '<h2 class="cotd-name">' + App.esc(cardName(c)) + "</h2>" +
          '<p class="cotd-meta">' + App.esc(cardSet(c)) + (c.rarity ? " · " + App.esc(c.rarity) : "") + "</p>" +
          (price !== null ? '<p class="cotd-price">' + App.ui.money(price) + "</p>" : "") +
          '<p class="cotd-line">' + App.esc(funLine(c, items)) + "</p>" +
          '<p class="cotd-tomorrow">A new card at midnight — come back tomorrow.</p>' +
        "</div>" +
      "</div>";
    App.ui.reveal(root);
  };
})();
