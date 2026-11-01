// worker/src/admin/ui/css.js
// Panel stylesheet, served as /admin/app.css. Light and dark follow the device setting.
// Phone (under 900px): one column of stacked cards, Edit opens a full-screen form.
// Desktop: sidebar, list in the middle, the selected item's detail on the right.
// Photos: a collapsible folder tree (sidebar; full-screen Move to… list on phones),
// tick boxes, a multi-select bar, drag and drop onto folders, and an Undo pop-up.
// Contacts: a searchable list with filters, and a page per contact with Save per field.

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
.intro{margin:2px 2px 12px;line-height:1.4}
.card.sum{margin-bottom:10px}
.sum-h{font:inherit;font-weight:700;background:none;border:0;padding:0;color:var(--accent);cursor:pointer;text-decoration:none;text-align:left}
span.sum-h{color:inherit;cursor:default}
.sum-l{margin:6px 0 0;padding-left:18px;line-height:1.5}
.sum-l li{margin:2px 0}
.sum-clear{margin:0;color:var(--ok)}
.chip-link{padding:0;min-height:0;color:inherit}
.nlstats tbody tr{cursor:pointer}
.sv-bars{display:flex;align-items:flex-end;gap:2px;height:120px;margin:.5rem 0 1rem;border-bottom:1px solid var(--line,#ccc)}
.sv-bar{flex:1;height:100%;display:flex;align-items:flex-end}
.sv-bar span{display:block;width:100%;background:var(--accent);border-radius:2px 2px 0 0}
.sv-bar.today span{opacity:.5}
.nlstats tr.sel td{background:var(--panel2);font-weight:600}
.draft-bar{display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.draft-bar .actions{margin:0}
.draft-frame{display:block;width:100%;height:78vh;border:1px solid var(--line);border-radius:10px;background:#fff}
.sum-hol{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.their-h{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:10px 0 4px}
.their-fold summary,.their-more summary{cursor:pointer;color:var(--muted);margin:8px 0}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.badge{font-size:.78rem;padding:2px 8px;border-radius:10px;background:var(--panel2);border:1px solid var(--line)}
.badge.bad{background:var(--bad-bg);color:var(--bad);border-color:transparent}
.badge.warn{background:var(--warn-bg);color:var(--warn);border-color:transparent}
.badge.info{background:var(--info-bg);color:var(--info);border-color:transparent}
.badge.ok{background:var(--ok-bg);color:var(--ok);border-color:transparent}
button.chip{font:inherit;color:inherit;cursor:pointer}
.fbtext{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.fbmsg{border-top:1px solid var(--line);padding-top:6px;margin-top:6px}
nav.side .n.attn{background:var(--bad-bg);color:var(--bad);box-shadow:inset 0 0 0 1px var(--bad);font-weight:600}
.fbnotes,.fbdraft{margin:8px 0;padding:8px 10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px}
.text{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.two{display:grid;gap:10px}
.two>div{background:var(--panel2);border-radius:8px;padding:8px 10px}
.imgs{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.imgs a{display:block;border-radius:6px;overflow:hidden;border:2px solid transparent;background:var(--panel2)}
.imgs a.main-img{border-color:var(--accent)}
.imgs img{display:block;height:140px;max-width:100%;object-fit:contain}
.photo img{display:block;width:100%;max-height:360px;object-fit:contain;background:var(--panel2);border-radius:8px}
.filebox{margin-top:14px;border-top:1px solid var(--line);padding-top:8px;font-size:.88rem}
.filebox summary{cursor:pointer;font-weight:600;padding:4px 0}
.filebox form{margin:4px 0 8px}
.filebox select.f+.toolbar{margin-top:6px}
.filebox label.f,.small label.f{font-size:.82rem;margin:8px 0 3px}
.small textarea.f{min-height:64px}
.copies{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.copies img{display:block;width:100%;height:200px;object-fit:contain;background:var(--panel2);border-radius:8px}
.suggest{margin:12px 0 4px;padding-top:8px;border-top:1px solid var(--line)}
.suggest h3{margin:0 0 6px}
.sg-list{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.sg{margin:0;display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;border:2px solid var(--line);background:var(--panel2);min-width:0}
.sg.chosen{border-color:var(--accent)}
.sg img,.sg .sg-none{display:block;width:100%;height:120px;object-fit:contain;background:var(--panel);border-radius:6px}
.sg .sg-none{display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:.85rem}
.sg-src{font-size:.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.sg figcaption{font-size:.82rem;display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere;flex:1}
.sg-links{display:flex;flex-wrap:wrap;gap:4px 10px}
.sg .btn{justify-content:center}
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
.ask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:15;display:flex;align-items:center;justify-content:center;padding:16px}
.ask .box{background:var(--bg);color:var(--ink);max-width:560px;width:100%;max-height:90vh;overflow:auto;border-radius:10px;padding:16px;box-shadow:0 4px 20px rgba(0,0,0,.3)}
.ask .msg{white-space:pre-line;margin:0 0 10px}
.onsite a{overflow-wrap:anywhere}
.toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:92vw;background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:8px;z-index:20;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.toast.bad{background:var(--bad);color:#fff}
.msgs .msg{border-radius:8px;padding:8px 12px;margin:8px 0;border:1px solid var(--line)}
.msgs .msg.them{background:var(--panel2);margin-right:12%}
.msgs .msg.holly,.msgs .msg.you{margin-left:12%;border-left:4px solid var(--accent,#3F5233)}
.msgs .msg.you{border-left-color:var(--muted)}
.msgs .msg-h{font-size:.85em;color:var(--muted);margin-bottom:4px}
.cfield #c-village-own{margin-top:6px}
.toast .btn.link{color:inherit;text-decoration:underline;margin-left:6px}
.waitbar{position:fixed;left:50%;top:10px;transform:translateX(-50%);max-width:92vw;background:var(--panel);color:var(--ink);border:1px solid var(--line);padding:6px 14px;border-radius:999px;z-index:19;font-size:.9em;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.folders{display:flex;flex-direction:column;gap:2px;margin:2px 0 8px}
.ftools{display:flex;flex-direction:column;gap:2px;margin:2px 0 4px}
.ftools input.f{padding:5px 8px;font-size:.85rem}
.fbtns{display:flex;gap:4px}
.fbtns .btn.link{padding:2px 4px;min-height:0;font-size:.8rem}
.tree{display:flex;flex-direction:column;gap:1px}
.tree [role="treeitem"]{display:flex;align-items:center;gap:4px;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:.82rem;color:var(--muted);user-select:none}
.tree [role="treeitem"]:hover{background:var(--panel2)}
.tree [role="treeitem"].top{font-weight:700;color:var(--ink);margin-top:3px}
.tree [role="treeitem"][aria-current="page"]{background:var(--accent);color:var(--accent-ink)}
.tree [role="treeitem"][aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.tree .tw{flex:none;width:1.1em;text-align:center;font-size:.9em}
.tree .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tree .here{font-size:.8em;font-weight:400}
.tree .n{display:inline-block;min-width:1.4em;padding:0 6px;border-radius:10px;background:var(--panel2);color:var(--ink);font-size:.8rem;text-align:center;font-weight:400}
.tree [aria-current="page"] .n{background:rgba(255,255,255,.25);color:inherit}
.tree [role="treeitem"].drop{outline:2px dashed var(--accent);outline-offset:-2px;background:var(--ok-bg);color:var(--ink)}
.tree [role="treeitem"].nodrop{opacity:.5}
.tree [role="treeitem"].bin{color:var(--muted);font-style:italic;margin-top:6px;border-top:1px dashed var(--line)}
.tree [role="treeitem"].bin.drop{opacity:1}
.move-tree .ftools input.f{font-size:16px;padding:10px}
.move-tree .fbtns .btn.link{font-size:.95rem;padding:8px 6px}
.move-tree .tree{gap:6px}
.move-tree .tree [role="treeitem"]{min-height:52px;font-size:1rem;padding:8px 12px;border:1px solid var(--line);background:var(--panel);border-radius:8px;color:var(--ink)}
.move-tree .tree .tw{width:1.8em;font-size:1.2em;padding:8px 0}
.pick{float:right;display:flex;align-items:center;padding:4px;margin:-4px -4px 0 6px;cursor:pointer}
.pick input{width:22px;height:22px;accent-color:var(--accent);cursor:pointer}
.pickbar{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:var(--info-bg);color:var(--info);box-shadow:0 2px 6px rgba(0,0,0,.12)}
.pickbar[hidden]{display:none}
.pickbar .btn{min-height:36px;padding:6px 12px}
.card[draggable="true"]{cursor:grab}
.card.dragging{opacity:.45}
.ghost{position:fixed;top:-100px;left:0;padding:6px 10px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:.9rem;font-weight:600}
.publist{display:flex;flex-direction:column;gap:6px;margin:4px 0 8px}
.pubrow{padding:6px 8px;border-radius:6px;background:var(--panel2)}
.undo{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);width:min(560px,92vw);display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:var(--ink);color:var(--bg);padding:10px 14px;border-radius:10px;z-index:20;box-shadow:0 2px 12px rgba(0,0,0,.3)}
.undo .msg{flex:1;min-width:200px}
.undo ul{margin:4px 0 0;padding-left:20px}
.undo .actions{margin:0}
.undo .btn{min-height:36px;padding:6px 14px}
.undo .btn.primary{background:var(--bg);color:var(--ink);border-color:var(--bg)}
.undo.bad{border:3px solid var(--bad)}
table.h{width:100%;border-collapse:collapse;font-size:.9rem}
table.runs .run-i{width:1.4em;font-size:1.05rem;text-align:center}
table.runs .run-t{white-space:nowrap}
table.runs tr.run-bad td{background:var(--bad-bg);color:var(--bad)}
table.runs tr.run-bad a{color:var(--bad)}
table.runs tr.run-on .run-i{color:var(--info)}
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
  .list details.card .text,.list .card.sel .text,.list .their-more .text,.list .msgs .text{display:block;-webkit-line-clamp:none;overflow:visible} /* Sent history, and the card you clicked: the whole text */
  .list .card h2.fname{font-size:.8rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .detail{display:block;flex:1;overflow:auto;padding:16px}
  .detail .card{padding:18px}
  .two{grid-template-columns:1fr 1fr}
  .list.wide{flex:1;max-width:none;border-right:0}
  nav.side{overflow:auto}
  .detail .photo img{max-height:280px}
  .filebox input.f,.filebox select.f,.small input.f,.small textarea.f{font-size:.88rem;padding:6px 8px}
  .filebox .btn,.small .btn{font-size:.85rem;padding:6px 10px;min-height:34px}
}
.cfilters{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
.cfilter{flex:1 1 160px;min-width:0}
.cfilter label.f{margin:4px 0 3px;font-size:.82rem}
.clist{display:flex;flex-direction:column;gap:8px}
.card.crow{display:flex;align-items:center;gap:10px}
.card.crow:hover{border-color:var(--accent)}
.crow-open{flex:1;min-width:0;background:none;border:0;padding:0;text-align:left;cursor:pointer}
.crow-del{flex:none;font-size:.85rem;padding:6px 10px;min-height:34px}
.crow-top{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.crow-badges{margin-left:auto;display:flex;gap:6px}
.crow-edit{display:flex;gap:8px;align-items:flex-start}
.crow-edit .btn{flex:none}
.cfield input.f[hidden]{display:none}
.cfield #c-status-own{margin-top:6px}
.clist-items{margin:6px 0 0;padding-left:20px}
.clist-items li{margin:3px 0}
`;
