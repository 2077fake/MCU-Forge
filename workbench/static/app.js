(function () {
'use strict';

/* ============================== helpers ============================== */
var $ = function (id) { return document.getElementById(id); };
var LS_KEY = 'mcu.console.settings.v1';
var PALETTE = ['#d9541e', '#1f6feb', '#2a9d5c', '#8b5cf6', '#c28a00', '#0e9aa7'];
var PHASE_ORDER = ['handshaking', 'loading', 'erasing', 'writing', 'options', 'done'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }

var DEFAULTS = {
  project: '', port: 'COM7', baud: 9600, wait: 90,
  window: 300, termMax: 1500, theme: 'light', autoscroll: true, hexView: false,
  filter: 'all', drawerTab: 'set', metaH: 0, wLeft: 0, wRight: 0, curveH: 0, sysH: 0
};
var S = {};
try { S = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { S = {}; }
for (var k in DEFAULTS) if (!(k in S)) S[k] = DEFAULTS[k];
function saveS() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }

function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) { var e = new Error(j && j.error ? j.error : 'HTTP ' + r.status); e.code = r.status; e.body = j; throw e; }
      return j;
    });
  });
}
function post(path, body) {
  return api(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

var toastBox = $('toasts');
function toast(msg, kind) {
  var d = document.createElement('div');
  d.className = 'toast ' + (kind || '');
  d.innerHTML = msg;
  toastBox.appendChild(d);
  setTimeout(function () { d.style.opacity = '0'; d.style.transition = 'opacity .3s'; }, kind === 'err' ? 5200 : 3200);
  setTimeout(function () { d.remove(); }, kind === 'err' ? 5600 : 3600);
}

function syslog(level, text, ts) {
  var box = $('syslog');
  var line = document.createElement('div');
  line.className = 'l ' + level;
  line.innerHTML = '<i class="dim">' + esc(ts || localTs()) + '</i><span>' + esc(text) + '</span>';
  box.appendChild(line);
  while (box.children.length > 600) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function localTs() {
  var d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* ============================== state ============================== */
var ST = {
  projects: [], byPath: {}, current: null, ports: [], job: null, seenJobs: {},
  diags: [], filesDir: null, fileStack: [], flashDeadline: 0, flashTimer: null,
  lastAttempt: 0, serialOpen: false, serialExpected: null, online: false, root: ''
};

/* ============================== SSE bus ============================== */
var es = null, esRetry = 0, lastMsgAt = Date.now();
function connectBus() {
  if (es) { try { es.close(); } catch (e) {} }
  es = new EventSource('/api/events');
  es.onopen = function () { esRetry = 0; lastMsgAt = Date.now(); setOnline(true); };
  es.onerror = function () {
    setOnline(false);
    esRetry++;
    if (es.readyState === 2) { setTimeout(connectBus, Math.min(10000, 800 * esRetry)); }
  };
  es.onmessage = function (ev) {
    lastMsgAt = Date.now();
    var d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    handle(d);
  };
}
function setOnline(on) {
  ST.online = on;
  $('rootPath').title = on ? '后端在线（SSE 已连接）' : '后端连接断开，正在重连';
  var b = $('sseBadge');
  if (b) {
    b.textContent = on ? '在线' : '重连中';
    b.className = 'sse-pill ' + (on ? 'on' : 'off');
  }
  if (!on) syslog('warn', '与后端的推送通道断了，正在重连…');
}

/* Edge 睡眠标签页冻结渲染线程后，SSE 只会静默、不触发 onerror；
   页面可见时 40s 无任何消息（服务端 15s 一跳）就强制重建 EventSource */
function busWatchdog() {
  if (document.hidden || !es || es.readyState !== 1) return;
  if (Date.now() - lastMsgAt > 40000) {
    lastMsgAt = Date.now();
    syslog('warn', '推送通道静默超 40s（页面可能被浏览器冻结过），强制重连…');
    connectBus();
  }
}
setInterval(busWatchdog, 5000);
document.addEventListener('visibilitychange', busWatchdog);

function handle(ev) {
  switch (ev.topic) {
    case 'hello': setOnline(true); break;
    case 'job': onJob(ev.job); break;
    case 'log': syslog(ev.level === 'danger' ? 'danger' : ev.level, ev.text, ev.ts); break;
    case 'build_diag': addDiag(ev, ev.ts); break;
    case 'serial': onSerial(ev.data, ev.direction || 'in', ev.ts); break;
    case 'curve': pushCurve(ev.values, ev.ts); break;
    case 'serial_state': onSerialState(ev); break;
    case 'flash_phase': onFlashPhase(ev); break;
    case 'flash_line': onFlashLine(ev); break;
    case 'flash_fail_reason': onFlashReason(ev); break;
    default: break;
  }
}

/* ============================== projects ============================== */
function refreshProjects() {
  return api('/api/projects').then(function (r) {
    ST.projects = r.projects || [];
    ST.byPath = {};
    var sel = $('projectSel');
    sel.innerHTML = '';
    if (!ST.projects.length) {
      sel.appendChild(new Option('没扫到 Keil 工程', ''));
      syslog('warn', '在 ' + ST.root + ' 下没找到 .uvproj/.uvprojx');
      return;
    }
    var groups = {};
    ST.projects.forEach(function (p) {
      ST.byPath[p.project] = p;
      var g = p.top || '（根目录）';
      (groups[g] = groups[g] || []).push(p);
    });
    Object.keys(groups).sort().forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g;
      groups[g].forEach(function (p) {
        var o = new Option(p.label, p.project);
        o.title = p.project;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    var want = ST.byPath[S.project] ? S.project : (r.default && ST.byPath[r.default] ? r.default : ST.projects[0].project);
    sel.value = want;
    setProject(want);
  }).catch(function (e) { toast('扫描工程失败：' + esc(e.message), 'err'); });
}

function setProject(path) {
  S.project = path; saveS();
  ST.current = ST.byPath[path] || null;
  renderProjMeta();
  refreshHex();
  goDir(null);
}

function renderProjMeta() {
  var p = ST.current;
  var box = $('projMeta');
  if (!p) { box.innerHTML = '<dd class="dim">未选择工程</dd>'; $('devBadge').textContent = '—'; $('devBadge').className = 'badge'; return; }
  var rows = [
    ['工程', p.name],
    ['设备', p.device || '未知'],
    ['时钟', p.clock ? (p.clock / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + ' MHz' : '未知'],
    ['生成 hex', p.create_hex ? '已勾选' : '未勾选 ⚠'],
    ['hex 路径', p.hex || '读不出'],
    ['大小/时间', p.hex_exists ? (p.hex_bytes + ' B · ' + (p.hex_mtime_text || '')) : '文件不存在']
  ];
  box.innerHTML = rows.map(function (r) {
    return '<dt>' + esc(r[0]) + '</dt><dd class="' + (r[0] === 'hex 路径' ? 'path' : '') + '" title="' + esc(r[1]) + '">' +
      (r[0] === '生成 hex' && !p.create_hex ? '<span style="color:var(--warn)">' : '') +
      esc(r[1]) + (r[0] === '生成 hex' && !p.create_hex ? '</span>' : '') + '</dd>';
  }).join('');
  if (p.error) box.innerHTML += '<dt>读取错误</dt><dd style="color:var(--danger)">' + esc(p.error) + '</dd>';
  $('devBadge').textContent = (p.device || '?') + ' · ' + (p.clock ? (p.clock / 1e6).toFixed(2) + 'MHz' : '?');
  $('devBadge').className = 'badge' + (p.device ? ' ok' : '');
}

function refreshHex() {
  var p = ST.current;
  var badge = $('hexBadge'), meta = $('hexMeta'), probs = $('hexProblems');
  if (!p) { badge.textContent = '无工程'; badge.className = 'badge'; meta.innerHTML = ''; probs.innerHTML = ''; return; }
  badge.textContent = 'hex 检查中…'; badge.className = 'badge';
  api('/api/hex?project=' + encodeURIComponent(p.project)).then(function (h) {
    if (!h || h.ok === undefined) { badge.textContent = 'hex 未知'; return; }
    if (h.info && !h.info.hex_exists) {
      meta.innerHTML = '<dt>状态</dt><dd class="dim">尚未编译（等待构建生成 .hex）</dd>';
      probs.innerHTML = '';
      badge.textContent = '待编译';
      badge.className = 'badge warn';
      return;
    }
    var lines = [];
    if (h.records !== undefined) lines.push(['记录数', h.records]);
    lines.push(['数据字节', (h.bytes || 0) + ' B']);
    if (h.start !== undefined && h.start !== null) {
      lines.push(['地址范围', '0x' + hex4(h.start) + ' – 0x' + hex4(h.end) + '（跨度 ' + h.span + '）']);
      lines.push(['复位向量', h.has_reset_vector ? '已写入' : '空的 ⚠']);
      lines.push(['入口', h.entry === null || h.entry === undefined ? '未识别（不是 LJMP 开头）' : '0x' + hex4(h.entry)]);
    }
    lines.push(['结束记录', h.eof ? '有' : '缺 ⚠']);
    meta.innerHTML = lines.map(function (r) {
      var warnish = /⚠/.test(String(r[1]));
      return '<dt>' + esc(r[0]) + '</dt><dd' + (warnish ? ' style="color:var(--warn)"' : '') + '>' + esc(r[1]) + '</dd>';
    }).join('');
    var pl = h.problems || [];
    probs.innerHTML = pl.length
      ? '<div class="sub">问题</div><div style="color:var(--danger);font-size:12px;line-height:1.7">' +
        pl.map(function (x) { return '· ' + esc(x); }).join('<br>') + '</div>'
      : (h.bytes ? '<div style="color:var(--ok);font-size:12px;margin-top:8px">结构与校验和都正常</div>' : '');
    badge.textContent = pl.length ? (h.bytes ? 'hex 有 ' + pl.length + ' 个问题' : 'hex 有问题') : 'hex 正常';
    badge.className = 'badge ' + (pl.length ? (h.bytes ? 'warn' : 'bad') : 'ok');
    if (pl.length && !h.bytes) toast('hex 有问题：' + esc(pl[0]), 'warn');
  }).catch(function (e) {
    badge.textContent = 'hex 读不了'; badge.className = 'badge bad';
    meta.innerHTML = '<dd class="dim">' + esc(e.message) + '</dd>';
  });
}
function hex4(n) { return ('000' + n.toString(16).toUpperCase()).slice(-4); }

/* ============================== files ============================== */
function goDir(dir) {
  var p = ST.current;
  var target = dir || (p ? dirname(p.project) : ST.root);
  ST.filesDir = target;
  api('/api/files?dir=' + encodeURIComponent(target)).then(function (r) {
    $('fileCrumb').textContent = r.dir;
    var list = $('fileList');
    list.innerHTML = '';
    (r.entries || []).forEach(function (en) {
      var b = document.createElement('button');
      b.className = 'row' + (en.type === 'dir' ? ' dir' : '');
      b.innerHTML = '<span class="nm">' + (en.type === 'dir' ? '▸ ' : '· ') + esc(en.name) + '</span>' +
        (en.bytes !== undefined ? '<span class="sz">' + en.bytes + ' B</span>' : '');
      b.onclick = function () {
        if (en.type === 'dir') { ST.fileStack.push(ST.filesDir); goDir(joinPath(ST.filesDir, en.name)); }
        else copyPath(joinPath(ST.filesDir, en.name));
      };
      list.appendChild(b);
    });
    if (!(r.entries || []).length) list.innerHTML = '<div class="dim" style="padding:6px 8px">这个目录里没有可看的文件</div>';
  }).catch(function (e) {
    $('fileList').innerHTML = '<div class="dim" style="padding:6px 8px">' + esc(e.message) + '</div>';
  });
}
function dirname(p) { return p.replace(/[\\/][^\\/]*$/, ''); }
function joinPath(a, b) { return a + (/\\$/.test(a) ? '' : '\\') + b; }
function copyPath(p) {
  var ok = function () { toast('已复制路径：<span class="mono">' + esc(p) + '</span>', 'ok'); };
  var nb = function () {
    toast('浏览器不让写剪贴板，路径：<span class="mono">' + esc(p) + '</span>', 'warn');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(p).then(ok, nb);
  } else {
    try {
      var ta = document.createElement('textarea');
      ta.value = p; document.body.appendChild(ta); ta.select();
      var done = document.execCommand('copy');
      ta.remove();
      done ? ok() : nb();
    } catch (e) { nb(); }
  }
}
$('btnFileUp').onclick = function () {
  var prev = ST.fileStack.pop();
  if (prev) goDir(prev); else toast('已经在工程目录这一层', 'warn');
};
$('btnFileHome').onclick = function () { ST.fileStack = []; goDir(null); };

/* ============================== 拖拽布局 ============================== */
/* 每栏一块「吃剩余」的填充卡 + 若干块靠显式高度的卡：
   左 meta|files(填充)、中 curve|term(填充)、右 diag(填充)|sys。 */
var CARD_MIN = {cardMeta:118, cardFiles:210, cardCurve:150, cardTerm:170, cardDiag:150, cardSys:120};
var SPLITS = [
  {sp:'hsplitL', axis:'x', cssvar:'--w-left',  side:'left',  key:'wLeft',  min:196},
  {sp:'hsplitR', axis:'x', cssvar:'--w-right', side:'right', key:'wRight', min:230},
  {sp:'splitMeta',  axis:'y', card:'cardMeta',  key:'metaH'},
  {sp:'splitCurve', axis:'y', card:'cardCurve', key:'curveH'},
  // 这条缝管的是它下面那块（系统日志），往下拖是变小，所以方向要翻
  {sp:'splitSys',   axis:'y', card:'cardSys',   key:'sysH', invert:true}
];
var CENTER_MIN = 320;

function hidden(el) { return getComputedStyle(el).display === 'none'; }
function splitOf(key) { for (var i = 0; i < SPLITS.length; i++) if (SPLITS[i].key === key) return SPLITS[i]; return null; }

function clearSize(spec, persist) {
  if (spec.axis === 'x') $('workspace').style.removeProperty(spec.cssvar);
  else { var c = $(spec.card); c.style.height = ''; c.style.maxHeight = ''; }
  if (persist) { S[spec.key] = 0; saveS(); }
  return 0;
}

function setColW(spec, w, persist) {
  var ws = $('workspace'), sp = $(spec.sp);
  if (!w || hidden(sp)) return clearSize(spec, persist);
  var wsW = ws.getBoundingClientRect().width;
  var wL = $('colL').getBoundingClientRect().width, wC = $('colC').getBoundingClientRect().width,
        wR = $('colR').getBoundingClientRect().width;
  var fixed = wsW - wL - wC - wR;                      // 内边距 + 缝隙 + 两条分割条
  var other = spec.side === 'left' ? wR : wL;
  var lim = Math.max(spec.min, wsW - fixed - other - CENTER_MIN);
  var px = clamp(Math.round(w), spec.min, lim);
  ws.style.setProperty(spec.cssvar, px + 'px');
  if (persist) { S[spec.key] = px; saveS(); }
  return px;
}

function setCardH(spec, h, persist) {
  var card = $(spec.card), col = card.parentNode, sp = $(spec.sp);
  var colH = col.clientHeight;
  // 只有并排布局才谈得上上下分割：窄屏堆叠、或列高小到来放不下时，宁可不写值
  if (!h || hidden(sp) || colH <= 0) return clearSize(spec, persist);
  var min = CARD_MIN[spec.card];
  var others = sp.offsetHeight;
  Array.prototype.forEach.call(col.children, function (el) {
    if (el === card || el === sp || hidden(el)) return;
    others += (el.classList.contains('vsplit') ? el.offsetHeight : (CARD_MIN[el.id] || 120));
    others += 12;                                      // .col 的 gap
  });
  var lim = colH - others;
  if (lim < min) return clearSize(spec, persist);      // 挤不下了，交回给 CSS 默认值
  var px = clamp(Math.round(h), min, Math.max(min, lim));
  card.style.maxHeight = 'none';                       // 拖过默认的 45% 上限时要能继续放大
  card.style.height = px + 'px';
  if (persist) { S[spec.key] = px; saveS(); }
  return px;
}

function applySize(spec, v, persist) { return spec.axis === 'x' ? setColW(spec, v, persist) : setCardH(spec, v, persist); }
function readSize(spec) {
  return spec.axis === 'x'
    ? $(spec.side === 'left' ? 'colL' : 'colR').getBoundingClientRect().width
    : $(spec.card).getBoundingClientRect().height;
}

SPLITS.forEach(function (spec) {
  var sp = $(spec.sp), sign = (spec.invert || spec.side === 'right') ? -1 : 1;
  var v0 = 0, px = 0, py = 0;
  sp.tabIndex = 0;
  sp.setAttribute('role', 'separator');
  sp.setAttribute('aria-orientation', spec.axis === 'x' ? 'vertical' : 'horizontal');
  function move(e) {
    var d = (spec.axis === 'x' ? e.clientX - px : e.clientY - py) * sign;
    applySize(spec, v0 + d, false);
  }
  function end() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    document.body.classList.remove('dragging', 'dragging-x');
    sp.classList.remove('drag');
    applySize(spec, readSize(spec), true);
    if (spec.axis === 'x') resizeCanvas();                 // 栏宽变了，画布要按新尺寸重画
  }
  sp.addEventListener('pointerdown', function (e) {
    if (hidden(sp)) return;
    px = e.clientX; py = e.clientY; v0 = readSize(spec);
    sp.classList.add('drag');
    document.body.classList.add(spec.axis === 'x' ? 'dragging-x' : 'dragging');
    // 拖动跟到 window 上：光标只要滑出这条 9px 的缝，绑在缝上的 move 就收不到了
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    e.preventDefault();
  });
  sp.addEventListener('dblclick', function () { applySize(spec, 0, true); if (spec.axis === 'x') resizeCanvas(); toast('已还原默认尺寸'); });
  sp.addEventListener('keydown', function (e) {
    var step = (e.shiftKey ? 40 : 12) * sign;
    if (spec.axis === 'x' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      applySize(spec, readSize(spec) + (e.key === 'ArrowLeft' ? -step : step), true); e.preventDefault();
    } else if (spec.axis === 'y' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      applySize(spec, readSize(spec) + (e.key === 'ArrowUp' ? -step : step), true); e.preventDefault();
    }
  });
});

function restoreLayout() {
  SPLITS.forEach(function (spec) { if (S[spec.key]) applySize(spec, S[spec.key], false); });
}
function resetLayout() {
  SPLITS.forEach(function (spec) { applySize(spec, 0, true); });
  resizeCanvas();
  toast('三栏宽度和各卡高度都回到默认', 'ok');
}
// 单文件前端没有测试入口，验证时得能从控制台驱动这几条分割条（浏览器里真点最难自动化）
window.__mcu = {SPLITS: SPLITS, apply: applySize, read: readSize, S: S, save: saveS, reset: resetLayout};

/* 顶栏装不下会换行，高度就不再是 62 了——设置抽屉得跟着量出来的高度让开 */
var barEl = document.querySelector('.topbar');
function syncBarH() { document.documentElement.style.setProperty('--bar-h', barEl.offsetHeight + 'px'); }
new ResizeObserver(syncBarH).observe(barEl);
// 标签页在后台时 ResizeObserver 会被节流，--bar-h 留在旧值就把抽屉顶到顶栏上面；回前台补量一次
document.addEventListener('visibilitychange', syncBarH);
syncBarH();

/* ============================== build ============================== */
function onJob(job) {
  if (!job) return;
  var prev = ST.seenJobs[job.id];
  ST.seenJobs[job.id] = job.status;
  ST.job = job;
  var running = job.status === 'running';
  var pill = $('jobPill');
  pill.textContent = running ? '运行中' : (job.status === 'ok' ? '成功' : '失败');
  pill.className = 'pill ' + (running ? 'run' : (job.status === 'ok' ? 'ok' : 'fail'));
  $('jobLabel').textContent = (job.kind === 'build' ? '编译 ' : '烧写 ') + (job.label || '');
  $('jobElapsed').textContent = job.elapsed + 's';
  setBusy(running);
  if (running) {
    if (job.kind === 'flash' && $('overlay').hidden) openOverlay(portOf(), job.started);
    return;
  }
  if (job.kind === 'build') renderBuildStats(job, prev === undefined);
  if (job.kind === 'build' && prev === 'running') {
    var t = (job.result || {}).totals || { errors: 0, warnings: 0 };
    refreshHex();
    toast(t.errors ? '编译失败：<span class="mono">' + t.errors + ' 个错误</span>，点右侧诊断行看位置'
                   : '编译通过：<span class="mono">' + t.errors + ' Error, ' + t.warnings + ' Warning</span>',
          t.errors ? 'err' : 'ok');
  }
  if (job.kind === 'flash' && prev === 'running') finishFlash(job);
}

function renderBuildStats(job, restored) {
  var res = job.result || {};
  var t = res.totals || { errors: 0, warnings: 0 };
  if (!res.ok && !res.totals && !res.program_size) {
    $('buildStats').innerHTML = '<span class="stat ' + (job.status === 'ok' ? 'g' : 'e') + '">' +
      esc(job.status) + ' · ' + esc(res.error || '无诊断输出') + '</span>';
    return;
  }
  var ps = res.program_size;
  var stats = [];
  stats.push('<span class="stat ' + (t.errors ? 'e' : 'g') + '">' + t.errors + ' Error</span>');
  stats.push('<span class="stat ' + (t.warnings ? 'w' : '') + '">' + t.warnings + ' Warning</span>');
  if (ps) stats.push('<span class="stat">code ' + ps.code + ' B</span>');
  if (ps) stats.push('<span class="stat">data ' + ps.data + '.' + ps.data_bits + ' / xdata ' + ps.xdata + '</span>');
  if (res.uv4_rc !== undefined) stats.push('<span class="stat">UV4 rc=' + res.uv4_rc + '</span>');
  if ((res.danger_warnings || []).length) stats.push('<span class="stat e">危险警告 ' + res.danger_warnings.length + '</span>');
  if (res.hex_missing) stats.push('<span class="stat e">没生成 hex</span>');
  if (res.log_file) stats.push('<span class="stat" title="' + esc(res.log_file) + '">日志在 .embeddedskills/build</span>');
  var info = res.project_info;
  if (!res.ok && info && info.hex_exists && info.hex_mtime && job.started && info.hex_mtime < job.started) {
    stats.push('<span class="stat w" title="' + esc(info.hex) + '">hex 没更新，现在烧进去还是上次的程序</span>');
  }
  $('buildStats').innerHTML = stats.join('') || '<span class="stat">没有输出</span>';
  if (res.ok === false && !t.errors && res.error) {
    $('buildStats').innerHTML += '<span class="stat e">' + esc(res.error) + '</span>';
  }
  if (restored) {
    $('buildStats').innerHTML += '<span class="stat" title="本页打开之前跑的作业，诊断明细没有推送到这里">上次作业 · 明细未随本页推送</span>';
  }
}

function addDiag(ev) {
  ST.diags.push({
    severity: ev.severity, code: ev.code, where: ev.where || '',
    message: ev.message || '', detail: ev.detail || '',
    danger: ev.severity === 'warning' && /^(L1|L2)$/.test(ev.code),
    ts: ev.ts
  });
  renderDiags();
}

function renderDiags() {
  var box = $('diagList');
  var f = S.filter;
  var items = ST.diags.filter(function (d) {
    if (f === 'all') return true;
    if (f === 'danger') return d.danger;
    if (f === 'error') return d.severity === 'error';
    if (f === 'warning') return d.severity === 'warning';
    return true;
  });
  if (!items.length) {
    box.innerHTML = '<div class="dim" style="padding:10px 4px">' +
      (ST.diags.length ? '这个筛选条件下没有条目' : '还没有诊断信息。编译一次，错误行会出现在这里并能点开。') + '</div>';
    return;
  }
  box.innerHTML = '';
  items.forEach(function (d, i) {
    var cls = d.danger ? 'danger' : (d.severity === 'error' ? 'err' : 'warn');
    var b = document.createElement('button');
    b.className = 'diag ' + cls;
    b.innerHTML = '<div class="top"><span class="code">' + esc(d.code) + '</span>' +
      '<span class="where">' + esc(d.where || d.severity) + '</span>' +
      '<span class="dim mono" style="margin-left:auto;font-size:10.5px">' + esc((d.ts || '').slice(-12)) + '</span></div>' +
      '<div class="msg">' + esc(d.message) + '</div>' +
      (d.detail ? '<div class="det">' + esc(d.detail) + '</div>' : '') +
      '<div class="paths"></div>';
    b.onclick = function () {
      Array.prototype.forEach.call(box.querySelectorAll('.diag'), function (x) { x.classList.remove('act'); });
      b.classList.add('act');
      var paths = b.querySelector('.paths');
      if (paths.dataset.done) return;
      paths.dataset.done = '1';
      var full = resolvePath(d.where);
      var mk = function (txt, fn) {
        var x = document.createElement('button');
        x.className = 'mini'; x.textContent = txt; x.onclick = fn;
        paths.appendChild(x);
      };
      if (full) mk('复制完整路径', function () { copyPath(full); });
      mk('复制这一行', function () { copyPath(d.where + '  ' + d.code + ': ' + d.message); });
      if (full) {
        var lab = document.createElement('span');
        lab.className = 'dim mono'; lab.style.fontSize = '10.5px'; lab.textContent = full;
        paths.appendChild(lab);
      }
    };
    box.appendChild(b);
  });
}

function resolvePath(where) {
  var file = String(where || '').split(':')[0];
  if (!file || !/[.]/.test(file)) return null;
  var base = file.toLowerCase();
  var p = ST.current;
  if (p && p.sources) {
    for (var i = 0; i < p.sources.length; i++) {
      if (p.sources[i].toLowerCase().slice(String(p.sources[i]).lastIndexOf('\\') + 1) === base) return p.sources[i];
    }
  }
  return null;
}
function refreshDiagFilters() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) {
    b.classList.toggle('act', b.dataset.filter === S.filter);
    b.onclick = function () { S.filter = b.dataset.filter; saveS(); refreshDiagFilters(); renderDiags(); };
  });
}

/* ============================== serial ============================== */
var USB_PORT_RE = /ch340|usb.?serial|usb.?to.?uart|cp210|ftdi|prolific|silicon labs/i;

function usbPorts() {
  return ST.ports.filter(function (p) { return USB_PORT_RE.test((p.desc || '') + ' ' + p.device); });
}

function preferredPortsFirst() {
  // 蓝牙 SPP 口也能"打开"，但连不到板子；把 USB 串口排在前面
  var usb = USB_PORT_RE;
  return ST.ports.slice().sort(function (a, b) {
    var ua = usb.test((a.desc || '') + ' ' + a.device) ? 0 : 1;
    var ub = usb.test((b.desc || '') + ' ' + b.device) ? 0 : 1;
    if (ua !== ub) return ua - ub;
    return num(a.device) - num(b.device);
  });
}
function num(dev) { return parseInt(String(dev).replace(/\D+/g, ''), 10) || 0; }

function pickPort() {
  var ordered = preferredPortsFirst();
  var usb = usbPorts();
  var found = ordered.filter(function (p) { return p.device === S.port; })[0];
  // 存过的端口如果是蓝牙口而板子的 USB 口又在，就别信那个旧值——它是上次连错留下的
  if (found && (!usb.length || USB_PORT_RE.test((found.desc || '') + ' ' + found.device))) return S.port;
  return usb.length ? usb[0].device : (ordered.length ? ordered[0].device : '');
}

function refreshPorts() {
  return api('/api/ports').then(function (r) {
    ST.ports = r.ports || [];
    if (!ST.ports.length) {
      syslog('warn', 'serial.tools.list_ports 没枚举到串口，检查 CH340 驱动 / 数据线');
      return;
    }
    var want = pickPort();
    if (want && want !== S.port) {
      syslog('info', '板子串口定为 ' + want + (usbPorts().length ? '（优先板子的 USB 串口，跳过蓝牙 SPP 口）' : ''));
      S.port = want;
      saveS();
    }
  }).catch(function (e) { syslog('error', '枚举串口失败：' + e.message); });
}

function onSerialState(ev) {
  ST.serialOpen = !!ev.open;
  var l = $('serialLight');
  l.className = 'light ' + (ev.open ? 'on' : 'off');
  var msg = ev.open ? ('监视中: ' + ev.port + ' @ ' + ev.baud) : '串口空闲';
  if ($('serialText')) $('serialText').textContent = msg;
  if ($('serialPill')) $('serialPill').title = ev.open ? ('串口被监视会话占用：' + ev.port + ' @ ' + ev.baud) : '串口空闲（烧写时会自动占用再释放）';
  l.title = ev.open ? ('串口被监视会话占用：' + ev.port + ' @ ' + ev.baud) : '串口空闲（烧写时会自动占用再释放）';
  if (ST.serialExpected !== null && ST.serialExpected !== ST.serialOpen) {
    syslog('warn', '串口实际' + (ST.serialOpen ? '被打开' : '被关闭') + '了，不是本页的操作：可能被别的程序抢走、被烧写释放，或线被拔了');
  }
  ST.serialExpected = ST.serialOpen;
}
function onSerial(data, dir, ts) {
  if (data == null) return;
  String(data).split('\n').forEach(function (line) {
    if (line === '') return;
    addTerm(dir, line, ts);
  });
}
function addTerm(dir, line, ts) {
  var box = $('term');
  var d = document.createElement('div');
  d.className = 'tline ' + (dir === 'out' ? 'out' : 'in');
  d.dataset.raw = line;
  d.innerHTML = '<span class="ts">' + esc(ts || localTs()) + '</span>' +
    '<span class="dir">' + (dir === 'out' ? 'tx' : 'rx') + '</span>' +
    '<span class="tx">' + esc(S.hexView ? toHexView(line) : line) + '</span>';
  box.appendChild(d);
  while (box.children.length > S.termMax) box.removeChild(box.firstChild);
  if (S.autoscroll) box.scrollTop = box.scrollHeight;
}
function toHexView(s) {
  var bytes = new TextEncoder().encode(s), out = [];
  for (var i = 0; i < bytes.length; i++) out.push(hex2(bytes[i]));
  return out.join(' ');
}
function rerenderTerm() {
  var box = $('term');
  Array.prototype.forEach.call(box.children, function (d) {
    d.querySelector('.tx').textContent = S.hexView ? toHexView(d.dataset.raw || '') : (d.dataset.raw || '');
  });
}

/* ============================== curve ============================== */
var cv = $('curve'), ctx = cv.getContext('2d');
var series = [], hiddenSeries = {}, sampleCount = 0, lastPush = 0, rateEMA = 0, paused = false, cursor = null, dirty = true;

function pushCurve(values, ts) {
  if (!values || !values.length) return;
  var t = Date.now();
  if (lastPush) {
    var dt = t - lastPush;
    if (dt > 0 && dt < 5000) rateEMA = rateEMA ? rateEMA * 0.7 + (1000 / dt) * 0.3 : 1000 / dt;
  }
  lastPush = t;
  while (series.length < values.length) {
    var i = series.length;
    series.push({ name: '序列 ' + (i + 1), color: PALETTE[i % PALETTE.length], data: [] });
  }
  for (var j = 0; j < series.length; j++) {
    var s = series[j];
    var v = j < values.length ? Number(values[j]) : null;
    s.data.push({ t: t, v: isFinite(v) ? v : null, ts: ts || '' });
    while (s.data.length > S.window) s.data.shift();
  }
  sampleCount++;
  dirty = true;
  updateLegend();
}

function updateLegend() {
  var lg = $('legend');
  if (!series.length) return;
  var want = series.map(function (s, i) {
    var last = null;
    for (var k = s.data.length - 1; k >= 0; k--) { if (s.data[k].v !== null) { last = s.data[k].v; break; } }
    return '<button class="chip' + (hiddenSeries[i] ? ' hid' : '') + '" data-s="' + i + '">' +
      '<span class="sw" style="background:' + s.color + '"></span>' + esc(s.name) +
      ' <b>' + (last === null ? '—' : fmtNum(last)) + '</b></button>';
  }).join('');
  lg.innerHTML = want + '<span class="dim" style="margin-left:auto;font-size:11px">' +
    (rateEMA ? rateEMA.toFixed(1) + ' Hz · ' : '') + '采样 ' + sampleCount + '</span>';
  Array.prototype.forEach.call(lg.querySelectorAll('.chip'), function (c) {
    c.onclick = function () {
      var i = c.dataset.s;
      hiddenSeries[i] = !hiddenSeries[i];
      c.classList.toggle('hid', hiddenSeries[i]);
      dirty = true;
    };
  });
}
function fmtNum(v) {
  if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toPrecision(3);
  return String(Math.round(v * 100) / 100);
}

function resizeCanvas() {
  var r = cv.getBoundingClientRect();
  var dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dirty = true;
}

function drawCurve() {
  if (!dirty || paused) return;
  dirty = false;
  var r = cv.getBoundingClientRect(), W = r.width, H = r.height;
  ctx.clearRect(0, 0, W, H);
  var css = getComputedStyle(document.documentElement);
  var line = css.getPropertyValue('--line-soft').trim(), dim = css.getPropertyValue('--dim').trim();
  var muted = css.getPropertyValue('--muted').trim();
  var padL = 46, padR = 12, padT = 12, padB = 20;
  var plotW = Math.max(10, W - padL - padR), plotH = Math.max(10, H - padT - padB);

  var vis = series.filter(function (s, i) { return !hiddenSeries[i]; });
  var lo = Infinity, hi = -Infinity, maxLen = 0;
  vis.forEach(function (s) {
    maxLen = Math.max(maxLen, s.data.length);
    s.data.forEach(function (p) { if (p.v !== null) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; } });
  });
  if (!isFinite(lo)) {
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath();
    for (var g = 0; g <= 4; g++) {
      var yy = padT + plotH * g / 4;
      ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy);
    }
    for (var gx = 0; gx <= 6; gx++) {
      var xx = padL + plotW * gx / 6;
      ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + plotH);
    }
    ctx.stroke();
    var midY = padT + plotH / 2;
    ctx.strokeStyle = css.getPropertyValue('--accent').trim() + '44';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, midY); ctx.lineTo(W - padR, midY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = dim; ctx.font = '11.5px ' + css.getPropertyValue('--mono');
    ctx.fillText('OSC IDLE // 等待串口打印 v: 数值', padL + 12, midY - 10);
    return;
  }
  if (hi === lo) { hi += 1; lo -= 1; }
  var pad = (hi - lo) * 0.12; lo -= pad; hi += pad;

  ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.beginPath();
  for (var k = 0; k <= 4; k++) {
    var y = padT + plotH * k / 4;
    ctx.moveTo(padL, y); ctx.lineTo(W - padR, y);
  }
  for (var vx = 1; vx < 6; vx++) {
    var xcol = padL + plotW * vx / 6;
    ctx.moveTo(xcol, padT); ctx.lineTo(xcol, padT + plotH);
  }
  ctx.stroke();
  ctx.fillStyle = dim; ctx.font = '10.5px ' + css.getPropertyValue('--mono');
  for (var m = 0; m <= 4; m++) {
    var val = hi - (hi - lo) * m / 4, ypos = padT + plotH * m / 4;
    ctx.fillText(fmtNum(val), 6, ypos + 3.5);
  }

  var n = Math.max(maxLen, 2);
  var X = function (i) { return padL + plotW * i / (n - 1); };
  var Y = function (v) { return padT + plotH * (1 - (v - lo) / (hi - lo)); };

  vis.forEach(function (s) {
    var off = n - s.data.length;
    ctx.save();
    ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = s.color; ctx.lineJoin = 'round';
    ctx.shadowColor = s.color; ctx.shadowBlur = 10;
    var started = false, min = Infinity, max = -Infinity, sum = 0, cnt = 0, lastX = null, lastY = null;
    s.data.forEach(function (p, i) {
      if (p.v === null) { started = false; return; }
      var x = X(off + i), y = Y(p.v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      lastX = x; lastY = y;
      if (p.v < min) min = p.v; if (p.v > max) max = p.v; sum += p.v; cnt++;
    });
    ctx.stroke();
    ctx.restore();
    if (vis.length === 1 && cnt) {
      ctx.lineTo(X(off + s.data.length - 1), padT + plotH); ctx.lineTo(X(off), padT + plotH); ctx.closePath();
      var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, s.color + '38');
      grad.addColorStop(1, s.color + '02');
      ctx.fillStyle = grad; ctx.fill();
    }
    if (lastX !== null) {
      ctx.save();
      ctx.fillStyle = s.color; ctx.shadowColor = s.color; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(lastX, lastY, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    s._stat = cnt ? { min: min, max: max, avg: sum / cnt } : null;
  });

  if (cursor !== null && cursor < n) {
    var cx = padL + plotW * clamp(cursor, 0, n - 1);
    ctx.strokeStyle = muted; ctx.setLineDash([3, 3]); ctx.beginPath();
    ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke(); ctx.setLineDash([]);
    var readout = [];
    vis.forEach(function (s) {
      var o = n - s.data.length;
      var p = s.data[cursor - o];
      readout.push(p && p.v !== null ? fmtNum(p.v) : '—');
    });
    $('curveStat').textContent = '游标 ' + cursor + ' · ' + readout.join(' / ');
  } else {
    var st = vis.filter(function (s) { return s._stat; });
    $('curveStat').textContent = st.length
      ? st.map(function (s, i) { return s._stat.min + ' ~ ' + s._stat.max + (st.length > 1 ? '' : ' / 均值 ' + (Math.round(s._stat.avg * 100) / 100)); }).join(' | ')
      : '等待 v: 数据';
  }
}

cv.addEventListener('mousemove', function (e) {
  var r = cv.getBoundingClientRect();
  var padL = 46, padR = 12, plotW = Math.max(10, r.width - padL - padR);
  var maxLen = 0;
  series.forEach(function (s, i) { if (!hiddenSeries[i]) maxLen = Math.max(maxLen, s.data.length); });
  var n = Math.max(maxLen, 2);
  var i = Math.round((e.clientX - r.left - padL) / plotW * (n - 1));
  if (i < 0 || i >= n) { cursor = null; $('curveTip').style.opacity = 0; dirty = true; return; }
  cursor = i;
  var lines = [], off = n - 0;
  series.forEach(function (s, si) {
    if (hiddenSeries[si]) return;
    var o = n - s.data.length, p = s.data[i - o];
    if (p) lines.push('<span style="color:' + s.color + '">●</span> ' + esc(s.name) + ' = ' + fmtNum(p.v) + ' <span class="dim">' + esc(p.ts || '') + '</span>');
  });
  var tip = $('curveTip');
  if (lines.length) {
    tip.innerHTML = lines.join('<br>');
    tip.style.opacity = 1;
    tip.style.left = clamp(e.clientX - r.left + 12, 8, r.width - 180) + 'px';
    tip.style.top = clamp(e.clientY - r.top - 8, 8, r.height - 40) + 'px';
  } else tip.style.opacity = 0;
  dirty = true;
});
cv.addEventListener('mouseleave', function () { cursor = null; $('curveTip').style.opacity = 0; dirty = true; });

$('btnPause').onclick = function () {
  paused = !paused;
  this.textContent = paused ? '继续' : '暂停';
  this.classList.toggle('act', paused);
  if (!paused) dirty = true;
  toast(paused ? '曲线画面已冻结（数据继续缓存）' : '曲线继续刷新');
};
$('btnClearCurve').onclick = function () {
  series.forEach(function (s) { s.data = []; });
  sampleCount = 0; rateEMA = 0; dirty = true;
  $('curveStat').textContent = '已清空';
};
$('btnCsv').onclick = function () {
  if (!series.length) { toast('还没有曲线数据', 'warn'); return; }
  var head = ['t_ms'].concat(series.map(function (s) { return s.name; })).join(',');
  var maxLen = 0; series.forEach(function (s) { maxLen = Math.max(maxLen, s.data.length); });
  var rows = [head];
  var t0 = series[0].data.length ? series[0].data[0].t : 0;
  for (var i = 0; i < maxLen; i++) {
    var cells = [];
    series.forEach(function (s) {
      var o = maxLen - s.data.length;
      var p = s.data[i - o];
      cells.push(p ? (p.v === null ? '' : p.v) : '');
    });
    rows.push((i === 0 ? t0 : '') + ',' + cells.join(','));
  }
  download('曲线_' + stampName() + '.csv', rows.join('\n'));
};
function stampName() {
  var d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}
function download(name, text) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('已导出 <span class="mono">' + esc(name) + '</span>', 'ok');
}
$('btnSaveLog').onclick = function () {
  var box = $('term');
  if (!box.children.length) { toast('终端是空的，没什么可存', 'warn'); return; }
  var lines = [];
  Array.prototype.forEach.call(box.children, function (d) {
    var ts = d.querySelector('.ts').textContent, dir = d.querySelector('.dir').textContent;
    lines.push(ts + ' ' + (dir === 'tx' ? '>> ' : '<< ') + (d.dataset.raw || ''));
  });
  download('串口_' + stampName() + '.log', lines.join('\n'));
};
$('btnClearTerm').onclick = function () { $('term').innerHTML = ''; };
$('btnHexView').onclick = function () {
  S.hexView = !S.hexView; saveS();
  this.classList.toggle('act', S.hexView);
  rerenderTerm();
};
$('chkScroll').onchange = function () { S.autoscroll = this.checked; saveS(); };

function portOf() { return S.port || 'COM7'; }

function openOverlay(port, startedAt) {
  // 别的标签页/刷新后接手正在跑的烧写：用 started 推出的窗口终点，别让倒计时从 90s 重来
  var wait = Number(S.wait) || 90;
  var endAt = startedAt ? (startedAt * 1000 + wait * 1000) : (Date.now() + wait * 1000);
  ST.flashDeadline = endAt;
  $('overlay').hidden = false;
  $('flLines').innerHTML = '';
  $('flReason').hidden = true;
  $('flBar').style.width = '0%';
  $('flTarget').textContent = (ST.current ? String(ST.current.hex).split(/[\\/]/).pop() : '?') + ' → ' + port;
  $('flPill').textContent = '等待断电'; $('flPill').className = 'pill run';
  setPhase(null, 0);
  if (ST.flashTimer) clearInterval(ST.flashTimer);
  ST.flashTimer = setInterval(function () {
    var left = Math.max(0, Math.round((ST.flashDeadline - Date.now()) / 1000));
    $('flSub').textContent = '窗口剩余 ' + left + ' s · 第 ' + (ST.lastAttempt || 0) + ' 次尝试' +
      (left === 0 ? '（窗口已到，脚本停止等待）' : '');
    if (left === 0) { clearInterval(ST.flashTimer); ST.flashTimer = null; }
  }, 200);
}
function closeOverlay() {
  $('overlay').hidden = true;
  if (ST.flashTimer) { clearInterval(ST.flashTimer); ST.flashTimer = null; }
}
$('flAbort').onclick = function () {
  closeOverlay();
  toast('遮罩已关闭；后端仍在等握手窗口，要真停它请点顶栏「停止」');
};

function onFlashPhase(ev) {
  if ($('overlay').hidden) openOverlay(portOf());
  $('flMsg').textContent = ev.text || '';
  ST.lastAttempt = ev.attempt || ST.lastAttempt || 0;
  $('flPwr').className = 'pwr ' + (ev.phase === 'done' ? 'win' : (ev.phase === 'failed' ? 'lose' : 'beckon'));
  $('flPill').textContent = ({
    waiting_power: '等待断电', handshaking: '握手探测', done: '烧写成功', failed: '超时未握手'
  })[ev.phase] || ev.phase;
  $('flPill').className = 'pill ' + (ev.phase === 'done' ? 'ok' : (ev.phase === 'failed' ? 'fail' : 'run'));
  if (ev.pct) $('flBar').style.width = clamp(ev.pct, 0, 100) + '%';
  setPhase(ev.phase, ev.attempt);
  if (ev.phase === 'done') {
    $('flBar').style.width = '100%';
    syslog('info', '烧写成功（第 ' + ev.attempt + ' 次尝试）：' + ev.text);
    setTimeout(closeOverlay, 6000);
  } else if (ev.phase === 'failed') {
    syslog('error', '烧写失败：' + ev.text);
  } else {
    syslog('info', ev.text);
  }
}
function setPhase(cur, attempt) {
  if (cur === 'failed') return;      // 超时时保留最后走到的那一步，别把进度抹平
  var idx = PHASE_ORDER.indexOf(cur === 'waiting_power' ? null : cur);
  Array.prototype.forEach.call(document.querySelectorAll('.step'), function (s, i) {
    s.classList.remove('on', 'done');
    if (idx < 0) return;
    if (i < idx) s.classList.add('done');
    if (i === idx) s.classList.add('on');
  });
  if (attempt) ST.lastAttempt = attempt;
}
function onFlashLine(ev) {
  var box = $('flLines');
  var d = document.createElement('div');
  d.textContent = ev.text;
  if (ev.phase) d.style.color = 'var(--text)';
  if (/error|not responding|Could not open/i.test(ev.text)) d.style.color = 'var(--danger)';
  box.appendChild(d);
  while (box.children.length > 120) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  if (ev.pct !== null && ev.pct !== undefined) $('flBar').style.width = clamp(ev.pct, 0, 100) + '%';
  if (ev.phase) setPhase(ev.phase, ST.lastAttempt);
}
function onFlashReason(ev) {
  var box = $('flReason');
  box.hidden = false;
  box.innerHTML = '<b>' + esc(ev.cause) + ' · 第 ' + esc(ev.attempt) + ' 次</b>' + esc(ev.hint);
  syslog('warn', '失败原因 [' + ev.cause + '] ' + ev.hint);
}
function finishFlash(job) {
  if (ST.flashTimer) { clearInterval(ST.flashTimer); ST.flashTimer = null; }
  var r = job.result || {};
  if (job.status === 'ok') {
    $('flMsg').textContent = '烧写成功，芯片已自动启动新程序';
    $('flPill').textContent = '成功'; $('flPill').className = 'pill ok';
    $('flPwr').className = 'pwr win';
    $('flBar').style.width = '100%';
    toast('烧写成功（第 ' + (r.attempts || '?') + ' 次尝试）—— 断电重上电才会跑', 'ok');
    setTimeout(closeOverlay, 8000);
  } else {
    if (r.attempts) $('flSub').textContent = '共尝试 ' + r.attempts + ' 次，没抓到冷启动窗口';
    if (r.error === 'hex_missing') $('flMsg').textContent = 'hex 不存在，先编译一次';
    if (r.error === 'no_handshake') $('flMsg').textContent = '窗口内没等到冷启动，再断一次电';
    toast('烧写没成功：' + esc(r.error || '未知原因') + '，遮罩里有逐条提示', 'err');
  }
  refreshState();
}

/* ============================== top-level actions ============================== */
function setBusy(b) {
  $('serialLight').className = 'light ' + (b ? 'busy' : (ST.serialOpen ? 'on' : 'off'));
  if ($('serialText')) {
    $('serialText').textContent = b ? '作业运行中' : (ST.serialOpen ? '串口监视中' : '串口空闲');
  }
}
if ($('btnTheme')) {
  $('btnTheme').onclick = function () {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    saveS(); applyTheme(); syncThemeSeg();
    toast('已切换为' + (S.theme === 'dark' ? '深色' : '浅色') + '主题', 'ok');
  };
}
$('btnRescan').onclick = function () { refreshProjects().then(function () { toast('工程列表已刷新', 'ok'); }); };
$('projectSel').onchange = function () { ST.fileStack = []; setProject(this.value); };
$('btnReloadHex').onclick = refreshHex;
$('btnClearDiag').onclick = function () { ST.diags = []; renderDiags(); };
$('btnClearSys').onclick = function () { $('syslog').innerHTML = ''; };

/* drawer */
function openDrawer(o) {
  var d = $('drawer');
  d.classList.toggle('open', !!o);
  // 后台标签页里 ResizeObserver 被节流，--bar-h 可能还是旧值；开抽屉当场量一次，别让抽屉压住顶栏
  if (o) { syncBarH(); applyTab(); }
}
$('btnSettings').onclick = function () { openDrawer(!$('drawer').classList.contains('open')); };
$('btnResetLayout').onclick = resetLayout;
$('btnCloseDrawer').onclick = function () { openDrawer(false); };
$('dscrim').onclick = function () { openDrawer(false); };
function applyTab() {
  var doc = S.drawerTab === 'doc';
  $('tabSet').classList.toggle('on', !doc);
  $('tabDoc').classList.toggle('on', doc);
  $('paneSet').classList.toggle('on', !doc);
  $('paneDoc').classList.toggle('on', doc);
}
function showTab(which) { S.drawerTab = which; saveS(); applyTab(); }
$('tabSet').onclick = function () { showTab('set'); };
$('tabDoc').onclick = function () { showTab('doc'); };
/* 说明收进页签后，坑位提示得留一条回去的路：行尾的 ? 跳到那一节并高亮一下 */
Array.prototype.forEach.call(document.querySelectorAll('.q'), function (b) {
  b.onclick = function () {
    showTab('doc');
    var d = $(b.getAttribute('data-doc'));
    if (!d) return;
    d.classList.add('hl');
    d.scrollIntoView(false);
    setTimeout(function () { d.classList.remove('hl'); }, 1800);
  };
});
function bindField(id, key, cast) {
  $(id).onchange = function () {
    S[key] = cast(this.value); saveS();
    toast('已保存：' + key + ' = ' + esc(String(S[key])), 'ok');
  };
}
bindField('stWindow', 'window', function (v) { return parseInt(v, 10); });
bindField('stTermMax', 'termMax', function (v) { return parseInt(v, 10); });
/* 冷启动窗口：拖动只动读数，松手才落库，免得一路刷 toast */
function syncWait() {
  var el = $('stWait'), v = clamp(parseInt(el.value, 10) || 90, 15, 300);
  $('stWaitV').textContent = v + ' 秒';
  el.style.setProperty('--pct', ((v - 15) / 285 * 100) + '%');
  return v;
}
$('stWait').oninput = syncWait;
$('stWait').onchange = function () {
  S.wait = syncWait(); saveS();
  toast('已保存：wait = ' + S.wait + ' 秒', 'ok');
};
/* 只有两个值的主题用分段，点一下当场生效，不用展开下拉再猜长什么样 */
function syncThemeSeg() {
  Array.prototype.forEach.call($('stTheme').children, function (b) {
    b.classList.toggle('on', b.getAttribute('data-v') === S.theme);
  });
}
$('stTheme').onclick = function (e) {
  var b = e.target.closest ? e.target.closest('button') : null;
  if (!b || b.getAttribute('data-v') === S.theme) return;
  S.theme = b.getAttribute('data-v'); saveS(); applyTheme(); syncThemeSeg();
  toast('已保存：theme = ' + esc(S.theme), 'ok');
};
function applyTheme() {
  document.documentElement.setAttribute('data-theme', S.theme === 'light' ? 'light' : 'dark');
  dirty = true;
}

document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === 'Escape') { closeOverlay(); openDrawer(false); }
});
$('overlay').addEventListener('click', function (e) { if (e.target === this) closeOverlay(); });

/* ============================== state bootstrap ============================== */
function refreshState() {
  return api('/api/state').then(function (st) {
    ST.root = st.root;
    ST.serialOpen = !!(st.serial && st.serial.open);
    $('rootPath').textContent = st.root;
    onSerialState({ open: ST.serialOpen, port: st.serial && st.serial.port, baud: st.serial && st.serial.baud });
    $('stHs').textContent = st.handshake_baud;
    $('stTx').textContent = st.transfer_baud;
    var missing = [];
    if (!st.uv4) missing.push('没找到 UV4.exe');
    if (!st.stcgal_ok) missing.push('没装 stcgal');
    if (!st.serial_ok) missing.push('没装 pyserial');
    if (missing.length) { syslog('error', missing.join(' / ')); toast(esc(missing[0]) + '，部分功能不可用', 'err'); }
    if (st.running) { setBusy(true); onJob(st.running); }
    else setBusy(false);
  }).catch(function (e) {
    syslog('error', '读后端状态失败：' + e.message);
    setOnline(false);
  });
}

function syncDrawerFields() {
  $('stWait').value = String(S.wait);
  syncWait();
  $('stWindow').value = String(S.window);
  $('stTermMax').value = String(S.termMax);
  syncThemeSeg();
  applyTab();
  $('chkScroll').checked = !!S.autoscroll;
  $('btnHexView').classList.toggle('act', !!S.hexView);
}

function init() {
  applyTheme();
  syncDrawerFields();
  refreshDiagFilters();
  renderDiags();
  restoreLayout();
  resizeCanvas();
  window.addEventListener('resize', function () {
    resizeCanvas();
    // 窗口变小后，存过的尺寸可能已经挤不下：按当前尺寸重新夹一遍
    restoreLayout();
  });
  (function loop() { drawCurve(); requestAnimationFrame(loop); })();
  connectBus();
  refreshState().then(function () {
    return refreshPorts();
  }).then(function () {
    return refreshProjects();
  }).then(function () {
    syslog('info', '调试台就绪（纯展示）：编译/烧写/串口作业由 Qoder agent 经 API 下发');
  }).catch(function (e) { syslog('error', '初始化失败：' + e.message); });
  setInterval(function () { api('/api/job').then(function (r) { if (r.job) onJob(r.job); }).catch(function () {}); }, 4000);
}
init();
})();
