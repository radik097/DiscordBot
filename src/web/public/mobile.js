(function () {
  const media = window.matchMedia("(max-width: 720px)");
  const board = document.getElementById("board");
  const nav = document.getElementById("mobileNav");
  const more = document.getElementById("mobileMoreMenu");
  const storageKey = "discordBot.mobilePanel";
  let active = "music";
  try { active = localStorage.getItem(storageKey) || active; } catch {}

  function selectPanel(id, { scroll = true } = {}) {
    const panel = board.querySelector(`.panel[data-panel="${id}"]`);
    if (!panel) return;
    active = id;
    for (const item of board.querySelectorAll(".panel")) item.classList.toggle("mobile-active", item === panel);
    for (const button of document.querySelectorAll("[data-mobile-panel]")) button.classList.toggle("active", button.dataset.mobilePanel === id);
    document.getElementById("mobileMoreBtn").classList.toggle("active", !nav.querySelector(`[data-mobile-panel="${id}"]`));
    more.hidden = true;
    document.body.classList.remove("mobile-menu-open");
    try { localStorage.setItem(storageKey, id); } catch {}
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function applyMode() {
    document.body.classList.toggle("mobile-mode", media.matches);
    if (media.matches) selectPanel(active, { scroll: false });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mobile-panel]");
    if (button && media.matches) selectPanel(button.dataset.mobilePanel);
  });
  document.getElementById("mobileMoreBtn").addEventListener("click", () => {
    more.hidden = false;
    document.body.classList.add("mobile-menu-open");
  });
  document.getElementById("mobileMoreClose").addEventListener("click", () => {
    more.hidden = true;
    document.body.classList.remove("mobile-menu-open");
  });
  more.addEventListener("click", (event) => {
    if (event.target === more) document.getElementById("mobileMoreClose").click();
  });
  media.addEventListener("change", applyMode);
  applyMode();
})();
