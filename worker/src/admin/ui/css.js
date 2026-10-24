// worker/src/admin/ui/css.js
// Panel stylesheet, served as /admin/app.css. Light and dark follow the device setting.
// Phone (under 900px): one column of stacked cards, Edit opens a full-screen form.
// Desktop: sidebar, list in the middle, the selected item's detail on the right.

export const CLIENT_CSS = String.raw`
:root{
  --bg:#F6F1E4;--panel:#fff;--panel2:#FBF8F0;--ink:#2b2b2b;--muted:#6b6b63;--line:#e3dccb;
  --accent:#3F5233;--accent-ink:#fff;--bad:#A33B2B;--bad-bg:#f9e4e0;--warn:#8a5a00;--warn-bg:#fdf0d5;
  --ok:#2f6b3a;--ok-bg:#e1f0e1;--info-bg:#e7ecf5;--info:#2c4a7a;--focus:#c98a00;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#141712;--panel:#1f241c;--panel2:#262c22;--ink:#e9e7e0;--muted:#a4a69b;--line:#353c30;
  --accent:#9cc28a;--accent-ink:#13200d;--bad:#ee8f80;--bad-bg:#3b211d;--warn:#f0c46a;--warn-bg:#352a12;
  --ok:#93d39b;--ok-bg:#1d3320;--info-bg:#1c2738;--info:#a8c2ee;--focus:#f0c46a;
}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
a{color:var(--accent)}
button,select,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.loading{padding:24px}
.app{display:flex;flex-direction:column;min-height:100vh}
header.top{background:var(--panel);border-bottom:1px solid var(--line);padding:10px 16px}
header.top h1{font-size:1.1rem;margin:0 0 8px;color:var(--accent)}
.strip{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:.9rem}
.chip b{font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;background:var(--muted);flex:none}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
.switch{position:relative;width:46px;height:26px;border-radius:13px;border:1px solid var(--line);background:var(--panel);cursor:pointer;padding:0;flex:none}
.switch::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--muted);transition:left .15s}
.switch[aria-checked="true"]{background:var(--warn-bg);border-color:var(--warn)}
.switch[aria-checked="true"]::after{left:22px;background:var(--warn)}
nav.side{display:flex;gap:4px;overflow-x:auto;background:var(--panel);border-bottom:1px solid var(--line);padding:6px 8px}
nav.side button{border:0;background:none;padding:8px 12px;border-radius:8px;white-space:nowrap;cursor:pointer;color:var(--muted)}
nav.side button[aria-current="page"]{background:var(--accent);color:var(--accent-ink)}
nav.side .n{display:inline-block;min-width:1.4em;margin-left:6px;padding:0 6px;border-radius:10px;background:var(--panel2);color:var(--ink);font-size:.8rem;text-align:center}
nav.side button[aria-current="page"] .n{background:rgba(255,255,255,.25);color:inherit}
.main{flex:1;display:flex;min-height:0}
.list{flex:1;padding:12px;display:flex;flex-direction:column;gap:12px;min-width:0}
.detail{display:none}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;background:var(--panel);padding:6px 12px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--accent);color:var(--accent-ink)}
.spacer{flex:1}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.card h2{font-size:1.05rem;margin:0 0 4px}
.card h3{font-size:.95rem;margin:12px 0 4px}
.card.sel{outline:2px solid var(--accent)}
.card.done{opacity:.55}
.meta{color:var(--muted);font-size:.88rem}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.badge{font-size:.78rem;padding:2px 8px;border-radius:10px;background:var(--panel2);border:1px solid var(--line)}
.badge.bad{background:var(--bad-bg);color:var(--bad);border-color:transparent}
.badge.warn{background:var(--warn-bg);color:var(--warn);border-color:transparent}
.badge.info{background:var(--info-bg);color:var(--info);border-color:transparent}
.badge.ok{background:var(--ok-bg);color:var(--ok);border-color:transparent}
.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.two{display:grid;gap:10px}
.two>div{background:var(--panel2);border-radius:8px;padding:8px 10px}
.imgs{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.imgs a{display:block;border-radius:6px;overflow:hidden;border:2px solid transparent;background:var(--panel2)}
.imgs a.main-img{border-color:var(--accent)}
.imgs img{display:block;height:140px;max-width:100%;object-fit:contain}
.photo img{display:block;width:100%;max-height:360px;object-fit:contain;background:var(--panel2);border-radius:8px}
.copies{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.copies img{display:block;width:100%;height:200px;object-fit:contain;background:var(--panel2);border-radius:8px}
.tick{display:flex;align-items:center;gap:8px;margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--warn-bg);color:var(--warn)}
.tick input{width:22px;height:22px;accent-color:var(--accent)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.btn{border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:9px 14px;cursor:pointer;min-height:42px;text-decoration:none;color:var(--ink);display:inline-flex;align-items:center}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.danger{color:var(--bad);border-color:var(--bad)}
.btn.link{border:0;background:none;padding:9px 6px;color:var(--accent);text-decoration:underline}
.btn[disabled]{opacity:.45;cursor:not-allowed}
label.f{display:block;margin:10px 0 4px;font-weight:600;font-size:.9rem}
input.f,select.f,textarea.f{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:16px}
textarea.f{min-height:120px;resize:vertical;line-height:1.4}
.note{font-size:.88rem;padding:8px 10px;border-radius:8px;background:var(--info-bg);color:var(--info);margin:8px 0}
.note.warn{background:var(--warn-bg);color:var(--warn)}
.note.bad{background:var(--bad-bg);color:var(--bad)}
.empty{color:var(--muted);padding:24px 8px;text-align:center}
.section{margin-top:8px;font-size:1rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.overlay{position:fixed;inset:0;background:var(--bg);z-index:10;overflow:auto;padding:12px 16px 80px}
.overlay .bar{position:sticky;top:-12px;display:flex;align-items:center;gap:8px;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);margin-bottom:8px}
.overlay .bar h2{flex:1;font-size:1.05rem;margin:0}
.toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:92vw;background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:8px;z-index:20;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.toast.bad{background:var(--bad);color:#fff}
table.h{width:100%;border-collapse:collapse;font-size:.9rem}
table.h td,table.h th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
@media (min-width:900px){
  .app{display:grid;grid-template-columns:210px 1fr;grid-template-rows:auto 1fr;height:100vh}
  header.top{grid-column:1 / span 2}
  nav.side{flex-direction:column;overflow:visible;border-bottom:0;border-right:1px solid var(--line);padding:12px 8px}
  nav.side button{text-align:left;display:flex;justify-content:space-between}
  .main{overflow:hidden}
  .list{flex:0 0 42%;max-width:520px;overflow:auto;border-right:1px solid var(--line)}
  .list .card{cursor:pointer;padding:10px 12px}
  .list .card .text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .detail{display:block;flex:1;overflow:auto;padding:16px}
  .detail .card{padding:18px}
  .two{grid-template-columns:1fr 1fr}
  .list.wide{flex:1;max-width:none;border-right:0}
}
`;
