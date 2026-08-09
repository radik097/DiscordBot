// Dashboard chrome: free-form drag positioning (with edge/panel magnetism),
// pin, collapse, close/reopen. Pure UI state — doesn't know anything about
// what's inside each panel. Persisted per-browser in localStorage.
(function () {
  const STORAGE_KEY = "dashboardLayout.v2";
  const SNAP = 14; // px threshold for magnetism
  const GAP = 20;
  const PANEL_W = 420;

  const board = document.getElementById("board");
  const panelsList = () => [...board.querySelectorAll(".panel")];
  const allIds = panelsList().map((p) => p.dataset.panel);

  function loadRaw() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
      return {};
    }
  }

  function getState() {
    const raw = loadRaw();
    return {
      positions: raw.positions ?? {},
      zOrder: raw.zOrder && raw.zOrder.length ? raw.zOrder : [...allIds],
      pinned: raw.pinned ?? [],
      collapsed: raw.collapsed ?? [],
      hidden: raw.hidden ?? [],
    };
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function updateState(mutator) {
    const state = getState();
    mutator(state);
    saveState(state);
    applyState();
  }

  // Simple masonry (shortest-column-first) layout for panels that have never
  // been manually positioned, so the first run doesn't look like a pile.
  function autoLayout(ids) {
    const boardW = board.clientWidth || PANEL_W;
    const cols = Math.max(1, Math.floor((boardW + GAP) / (PANEL_W + GAP)));
    const colBottoms = new Array(cols).fill(0);
    const positions = {};
    for (const id of ids) {
      const panel = board.querySelector(`.panel[data-panel="${id}"]`);
      const col = colBottoms.indexOf(Math.min(...colBottoms));
      positions[id] = { x: col * (PANEL_W + GAP), y: colBottoms[col] };
      colBottoms[col] = colBottoms[col] + (panel?.offsetHeight || 200) + GAP;
    }
    return positions;
  }

  function applyState() {
    const state = getState();

    const missing = allIds.filter((id) => !state.positions[id]);
    if (missing.length) Object.assign(state.positions, autoLayout(missing));
    for (const id of allIds) if (!state.zOrder.includes(id)) state.zOrder.push(id);

    let maxBottom = 0;
    for (const p of panelsList()) {
      const id = p.dataset.panel;
      const pos = state.positions[id] ?? { x: 0, y: 0 };
      p.style.left = `${pos.x}px`;
      p.style.top = `${pos.y}px`;
      p.style.zIndex = String(10 + state.zOrder.indexOf(id));

      const pinned = state.pinned.includes(id);
      const hidden = state.hidden.includes(id);
      p.classList.toggle("pinned", pinned);
      p.classList.toggle("collapsed", state.collapsed.includes(id));
      p.classList.toggle("hidden-panel", hidden);
      p.querySelector(".pin-btn")?.classList.toggle("active", pinned);
      const collapseBtn = p.querySelector(".collapse-btn");
      if (collapseBtn) collapseBtn.textContent = state.collapsed.includes(id) ? "▸" : "▾";

      if (!hidden) maxBottom = Math.max(maxBottom, pos.y + p.offsetHeight);
    }
    board.style.height = `${maxBottom + GAP}px`;

    saveState(state); // persist any auto-layout / z-order fill-ins we just computed
    renderMenu(state);
  }

  function renderMenu(state) {
    const menu = document.getElementById("panelMenuList");
    menu.innerHTML = "";
    for (const p of panelsList()) {
      const id = p.dataset.panel;
      const hidden = state.hidden.includes(id);
      const item = document.createElement("button");
      item.className = "menu-item" + (hidden ? " hidden-item" : "");
      item.textContent = `${p.dataset.icon} ${p.dataset.title}${hidden ? " · скрыта" : ""}`;
      item.addEventListener("click", () => {
        updateState((s) => {
          s.hidden = hidden ? s.hidden.filter((h) => h !== id) : [...s.hidden, id];
        });
      });
      menu.appendChild(item);
    }
  }

  function bringToFront(id) {
    updateState((s) => {
      s.zOrder = [...s.zOrder.filter((x) => x !== id), id];
    });
  }

  // --- Free-drag with magnetism against the board edges and other panels ---
  function computeSnap(id, x, y, w, h) {
    let snapX = x;
    let snapY = y;
    const boardW = board.clientWidth;

    if (Math.abs(x) < SNAP) snapX = 0;
    if (Math.abs(x + w - boardW) < SNAP) snapX = boardW - w;
    if (Math.abs(y) < SNAP) snapY = 0;

    for (const other of panelsList()) {
      if (other.dataset.panel === id || other.classList.contains("hidden-panel")) continue;
      const ox = parseFloat(other.style.left) || 0;
      const oy = parseFloat(other.style.top) || 0;
      const ow = other.offsetWidth;
      const oh = other.offsetHeight;

      if (Math.abs(x - ox) < SNAP) snapX = ox;
      if (Math.abs(x + w - (ox + ow)) < SNAP) snapX = ox + ow - w;
      if (Math.abs(x - (ox + ow)) < SNAP) snapX = ox + ow + GAP;
      if (Math.abs(x + w - ox) < SNAP) snapX = ox - GAP - w;

      if (Math.abs(y - oy) < SNAP) snapY = oy;
      if (Math.abs(y + h - (oy + oh)) < SNAP) snapY = oy + oh - h;
      if (Math.abs(y - (oy + oh)) < SNAP) snapY = oy + oh + GAP;
      if (Math.abs(y + h - oy) < SNAP) snapY = oy - GAP - h;
    }

    return { x: Math.max(0, snapX), y: Math.max(0, snapY) };
  }

  let dragEl = null;
  let dragStartMouse = { x: 0, y: 0 };
  let dragStartPos = { x: 0, y: 0 };

  function onMove(e) {
    if (!dragEl) return;
    const id = dragEl.dataset.panel;
    const dx = e.clientX - dragStartMouse.x;
    const dy = e.clientY - dragStartMouse.y;
    const raw = { x: dragStartPos.x + dx, y: dragStartPos.y + dy };
    const snapped = computeSnap(id, raw.x, raw.y, dragEl.offsetWidth, dragEl.offsetHeight);
    dragEl.style.left = `${snapped.x}px`;
    dragEl.style.top = `${snapped.y}px`;
  }

  function onUp() {
    if (!dragEl) return;
    const id = dragEl.dataset.panel;
    const x = parseFloat(dragEl.style.left) || 0;
    const y = parseFloat(dragEl.style.top) || 0;
    dragEl.classList.remove("dragging");
    document.body.classList.remove("dragging-active");
    dragEl = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    updateState((s) => {
      s.positions[id] = { x, y };
    });
  }

  for (const p of panelsList()) {
    p.querySelector(".drag-handle").addEventListener("mousedown", (e) => {
      if (p.classList.contains("pinned")) return;
      e.preventDefault();
      dragEl = p;
      dragStartMouse = { x: e.clientX, y: e.clientY };
      dragStartPos = { x: parseFloat(p.style.left) || 0, y: parseFloat(p.style.top) || 0 };
      p.classList.add("dragging");
      document.body.classList.add("dragging-active");
      bringToFront(p.dataset.panel);
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // --- Pin / collapse / close ---
  for (const p of panelsList()) {
    const id = p.dataset.panel;
    p.querySelector(".pin-btn").addEventListener("click", () => {
      updateState((s) => {
        s.pinned = s.pinned.includes(id) ? s.pinned.filter((x) => x !== id) : [...s.pinned, id];
      });
    });
    p.querySelector(".collapse-btn").addEventListener("click", () => {
      updateState((s) => {
        s.collapsed = s.collapsed.includes(id) ? s.collapsed.filter((x) => x !== id) : [...s.collapsed, id];
      });
    });
    p.querySelector(".close-btn").addEventListener("click", () => {
      updateState((s) => {
        if (!s.hidden.includes(id)) s.hidden = [...s.hidden, id];
      });
    });
  }

  const menuBtn = document.getElementById("panelMenuBtn");
  const menuList = document.getElementById("panelMenuList");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuList.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!menuList.contains(e.target) && e.target !== menuBtn) menuList.classList.remove("open");
  });

  window.addEventListener("resize", () => applyState());

  applyState();
})();
