/* VaultDex — Trophy Case (achievements).
 * Public read-only showcase of the owner's badges; toasts and celebrations
 * are owner-only (handled in js/achievements.js). Zero PkmnPrices credits. */
(function () {
  window.App = window.App || {};
  App.views = App.views || {};

  function badgeCard(r) {
    var b = r.badge;
    var pct = Math.max(0, Math.min(100, Math.round((r.current / r.target) * 100)));
    var prog = r.unlocked ? "" :
      '<div class="badge-prog"><div class="badge-prog-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="badge-hint">' + App.esc(formatProgress(r)) + "</div>";
    return '<div class="badge-card' + (r.unlocked ? " unlocked" : " locked") + '">' +
      '<div class="badge-icon" aria-hidden="true">' + (r.unlocked ? App.esc(b.icon) : "🔒") + "</div>" +
      '<div class="badge-name">' + App.esc(b.name) + "</div>" +
      '<div class="badge-desc">' + App.esc(b.desc) + "</div>" +
      prog +
    "</div>";
  }

  function formatProgress(r) {
    var money = r.badge.category === "Value";
    function f(v) { return money ? App.ui.money(v) : Number(v).toLocaleString("en-US"); }
    return f(r.current) + " / " + f(r.target);
  }

  App.views.trophies = async function (root) {
    if (!App.isConfigured()) {
      root.innerHTML = App.ui.emptyState({
        title: "Supabase isn't configured",
        body: "Add your Supabase URL and anon key to js/config.js (see SETUP.md), then reload.",
        actionHtml: '<a class="btn btn-ghost" href="/browse">Browse cards</a>'
      });
      return;
    }
    var readOnly = !App.auth.isOwner();
    root.innerHTML =
      '<div class="trophies-head">' +
        '<h1 class="trophies-title">Trophy Case</h1>' +
        '<p class="trophies-sub">' + App.esc(readOnly ? "Vedant's achievements." : "Your achievements. New badges unlock as the vault grows.") + "</p>" +
      "</div>" +
      '<div id="t-loading"></div>';
    App.ui.skeletonGrid(root.querySelector("#t-loading"), 6);

    var items;
    try {
      items = (readOnly ? await App.collection.listPublic() : await App.collection.list()) || [];
    } catch (e) {
      root.innerHTML = App.ui.emptyState({ title: "Couldn't load the vault", body: (e && e.message) || "Something went wrong." });
      return;
    }

    var input;
    try { input = await App.achievements.buildInput(items); }
    catch { input = { rows: items, peakValue: 0, completedSets: 0, speciesCount: 0, speciesGroups: {} }; }
    var results = App.achievements.evaluate(input);
    var unlocked = results.filter(function (r) { return r.unlocked; });

    var cats = [];
    results.forEach(function (r) {
      if (cats.indexOf(r.badge.category) === -1) cats.push(r.badge.category);
    });
    var html =
      '<div class="trophies-head">' +
        '<h1 class="trophies-title">Trophy Case</h1>' +
        '<p class="trophies-sub">' +
          App.esc(readOnly ? "Vedant's achievements." : "Your achievements. New badges unlock as the vault grows.") +
        "</p>" +
        '<div class="trophies-count"><span class="trophies-count-num">' + unlocked.length + "</span> / " + results.length + " unlocked</div>" +
      "</div>";
    cats.forEach(function (cat) {
      html += '<section class="trophies-section"><h2 class="trophies-h">' + App.esc(cat) + "</h2>" +
        '<div class="badge-grid">' +
        results.filter(function (r) { return r.badge.category === cat; }).map(badgeCard).join("") +
        "</div></section>";
    });
    root.innerHTML = html;
    App.ui.reveal(root);
  };
})();
