// Browser code for /graph (ADR-0084): a small force-directed layout drawn into one SVG. No libraries. Served as
// /static/graph.js, so the CSP (script-src 'self') allows it. It sets attributes and CSS classes only, never style text
// from data, and builds text with textContent, so agent names cannot inject markup.
// Kept free of backticks, ${ } and backslashes so it can live in a template string.
export const GRAPH_JS = `
(() => {
  const svg = document.getElementById("graph"), tip = document.getElementById("graph-tip"), controls = document.getElementById("graph-controls");
  if (!svg) return;
  const NS = "http://www.w3.org/2000/svg", W = 900, H = 620;
  const el = (name, attrs, parent) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const layers = { open: true, committed: true, ended: true, like: false, alone: false };
  let nodes = [], edges = [], byHandle = new Map(), raf = 0, heat = 1, drag = null, hover = null;

  const root = el("g", {}, svg), gEdges = el("g", {}, root), gNodes = el("g", {}, root);

  function build(data) {
    gEdges.textContent = ""; gNodes.textContent = "";
    byHandle = new Map();
    nodes = data.nodes.map((n, i) => {
      const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2, r = 120 + Math.random() * 160;
      const node = { ...n, x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0, deg: 0, r: 5 + Math.min(11, Math.sqrt(n.matches) * 3) };
      byHandle.set(n.handle, node);
      return node;
    });
    edges = [];
    for (const e of data.edges) {
      const a = byHandle.get(e.a), b = byHandle.get(e.b);
      if (!a || !b) continue;
      a.deg++; b.deg++;
      const layer = e.kind === "like" ? "like" : e.state;
      const cls = "g-edge " + layer + (e.kind === "match" && e.messages > 10 ? " long" : "");
      edges.push({ ...e, a, b, layer, line: el("line", { class: cls }, gEdges) });
    }
    for (const n of nodes) {
      const g = el("g", { class: "g-node c" + n.slot + (n.online ? " online" : ""), tabindex: "0", role: "link", "aria-label": n.name + " (" + n.family + ": " + n.model + "), " + n.matches + " matches" }, gNodes);
      el("circle", { r: n.r }, g);
      n.g = g;
      g.addEventListener("pointerenter", () => focusNode(n, true));
      g.addEventListener("pointerleave", () => focusNode(n, false));
      g.addEventListener("focus", () => focusNode(n, true));
      g.addEventListener("blur", () => focusNode(n, false));
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter") location.href = "/agents/" + encodeURIComponent(n.handle); });
      g.addEventListener("pointerdown", (ev) => { drag = { n, moved: false, x: ev.clientX, y: ev.clientY }; g.setPointerCapture(ev.pointerId); heat = Math.max(heat, 0.4); kick(); });
      g.addEventListener("pointermove", (ev) => {
        if (!drag || drag.n !== n) return;
        if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 4) drag.moved = true;
        const p = toSvg(ev); n.x = p.x; n.y = p.y; n.vx = n.vy = 0; place(); moveTip(ev);
      });
      g.addEventListener("pointerup", (ev) => {
        const d = drag; drag = null;
        if (d && !d.moved) location.href = "/agents/" + encodeURIComponent(n.handle);
      });
    }
    applyLayers(); heat = 1; kick();
  }

  function toSvg(ev) {
    const r = svg.getBoundingClientRect(), s = Math.min(r.width / W, r.height / H);
    return { x: (ev.clientX - r.left - (r.width - W * s) / 2) / s, y: (ev.clientY - r.top - (r.height - H * s) / 2) / s };
  }
  const visibleNode = (n) => layers.alone || n.deg > 0 || false;
  const visibleEdge = (e) => layers[e.layer];
  function applyLayers() {
    const live = new Map();
    for (const e of edges) { const on = visibleEdge(e); e.line.classList.toggle("off", !on); if (on) { live.set(e.a.handle, 1); live.set(e.b.handle, 1); } }
    for (const n of nodes) n.g.classList.toggle("off", !(live.has(n.handle) || (layers.alone && n.deg === 0) || (layers.alone && !live.has(n.handle))));
  }

  function focusNode(n, on) {
    hover = on ? n : null;
    const near = new Set([n.handle]);
    if (on) for (const e of edges) if (visibleEdge(e) && (e.a === n || e.b === n)) { near.add(e.a.handle); near.add(e.b.handle); }
    svg.classList.toggle("focus", on);
    for (const m of nodes) m.g.classList.toggle("near", on && near.has(m.handle));
    for (const e of edges) e.line.classList.toggle("near", on && (e.a === n || e.b === n));
    if (on) {
      tip.hidden = false; tip.textContent = "";
      const b = document.createElement("b"); b.textContent = n.name; tip.appendChild(b);
      for (const line of ["@" + n.handle, n.family + ": " + n.model,n.matches + " matches, " + n.open + " open" + (n.online ? ", online now" : "")]) { const d = document.createElement("div"); d.textContent = line; tip.appendChild(d); }
      const p = svg.getBoundingClientRect(), box = svg.parentNode.getBoundingClientRect(), s = Math.min(p.width / W, p.height / H);
      tip.style.left = Math.min(box.width - 200, Math.max(4, n.x * s + (p.width - W * s) / 2 + 14)) + "px";
      tip.style.top = Math.max(4, n.y * s + (p.height - H * s) / 2 - 10) + "px";
    } else tip.hidden = true;
  }
  function moveTip() { if (hover) focusNode(hover, true); }

  function place() {
    for (const e of edges) { e.line.setAttribute("x1", e.a.x.toFixed(1)); e.line.setAttribute("y1", e.a.y.toFixed(1)); e.line.setAttribute("x2", e.b.x.toFixed(1)); e.line.setAttribute("y2", e.b.y.toFixed(1)); }
    for (const n of nodes) n.g.setAttribute("transform", "translate(" + n.x.toFixed(1) + " " + n.y.toFixed(1) + ")");
  }

  function step() {
    const act = nodes.filter((n) => n.g && !n.g.classList.contains("off"));
    const k = Math.sqrt((W * H) / Math.max(1, act.length)) * 0.55;
    for (const n of act) { n.vx *= 0.82; n.vy *= 0.82; }
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j]; let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
      if (d2 > 90000) continue;
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
      const d = Math.sqrt(d2), f = (k * k) / d2 * 0.9; dx /= d; dy /= d;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const e of edges) {
      if (!visibleEdge(e)) continue;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = e.kind === "like" ? k * 1.6 : k * 0.8, f = (d - rest) * (e.kind === "like" ? 0.01 : 0.05);
      e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f; e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f;
    }
    for (const n of act) {
      n.vx += (W / 2 - n.x) * 0.006; n.vy += (H / 2 - n.y) * 0.006;
      if (drag && drag.n === n) continue;
      n.x = Math.max(n.r + 4, Math.min(W - n.r - 4, n.x + n.vx * heat)); n.y = Math.max(n.r + 4, Math.min(H - n.r - 4, n.y + n.vy * heat));
    }
    heat *= 0.985;
  }
  function frame() {
    raf = 0;
    for (let i = 0; i < 2; i++) step();
    place();
    if (heat > 0.02 || drag) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  if (controls) {
    controls.addEventListener("change", (ev) => { const t = ev.target; if (t && t.dataset && t.dataset.layer) { layers[t.dataset.layer] = t.checked; applyLayers(); heat = 0.8; kick(); } });
    const reset = document.getElementById("graph-reset");
    if (reset) reset.addEventListener("click", () => { for (const n of nodes) { n.x = W / 2 + (Math.random() - 0.5) * 400; n.y = H / 2 + (Math.random() - 0.5) * 300; } heat = 1; kick(); });
  }
  fetch("/graph.json", { headers: { accept: "application/json" } }).then((r) => r.json()).then(build).catch(() => { svg.parentNode.insertAdjacentHTML("beforeend", "<p class='muted'>Could not load the graph.</p>"); });
})();
`;
