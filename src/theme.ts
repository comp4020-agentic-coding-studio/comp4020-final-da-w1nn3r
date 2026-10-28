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
.stat{position:relative;transition:border-color .3s,box-shadow .3s}
.stat b{transform-origin:left center;will-change:transform}
.stat.bump{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 12px 34px -12px var(--glow);animation:tilebump .9s ease-out}
.stat.bump b{animation:numpop .55s cubic-bezier(.2,1.6,.4,1)}
.stat .gain{position:absolute;top:.55rem;right:.8rem;font:700 .85rem var(--mono);color:var(--online);pointer-events:none;animation:gain 1.3s ease-out forwards}
@keyframes numpop{0%{transform:scale(1)}35%{transform:scale(1.22)}100%{transform:scale(1)}}
@keyframes tilebump{0%{background-color:var(--surface2)}100%{background-color:var(--surface)}}
@keyframes gain{0%{opacity:0;transform:translateY(.6rem) scale(.8)}20%{opacity:1;transform:translateY(0) scale(1.1)}100%{opacity:0;transform:translateY(-1.6rem) scale(1)}}

.feed,.cards,.chat,.plain{list-style:none;padding:0;margin:0}
.feed{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:.4rem 1rem;font:.88rem/1.5 var(--mono)}
.feed li{display:flex;flex-wrap:wrap;gap:.2rem .8rem;padding:.55rem 0;border-bottom:1px dashed var(--line)}
.feed li:last-child{border-bottom:0}
.feed li::before{content:"\\203A";color:var(--accent);font-weight:700}
.feed time{order:-1;flex:none}
.feed li>:last-child{overflow-wrap:anywhere}

.feed li.ev{display:flex;flex-wrap:nowrap;align-items:center;gap:.8rem;padding:.7rem 0}
.feed li.ev::before{content:none}
.feed li.ev time{order:0;margin-left:auto;align-self:flex-start;font:.72rem var(--mono);color:var(--muted);white-space:nowrap}
.ev-av{display:flex;flex:none;align-items:center}
.ev-av .avatar{width:2.3rem;height:2.3rem;font-size:1.25rem;box-shadow:none}
.ev-av .avatar.initial{font-size:1rem}
.ev-av .avatar+.avatar{margin-left:-.55rem}
.ev-main{display:flex;flex-direction:column;gap:.1rem;min-width:0;font:.92rem/1.4 var(--font);overflow-wrap:anywhere}
.ev-main a{color:var(--fg)}.ev-main a:hover{color:var(--accent2)}
.ev-arrow{color:var(--accent2)}
.ev-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .2rem}
.ev-n{font:.75rem var(--mono);color:var(--muted)}
.ev-n:empty{display:none}
.ev-sub{display:block;color:var(--muted);font-size:.84rem}
.ev-quote{font-style:italic;color:var(--fg);opacity:.8;border-left:2px solid var(--accent);padding-left:.6rem;margin-top:.25rem}
.ev-like{opacity:.8;padding:.4rem 0!important}
.ev-like .ev-av .avatar{width:1.6rem;height:1.6rem;font-size:.9rem}
.ev-like .ev-av .avatar.initial{font-size:.75rem}
.ev-like .ev-main{font-size:.85rem}
.ev-join .ev-main a b{background:linear-gradient(100deg,var(--accent2),var(--accent3));-webkit-background-clip:text;background-clip:text;color:transparent}
.ev-ended .ev-av{filter:grayscale(.7);opacity:.85}
.feed li.ev-match{margin:.5rem 0;padding:.85rem 1rem;border:1px solid var(--accent);border-radius:var(--radius);background:linear-gradient(135deg,rgba(159,85,216,.2),rgba(222,58,200,.12))}
.ev-kicker{font:700 .72rem var(--mono);letter-spacing:.08em;text-transform:uppercase;background:linear-gradient(100deg,var(--accent2),var(--accent3));-webkit-background-clip:text;background-clip:text;color:transparent}
.ev-match .ev-main a{font-size:1.02rem;font-weight:600}
.ev-match .ev-av .avatar{width:2.6rem;height:2.6rem}
.ev-match .ev-av .avatar+.avatar{margin-left:0}
.ev-heart{margin:0 .35rem;font-size:1.3rem;animation:heartbeat 1.6s ease-in-out infinite}
@keyframes heartbeat{0%,100%{transform:scale(1)}15%{transform:scale(1.25)}30%{transform:scale(1)}45%{transform:scale(1.15)}}
.feed li.ev.fresh{animation:evin .55s ease-out}
.feed li.ev-match.fresh{animation:evmatch 1.1s cubic-bezier(.2,1.4,.4,1)}
@keyframes evin{from{opacity:0;transform:translateY(-12px);background-color:var(--surface2)}to{opacity:1;transform:none;background-color:transparent}}
@keyframes evmatch{0%{opacity:0;transform:scale(.92);box-shadow:0 0 0 0 var(--glow)}40%{opacity:1;transform:scale(1.03);box-shadow:0 0 0 .6rem rgba(159,85,216,.0),0 0 40px 4px var(--glow)}100%{transform:none;box-shadow:0 0 0 0 transparent}}

.hot:empty{display:none}
.hot h2{margin:1.4rem 0 .7rem}
.hot-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.9rem;list-style:none;padding:0;margin:0 0 1rem}
.hot-card a{display:flex;flex-direction:column;gap:.4rem;height:100%;padding:1rem 1.1rem;color:var(--fg);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);transition:transform .2s,border-color .2s,box-shadow .2s}
.hot-card a:hover{text-decoration:none;transform:translateY(-3px);border-color:var(--accent);box-shadow:0 18px 40px -22px var(--glow)}
.hot-label{font:700 .72rem var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--accent2)}
.hot-pair{display:flex;align-items:center;gap:.55rem;font-size:1rem;min-width:0}
.hot-pair b{min-width:0;overflow-wrap:anywhere}
.hot-pair .avatar{width:2.3rem;height:2.3rem;font-size:1.25rem;box-shadow:none}
.hot-pair .avatar.initial{font-size:1rem}
.hot-pair .avatar+.avatar{margin-left:-1.1rem}
.hot.flash .hot-card a{animation:hotflash 1.1s ease-out}
@keyframes hotflash{0%{border-color:var(--accent2);box-shadow:0 0 0 3px var(--glow)}100%{border-color:var(--line);box-shadow:none}}

.watch-btn{flex:none;align-self:flex-start;font:600 .72rem var(--mono);padding:.2rem .7rem;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer}
.watch-btn:hover,.watch-btn:focus-visible{border-color:var(--accent);background:var(--surface2)}
.hot-card{position:relative}
.hot-card>.watch-btn{position:absolute;top:.8rem;right:.9rem;z-index:1}
.card .pair{display:flex;align-items:center;flex-wrap:wrap;gap:.4rem .6rem}
.card .pair .watch-btn{margin-left:auto}

#watch{position:fixed;top:3.7rem;right:0;bottom:0;width:min(24rem,100vw);z-index:40;display:flex;flex-direction:column;background:var(--bg2);border-left:1px solid var(--line);
  box-shadow:-24px 0 50px -30px rgba(0,0,0,.7);transition:transform .25s ease}
#watch[hidden]{display:none}
#watch.collapsed{transform:translateX(105%)}
.watch-head{display:flex;align-items:center;gap:.4rem;padding:.7rem .8rem;border-bottom:1px solid var(--line)}
.watch-who{display:flex;align-items:center;min-width:0;flex:1;gap:.5rem;font:600 .9rem var(--font);color:var(--fg)}
.watch-who .avatar{width:2rem;height:2rem;font-size:1.1rem;box-shadow:none}
.watch-who .avatar+.avatar{margin-left:-.9rem}
.watch-who span.t{min-width:0;overflow-wrap:anywhere;line-height:1.25}
.watch-x{flex:none;width:2rem;height:2rem;display:grid;place-items:center;font:700 1.2rem var(--font);line-height:1;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--fg);cursor:pointer}
.watch-x:hover,.watch-x:focus-visible{border-color:var(--accent);background:var(--surface2)}
.watch-scroll{flex:1;overflow-y:auto;padding:.8rem .8rem 1rem}
.watch-scroll .chat{gap:.55rem}
.watch-scroll .msg{max-width:92%;padding:.5rem .8rem;font-size:.9rem}
.watch-note{margin:0 0 .8rem;padding:.5rem .7rem;border:1px dashed var(--line);border-radius:var(--radius);font-size:.82rem;color:var(--muted)}
.watch-note[hidden]{display:none}
.watch-open{display:block;margin:.8rem;text-align:center}
.watch-tab{position:fixed;right:0;top:45%;z-index:40;display:flex;align-items:center;gap:.4rem;padding:.7rem .6rem;border:1px solid var(--line);border-right:0;border-radius:var(--radius) 0 0 var(--radius);
  background:var(--bg2);color:var(--fg);font:600 .8rem var(--mono);cursor:pointer;writing-mode:vertical-rl;box-shadow:-10px 0 30px -18px rgba(0,0,0,.7)}
.watch-tab[hidden]{display:none}
.watch-tab:hover,.watch-tab:focus-visible{border-color:var(--accent)}
.watch-tab.unread::after{content:"";width:.55rem;height:.55rem;border-radius:50%;background:var(--online);box-shadow:0 0 .6rem var(--online);animation:pulse 2s infinite}
/* The panel pushes the page aside without widening it: same 66rem column, centred in what is left, so the grids keep 3 to a row.
   Below 1300px there is no room for that, so the panel simply covers the right of the page. */
@media(min-width:1300px){body.watching main{max-width:66rem;margin-left:max(0px,calc((100vw - 24rem - 66rem) / 2));margin-right:24rem}}
.watch-back{margin-top:.6rem;font:inherit;font-weight:600;cursor:pointer;padding:.45rem 1.1rem}
@media(max-width:640px){#watch{top:0;width:100vw}}
.mcard{display:flex;flex-direction:column;gap:.15rem}
.mcard.is-ended{opacity:.85}
.mc-top{display:flex;align-items:center;gap:.7rem}
.mc-av{display:flex;flex:none}
.mc-av .avatar{width:2.6rem;height:2.6rem;font-size:1.4rem;box-shadow:none}
.mc-av .avatar.initial{font-size:1.1rem}
.mc-av .avatar+.avatar{margin-left:-.8rem}
.mcard.is-ended .mc-av{filter:grayscale(.6)}
.mc-who{display:flex;flex-direction:column;min-width:0;flex:1}
.mc-pair{color:var(--fg);font-size:1.02rem;overflow-wrap:anywhere}
.mc-pair:hover{color:var(--accent2);text-decoration:none}
.mc-top .watch-btn{align-self:center}
.mcard .models{font-size:.78rem;margin:.5rem 0 .2rem}
.mcard .ev-quote{margin:.3rem 0}
.mcard .mc-meta{margin:.4rem 0 0;font-size:.8rem}

.match-hero{margin:0 0 1.2rem;padding:1.4rem 1.5rem;border:1px solid var(--line);border-radius:var(--radius);background:linear-gradient(135deg,rgba(159,85,216,.16),rgba(222,58,200,.08))}
.match-hero.is-ended{background:var(--surface)}
.match-hero h1{margin:.3rem 0 .8rem}
.match-hero .duo{margin:.2rem 0 .6rem}
.match-hero p{margin:.4rem 0 0}
.duo-card{display:flex;min-width:0}
.duo-card .side{flex:1}
.match-hero .duo .heart{animation:heartbeat 1.6s ease-in-out infinite}
.match-hero.is-ended .duo .heart{animation:none;filter:grayscale(1);opacity:.6}
.chat .msg{display:flex;align-items:flex-end;gap:.55rem;padding:0;border:0;background:none;border-radius:0;max-width:min(36rem,92%)}
.chat .msg.right{flex-direction:row-reverse;background:none;border-radius:0}
.msg-av{flex:none}
.msg-av .avatar{width:2rem;height:2rem;font-size:1.1rem;box-shadow:none}
.msg-av .avatar.initial{font-size:.9rem}
.msg-body{min-width:0;padding:.6rem .95rem;border-radius:18px 18px 18px 4px;background:var(--surface2);border:1px solid var(--line)}
.msg.right .msg-body{border-radius:18px 18px 4px 18px;background:linear-gradient(135deg,rgba(159,85,216,.28),rgba(192,70,208,.24))}
.msg-body b{font:600 .82rem var(--font);color:var(--accent2)}
.msg.right .msg-body b{color:var(--accent3)}
.msg-body .handle{font:.72rem var(--mono);margin-left:.3rem}
.msg-body time{font:.72rem var(--mono);color:var(--muted)}
.ended-note{margin:1.2rem 0 0;padding:.8rem 1rem;border:1px dashed var(--line);border-radius:var(--radius);background:var(--surface)}
.watch-scroll .msg{max-width:100%}
.watch-scroll .msg-av .avatar{width:1.6rem;height:1.6rem;font-size:.9rem}
.watch-scroll .msg-body{padding:.45rem .75rem}
.watch-note .ev-quote{margin-top:.3rem}
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
  // Watch a conversation in a side panel (ADR-0074). The panel is built from the match page itself, so the transcript
  // markup is the server's, already escaped; a live event on that match fetches it again. Hide folds it into a tab,
  // Close removes it. What you are watching is remembered for the tab session, and #watch-ID in the address opens it.
  const store = {
    get() { try { return JSON.parse(sessionStorage.getItem("watch") || "null"); } catch { return null; } },
    set(v) { try { if (v) sessionStorage.setItem("watch", JSON.stringify(v)); else sessionStorage.removeItem("watch"); } catch {} },
  };
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let panel = null, tab = null, scroller = null, chatEl = null, noteEl = null, whoEl = null, watchId = 0, wTimer = 0, opener = null;
  const setHidden = (h) => {
    panel.classList.toggle("collapsed", h); panel.inert = h; tab.hidden = !h;
    panel.querySelector("[data-watch-hide]").setAttribute("aria-expanded", String(!h));
    document.body.classList.toggle("watching", !h);
    if (!h) tab.classList.remove("unread");
    store.set({ id: watchId, hidden: h });
  };
  const closeWatch = () => {
    clearTimeout(wTimer); watchId = 0; store.set(null);
    if (panel) { panel.hidden = true; tab.hidden = true; document.body.classList.remove("watching"); }
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  };
  const build = () => {
    panel = document.createElement("aside");
    panel.id = "watch"; panel.tabIndex = -1; panel.hidden = true;
    panel.setAttribute("aria-label", "Watching a conversation");
    panel.innerHTML = '<div class="watch-head"><a class="watch-who" href="/matches"></a><button type="button" class="watch-x" data-watch-hide aria-label="Hide the conversation panel" aria-expanded="true">&minus;</button><button type="button" class="watch-x" data-watch-close aria-label="Close the conversation panel">&times;</button></div><div class="watch-scroll"><p class="watch-note" hidden></p><ul class="chat" aria-live="polite"></ul><a class="btn watch-open" href="/matches">Open the full page</a></div>';
    tab = document.createElement("button");
    tab.type = "button"; tab.className = "watch-tab"; tab.hidden = true; tab.textContent = "\\u{1F4AC} Watching";
    tab.setAttribute("aria-label", "Show the conversation panel");
    document.body.append(panel, tab);
    scroller = panel.querySelector(".watch-scroll"); chatEl = panel.querySelector(".chat"); noteEl = panel.querySelector(".watch-note"); whoEl = panel.querySelector(".watch-who");
    panel.querySelector("[data-watch-hide]").addEventListener("click", () => { setHidden(true); tab.focus(); });
    panel.querySelector("[data-watch-close]").addEventListener("click", closeWatch);
    tab.addEventListener("click", () => { setHidden(false); panel.focus(); });
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") closeWatch(); });
  };
  const loadWatch = async (first) => {
    const id = watchId;
    try {
      const res = await fetch("/matches/" + id, { headers: { accept: "text/html" } });
      if (!res.ok) { if (first && id === watchId) closeWatch(); return; }
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const next = doc.querySelector("ul.chat");
      if (!next || id !== watchId) return;
      const stick = first || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      const had = chatEl.children.length;
      whoEl.replaceChildren();
      for (const a of doc.querySelectorAll(".duo .avatar")) whoEl.append(document.importNode(a, true));
      const title = document.createElement("span");
      title.className = "t"; title.textContent = (doc.querySelector("h1.pair") || {}).textContent || "Conversation";
      whoEl.append(title); whoEl.href = "/matches/" + id;
      panel.querySelector(".watch-open").href = "/matches/" + id;
      const ended = doc.querySelector(".ended-note");
      noteEl.hidden = !ended; noteEl.replaceChildren();
      if (ended) for (const n of ended.childNodes) noteEl.append(document.importNode(n, true));
      chatEl.replaceChildren(...[...next.children].map((n, i) => {
        const li = document.importNode(n, true);
        if (!first && !calm && i >= had) li.classList.add("arrived");
        return li;
      }));
      for (const el of panel.querySelectorAll("time[data-since]")) if (window.stampTime) window.stampTime(el, Number(el.dataset.since), el.title);
      if (stick) scroller.scrollTop = scroller.scrollHeight;
      else if (chatEl.children.length > had && !tab.hidden) tab.classList.add("unread");
    } catch {}
  };
  const openWatch = (id, hidden, from) => {
    if (!panel) build();
    const same = watchId === id && !panel.hidden;
    watchId = id; opener = from || opener;
    panel.hidden = false; setHidden(!!hidden);
    if (!same) { chatEl.replaceChildren(); loadWatch(true); }
    if (!hidden && from) panel.focus();
  };
  const panelEvent = (e) => {
    if (!watchId || e.matchId !== watchId) return;
    if (e.type === "message" && panel.classList.contains("collapsed")) tab.classList.add("unread");
    clearTimeout(wTimer); wTimer = setTimeout(() => loadWatch(false), 150);
  };
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-watch]");
    if (!b) return;
    e.preventDefault();
    openWatch(Number(b.dataset.watch), false, b);
  });
  // The site sends no Referer, so remember the page before this one ourselves (this tab only). A reload keeps it.
  try {
    const last = sessionStorage.getItem("lastPage");
    if (last !== here) { if (last) sessionStorage.setItem("prevPage", last); sessionStorage.setItem("lastPage", here); }
  } catch {}
  // On a conversation page, "Watch in the side panel" goes back to the page you came from with this chat open there.
  // Without a usable previous page (a direct visit) it opens the home page on the chat (the link's own address).
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("[data-watch-back]");
    if (!a) return;
    e.preventDefault();
    const id = Number(a.dataset.watchBack);
    store.set({ id, hidden: false });
    let prev = "";
    try { prev = sessionStorage.getItem("prevPage") || ""; } catch {}
    if (history.length > 1 && ["/", "/feed", "/matches", "/agents"].includes(prev)) history.back();
    else location.assign("/#watch-" + id);
  });
  // Coming back to a page the browser kept: it did not run its start-up again, so pick up what was stored.
  addEventListener("pageshow", (e) => {
    const saved = store.get();
    if (e.persisted && !isChat && saved && saved.id) openWatch(Number(saved.id), !!saved.hidden);
  });
  if (!isChat) {
    const deep = location.hash.match(/^#watch-(\\d+)$/);
    const saved = store.get();
    if (deep) openWatch(Number(deep[1]), false);
    else if (saved && saved.id) openWatch(Number(saved.id), !!saved.hidden);
  }
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
  // Home page tiles: a rise is counted up, popped and flagged with "+N"; a fall just sets the number.
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const bump = (el, to) => {
    const tile = el.closest(".stat");
    const from = Number(el.dataset.shown ?? el.textContent) || 0;
    el.dataset.shown = to;
    cancelAnimationFrame(Number(el.dataset.raf || 0));
    if (to <= from || reduce) { el.textContent = to; return; }
    const gain = to - from + Number(tile.dataset.pending || 0);
    tile.dataset.pending = gain;
    tile.classList.remove("bump"); void tile.offsetWidth; tile.classList.add("bump");
    const tag = document.createElement("span");
    tag.className = "gain"; tag.textContent = "+" + gain; tag.setAttribute("aria-hidden", "true");
    for (const old of tile.querySelectorAll(".gain")) old.remove();
    tile.append(tag);
    setTimeout(() => { tag.remove(); tile.dataset.pending = 0; tile.classList.remove("bump"); }, 1300);
    const t0 = performance.now(), ms = Math.min(1400, 500 + (to - from) * 40);
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      el.textContent = Math.round(from + (to - from) * ease(t));
      if (t < 1) el.dataset.raf = requestAnimationFrame(frame);
    };
    el.dataset.raf = requestAnimationFrame(frame);
  };
  // "Hot right now": the cards are server-rendered, so when something happens, fetch the page again (at most every 8 s) and swap them.
  let hotTimer = 0;
  const refreshHot = () => {
    if (hotTimer) return;
    hotTimer = setTimeout(async () => {
      hotTimer = 0;
      try {
        const res = await fetch(location.href, { headers: { accept: "text/html" } });
        if (!res.ok) return;
        const next = new DOMParser().parseFromString(await res.text(), "text/html").getElementById("hot");
        const cur = document.getElementById("hot");
        if (!next || !cur || next.innerHTML === cur.innerHTML) return;
        cur.innerHTML = next.innerHTML;
        for (const el of cur.querySelectorAll("time[data-since]")) if (window.stampTime) window.stampTime(el, Number(el.dataset.since), el.title);
        cur.classList.remove("flash"); void cur.offsetWidth; cur.classList.add("flash");
      } catch {}
    }, 8000);
  };
  const open = () => {
  const es = new EventSource("/feed/stream");
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    panelEvent(e);
    if (e.actor && window.markOnline) window.markOnline(e.actor);
    if (e.stats) {
      for (const [k, v] of Object.entries(e.stats)) for (const el of document.querySelectorAll('[data-stat="' + k + '"]')) {
        if (el.closest(".stat")) bump(el, v); else el.textContent = v;
        if (k === "online") { const n = el.parentElement.querySelector("[data-noun]"); if (n) n.textContent = v === 1 ? "agent" : "agents"; }
      }
      if (window.liveStats) window.liveStats(e.stats);
    }
    if (document.getElementById("hot")) refreshHot();
    if (watching) {
      if (here === "/matches" || here === "/agents" || e.href === here) refresh();
      return;
    }
    if (list.querySelector('[data-id="' + e.id + '"]') || !e.html) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = e.html;
    const li = tpl.content.firstElementChild;
    if (!li) return;
    // Back-and-forth in one chat folds into a single row that moves to the top.
    if (e.type === "message" && e.matchId) {
      const prev = list.querySelector('[data-match="' + e.matchId + '"]');
      if (prev) {
        const n = Number(prev.dataset.count || 1) + 1;
        li.dataset.count = n;
        const c = li.querySelector(".ev-n");
        if (c) c.textContent = " \\u00b7 " + n + " messages";
        prev.remove();
      }
    }
    const t = li.querySelector("time");
    if (t && window.stampTime) window.stampTime(t, e.since, e.time);
    for (const old of list.querySelectorAll("li:not([data-id])")) old.remove();
    li.classList.add("fresh");
    list.prepend(li);
    const max = Number(list.dataset.max) || 100;
    while (list.children.length > max) list.lastChild.remove();
  };
  };
  start();
})();
`;
