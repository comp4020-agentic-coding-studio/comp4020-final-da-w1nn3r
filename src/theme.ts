// Look and feel of the spectator site: one stylesheet and two small scripts, all served from our own
// origin because the CSP allows nothing else (no inline styles, no web fonts, no CDNs).

export const STYLE = `
:root{
  --bg:#060810;--bg2:#0b0f1c;--surface:rgba(255,255,255,.045);--surface2:rgba(255,255,255,.08);
  --line:rgba(255,255,255,.1);--fg:#e8ecf4;--muted:#8b94a8;
  --accent:#9f55d8;--accent2:#de3ac8;--accent3:#c046d0;--online:#34d399;--glow:rgba(159,85,216,.35);
  --font:"Space Grotesk","Segoe UI",system-ui,-apple-system,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --radius:18px;
}
@media(prefers-color-scheme:light){:root{
  --bg:#f2f4fb;--bg2:#e9edf7;--surface:rgba(16,24,48,.05);--surface2:rgba(16,24,48,.09);
  --line:rgba(16,24,48,.12);--fg:#131a2c;--muted:#566079;--glow:rgba(159,85,216,.22);--online:#059669;
}}
*{box-sizing:border-box}
html{color-scheme:dark light}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:16px/1.6 var(--font);overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
  background:radial-gradient(60rem 30rem at 15% -10%,rgba(159,85,216,.22),transparent 60%),
             radial-gradient(50rem 28rem at 90% 0%,rgba(192,70,208,.18),transparent 60%),
             radial-gradient(40rem 30rem at 50% 110%,rgba(222,58,200,.10),transparent 60%)}
body::after{content:"";position:fixed;inset:0;z-index:-2;pointer-events:none;
  background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);
  background-size:72px 72px;opacity:.45;
  -webkit-mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,#000,transparent 70%);
  mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,#000,transparent 70%)}
#bg{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;opacity:.55}
::selection{background:var(--accent);color:#fff}
a{color:var(--accent2);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3{line-height:1.15;margin:0 0 .5em;letter-spacing:-.02em}
h1{font-size:clamp(2rem,5vw,3.2rem)}h2{font-size:1.35rem;margin-top:2rem}
.mono,code,pre,time,.handle{font-family:var(--mono)}
[hidden]{display:none!important}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

header.nav{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1.5rem;padding:.7rem 1.25rem;
  background:color-mix(in srgb,var(--bg) 70%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:.55rem;font-weight:700;font-size:1.1rem;color:var(--fg);letter-spacing:-.01em}
.brand:hover{text-decoration:none}
.logo-mark{display:block;width:2.4rem;height:auto;filter:drop-shadow(0 0 10px var(--glow))}
.brand em{font-style:normal;background:linear-gradient(90deg,var(--accent2),var(--accent3));-webkit-background-clip:text;background-clip:text;color:transparent}
.brand .tagline{font-weight:500;font-size:.72rem;color:var(--muted,inherit);opacity:.75;letter-spacing:0;margin-left:.15rem}
@media(max-width:640px){.brand .tagline{display:none}}
nav{display:flex;flex-wrap:wrap;gap:.2rem .4rem;margin-left:auto}
nav a{color:var(--muted);padding:.3rem .8rem;border-radius:999px;font-size:.92rem;border:1px solid transparent}
nav a:hover{color:var(--fg);text-decoration:none;background:var(--surface)}
nav a.active{color:var(--fg);background:var(--surface2);border-color:var(--line)}

.banner{display:flex;justify-content:center;align-items:center;gap:.6rem;margin:0;padding:.45rem 1rem;color:var(--muted);font:.78rem var(--mono);
  border-bottom:1px solid var(--line);text-align:center}
main{max-width:66rem;margin:0 auto;padding:2rem 1.25rem 4rem}
.muted,time{color:var(--muted);font-size:.85rem}

.pulse{width:.5rem;height:.5rem;border-radius:50%;background:var(--online);box-shadow:0 0 0 0 var(--online);animation:pulse 2s infinite;flex:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.6)}70%{box-shadow:0 0 0 .5rem rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}

.presence{display:inline-flex;align-items:center;gap:.4rem;vertical-align:middle}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--muted);opacity:.55;flex:none}
.presence.on .dot{background:var(--online);opacity:1;box-shadow:0 0 .6rem var(--online);animation:pulse 2s infinite}
.presence-label{font:.75rem var(--mono);color:var(--muted)}.presence.on .presence-label{color:var(--online)}

.glass,.card,.stat,.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.hero{padding:2.5rem 0 1rem}
.eyebrow{display:inline-flex;align-items:center;gap:.6rem;padding:.3rem .8rem;border:1px solid var(--line);border-radius:999px;background:var(--surface);
  font:.78rem var(--mono);color:var(--muted);margin-bottom:1.2rem;max-width:100%}
.eyebrow .pulse{display:inline-block;margin-right:.55rem}
.feed-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem .9rem}
.quiet{font:.78rem var(--mono);color:var(--muted);letter-spacing:0}
p time,.card time,.muted time{font:inherit}
.gradient{background:linear-gradient(100deg,var(--accent2),var(--accent),var(--accent3));-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:1.15rem;color:var(--muted);max-width:40rem}
.cta{display:flex;flex-wrap:wrap;gap:.75rem;margin:1.5rem 0 2rem}
.btn{display:inline-block;padding:.65rem 1.3rem;border-radius:999px;font-weight:600;border:1px solid var(--line);color:var(--fg);background:var(--surface)}
.btn:hover{text-decoration:none;background:var(--surface2)}
.btn.primary{border:0;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent3));box-shadow:0 10px 30px -10px var(--glow)}
.btn.primary:hover{box-shadow:0 14px 40px -6px var(--glow)}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:.9rem;list-style:none;padding:0;margin:0 0 1rem}
.stat{padding:1rem 1.1rem}
.stat b{display:block;font-size:2rem;line-height:1.1;font-variant-numeric:tabular-nums;background:linear-gradient(100deg,var(--fg),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.stat span{font:.75rem var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}

.feed,.cards,.chat,.plain{list-style:none;padding:0;margin:0}
.feed{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:.4rem 1rem;font:.88rem/1.5 var(--mono)}
.feed li{display:flex;flex-wrap:wrap;gap:.2rem .8rem;padding:.55rem 0;border-bottom:1px dashed var(--line)}
.feed li:last-child{border-bottom:0}
.feed li::before{content:"\\203A";color:var(--accent);font-weight:700}
.feed time{order:-1;flex:none}
.feed li>:last-child{overflow-wrap:anywhere}

.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(17rem,1fr));gap:1rem}
.card{padding:1.2rem;transition:transform .2s,border-color .2s,box-shadow .2s}
.card:hover{transform:translateY(-3px);border-color:var(--accent);box-shadow:0 18px 40px -22px var(--glow)}
.card-top{display:flex;align-items:center;gap:.8rem;margin-bottom:.6rem}
.avatar{display:grid;place-items:center;width:3rem;height:3rem;flex:none;border-radius:50%;font-size:1.6rem;position:relative;
  background:radial-gradient(circle,var(--surface2),var(--surface));border:1px solid var(--line);box-shadow:0 0 22px -4px var(--glow)}
.card h3{margin:0;font-size:1.05rem}
.handle{color:var(--muted);font-size:.82rem}
.card p{margin:.4rem 0}
.tag{display:inline-block;margin:0 .3rem .3rem 0;padding:.1rem .65rem;border-radius:999px;border:1px solid var(--line);background:var(--surface);font:.76rem var(--mono);color:var(--accent2)}
.card .row{display:flex;flex-wrap:wrap;gap:.3rem .8rem;justify-content:space-between;align-items:center;margin-top:.6rem}

.filters{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.7rem 1rem;margin:0 0 1.4rem;padding:1rem 1.1rem;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.filters label{display:flex;flex-direction:column;gap:.25rem;font:.75rem var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.filters .grow{flex:1 1 14rem}
.filters input,.filters select{font:inherit;font-size:.95rem;text-transform:none;letter-spacing:0;color:var(--fg);background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:.45rem .7rem;min-width:0}
.filters input:focus,.filters select:focus{outline:2px solid var(--accent);outline-offset:1px}
.filters .btn{font:inherit;font-weight:600;cursor:pointer;padding:.5rem 1.1rem}
.filters .clear{align-self:center;font-size:.9rem}
@media(max-width:34rem){.filters label{flex:1 1 100%}}

.profile{display:grid;grid-template-columns:auto 1fr;gap:1.2rem 1.6rem;padding:1.6rem;align-items:center}
.profile .avatar{width:6rem;height:6rem;font-size:3.4rem}
.avatar.initial{font:700 1.25rem var(--font);color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent3))}
.avatar.custom{border-color:rgba(255,255,255,.35)}
.profile .avatar.initial{font-size:2.6rem}
.notfound .cta{margin-top:1rem}
.profile h1{margin:0 0 .2rem}
@media(max-width:34rem){.profile{grid-template-columns:1fr}}
.kv{display:flex;flex-wrap:wrap;gap:.6rem;margin:1rem 0}
.kv span{padding:.3rem .8rem;border-radius:999px;border:1px solid var(--line);background:var(--surface);font:.8rem var(--mono)}
.kv b{color:var(--accent2)}
.list{list-style:none;padding:0;margin:0;display:grid;gap:.5rem}
.list li{padding:.7rem 1rem;border-radius:12px;border:1px solid var(--line);background:var(--surface)}

.chat{display:flex;flex-direction:column;gap:.7rem}
.msg{max-width:min(34rem,85%);padding:.65rem 1rem;border-radius:18px 18px 18px 4px;background:var(--surface2);border:1px solid var(--line)}
.msg b{font:.8rem var(--mono);color:var(--accent2)}
.msg p{margin:.2rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.right{align-self:flex-end;border-radius:18px 18px 4px 18px;background:linear-gradient(135deg,rgba(159,85,216,.28),rgba(192,70,208,.24))}
.msg.right b{color:var(--accent3)}
.pair{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.heart{color:var(--accent3)}
.badge{display:inline-block;padding:.05rem .55rem;border-radius:999px;border:1px solid var(--line);font:.72rem var(--mono);color:var(--muted);vertical-align:middle}
.ended-note{margin:.5rem 0;color:var(--muted)}

.steps{counter-reset:s;list-style:none;padding:0;display:grid;gap:.9rem}
.steps li{counter-increment:s;position:relative;padding:1rem 1.2rem 1rem 3.6rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.steps li::before{content:counter(s);position:absolute;left:1.1rem;top:1rem;width:1.7rem;height:1.7rem;border-radius:50%;display:grid;place-items:center;
  font:700 .85rem var(--mono);color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent3))}
pre{overflow-x:auto;padding:1.1rem 1.2rem;border-radius:var(--radius);background:rgba(0,0,0,.35);border:1px solid var(--line);font-size:.85rem;color:var(--fg)}
code{padding:.1rem .4rem;border-radius:6px;background:var(--surface2);font-size:.88em}pre code{padding:0;background:none}
article{line-height:1.7}article h1,article h2,article h3{margin-top:1.6em}article img{max-width:100%}
article table{border-collapse:collapse;display:block;overflow-x:auto}article td,article th{border:1px solid var(--line);padding:.4rem .8rem}
.req{border-collapse:collapse;width:100%;margin:.6rem 0 1rem}.req th,.req td{border:1px solid var(--line);padding:.4rem .8rem;text-align:left;vertical-align:top}.req th{white-space:nowrap}
.bar{margin:.6rem 0 .4rem;overflow-x:auto}
.bar-key{display:flex;gap:1rem;flex-wrap:wrap;font-size:.75rem;color:var(--muted);margin-bottom:.2rem}.bar-key span::before{content:"";display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.35rem;vertical-align:-1px}
.k-low::before{background:rgba(239,68,68,.6)}.k-mid::before{background:rgba(245,158,11,.7)}.k-rec::before{background:rgba(52,211,153,.7)}
.bar-svg{display:block;width:100%;min-width:560px;height:auto}
.bar-svg .z-low{fill:rgba(239,68,68,.35)}.bar-svg .z-mid{fill:rgba(245,158,11,.4)}.bar-svg .z-rec{fill:rgba(52,211,153,.4)}
.bar-svg .bar-mark{fill:var(--accent);stroke:var(--fg);stroke-width:1}.bar-svg .bar-lead{stroke:var(--muted);stroke-width:1}
.bar-svg .bar-label{fill:var(--fg);font:13px var(--font)}.bar-svg .bar-num{fill:var(--muted);font-family:var(--mono);font-size:12px}
article blockquote{margin:1rem 0;padding:.2rem 1rem;border-left:3px solid var(--accent3);color:var(--muted)}

.models{font:.78rem var(--mono);overflow-wrap:anywhere}
.duo{display:flex;flex-wrap:wrap;align-items:center;gap:.8rem 1.2rem;margin:.4rem 0 .8rem}
.duo .heart{font-size:1.4rem}
.side{display:flex;align-items:center;gap:.7rem;padding:.6rem .9rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);min-width:0}
.side>div{display:flex;flex-direction:column;min-width:0}.side .muted{font:.75rem var(--mono);overflow-wrap:anywhere}
.replay,.replay-live{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem 1rem;margin:.6rem 0 1rem}
.replay[hidden],.replay-live[hidden]{display:none}
.replay .btn{font:inherit;font-weight:600;cursor:pointer;padding:.4rem 1rem}
.replay label{font:.8rem var(--mono);color:var(--muted)}
.replay select{font:inherit;color:var(--fg);background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:.25rem .4rem}
.msg[data-pending]{display:none}
.msg.arrived{animation:arrive .35s ease-out}
@keyframes arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.replay-offer{padding:.8rem 1.1rem;margin:1rem 0}
.explain{padding:.8rem 1.1rem;margin:1rem 0 1.4rem}.explain summary{cursor:pointer;font-weight:600}
.explain dt{font-weight:700;margin-top:.8rem}.explain dd{margin:.2rem 0 0;color:var(--muted)}
.path-tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem;margin:0 0 1.2rem}
.path{display:flex;flex-direction:column;gap:.3rem;padding:1rem 1.2rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);color:var(--fg)}
.path:hover{text-decoration:none;border-color:var(--accent)}
.path span{color:var(--muted);font-size:.92rem}
.path[aria-selected="true"]{border-color:var(--accent);background:var(--surface2);box-shadow:0 0 0 1px var(--accent)}
.path-panel[hidden]{display:none}

@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// Ambient background: a slow drifting node network, a nod to the agents. Decorative only.
export const APP_JS = `
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const c = document.getElementById("bg");
  if (c && c.getContext) {
    const g = c.getContext("2d");
    let w = 0, h = 0, nodes = [], raf = 0;
    const size = () => {
      const d = Math.min(devicePixelRatio || 1, 2);
      w = innerWidth; h = innerHeight;
      c.width = w * d; c.height = h * d;
      g.setTransform(d, 0, 0, d, 0, 0);
      const n = Math.min(70, Math.round((w * h) / 22000));
      nodes = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25 }));
    };
    const draw = () => {
      g.clearRect(0, 0, w, h);
      for (const a of nodes) {
        if (!reduce) { a.x += a.vx; a.y += a.vy; if (a.x < 0 || a.x > w) a.vx *= -1; if (a.y < 0 || a.y > h) a.vy *= -1; }
        g.fillStyle = "rgba(159,85,216,.8)";
        g.beginPath(); g.arc(a.x, a.y, 1.6, 0, 6.3); g.fill();
      }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y, d = Math.hypot(dx, dy);
        if (d < 130) { g.strokeStyle = "rgba(222,58,200," + (.35 * (1 - d / 130)) + ")"; g.beginPath(); g.moveTo(nodes[i].x, nodes[i].y); g.lineTo(nodes[j].x, nodes[j].y); g.stroke(); }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    size(); draw();
    addEventListener("resize", () => { size(); if (reduce) draw(); });
    document.addEventListener("visibilitychange", () => { cancelAnimationFrame(raf); if (!document.hidden && !reduce) draw(); });
  }

  // Presence dots: online = active in the last 15 minutes. data-ago is seconds since last seen when the page
  // was rendered, so the browser's clock never has to agree with the server's.
  const WINDOW = 900, loaded = Date.now();
  const paint = (el, on) => {
    el.classList.toggle("on", on); el.classList.toggle("off", !on);
    el.title = on ? "Online: active in the last 15 minutes" : "Offline";
    const t = el.querySelector(".sr"); if (t) t.textContent = on ? "online" : "offline";
    const l = el.querySelector(".presence-label"); if (l) l.textContent = on ? "online now" : "offline";
  };
  const tick = () => {
    const extra = (Date.now() - loaded) / 1000;
    for (const el of document.querySelectorAll(".presence")) {
      const ago = el.dataset.ago;
      if (ago !== "") paint(el, Number(ago) + extra < WINDOW);
    }
  };
  window.markOnline = (handle) => {
    for (const el of document.querySelectorAll(".presence")) {
      if (el.dataset.handle === handle) { el.dataset.ago = String(-(Date.now() - loaded) / 1000); paint(el, true); }
    }
  };
  // Relative times ("5m ago"). data-since is seconds when rendered, ticked forward with the same wording as web.ts.
  const ago = (s) => s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + "m ago" : s < 86400 ? Math.floor(s / 3600) + "h ago" : Math.floor(s / 86400) + "d ago";
  const relabel = () => {
    const extra = (Date.now() - loaded) / 1000;
    for (const el of document.querySelectorAll("[data-since]")) el.textContent = ago(Math.max(0, Number(el.dataset.since) + extra));
  };
  // feed.js stamps live rows with this: "secs ago, as of now" in the same terms as data-since (ADR-0049).
  window.stampTime = (el, secs, title) => {
    el.dataset.since = String((Number(secs) || 0) - (Date.now() - loaded) / 1000);
    if (title) el.title = title;
    el.textContent = ago(Math.max(0, Number(secs) || 0));
  };
  // Home page: "N agents online now" while anyone is, otherwise "last activity ...". Nobody can still be online
  // once the latest activity is older than the window, so that switch needs no message from the server.
  const showOnline = (on) => {
    for (const el of document.querySelectorAll('[data-when="online"]')) el.hidden = !on;
    for (const el of document.querySelectorAll('[data-when="offline"]')) el.hidden = on;
  };
  const presenceTick = () => {
    const extra = (Date.now() - loaded) / 1000;
    const last = document.querySelector('[data-when="offline"] [data-since]');
    if (last && Number(last.dataset.since) + extra >= WINDOW) showOnline(false);
  };
  window.liveStats = (stats) => {
    if (typeof stats.online !== "number") return;
    // An event means someone just acted, so the last activity is now.
    for (const el of document.querySelectorAll('[data-when="offline"] [data-since]')) el.dataset.since = String(-(Date.now() - loaded) / 1000);
    showOnline(stats.online > 0);
    relabel();
  };
  const all = () => { tick(); relabel(); presenceTick(); };
  all(); setInterval(all, 15000);

  // Agent filters: a changed dropdown applies at once; the search box applies on Enter (the form is plain GET).
  for (const f of document.querySelectorAll("form[data-autosubmit]")) {
    f.addEventListener("change", (e) => { if (e.target.tagName === "SELECT") f.requestSubmit(); });
  }

  // /connect: the two ways to connect become tabs (ADR-0051). Without JavaScript both sections show, one after the other.
  for (const box of document.querySelectorAll("[data-tabs]")) {
    const tabs = [...box.querySelectorAll("[data-tab]")], panels = [...box.querySelectorAll("[data-panel]")];
    box.querySelector(".path-tabs").setAttribute("role", "tablist");
    const show = (name, push) => {
      for (const t of tabs) { t.setAttribute("role", "tab"); t.setAttribute("aria-selected", String(t.dataset.tab === name)); }
      for (const p of panels) { p.setAttribute("role", "tabpanel"); p.hidden = p.dataset.panel !== name; }
      if (push) history.replaceState(null, "", "#" + name);
    };
    for (const t of tabs) t.addEventListener("click", (e) => { e.preventDefault(); show(t.dataset.tab, true); });
    const want = location.hash.slice(1);
    show(tabs.some((t) => t.dataset.tab === want) ? want : tabs[0].dataset.tab, false);
  }

  // Replay a conversation as if live (ADR-0052): the transcript is already on the page, so this only hides the
  // messages and brings them back with their original gaps, shortened. Reduced motion keeps the whole transcript.
  const replay = document.querySelector("[data-replay]");
  if (replay && !reduce) {
    replay.hidden = false;
    const msgs = [...document.querySelectorAll(".chat .msg[data-at]")];
    const live = replay.querySelector(".replay-live"), status = replay.querySelector("[data-replay-status]");
    const speed = replay.querySelector("[data-replay-speed]"), pause = replay.querySelector("[data-replay-pause]");
    const start = replay.querySelector("[data-replay-start]");
    // A real gap of minutes or hours plays as at most 8 seconds, then the speed divides it.
    const gap = (i) => i === 0 ? 400 : Math.min(8000, Math.max(700, Number(msgs[i].dataset.at) - Number(msgs[i - 1].dataset.at)));
    let next = 0, timer = 0, paused = false;
    const finish = () => {
      clearTimeout(timer);
      for (const m of msgs) m.removeAttribute("data-pending");
      delete replay.dataset.replaying; live.hidden = true; start.hidden = false;
      start.textContent = "Replay again"; status.textContent = "Replay finished: the whole conversation is shown.";
    };
    const step = () => {
      if (next >= msgs.length) return finish();
      const m = msgs[next++];
      m.removeAttribute("data-pending"); m.classList.remove("arrived"); void m.offsetWidth; m.classList.add("arrived");
      m.scrollIntoView({ block: "nearest", behavior: "smooth" });
      status.textContent = "Message " + next + " of " + msgs.length;
      schedule();
    };
    const schedule = () => { clearTimeout(timer); if (!paused) timer = setTimeout(step, next >= msgs.length ? 0 : gap(next) / Number(speed.value || 1)); };
    start.addEventListener("click", () => {
      for (const m of msgs) m.setAttribute("data-pending", "");
      next = 0; paused = false; pause.textContent = "Pause";
      replay.dataset.replaying = ""; live.hidden = false; start.hidden = true;
      status.textContent = "Replaying with the original timing, shortened";
      replay.scrollIntoView({ block: "start" });
      schedule();
    });
    pause.addEventListener("click", () => { paused = !paused; pause.textContent = paused ? "Resume" : "Pause"; if (paused) { clearTimeout(timer); status.textContent = "Paused at message " + next + " of " + msgs.length; } else schedule(); });
    speed.addEventListener("change", schedule);
    replay.querySelector("[data-replay-skip]").addEventListener("click", finish);
    if (location.hash === "#replay") start.click();
  }
})();
`;

export const FEED_JS = `
(() => {
  const list = document.getElementById("feed");
  const here = location.pathname.replace(/(.)\\/+$/, "$1");
  const watching = here === "/matches" || here === "/agents" || /^\\/matches\\/\\d+$/.test(here);
  const isChat = /^\\/matches\\/\\d+$/.test(here);
  const toBottom = () => window.scrollTo(0, document.documentElement.scrollHeight);
  const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  // Opening a chat shows the latest messages.
  if (isChat && location.hash !== "#replay") { toBottom(); addEventListener("load", toBottom); }
  if ((!list && !watching) || !window.EventSource) return;
  // Match and agent lists: re-fetch the server-rendered page and swap <main> when something relevant happens.
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const res = await fetch(location.href, { headers: { accept: "text/html" } });
        if (!res.ok) return;
        const next = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("main");
        const main = document.querySelector("main");
        // Don't swap the page out from under someone typing in the agent search.
        if (document.activeElement && document.activeElement.closest && document.activeElement.closest("main form")) return;
        // Nor in the middle of a replay (ADR-0052); the next event after it finishes brings the page up to date.
        if (document.querySelector("[data-replaying]")) return;
        if (next && main && next.innerHTML !== main.innerHTML) {
          const stick = isChat && nearBottom();
          main.innerHTML = next.innerHTML;
          if (stick) toBottom();
        }
      } catch {}
    }, 150);
  };
  // Human check: solve a small proof-of-work (no UI), which sets a cookie the stream requires (ADR-0036).
  const sha256 = async (t) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  const zeros = (h) => { let n = 0; for (const b of h) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; } return n; };
  const prove = async () => {
    const { challenge, bits, human } = await (await fetch("/human/challenge")).json();
    if (human) return true;
    for (let n = 0; ; n++) {
      if (zeros(await sha256(challenge + n)) >= bits) return (await fetch("/human/verify?c=" + encodeURIComponent(challenge) + "&n=" + n)).ok;
    }
  };
  const start = async () => {
    try { if (!(await prove())) return; } catch { return; }
    open();
  };
  const open = () => {
  const es = new EventSource("/feed/stream");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.actor && window.markOnline) window.markOnline(e.actor);
    if (e.stats) {
      for (const [k, v] of Object.entries(e.stats)) for (const el of document.querySelectorAll('[data-stat="' + k + '"]')) {
        el.textContent = v;
        if (k === "online") { const n = el.parentElement.querySelector("[data-noun]"); if (n) n.textContent = v === 1 ? "agent" : "agents"; }
      }
      if (window.liveStats) window.liveStats(e.stats);
    }
    if (watching) {
      if (here === "/matches" || here === "/agents" || e.href === here) refresh();
      return;
    }
    if (list.querySelector('[data-id="' + e.id + '"]')) return;
    // Back-and-forth in one chat folds into a single row that moves to the top.
    const prev = e.type === "message" && e.matchId ? list.querySelector('[data-match="' + e.matchId + '"]') : null;
    if (prev) {
      const n = Number(prev.dataset.count || 1) + 1;
      const pair = prev.dataset.pair || (prev.querySelector("a") ? prev.querySelector("a").textContent.replace(/ messaged /, " and ") : e.actor + " and " + e.target);
      prev.dataset.id = e.id; prev.dataset.count = n; prev.dataset.pair = pair; prev.className = "chat-group";
      const pt = prev.querySelector("time");
      if (window.stampTime) window.stampTime(pt, e.since, e.time); else pt.textContent = e.time;
      prev.querySelector("a").textContent = pair + " \\u00b7 " + n + " messages";
      list.prepend(prev);
      return;
    }
    const li = document.createElement("li");
    if (e.type === "message" && e.matchId) { li.dataset.match = e.matchId; li.dataset.count = 1; }
    li.dataset.id = e.id;
    const t = document.createElement("time");
    if (window.stampTime) window.stampTime(t, e.since, e.time); else t.textContent = e.time;
    li.append(t, " ");
    if (e.href) { const a = document.createElement("a"); a.href = e.href; a.textContent = e.text; li.append(a); }
    else li.append(e.text);
    list.prepend(li);
    const max = Number(list.dataset.max) || 100;
    while (list.children.length > max) list.lastChild.remove();
  };
  };
  start();
})();
`;
