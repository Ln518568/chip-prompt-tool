/* WeiLin 提示词工具 —— 前端逻辑（通过 window.pywebview.api 调后端） */

let PY = null;
const $ = s => document.querySelector(s);
const api = () => PY || (window.pywebview ? window.pywebview.api : null);

let state = {
  mode: "prompt", cat: 0, focus: "pos",
  tags: [], zhMap: {},
  posTags: [], negTags: [], sel: null,
  folder: "", images: [], imgIndex: 0,
  capData: {}, globalTrigger: "",
  repo: [], apis: null, settings: {},
  repoSelMode: false, repoSelected: new Set(),
  repoFolder: "", repoAll: [], repoFolders: [], lastRepoIdx: null,
  recaptionActive: false, recaptionPaths: [],
  favorites: [],
};
const FAV_CAT = "⭐ 收藏";   // 虚拟分类名（不在 state.tags 里，独立存储）

/* ---------------- 工具 ---------------- */
let toastTimer, toastOutTimer;
function toast(msg) {
  const el = $("#toast");
  const done = /^(已|全部已)/.test(String(msg || ""));   // 完成类提示加个对勾
  el.classList.remove("out");                          // 淡出途中来新提示：立刻恢复可见
  el.textContent = done ? "✓ " + msg : msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  clearTimeout(toastOutTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("out");                           // 先播淡出动画
    toastOutTimer = setTimeout(() => {
      el.hidden = true; el.classList.remove("out");
    }, 260);
  }, 2000);
}
const hasZh = s => /[\u4e00-\u9fa5]/.test(s || "");

/* 程序内二次确认弹窗（代替浏览器原生 confirm，样式与打标库弹窗一致） */
let _ucResolve = null;
/* 通用确认弹窗：底部按钮可自定义
   opts.buttons = [{label, value, danger}]；返回所点按钮的 value，取消返回 false */
function uiConfirm(title, bodyHtml, opts = {}) {
  const buttons = opts.buttons ||
    [{ label: opts.okText || "确定", value: true, danger: !!opts.danger }];
  return buildConfirm(title, bodyHtml, buttons, opts);
}
function buildConfirm(title, bodyHtml, buttons, opts = {}) {
  $("#ucTitle").textContent = title;
  $("#ucBody").innerHTML = bodyHtml;
  const foot = $("#ucFoot");
  foot.innerHTML = "";
  if (!opts.noCancel) {                       // 信息类弹窗可去掉「取消」（如导出完成）
    const cancel = document.createElement("button");
    cancel.className = "btn ghost"; cancel.textContent = "取消";
    cancel.onclick = () => uiConfirmResolve(false);
    foot.appendChild(cancel);
  }
  (buttons || []).forEach(b => {
    const el = document.createElement("button");
    el.className = "btn" + (b.danger ? " danger" : "");
    el.textContent = b.label;
    el.onclick = () => uiConfirmResolve(b.value);
    foot.appendChild(el);
  });
  $("#uiConfirmMask").hidden = false;
  return new Promise(res => { _ucResolve = res; });
}
function uiConfirmResolve(v) {
  $("#uiConfirmMask").hidden = true;
  if (_ucResolve) { const r = _ucResolve; _ucResolve = null; r(v); }
}

/* 程序内输入弹窗（代替浏览器原生 prompt，样式一致；返回输入值或 null） */
let _upResolve = null;
function uiPrompt(title, opts = {}) {
  $("#upTitle").textContent = title;
  $("#upLabel").textContent = opts.label || "";
  const inp = $("#upInput");
  inp.value = opts.value || "";
  inp.placeholder = opts.placeholder || "";
  $("#upOk").textContent = opts.okText || "确定";
  $("#uiPromptMask").hidden = false;
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  return new Promise(res => { _upResolve = res; });
}
function uiPromptResolve(v) {
  $("#uiPromptMask").hidden = true;
  if (_upResolve) {
    const r = _upResolve; _upResolve = null;
    const val = String($("#upInput").value || "").trim();
    r(v === false || !val ? null : val);
    $("#upInput").value = "";
  }
}

/* 英文→中文 / 中文→英文 全量映射（标签库变化后需重建） */
function buildZh() {
  state.zhMap = {}; state.zhRev = {};
  (state.tags || []).forEach(c => (c.children || []).forEach(g =>
    (g.tags || []).forEach(t => {
      if (!state.zhMap[t[0]]) state.zhMap[t[0]] = t[1];
      if (!state.zhRev[t[1]]) state.zhRev[t[1]] = t[0];
    })));
}

/* ---------------- 启动 ---------------- */
function showFatal(msg) {
  try {
    window.__wlFatal = true;
    logErr(msg);
    const el = $("#tagList");
    if (el) el.innerHTML = `<div class="empty" style="color:var(--danger)">启动出错：${String(msg).replace(/</g, "&lt;")}</div>`;
    document.title = "提示词工具 · 出错";
  } catch (e) { }
}
function logErr(msg) {
  try { if (window.pywebview && window.pywebview.api) window.pywebview.api.log_error(String(msg)); } catch (e) { }
}
window.addEventListener("error", e => showFatal((e.message || "脚本错误") + "（第 " + (e.lineno || "?") + " 行）\n" + ((e.error && e.error.stack) || "")));
window.addEventListener("unhandledrejection", e => showFatal("调用失败：" + ((e.reason && e.reason.message) || e.reason) + "\n" + ((e.reason && e.reason.stack) || "")));

let booted = false;
function _start(fn) {
  if (booted) return; booted = true;
  PY = window.pywebview.api; fn();
}
/* 等待 pywebview 桥接：事件 + 轮询双保险，避免事件早于监听导致界面空白 */
function bridgeReady(fn) {
  if (window.pywebview && window.pywebview.api) { _start(fn); return; }
  window.addEventListener("pywebviewready", () => { try { _start(fn); } catch (err) { showFatal(err); } });
  let n = 0;
  const timer = setInterval(() => {
    if (window.pywebview && window.pywebview.api) { clearInterval(timer); try { _start(fn); } catch (err) { showFatal(err); } }
    else if (++n > 100) { clearInterval(timer); showFatal("pywebview 桥接未就绪（请用 启动.bat 打开本程序）"); }
  }, 200);
}
bridgeReady(boot);

/* ---------------- 标签库维护（程序自带：导出/导入备份、清除全部颜色） ---------------- */
async function clearAllTagColors() {
  const ok = await uiConfirm("清除全部颜色",
    `确定清除<b>所有分类颜色</b>和<b>所有标签独立颜色</b>吗？<br><span class="hint">标签和分类本身不受影响，只是恢复默认样式。</span>`,
    { danger: true, okText: "清除" });
  if (!ok) return;
  const r = await api().clear_all_tag_colors();
  state.tags = await api().get_tags();
  renderTagLibSide(); renderTagLib(); renderTabs(); renderTags();
  toast(`已清除 ${r[0]} 个分类色、${r[1]} 个标签色、${r[2]} 个二级分类色`);
}
async function exportTagsBackup() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const path = await api().pick_save_path(`标签库_${stamp}.json`);
  if (!path) return;
  const n = await api().tags_export(path);
  if (!n) { toast("导出失败"); return; }
  const open = await uiConfirm("导出完成",
    `已把 <b>${n}</b> 个分类的标签库导出到：<br><span class="hint">${path}</span>`,
    { buttons: [{ label: "打开所在文件夹", value: "open" }, { label: "好", value: "ok" }] });
  if (open === "open") api().show_in_folder(path);
}
async function importTagsBackup() {
  const path = await api().pick_open_path();
  if (!path) return;
  const info = await api().tags_backup_info(path);
  if (!info) { toast("这不是本程序导出的备份文件，已取消"); return; }
  const curC = (state.tags || []).length;
  let curT = 0;
  (state.tags || []).forEach(c => (c.children || []).forEach(g => curT += (g.tags || []).length));
  const ok = await uiConfirm("导入备份",
    `备份内容：<b>${info.cats}</b> 个分类、<b>${info.tags}</b> 条标词<br>` +
    `当前标签库：${curC} 个分类、${curT} 条标词<br><br>` +
    `导入后会<b>替换</b>当前的分类与标词，你现在的自建内容会被覆盖。`,
    { okText: "覆盖导入", danger: true });
  if (!ok) return;
  await api().tags_import_apply(path);
  state.tags = await api().get_tags();
  state.cat = 0;
  renderTabs(); renderTags();
  toast("已导入备份，标签库已恢复");
}


/* ---------------- 插件（ComfyUI 式：扫描目录、检测到才显示入口） ----------------
   后端 list_plugins() 只返回清单与入口文本；这里把 JS 用 <script> 注入（不用 eval，
   函数才会成为全局供 panel.html 的 onclick 调用），HTML 注入浮层内容区。
   热检测：窗口获得焦点 / 页面重新可见 / 点开浮层时重扫，签名没变就零开销跳过。 */
let pluginList = [];
let pluginSig = "";
let pluginScanTask = null;
const pluginInjected = new Set();   // 已注入脚本的插件 id：脚本只注入一次，
                                    // 避免重复注入时顶层 let 重复声明报错；装回的插件复用已有全局函数
function _pluginSig(list) {
  return JSON.stringify(list.map(p => [p.id, p.name, p.version, p.icon, p.desc]));
}
async function initPlugins() {
  if (pluginScanTask) return pluginScanTask;    // 焦点 + 点开浮层可能同时触发，合并成一次
  pluginScanTask = (async () => {
    let list;
    try { list = await api().list_plugins() || []; }
    catch (e) { list = []; logErr("插件扫描失败：" + (e && e.message || e)); }
    const sig = _pluginSig(list);
    if (sig === pluginSig) return;              // 列表没变 → 不重建，界面状态原样保留
    pluginSig = sig;
    pluginList = list;
    renderPlugins();
  })();
  try { await pluginScanTask; } finally { pluginScanTask = null; }
}
function renderPlugins() {
  const btn = $("#btnPlugins"), hint = $("#setPluginHint");
  const nav = $("#pluginNav"), body = $("#pluginBody");
  nav.innerHTML = ""; body.innerHTML = "";
  if (!pluginList.length) {                     // 插件全删 → 入口、引导、浮层一起消失
    if (btn) btn.hidden = true;
    if (hint) hint.hidden = true;
    $("#pluginMask").hidden = true;
    return;
  }
  if (btn) { btn.hidden = false; btn.onclick = openPlugins; }
  if (hint) hint.hidden = false;
  pluginList.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "plugin-nav-item" + (i === 0 ? " on" : "");
    item.textContent = (p.icon || "🧩") + " " + p.name;
    item.title = p.desc || "";
    item.onclick = () => showPlugin(i);
    nav.appendChild(item);
    const pane = document.createElement("div");
    pane.className = "plugin-pane" + (i === 0 ? " on" : "");
    pane.innerHTML = p.html || "";               // 内容来自本地插件文件，与页面同源可信
    body.appendChild(pane);
    if (pluginInjected.has(p.id)) return;        // 装回的插件：函数已在，不重复注入
    const s = document.createElement("script");
    s.dataset.plugin = p.id;
    s.textContent = p.js || "";
    document.head.appendChild(s);
    pluginInjected.add(p.id);
  });
  nav.hidden = pluginList.length < 2;            // 只有一个插件时不显示左侧列表
}
function showPlugin(i) {
  document.querySelectorAll("#pluginNav .plugin-nav-item").forEach((n, k) => n.classList.toggle("on", k === i));
  document.querySelectorAll("#pluginBody .plugin-pane").forEach((n, k) => n.classList.toggle("on", k === i));
}
async function openPlugins() {
  closeMenus();
  $("#pluginMask").hidden = false;               // 先开窗不等待，再后台重扫
  await initPlugins();                           // 装/删了插件会在这里反映出来
}
function closePlugins() { $("#pluginMask").hidden = true; }

async function boot() {
  logErr("boot 开始");
  state.tags = await api().get_tags() || [];
  logErr("get_tags 完成，分类数=" + state.tags.length);
  state.favorites = await api().fav_list() || [];
  buildZh();

  state.settings = await api().get_settings() || {};
  applyTheme(state.settings.theme || "dark");
  applyRingColor(state.settings.ring_color);
  $("#setSep").value = state.settings.separator || ", ";
  $("#setTheme").value = state.settings.theme || "dark";
  $("#setAutoAdd").checked = !!state.settings.auto_add_tag;
  $("#setAutoIdle").checked = !!state.settings.auto_add_idle;
  $("#setIdleSec").value = state.settings.idle_sec || 1.5;
  tagLibView = state.settings.taglib_view || "tab";
  applyTagLibView();
  applyLazyRender();
  applyNoAnim();

  state.capData = await api().get_progress() || {};
  state.apis = await api().get_translate_apis();
  renderApiSelect();

  renderTabs(); renderTags(); renderPromptBox("pos"); renderPromptBox("neg");
  syncModeInd(true);                  // 初始对齐，不做滑入动画
  window.addEventListener("resize", () => syncModeInd(true));
  await initPlugins();                // 检测插件目录，有插件才显示顶栏入口
  /* 热检测：切回窗口 / 页面重新可见时重扫插件目录，删掉或装上插件不用重启程序 */
  window.addEventListener("focus", () => initPlugins());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) initPlugins(); });
  refreshGpBtn();
  $("#tagCnt").textContent = state.tags.length + " 个分类";

  const last = state.settings.last_folder;
  if (last) { state.folder = last; $("#folderName").textContent = last; $("#folderName").title = last; await loadImages(last); }
  logErr("boot 完成");
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#setTheme").value = t;
}

/* 当前图光圈颜色：--ring 实心描边 + --ring-glow 柔光晕 */
const RING_DEFAULT = "#4a9eff";
/* 光圈预设色：低饱和柔和色，和深色界面协调，不再是一组刺眼的高亮色 */
const RING_PRESETS = ["#7aa5ff", "#6fd3a7", "#f2a3a3", "#f0b866", "#e8d06d", "#b9a0f5", "#f0a3c8", "#79cfc4", "#e6e8ee"];
function applyRingColor(hex) {
  const v = /^#[0-9a-fA-F]{6}$/.test(hex || "") ? hex : RING_DEFAULT;
  state.ringColor = v;
  const r = parseInt(v.slice(1, 3), 16), g = parseInt(v.slice(3, 5), 16), b = parseInt(v.slice(5, 7), 16);
  const rs = document.documentElement.style;
  rs.setProperty("--ring", v);
  rs.setProperty("--ring-glow", `rgba(${r},${g},${b},.55)`);
}
/* 只刷新选中标记与自定义块的颜色（不重建，避免选色中被打断） */
function updateRingSwatchSel() {
  const box = $("#ringSwatches"); if (!box) return;
  const cur = (state.ringColor || RING_DEFAULT).toLowerCase();
  [...box.querySelectorAll(".swatch")].forEach((el, i) => {
    if (el.classList.contains("custom")) { el.style.background = cur; return; }
    const c = RING_PRESETS[i];
    el.classList.toggle("sel", !!c && c.toLowerCase() === cur);
  });
}
/* 设置里的色板：预设色块 + 自定义入口 */
function renderRingSwatches() {
  const box = $("#ringSwatches"); if (!box) return;
  const cur = (state.ringColor || RING_DEFAULT).toLowerCase();
  box.innerHTML = "";
  document.querySelectorAll(".ring-note").forEach(n => n.remove());   // 清掉上次插入的说明行，避免重复
  box.className = "ring-row";                 // 色块单独一行，不与文字挤在一起
  RING_PRESETS.forEach(c => {
    const b = document.createElement("button");
    b.className = "swatch" + (c.toLowerCase() === cur ? " sel" : "");
    b.style.background = c; b.title = c;
    b.onclick = () => { applyRingColor(c); saveRingColor(c); updateRingSwatchSel(); };
    box.appendChild(b);
  });
  const custom = document.createElement("button");
  custom.className = "swatch custom";
  custom.title = "自定义颜色（点开取色器选任意颜色）";
  custom.style.background = cur;
  custom.innerHTML = `<span class="custom-mark">✎</span>`;
  custom.onclick = () => openRingPicker();
  box.appendChild(custom);
  const note = document.createElement("div");
  note.className = "ring-note";
  const hint = document.createElement("span");
  hint.className = "hint"; hint.textContent = "点色块即换（最后一个为自定义），实时预览";
  note.appendChild(hint);
  const reset = document.createElement("button");
  reset.className = "btn tiny ghost"; reset.textContent = "恢复默认";
  reset.onclick = () => { applyRingColor(RING_DEFAULT); saveRingColor(RING_DEFAULT); updateRingSwatchSel(); toast("已恢复默认光圈颜色"); };
  note.appendChild(reset);
  $("#ringSwatches").parentNode.insertBefore(note, $("#ringSwatches").nextSibling);
}
function saveRingColor(c) {
  state.settings.ring_color = c;
  if (api()) api().save_settings({ ring_color: c });
}

/* ---------- 自制取色器（替代浏览器原生取色弹窗） ---------- */
const P = { h: 211, s: 0.71, v: 1 };          // 当前色相/饱和度/明度
let pickerStart = RING_DEFAULT;

function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  switch (Math.floor(h / 60) % 6) {
    case 0: r = c; g = x; break;
    case 1: r = x; g = c; break;
    case 2: g = c; b = x; break;
    case 3: g = x; b = c; break;
    case 4: r = x; b = c; break;
    default: r = c; b = x;
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx ? d / mx : 0, mx];
}
function pickerHex() { const [r, g, b] = hsvToRgb(P.h, P.s, P.v); return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join(""); }

function drawSV() {
  const cv = $("#svCanvas"); const ctx = cv.getContext("2d");
  const w = cv.width, h = cv.height;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = hsvToRgb(P.h, x / (w - 1), 1 - y / (h - 1));
      const i = (y * w + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const cx = Math.round(P.s * (w - 1)), cy = Math.round((1 - P.v) * (h - 1));
  [[2, "#fff"], [1, "rgba(0,0,0,.7)"]].forEach(([lw, col]) => {
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
  });
}
function syncPicker() {
  const hex = pickerHex();
  if (!pickerCb) applyRingColor(hex);   // 通用模式（标签取色等）不实时改动打标圈环
  $("#svPreview").style.background = hex;
  if (document.activeElement !== $("#svHex")) $("#svHex").value = hex;
  const bar = $("#hueBar"), knob = $("#hueKnob");
  if (bar && knob) knob.style.left = (P.h / 360) * (bar.clientWidth - knob.offsetWidth) + "px";
  drawSV();
}
let pickerCb = null;                    // 非空 = 通用模式：确定时回调该颜色，不写圈环设置
function openRingPicker(cur, cb) {
  if (typeof cb === "function") pickerCb = cb; else pickerCb = null;
  pickerStart = pickerCb ? (cur || "#3498db") : (state.ringColor || RING_DEFAULT);
  const m = /^#?([0-9a-f]{6})$/i.exec(pickerStart);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
    const hsv = rgbToHsv(r, g, b);
    P.h = hsv[0]; P.s = hsv[1]; P.v = hsv[2];
  }
  const h3 = $("#ringPickerMask .dialog-head h3");
  if (h3) h3.textContent = pickerCb ? "选择颜色" : "自定义颜色";
  $("#ringPickerMask").hidden = false;
  syncPicker();
}
function closeRingPicker(ok) {
  $("#ringPickerMask").hidden = true;
  if (pickerCb) { const cb = pickerCb; pickerCb = null; if (ok) cb(pickerHex()); return; }
  if (ok) { saveRingColor(pickerHex()); updateRingSwatchSel(); }
  else { applyRingColor(pickerStart); updateRingSwatchSel(); }
}
/* 输入 HEX 直接改色 */
function pickerFromHex(v) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(v || "").trim());
  if (!m) return;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const hsv = rgbToHsv(r, g, b);
  P.h = hsv[0]; P.s = hsv[1]; P.v = hsv[2];
  syncPicker();
}
function bindPickerEvents() {
  const cv = $("#svCanvas");
  const pick = e => {
    const r = cv.getBoundingClientRect();
    P.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    P.v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    syncPicker();
  };
  let on = false;
  cv.addEventListener("pointerdown", e => { on = true; cv.setPointerCapture(e.pointerId); pick(e); });
  cv.addEventListener("pointermove", e => { if (on) pick(e); });
  cv.addEventListener("pointerup", () => { on = false; });
  const bar = $("#hueBar");
  const pickH = e => {
    const r = bar.getBoundingClientRect();
    P.h = Math.min(360, Math.max(0, (e.clientX - r.left) / r.width * 360));
    syncPicker();
  };
  let onH = false;
  bar.addEventListener("pointerdown", e => { onH = true; bar.setPointerCapture(e.pointerId); pickH(e); });
  bar.addEventListener("pointermove", e => { if (onH) pickH(e); });
  bar.addEventListener("pointerup", () => { onH = false; });
  $("#svHex").addEventListener("input", e => pickerFromHex(e.target.value));
}


/* ---------------- 标签库 ---------------- */
/* 左侧标签库（提示词模式）：手风琴式浏览 —— 顶层分类为可展开条，子分类可折叠，悬停标签预览图跟随鼠标 */
let openCat = undefined;            // undefined=未初始化（默认展开第一个）；""=全部收起；"名字"=展开该分类
let foldedSubs = new Set();         // 已折叠的子容器路径集合（join('\x01')）

function renderTabs() {
  /* 手风琴已取代 tab 切换：清空旧 tab 栏即可 */
  const box = $("#tabs"); if (box) box.innerHTML = "";
}

/* ---------------- 收藏标签（虚拟分类 + 悬停星标） ---------------- */
const isFav = en => (state.favorites || []).some(t => t && t[0] === en);

async function toggleFav(t) {
  const en = String(t[0] || "").trim();
  if (!en) return;
  const snap = [en, String(t[1] || ""), Array.isArray(t[2]) ? t[2].slice() : [], String(t[3] || "")];
  const was = isFav(en);
  const r = was ? await api().fav_remove(en) : await api().fav_add(snap);
  if (!Array.isArray(r)) { toast("收藏保存失败"); return; }
  state.favorites = r;
  renderTags();                       // 刷新星标状态与「⭐ 收藏」分类内容
  toast(was ? "已取消收藏：" + en : "已收藏：" + en);
}

/* 虚拟分类「⭐ 收藏」：与真实分类共用手风琴结构，标签同样可点击插入 / 拖拽 / 悬停预览 */
function renderFavCat(box, mode, catColor) {
  const el = document.createElement("div");
  el.className = "acc-cat fav-cat" + (openCat === FAV_CAT ? " active" : "");
  el.innerHTML = `<div class="acc-bar"><span class="caret">▼</span><span class="name">⭐ 收藏</span><span class="cnt">${(state.favorites || []).length}</span></div><div class="acc-panel"></div>`;
  el.querySelector(".acc-bar").onclick = () => {
    if (openCat === FAV_CAT) {
      el.classList.remove("active"); openCat = "";
    } else {
      const prev = box.querySelector(".acc-cat.active");
      if (prev) prev.classList.remove("active");
      el.classList.add("active"); openCat = FAV_CAT;
    }
    updateAddTagRow("");
  };
  const body = document.createElement("div");
  body.className = "acc-sub-body";
  const chips = document.createElement("div");
  chips.className = "acc-chips";
  if (!(state.favorites || []).length) {
    chips.innerHTML = `<div class="empty">还没有收藏标签 · 悬停标签点右上角 ☆ 即可收藏</div>`;
  } else {
    state.favorites.forEach(t => chips.appendChild(accChip(t, FAV_CAT, mode, catColor)));
  }
  body.appendChild(chips);
  el.querySelector(".acc-panel").appendChild(body);
  box.appendChild(el);
}

/* 单张标签芯片（点击插入 / 可拖拽 / 悬停预览 / 悬停星标收藏） */
function accChip(t, cat, mode, catColor) {
  const chip = document.createElement("span");
  chip.className = "chip acc-chip" + (isFav(t[0]) ? " faved" : "");
  const lm = dispOf("disp_lib");
  chip.textContent = lm === "both" ? (t[1] ? `${t[0]}  ${t[1]}` : t[0]) : (lm === "en" ? t[0] : (t[1] || t[0]));
  chip.title = "插入：" + t[0] + "（也可拖入编辑框）";
  let color = "";
  if (mode === "category") color = catColor[cat] || "";
  else if (mode === "individual") color = t[3] || "";
  else if (mode === "hybrid") color = t[3] || catColor[cat] || "";
  if (color) { chip.style.background = colorTint(color); chip.style.border = "1px solid " + color; }
  const imgs = (t[2] && t[2].length) ? t[2] : [];
  chip.dataset.img = imgs.length ? imgs[0] : "";
  chip.onclick = () => insertTag(t[0]);
  chip.draggable = true;
  chip.ondragstart = e => { e.dataTransfer.setData("text/plain", t[0]); e.dataTransfer.effectAllowed = "copy"; };
  chip.addEventListener("mouseenter", () => accPreviewShow(chip));
  chip.addEventListener("mousemove", e => accPreviewMove(e));
  chip.addEventListener("mouseleave", accPreviewHide);
  /* 悬停星标：点击只切换收藏，不触发插入 */
  const star = document.createElement("span");
  star.className = "fav-star" + (isFav(t[0]) ? " on" : "");
  star.textContent = isFav(t[0]) ? "★" : "☆";
  star.title = isFav(t[0]) ? "取消收藏" : "收藏这个标签";
  star.draggable = false;
  star.onclick = e => { e.stopPropagation(); toggleFav(t); };
  chip.appendChild(star);
  return chip;
}

/* 递归渲染某节点的直接标签 + 子容器（子容器为可折叠 .acc-sub） */
function accNodeBody(node, path, mode, catColor) {
  const wrap = document.createElement("div");
  wrap.className = "acc-sub-body";
  const chips = document.createElement("div");
  chips.className = "acc-chips";
  (node.tags || []).forEach(t => chips.appendChild(accChip(t, path[0], mode, catColor)));
  wrap.appendChild(chips);
  (node.children || []).forEach(ch => {
    const key = path.concat(ch.name).join("\x01");
    const sub = document.createElement("div");
    sub.className = "acc-sub" + (foldedSubs.has(key) ? " folded" : "");
    sub.innerHTML = `<div class="acc-sub-title"><span class="caret">▼</span>${escAttr(ch.name)}<span class="cnt">${_nodeTagCount(ch)}</span></div>`;
    sub.appendChild(accNodeBody(ch, path.concat(ch.name), mode, catColor));
    sub.querySelector(".acc-sub-title").onclick = e => {
      e.stopPropagation();
      const k = path.concat(ch.name).join("\x01");
      foldedSubs.has(k) ? foldedSubs.delete(k) : foldedSubs.add(k);
      sub.classList.toggle("folded");          // 直接切类播放折叠动画，不重建 DOM
    };
    wrap.appendChild(sub);
  });
  return wrap;
}

function renderTags() {
  const kw = $("#search").value.trim().toLowerCase();
  const box = $("#tagList"); if (!box) return; box.innerHTML = "";
  const mode = state.settings.tag_color_mode || "off";
  const catColor = {};
  if (mode === "category" || mode === "hybrid") state.tags.forEach(c => { if (c.color) catColor[c.name] = c.color; });

  /* 搜索：跨分类汇总匹配（保留原「全部」行为）；收藏项优先纳入并去重 */
  if (kw) {
    const list = []; const seen = new Set();
    (state.favorites || []).forEach(t => {
      if (!t || !t[0]) return;
      const k = String(t[0]).toLowerCase(), z = String(t[1] || "").toLowerCase();
      if ((k.includes(kw) || z.includes(kw)) && !seen.has(t[0])) { seen.add(t[0]); list.push({ t, cat: FAV_CAT }); }
    });
    state.tags.forEach(c => {
      const walk = nd => {
        (nd.tags || []).forEach(t => {
          const k = (t[0] || "").toLowerCase(), z = String(t[1] || "").toLowerCase();
          if ((k.includes(kw) || z.includes(kw)) && !seen.has(t[0])) { seen.add(t[0]); list.push({ t, cat: c.name }); }
        });
        (nd.children || []).forEach(walk);
      };
      walk(c);
    });
    updateAddTagRow(kw);
    if (!list.length) { box.innerHTML = `<div class="empty">没有匹配的标签</div>`; return; }
    list.forEach(({ t, cat }) => box.appendChild(accChip(t, cat, mode, catColor)));
    return;
  }

  /* 手风琴：每个顶层分类一条；点击展开/收起（""=全部收起），其余为压缩小条 */
  if (openCat === undefined || (openCat !== "" && openCat !== FAV_CAT && !state.tags.some(c => c.name === openCat)))
    openCat = state.tags.length ? state.tags[0].name : "";
  renderFavCat(box, mode, catColor);   // 虚拟分类固定在最上面
  state.tags.forEach(cat => {
    const el = document.createElement("div");
    el.className = "acc-cat" + (cat.name === openCat ? " active" : "");
    el.innerHTML = `<div class="acc-bar"><span class="caret">▼</span><span class="name">${escAttr(cat.name)}</span><span class="cnt">${_nodeTagCount(cat)}</span></div><div class="acc-panel"></div>`;
    el.querySelector(".acc-bar").onclick = () => {
      if (openCat === cat.name) {              // 收起当前（动画收拢）
        el.classList.remove("active"); openCat = "";
      } else {                                  // 切换展开：旧条收拢、新条展开，两段动画同时跑
        const prev = box.querySelector(".acc-cat.active");
        if (prev) prev.classList.remove("active");
        el.classList.add("active"); openCat = cat.name;
      }
      updateAddTagRow("");
    };
    el.querySelector(".acc-panel").appendChild(accNodeBody(cat, [cat.name], mode, catColor));
    box.appendChild(el);
  });
  updateAddTagRow(kw);
}

/* 悬停预览图（跟随鼠标） */
let _accPrev = null;
function accPreviewShow(chip) {
  const rel = chip.dataset.img;
  if (!_accPrev) {
    _accPrev = document.createElement("div");
    _accPrev.id = "tlHoverPreview";
    _accPrev.innerHTML = `<div class="ph">无预览图</div><img alt="">`;
    document.body.appendChild(_accPrev);
  }
  const img = _accPrev.querySelector("img"), ph = _accPrev.querySelector(".ph");
  if (rel) {
    ph.style.display = "none"; img.style.display = "block"; img.src = "";
    api().tag_image(rel, 220).then(b => { if (b) img.src = b; });
    _accPrev.classList.remove("empty");
  } else {
    img.style.display = "none"; ph.style.display = "flex";
    _accPrev.classList.add("empty");
  }
  _accPrev.style.display = "block";
}
function accPreviewMove(e) {
  if (!_accPrev || _accPrev.style.display === "none") return;
  let l = e.clientX + 16, t = e.clientY + 16;
  if (l + 232 > innerWidth) l = e.clientX - 232 - 16;
  if (t + 248 > innerHeight) t = e.clientY - 248 - 16;
  _accPrev.style.left = l + "px"; _accPrev.style.top = t + "px";
}
function accPreviewHide() { if (_accPrev) _accPrev.style.display = "none"; }

/* 底部固定「添加标签」行：随当前展开分类显示/隐藏 */
function updateAddTagRow(kw) {
  const row = $("#addTagRow");
  if (!row) return;
  row.hidden = !!(kw || !openCat || openCat === FAV_CAT);
}

/* ---------------- 标签库窗口（文件管理器式：浏览/搜索/新建/删除/右键/拖拽移动/多选批量） ---------------- */
let tagLibPath = null;            // 当前选中的容器路径（数组）；null=全部
let tagLibOpenCat = undefined;    // 当前展开的大分类：undefined=按选择自动推断；否则分类名或 null(全收)
let tagLibFolded = new Set();     // 已折叠的子分类路径（join(TL_SEP) 集合）
let tcPathSelections = [];        // 新建标签弹窗里的级联选择（各级容器名）
let tagLibSel = new Set();          // 选中标签的 key 集合："分类名\x01英文"
let tagLibListKeys = [];            // 与当前渲染顺序一一对应，供 Shift 连选 / 拖拽
let tagLibLastClick = null;
let tagLibDrag = null;              // 正在拖拽的 key 数组
let tagCtxKeys = [];               // 右键菜单作用的目标集合
let tagRenCtx = null;              // {cat, old_en}

const TL_SEP = "";
function tlKey(path, t) { return (Array.isArray(path) ? path.join(TL_SEP) : path) + TL_SEP + t[0]; }
function findTag(cat, en) {
  const c = state.tags.find(x => x.name === cat);
  if (!c) return null;
  let res = null;
  const walk = nd => {
    for (const t of (nd.tags || [])) if (t[0] === en) { res = t; return; }
    for (const ch of (nd.children || [])) walk(ch);
  };
  walk(c);
  return res;
}
function findContainer(path) {
  if (!path || !path.length) return null;
  let node = state.tags.find(c => c.name === path[0]);
  for (let i = 1; i < path.length; i++) {
    if (!node) return null;
    node = (node.children || []).find(ch => ch.name === path[i]);
  }
  return node || null;
}
/* 取路径上最深的非空容器色（用于混合染色的「继承分类底色」，支持任意层级容器） */
function colorOfPath(path) {
  let c = "";
  for (let i = 1; i <= (path || []).length; i++) {
    const node = findContainer(path.slice(0, i));
    if (node && node.color) c = node.color;
  }
  return c;
}
function _tagLibCollect(catIdx) {
  const out = [];
  const push = g => (g.tags || []).forEach(t => out.push(t));
  if (catIdx === "all") state.tags.forEach(c => (c.children || []).forEach(push));
  else { const c = state.tags[Number(catIdx)]; (c && c.children || []).forEach(push); }
  return out;
}
/* 带源分类的列表，用于选择/拖拽定位 */
function _tagLibList(catIdx) {
  const out = [];
  const add = (cat, g) => (g.tags || []).forEach(t => out.push({ cat, t }));
  if (catIdx === "all") state.tags.forEach(c => (c.children || []).forEach(g => add(c.name, g)));
  else { const c = state.tags[Number(catIdx)]; (c && c.children || []).forEach(g => add(c.name, g)); }
  return out;
}
/* 当前选择范围（容器路径）下的标签列表，含完整路径 */
function _tagLibScope() {
  const out = [];
  const addNode = (node, path) => {
    (node.tags || []).forEach(t => out.push({ path: path.slice(), cat: path[0], group: path[path.length - 1], t }));
    (node.children || []).forEach(ch => addNode(ch, path.concat(ch.name)));
  };
  if (!tagLibPath || !tagLibPath.length) state.tags.forEach(c => addNode(c, [c.name]));
  else { const node = findContainer(tagLibPath); if (node) addNode(node, tagLibPath.slice()); }
  return out;
}
function _nodeTagCount(node) {
  let n = 0;
  const w = nd => { n += (nd.tags || []).length; (nd.children || []).forEach(w); };
  w(node); return n;
}
function _tagLibAllCount() { let n = 0; state.tags.forEach(c => n += _nodeTagCount(c)); return n; }
/* 标签库：按设置选择「主界面页签」或「悬浮弹窗」显示；复用唯一的 #viewTagLib 节点（不复制副本，避免重复 id） */
let tagLibView = "tab";          // "tab" = 主界面页签；"popup" = 悬浮弹窗
let _tlHome = null;              // #viewTagLib 的原始父节点/相邻节点，用于弹窗关闭后归位
function applyTagLibView() {
  const tb = $("#modeTaglib");
  if (tb) tb.style.display = tagLibView === "tab" ? "" : "none";
  const bb = $("#btnTagLib");
  if (bb) bb.style.display = tagLibView === "popup" ? "" : "none";   // 页签模式下右上角按钮多余，隐藏
}
/* 懒渲染开关：开 → body 加 .lazy-render，CSS 才给卡片加 content-visibility */
function applyLazyRender() {
  document.body.classList.toggle("lazy-render", state.settings.lazy_render !== false);
}
/* 关闭动画开关：body.no-anim 由 CSS 全局禁用动效；JS 侧跳过显现观察器、直接显示卡片 */
function applyNoAnim() {
  const off = !!state.settings.no_anim;
  document.body.classList.toggle("no-anim", off);
  if (off) document.querySelectorAll(".mode-enter").forEach(el => el.classList.remove("mode-enter"));
}
function noAnim() { return document.body.classList.contains("no-anim"); }
function openTagLib() {
  tagLibEntering = true;              // 打开时播一次左栏交错入场
  if (tagLibView === "popup") {
    const v = $("#viewTagLib");
    if (!_tlHome) _tlHome = { parent: v.parentNode, next: v.nextSibling };
    $("#tagLibMask .dialog").appendChild(v);
    v.style.display = "flex";
    tagLibPath = null; tagLibSel.clear(); tagLibLastClick = null;
    $("#tagLibSearch").value = "";
    renderTagLibSide();
    renderTagLib();
    $("#tagLibMask").hidden = false;
    return;
  }
  /* 页签模式：还没在标签库页就切过去（switchMode 会回调本函数完成渲染）；
     已经在标签库页则直接重置渲染。先前无条件 switchMode 造成互相调用 → 栈溢出 */
  if (state.mode !== "taglib") { switchMode("taglib"); return; }
  tagLibPath = null; tagLibSel.clear(); tagLibLastClick = null;
  $("#tagLibSearch").value = "";
  renderTagLibSide();
  renderTagLib();
}
function closeTagLib() {
  closeMenus();
  $("#tagLibMask").hidden = true;
  const v = $("#viewTagLib");
  if (_tlHome && v.parentNode !== _tlHome.parent) _tlHome.parent.insertBefore(v, _tlHome.next);
  v.style.display = "none";
}

/* ----- 右键菜单：直接复用打标库已验证的 #repoItemCtx 元素与关闭机制 ----- */
/* （照 openItemCtx 写法：stopPropagation + 先 close + 全局 click 关闭） */
function closeMenus() { closeItemCtx(); closeRepoCtx(); }
function tlMenu(e, items) {
  e.preventDefault(); e.stopPropagation();
  closeItemCtx(); closeRepoCtx();
  const m = $("#repoItemCtx"); m.innerHTML = "";
  items.forEach(it => {
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.danger) b.style.color = "var(--danger)";
    b.onclick = () => { closeItemCtx(); it.onClick(); };
    m.appendChild(b);
  });
  m.hidden = false;
  const h = m.offsetHeight || 120;
  m.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - h - 8) + "px";
}

/* ----- 标签卡片右键 ----- */
function openTagCtx(e) {
  if (!tagLibSel.size) return;
  tagCtxKeys = [...tagLibSel];
  const multi = tagCtxKeys.length > 1;
  const items = multi
    ? [{ label: `移动到分类（${tagCtxKeys.length} 项）`, onClick: tlMoveAsk }, { label: `删除选中（${tagCtxKeys.length}）`, danger: true, onClick: tagDeleteSel }]
    : [{ label: "复制文本", onClick: tagCopy }, { label: "移动到分类", onClick: tlMoveAsk },
       { label: "重命名", onClick: tagRenameSel }, { label: "删除", danger: true, onClick: tagDeleteSel }];
  tlMenu(e, items);
}
/* 移动到分类：用多按钮确认框选目标（避免子菜单链，复用 uiConfirm） */
async function tlMoveAsk() {
  const src = new Set(tagCtxKeys.map(k => k.split(TL_SEP)[0]));
  const cats = state.tags.filter(c => !src.has(c.name));
  if (!cats.length) { toast("没有其它分类可移动"); return; }
  const target = await uiConfirm("移动到分类", `将选中的 <b>${tagCtxKeys.length}</b> 个标签移动到：`, { buttons: cats.map(c => ({ label: c.name, value: c.name })) });
  if (!target) return;
  await tagMoveTo(target);
}
async function tagMoveTo(catName) {
  closeMenus();
  let ok = 0, dup = 0;
  for (const k of tagCtxKeys) {
    const parts = k.split(TL_SEP); const en = parts.pop(); const oldPath = parts;
    if (oldPath[0] === catName && oldPath.length === 1) continue;
    const r = await api().move_tag(oldPath, en, [catName]);
    if (r === true) ok++; else if (r === "dup") dup++;
  }
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib(); tagLibSel.clear();
  toast(`已移动 ${ok} 个${dup ? `（${dup} 个目标已有，已跳过）` : ""} → ${catName}`);
}
async function tagDeleteSel() {
  const keys = [...tagCtxKeys];
  const ok = await uiConfirm("删除标签",
    `确定删除选中的 <b>${keys.length}</b> 个标签吗？<br><span class="hint">仅删除标签库里的标签，已用在提示词里的不受影响。</span>`,
    { danger: true, okText: "删除" });
  if (!ok) return;
  for (const k of keys) { const parts = k.split(TL_SEP); const en = parts.pop(); await api().delete_tag(parts, en); }
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib(); tagLibSel.clear();
  toast("已删除 " + keys.length + " 个标签");
}
async function tagCopy() {
  const p = tagCtxKeys[0].split(TL_SEP); const en = p.pop();
  const t = findTag(p[0], en);
  closeMenus();
  if (t) { try { await navigator.clipboard.writeText(t[0]); } catch (_) {} toast("已复制：" + t[0]); }
}
function tagRenameSel() {
  const p = tagCtxKeys[0].split(TL_SEP); const en = p.pop();
  const t = findTag(p[0], en);
  if (!t) return;
  openTagRename(p, en, t[0], t[1] || "");
}

/* ----- 标签示例图（对齐奥术秘典「词条预览图」：拖图入卡片即添加，可多张，滚轮切换） ----- */
function escAttr(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
async function loadTagImg(el, rel) {
  const img = el.querySelector(".tl-img");
  if (!img || !rel) return;
  const b = await api().tag_image(rel, 120);
  if (b) img.src = b;
}
function fileToB64(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }); }
async function tagAddImages(files, o) {
  let n = 0;
  for (const f of files) {
    if (!f.type || !f.type.startsWith("image/")) continue;
    const du = await fileToB64(f);
    const b64 = (du.split(",")[1] || "");
    const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
    if (await api().add_tag_image(o.path, o.t[0], b64, ext)) n++;
  }
  if (!n) { toast("没有可添加的图片"); return; }
  state.tags = await api().get_tags(); renderTagLib();
  toast("已添加 " + n + " 张示例图");
}
/* 示例图查看大图（翻页 / 删除） */
let tiList = [], tiIdx = 0, tiPath = "", tiEn = "";
async function openTagImages(o) {
  tiList = (o.t[2] && o.t[2].length) ? o.t[2].slice() : [];
  if (!tiList.length) return;
  tiIdx = 0; tiPath = o.path; tiEn = o.t[0];
  $("#tagImgMask").hidden = false; await tiShow();
}
async function tiShow() {
  $("#tiImg").src = await api().tag_image(tiList[tiIdx], 900) || "";
  $("#tiCnt").textContent = (tiIdx + 1) + " / " + tiList.length;
}
function tiNav(d) { tiIdx = (tiIdx + d + tiList.length) % tiList.length; tiShow(); }
async function tiDel() {
  const r = await api().remove_tag_image(tiPath, tiEn, tiIdx);
  if (!r) { closeTagImages(); return; }
  tiList = r.slice();
  if (!tiList.length) closeTagImages();
  else { tiIdx = Math.min(tiIdx, tiList.length - 1); tiShow(); }
  state.tags = await api().get_tags(); renderTagLib();
}
async function tiMove(dir) {                    // 左右移调整顺序
  const ni = tiIdx + dir;
  if (ni < 0 || ni >= tiList.length) return;
  const r = await api().reorder_tag_image(tiPath, tiEn, tiIdx, ni);
  if (r) { tiList = r.slice(); tiIdx = ni; state.tags = await api().get_tags(); renderTagLib(); tiShow(); }
}
async function tiSetCover() {                   // 设为封面（卡片缩略图用这张）
  const r = await api().set_cover_tag_image(tiPath, tiEn, tiIdx);
  if (r) { tiList = r.slice(); tiIdx = 0; state.tags = await api().get_tags(); renderTagLib(); tiShow(); toast("已设为封面"); }
}
async function tiReplace() {                    // 用新图替换当前这张
  const paths = await api().pick_images();
  if (!paths || !paths.length) return;
  const r = await api().replace_tag_image_file(tiPath, tiEn, tiIdx, paths[0]);
  if (r) { tiList = r.slice(); await tiShow(); state.tags = await api().get_tags(); renderTagLib(); toast("已替换这张示例图"); }
}
function closeTagImages() { $("#tagImgMask").hidden = true; }

/* ----- 标签染色：取色浮层（预设色 + 自定义 + 清除） ----- */
const TAG_COLORS = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db",
  "#9b59b6", "#e84393", "#fd79a8", "#00b894", "#6c5ce7", "#95a5a6"];
function hexToRgba(hex, a) {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map(x => x + x).join("") : m;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function colorTint(c) { return (!c) ? "" : (c[0] === "#" ? hexToRgba(c, 0.18) : c); }  // 已有 rgba 直接用
let colorPopEl = null;
function closeColorPop() {
  if (colorPopEl) { colorPopEl.remove(); colorPopEl = null; }
  if (window.__cpDoc) { document.removeEventListener("mousedown", window.__cpDoc, true); window.__cpDoc = null; }
}
function openColorPop(anchor, cur, cb) {
  closeColorPop();
  const p = document.createElement("div");
  p.className = "color-pop";
  let html = `<div class="cp-title">选择颜色</div><div class="cp-swatches">`;
  TAG_COLORS.forEach(c => { html += `<span class="cp-sw" data-c="${c}" style="background:${c}" title="${c}"></span>`; });
  html += `</div><div class="cp-row"><button class="btn tiny ghost cp-custom">🎨 自定义取色器</button><button class="btn tiny ghost cp-clear">清除颜色</button></div>`;
  p.innerHTML = html;
  document.body.appendChild(p);
  const r = anchor.getBoundingClientRect();
  p.style.left = Math.min(r.left, innerWidth - p.offsetWidth - 8) + "px";
  p.style.top = (r.bottom + 6) + "px";
  p.querySelectorAll(".cp-sw").forEach(s => s.onclick = () => { cb(s.dataset.c); closeColorPop(); });
  p.querySelector(".cp-custom").onclick = () => { closeColorPop(); openRingPicker((cur && cur[0] === "#") ? cur : "#3498db", cb); };
  p.querySelector(".cp-clear").onclick = () => { cb(""); closeColorPop(); };
  colorPopEl = p;
  window.__cpDoc = e => { if (!p.contains(e.target) && e.target !== anchor) closeColorPop(); };
  setTimeout(() => document.addEventListener("mousedown", window.__cpDoc, true), 0);
}

/* ----- 容器右键（分类 / 任意层级分组通用） ----- */
function openContainerCtx(e, path) {
  const name = path[path.length - 1];
  const isCat = path.length === 1;
  tlMenu(e, [
    { label: "＋ 新建标签", onClick: () => { tagLibPath = path.slice(); renderTagLibSide(); renderTagLib(); openTagCreate(path.slice()); } },
    { label: "＋ 新建下一级分类", onClick: () => tagLibNewGroup(path.slice()) },
    { label: isCat ? "重命名分类" : "重命名分类/分组", onClick: () => tagLibRenameGroup(path.slice()) },
    { label: isCat ? "删除分类" : "删除分类/分组", danger: true, onClick: () => tagLibDeleteGroup(path.slice()) }
  ]);
}
async function tagLibNewGroup(parentPath) {
  const name = await uiPrompt("新建下一级分类", { label: "父级：" + (parentPath.join(" / ") || "（顶级分类）") + "\n新分类名称：", placeholder: "如：常用风格" });
  if (!name) return;
  const r = await api().add_group(parentPath, name.trim());
  if (r === false) { toast("父级不存在"); return; }
  if (r === "dup") { toast("该父级下已有同名分类"); return; }
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib();
  toast("已添加分类：" + name);
}
async function tagLibRenameGroup(path) {
  const oldName = path[path.length - 1];
  const name = await uiPrompt("重命名", { label: "新名称（当前：" + oldName + "）：", placeholder: oldName, value: oldName });
  if (!name || name === oldName) return;
  const r = await api().rename_group(path.slice(), name.trim());
  if (r === false) { toast("分类/分组不存在"); return; }
  if (r === "dup") { toast("同层级已有同名分类"); return; }
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib();
  toast("已重命名：" + name);
}
async function tagLibDeleteGroup(path) {
  const name = path[path.length - 1];
  const ok = await uiConfirm("删除",
    `确定删除 <b>${escAttr(name)}</b>（在「${escAttr(path.slice(0, -1).join(" / ") || "顶级")}」下）吗？<br><span class="hint">其下所有标签与子分类会一并删除，且不可恢复。</span>`,
    { danger: true, okText: "删除" });
  if (!ok) return;
  const done = await api().delete_group(path.slice());
  if (!done) { toast("删除失败（不存在）"); return; }
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  if (tagLibPath && tagLibPath.join(TL_SEP).startsWith(path.join(TL_SEP))) tagLibPath = null;
  renderTagLibSide(); renderTagLib();
  toast("已删除：" + name);
}
async function dropMoveToPath(path) {
  const keys = tagLibDrag || []; tagLibDrag = null;
  if (!keys.length) return;
  let ok = 0, dup = 0;
  for (const k of keys) {
    const parts = k.split(TL_SEP); const en = parts.pop(); const oldPath = parts;
    const r = await api().move_tag(oldPath, en, path.slice());
    if (r === true) ok++; else if (r === "dup") dup++;
  }
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib(); tagLibSel.clear();
  toast(`已移动 ${ok} 个${dup ? `（${dup} 个目标已有，已跳过）` : ""} → ${path.join(" / ")}`);
}
async function catRename() {
  const old = (tagLibPath && tagLibPath[0]) || "";
  const name = await uiPrompt("重命名分类", { label: "新名称（当前：" + old + "）：", placeholder: old, value: old });
  if (!name || name === old) return;
  const r = await api().rename_category(old, name.trim());
  if (r === false) { toast("分类不存在"); return; }
  if (r === "dup") { toast("已有同名分类"); return; }
  if (tagLibPath && tagLibPath.length) tagLibPath[0] = name;
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib();
  toast("已重命名分类：" + name);
}

/* 只有「打开标签库」时播左栏入场；改色/增删等数据刷新重建时不重闪 */
let tagLibEntering = false;

/* 标签库左栏：只同步选中高亮，不重建 DOM（否则展开过渡会被打断） */
function tlSyncSelection(box) {
  const cur = tagLibPath ? tagLibPath.join(TL_SEP) : "";
  box.querySelectorAll("[data-tlkey]").forEach(n => n.classList.toggle("on", n.dataset.tlkey === cur));
}
/* 左栏手风琴：直接切 .active 播放 grid 0fr↔1fr 过渡，不重建 DOM */
function tlSyncOpen(box, name) {
  box.querySelectorAll(".acc-cat").forEach(n => n.classList.toggle("active", !!name && n.dataset.tlkey === name));
}
/* 右栏卡片：滚进 #tagLibGrid 视口才淡入；每次进入都重播（不做一次性） */
let tagLibRevealObs = null;
let tagLibSawIO = false;        // IO 是否已正常回报过（true 时兜底不再介入）
let tagLibRenderT0 = 0;         // 本次渲染时间（区分初始批次与滚动触发，不写进每个卡片）
function tagLibObserve(el) {
  if (noAnim()) { el.dataset.shown = "1"; el.classList.add("in"); return; }  // 关动画：直接显现，不挂观察器
  if (!("IntersectionObserver" in window)) { el.classList.add("in"); return; }
  if (!tagLibRevealObs) {
    tagLibRevealObs = new IntersectionObserver(ents => {
      tagLibSawIO = true;
      ents.forEach(en => {
        const el = en.target;
        if (en.isIntersecting) {
          /* 首屏交错批次首次显现保留行号延迟；滚动触发 / 重复滚进都清零立即播放 */
          if (!el.dataset.shown) {
            el.dataset.shown = "1";
            if (!el.dataset.lead) el.style.setProperty("--i", 0);
          } else {
            if (el.dataset.lead) delete el.dataset.lead;
            el.style.setProperty("--i", 0);
          }
          el.classList.add("in");
        } else {
          el.classList.remove("in");   // 滚出即复位，下次进入再播
        }
      });
    }, { rootMargin: "0px 0px 40px 0px" });   // 用视口 root：网格自身带 contain，交由祖先裁剪判断可见
  }
  tagLibRevealObs.observe(el);
}
/* 点选只切 .sel，不重建网格（避免整屏入场动画重播、拖拽被打断） */
function refreshTagLibSelection() {
  [...($("#tagLibGrid")?.children || [])].forEach((el, i) =>
    el.classList.toggle("sel", tagLibSel.has(tagLibListKeys[i])));
}

/* ----- 渲染：侧栏分类（手风琴：顶层单开，子级任意层级；只做分类导航，不显示标签） ----- */
function renderTagLibSide() {
  const box = $("#tagLibSide"); box.innerHTML = "";
  box.classList.toggle("tl-entering", tagLibEntering);
  tagLibEntering = false;
  const colorMode = state.settings.tag_color_mode || "off";
  const showDot = (colorMode === "category" || colorMode === "hybrid");
  /* 当前展开的大分类：首次按选择自动推断，之后由点击显式决定（可收起） */
  const activeCat = (tagLibOpenCat !== undefined)
    ? tagLibOpenCat
    : (tagLibPath && tagLibPath.length ? tagLibPath[0] : null);

  /* 全部 */
  const all = document.createElement("div");
  all.className = "side-item" + (!tagLibPath ? " on" : "");
  all.dataset.tlkey = "";
  all.style.setProperty("--i", 0);
  all.innerHTML = `<span class="side-color hide"></span><span class="lbl">全部</span><span class="cnt">${_tagLibAllCount()}</span>`;
  all.onclick = () => { tagLibPath = null; tagLibSel.clear(); tlSyncSelection(box); renderTagLib(); };
  all.oncontextmenu = e => { e.preventDefault(); tlMenu(e, [{ label: "＋ 新建分类", onClick: addCategory }]); };
  box.appendChild(all);

  /* 子级（二级/三级…）递归：返回 .acc-sub；含折叠与选中高亮，不渲染标签芯片 */
  const drawSub = (node, path, depth) => {
    const key = path.join(TL_SEP);
    const hasChild = (node.children || []).length > 0;
    const selected = tagLibPath && tagLibPath.join(TL_SEP) === key;
    const folded = tagLibFolded.has(key);
    const el = document.createElement("div");
    el.className = "acc-sub" + (folded ? " folded" : "") + (selected ? " on" : "");
    el.dataset.tlkey = key;
    el.style.marginLeft = (depth >= 2 ? 10 : 0) + "px";
    const title = document.createElement("div");
    title.className = "acc-sub-title";
    title.innerHTML =
      (hasChild ? `<span class="caret">▼</span>` : `<span class="caret spacer"></span>`)
      + `<span class="side-color${showDot ? (node.color ? "" : " empty") : " hide"}"></span>`
      + `<span class="name">${escAttr(node.name)}</span>`
      + `<span class="cnt">${_nodeTagCount(node)}</span>`;
    /* 点标题 = 选中该分类（右侧网格显示其标签）；只切高亮，不重建左栏 */
    title.onclick = () => { tagLibPath = path.slice(); tagLibSel.clear(); tlSyncSelection(box); renderTagLib(); };
    /* 点箭头 = 折叠/展开（不选中），直接切类触发动画 */
    const caretEl = title.querySelector(".caret");
    if (hasChild) caretEl.onclick = e => {
      e.stopPropagation();
      if (tagLibFolded.has(key)) tagLibFolded.delete(key); else tagLibFolded.add(key);
      el.classList.toggle("folded", tagLibFolded.has(key));
    };
    title.oncontextmenu = e => openContainerCtx(e, path.slice());
    if (showDot) {
      const dot = title.querySelector(".side-color");
      if (node.color) dot.style.background = node.color; else dot.classList.add("empty");
      dot.onclick = e => {
        e.stopPropagation();
        openColorPop(dot, node.color || "", async col => {
          const r = await api().set_group_color(path.slice(), col);
          if (r !== false) { state.tags = await api().get_tags(); renderTagLibSide(); renderTagLib(); renderTabs(); renderTags(); }
        });
      };
    }
    /* 拖拽标签落到此容器：移动 */
    title.ondragover = e => { if (tagLibDrag) { e.preventDefault(); title.classList.add("drop"); } };
    title.ondragleave = () => title.classList.remove("drop");
    title.ondrop = async e => { e.preventDefault(); title.classList.remove("drop"); await dropMoveToPath(path.slice()); };
    el.appendChild(title);
    if (hasChild) {
      const body = document.createElement("div"); body.className = "acc-sub-body";
      (node.children || []).forEach(ch => body.appendChild(drawSub(ch, path.concat(ch.name), depth + 1)));
      const add = document.createElement("div");
      add.className = "side-item add";
      add.textContent = "＋ 新建子分类";
      add.title = "在「" + path.join(" / ") + "」下新建下一级分类";
      add.onclick = () => tagLibNewGroup(path.slice());
      body.appendChild(add);
      el.appendChild(body);
    }
    return el;
  };

  /* 顶层分类 = 手风琴大条（同一时间只展开一条） */
  state.tags.forEach((c, ci) => {
    const hasChild = (c.children || []).length > 0;
    const open = activeCat === c.name;
    const cat = document.createElement("div");
    cat.className = "acc-cat" + (open ? " active" : "");
    cat.dataset.tlkey = c.name;
    cat.style.setProperty("--i", Math.min(ci + 1, 20));
    const bar = document.createElement("div");
    bar.className = "acc-bar";
    bar.innerHTML =
      `<span class="caret">▼</span>`
      + `<span class="side-color${showDot ? (c.color ? "" : " empty") : " hide"}"></span>`
      + `<span class="name">${escAttr(c.name)}</span>`
      + `<span class="cnt">${_nodeTagCount(c)}</span>`;
    /* 点大条 = 选中该分类 + 展开/收起切换；直接切类让 grid 过渡真正播放，不重建左栏 */
    bar.onclick = () => {
      tagLibPath = [c.name]; tagLibSel.clear();
      const wasOpen = cat.classList.contains("active");
      tagLibOpenCat = wasOpen ? null : c.name;
      tlSyncOpen(box, wasOpen ? "" : c.name);   // 旧条收拢、新条展开（或全收）
      tlSyncSelection(box);
      renderTagLib();
    };
    bar.oncontextmenu = e => openContainerCtx(e, [c.name]);
    if (showDot) {
      const dot = bar.querySelector(".side-color");
      if (c.color) dot.style.background = c.color; else dot.classList.add("empty");
      dot.onclick = e => {
        e.stopPropagation();
        openColorPop(dot, c.color || "", async col => {
          const r = await api().set_group_color([c.name], col);
          if (r !== false) { state.tags = await api().get_tags(); renderTagLibSide(); renderTagLib(); renderTabs(); renderTags(); }
        });
      };
    }
    bar.ondragover = e => { if (tagLibDrag) { e.preventDefault(); bar.classList.add("drop"); } };
    bar.ondragleave = () => bar.classList.remove("drop");
    bar.ondrop = async e => { e.preventDefault(); bar.classList.remove("drop"); await dropMoveToPath([c.name]); };
    cat.appendChild(bar);
    if (hasChild) {
      const panel = document.createElement("div"); panel.className = "acc-panel";
      const subBody = document.createElement("div"); subBody.className = "acc-sub-body";
      (c.children || []).forEach(ch => subBody.appendChild(drawSub(ch, [c.name, ch.name], 1)));
      const add = document.createElement("div");
      add.className = "side-item add";
      add.textContent = "＋ 新建子分类";
      add.title = "在「" + c.name + "」下新建下一级分类";
      add.onclick = () => tagLibNewGroup([c.name]);
      subBody.appendChild(add);
      panel.appendChild(subBody);
      cat.appendChild(panel);
    }
    box.appendChild(cat);
  });

  /* 新建分类 */
  const addBtn = document.createElement("div");
  addBtn.className = "side-item add";
  addBtn.style.setProperty("--i", Math.min(state.tags.length + 1, 21));
  addBtn.textContent = "＋ 新建分类";
  addBtn.title = "新建一个空分类";
  addBtn.onclick = async () => { await addCategory(); renderTagLibSide(); renderTagLib(); };
  box.appendChild(addBtn);
}

/* ----- 渲染：标签网格（含选择 / 右键 / 拖拽） ----- */
function renderTagLib() {
  const kw = $("#tagLibSearch").value.trim().toLowerCase();
  const box = $("#tagLibGrid");
  if (tagLibRevealObs) [...box.children].forEach(n => tagLibRevealObs.unobserve(n));  // 只释放旧目标
  box.innerHTML = "";
  tagLibSawIO = false;
  tagLibRenderT0 = performance.now();
  let list = _tagLibScope();
  if (kw) list = list.filter(o => (o.t[0] || "").toLowerCase().includes(kw) || String(o.t[1] || "").toLowerCase().includes(kw));
  const cnt = $("#tagLibCnt"); if (cnt) cnt.textContent = list.length + " 个";
  if (!list.length) { box.innerHTML = `<div class="empty" style="grid-column:1/-1">没有匹配的标签</div>`; tagLibListKeys = []; return; }
  const disp = dispOf("disp_lib");
  const colorMode = state.settings.tag_color_mode || "off";
  const catColor = {};                                  // 顶层分类名 → 颜色（分类/混合模式都要用）
  if (colorMode === "category" || colorMode === "hybrid") state.tags.forEach(c => {
    if (c.color) catColor[c.name] = c.color;
  });
  tagLibListKeys = list.map(o => tlKey(o.path, o.t));
  /* 首屏可见卡片按「行」交错：只给首屏范围内的卡片写 --i，不给 3919 张全写（保持上轮的性能修复）。
     列数按 minmax(150px)+gap 估算，行数按卡片 54px+gap 估算；容器当时隐藏时用兜底尺寸。 */
  const cols = Math.max(1, Math.floor(((box.clientWidth || 900) + 8) / 158));
  const rows = Math.ceil((box.clientHeight || 620) / 62) + 1;
  const cap = Math.min(list.length, cols * rows);
  list.forEach((o, i) => {
    const key = tagLibListKeys[i];
    const el = document.createElement("div");
    el.className = "taglib-chip" + (tagLibSel.has(key) ? " sel" : "");
    if (i < cap) {                       // --i = 行号，整排一起浮现；lead 标记保住首屏交错不被清零
      el.style.setProperty("--i", Math.floor(i / cols));
      el.dataset.lead = "1";
    }
    const zh = o.t[1] || "";
    const main = disp === "zh" && zh ? zh : o.t[0];
    const imgs = (o.t[2] && o.t[2].length) ? o.t[2] : [];
    let html = imgs.length ? `<img class="tl-img" alt="">` : "";
    html += `<div class="tl-txt"><span class="en">${escAttr(main)}</span>`
      + (disp === "both" ? `<span class="zh">${escAttr(zh ? zh : "（未翻译）")}</span>` : "") + `</div>`;
    if (colorMode === "individual" || colorMode === "hybrid") html += `<span class="tl-color" title="给这个标签单独上色">🎨</span>`;
    html += `<span class="del" title="删除标签">✕</span>`;
    if (imgs.length > 1) html += `<span class="tl-badge">1/${imgs.length}</span>`;
    el.innerHTML = html;
    /* 染色：按分类 → 整类同色；独立 → 取标签自带色 t[3]；混合 → 标签色优先，否则继承所属容器底色（任意层级） */
    let color = "";
    if (colorMode === "category") color = catColor[o.path[0]] || "";
    else if (colorMode === "individual") color = o.t[3] || "";
    else if (colorMode === "hybrid") color = o.t[3] || colorOfPath(o.path) || catColor[o.path[0]] || "";
    if (color) { el.style.borderLeft = "4px solid " + color; el.style.background = colorTint(color); }
    else { el.style.borderLeft = ""; el.style.background = ""; }
    el.title = o.t[0] + (zh ? "（" + zh + "）" : "") + (imgs.length ? `　示例图 ${imgs.length} 张（滚轮切换 / 点图看大图）` : "") + "；双击编辑此标签";
    el.dataset.imgs = imgs.length ? JSON.stringify(imgs) : "";
    el.dataset.idx = "0";
    el.draggable = true;
    if (imgs.length) loadTagImg(el, imgs[0]);
    el.onclick = e => onTagClick(e, i, key);
    el.ondblclick = e => {                       // 双击直接编辑（开重命名弹窗，可改名称+内容）
      e.preventDefault();
      tagLibSel.clear(); tagLibSel.add(key); tagLibLastClick = i;
      openTagRename(o.path, o.t[0], o.t[0], o.t[1] || "");
    };
    el.oncontextmenu = e => {
      e.preventDefault();
      if (!tagLibSel.has(key)) { if (!e.ctrlKey && !e.metaKey) tagLibSel.clear(); tagLibSel.add(key); }
      tagLibLastClick = i; refreshTagLibSelection(); openTagCtx(e);
    };
    if (imgs.length) el.querySelector(".tl-img").onclick = e => { e.stopPropagation(); openTagImages(o); };
    el.querySelector(".del").onclick = e => { e.stopPropagation(); tagLibSel.clear(); tagLibSel.add(key); tagDeleteSel(); };
    const colorBtn = el.querySelector(".tl-color");
    if (colorBtn) colorBtn.onclick = e => {           // 独立模式：给单张卡片上色
      e.stopPropagation();
      openColorPop(colorBtn, o.t[3] || "", async c => {
        const r = await api().set_tag_color(o.path, o.t[0], c);
        if (r !== false) { state.tags = await api().get_tags(); renderTagLib(); renderTags(); }
      });
    };
    el.onwheel = e => {                                  // 滚轮在卡片上切换多张示例图（对齐奥术秘典）
      if (!imgs.length) return;
      e.preventDefault();
      const n = imgs.length, j = (+el.dataset.idx + (e.deltaY > 0 ? 1 : -1) + n) % n;
      el.dataset.idx = j; loadTagImg(el, imgs[j]);
      const b = el.querySelector(".tl-badge"); if (b) b.textContent = (j + 1) + "/" + n;
    };
    el.ondragover = e => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) e.preventDefault(); };
    el.ondrop = async e => {                              // 拖图片到卡片 → 加示例图
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault(); e.stopPropagation(); await tagAddImages(e.dataTransfer.files, o);
      }
    };
    el.ondragstart = e => {
      if (!tagLibSel.has(key)) { tagLibSel.clear(); tagLibSel.add(key); refreshTagLibSelection(); }
      tagLibDrag = [...tagLibSel];
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", key); } catch (_) {}
    };
    el.ondragend = () => { tagLibDrag = null; document.querySelectorAll(".side-item.drop").forEach(d => d.classList.remove("drop")); };
    box.appendChild(el);
    tagLibObserve(el);
  });
  /* 兜底（仅在 IO 完全没回报时才介入，正常路径零开销）：
     250ms 后一张都没显现且容器可见 → 只扫前 160 张、先读后写，避免整网格布局抖动 */
  setTimeout(() => {
    if (noAnim() || tagLibSawIO || !box.children.length || !box.clientHeight) return;
    const r = box.getBoundingClientRect();
    const hits = [];
    for (let i = 0, n; i < box.children.length && i < 160; i++) {
      n = box.children[i];
      const b = n.getBoundingClientRect();
      if (b.top < r.bottom + 40 && b.bottom > r.top) hits.push(n);
    }
    hits.forEach(n => { n.dataset.shown = "1"; n.style.setProperty("--i", 0); n.classList.add("in"); });
  }, 250);
}
function onTagClick(e, i, key) {
  if (e.ctrlKey || e.metaKey) {
    tagLibSel.has(key) ? tagLibSel.delete(key) : tagLibSel.add(key);
    tagLibLastClick = i; refreshTagLibSelection(); return;
  }
  if (e.shiftKey && tagLibLastClick != null) {
    const a = Math.min(tagLibLastClick, i), b = Math.max(tagLibLastClick, i);
    for (let j = a; j <= b; j++) tagLibSel.add(tagLibListKeys[j]);
    refreshTagLibSelection(); return;
  }
  tagLibSel.clear(); tagLibSel.add(key); tagLibLastClick = i; refreshTagLibSelection();
}

/* ----- 新建标签（弹窗：名称 + 内容 + 所属容器路径） ----- */
/* ＋新建标签：弹窗式（名称 = 显示名，内容 = 实际提示词，存为 [内容, 名称]）
   src = "lib"（标签库窗口）/ "main"（主界面，用当前标签页 state.cat）；path 指定默认所属容器 */
let tagCreateSrc = "lib";
/* 新建标签弹窗的「所属容器」级联选择（支持任意层级）：
   tcPathSelections = 各级依次选中的容器名数组；每级根据上一级的子容器动态生成下一级 <select> */
function renderTcPath() {
  const box = $("#tcPath"); if (!box) return;
  box.innerHTML = "";
  let path = [];
  for (let depth = 0; ; depth++) {
    const parentNode = depth === 0 ? { children: state.tags } : findContainer(path);
    if (!parentNode) break;
    const children = parentNode.children || [];
    const sel = document.createElement("select");
    sel.className = "tc-path-sel";
    const none = document.createElement("option");
    none.value = ""; none.textContent = depth === 0 ? "（选择分类）" : "（选择子分类）";
    sel.appendChild(none);
    children.forEach(ch => { const o = document.createElement("option"); o.value = ch.name; o.textContent = ch.name; sel.appendChild(o); });
    const nv = document.createElement("option");
    nv.value = "__new__"; nv.textContent = depth === 0 ? "＋ 新建分类…" : "＋ 在此下新建子分类…";
    sel.appendChild(nv);
    const cur = (tcPathSelections[depth] || "");
    sel.value = cur;
    sel.onchange = () => onTcPathChange(depth, sel.value);
    box.appendChild(sel);
    if (!cur || cur === "__new__") break;        // 没有有效父级就停止级联
    path.push(cur);
  }
}
async function onTcPathChange(depth, val) {
  if (val === "__new__") {
    const parentPath = tcPathSelections.slice(0, depth);
    const isCat = depth === 0;
    const name = await uiPrompt(isCat ? "新建分类" : "新建子分类",
      { label: isCat ? "分类名称：" : "父级：" + (parentPath.join(" / ") || "（顶级）") + "\n子分类名称：", placeholder: "如：常用风格" });
    if (!name) { renderTcPath(); return; }
    const r = isCat ? await api().add_category(name.trim()) : await api().add_group(parentPath, name.trim());
    if (r === false) { toast(isCat ? "分类已存在或名称无效" : "父级不存在"); renderTcPath(); return; }
    if (r === "dup") { toast(isCat ? "分类已存在" : "同层级已有同名分类"); renderTcPath(); return; }
    state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags(); renderTagLibSide();
    tcPathSelections = tcPathSelections.slice(0, depth).concat([name.trim()]);
    renderTcPath();
    return;
  }
  tcPathSelections = tcPathSelections.slice(0, depth).concat([val]);
  renderTcPath();
}
/* src = "lib"（标签库窗口）/ "main"（主界面，用当前标签页 state.cat）；path = 指定默认所属容器路径 */
function openTagCreate(src, path) {
  tagCreateSrc = src === "main" ? "main" : "lib";
  let def = [];
  if (Array.isArray(path) && path.length) def = path.slice();
  else if (tagCreateSrc === "main") {
    def = openCat ? [openCat] : (state.tags[0] ? [state.tags[0].name] : []);
  } else if (tagLibPath && tagLibPath.length) def = tagLibPath.slice();
  else if (state.tags[0]) def = [state.tags[0].name];
  tcPathSelections = def;
  renderTcPath();
  $("#tcTitle").textContent = `＋ 新建标签`;
  $("#tcName").value = "";
  $("#tcContent").value = "";
  $("#tagCreateMask").hidden = false;
  setTimeout(() => $("#tcName").focus(), 50);
}
function closeTagCreate() { $("#tagCreateMask").hidden = true; }
async function saveTagCreate() {
  const name = $("#tcName").value.trim();
  const content = $("#tcContent").value.trim();
  if (!name) { toast("请填写标签名称"); return; }
  const containerPath = tcPathSelections.filter(x => x && x !== "__new__");
  if (!containerPath.length) containerPath = state.tags[0] ? [state.tags[0].name] : [];
  const r = await api().add_tag(containerPath, content || name, name);
  if (r === false) { toast("容器不存在"); return; }
  if (r === "dup") { toast("该容器下已有此标签"); return; }
  closeTagCreate();
  state.tags = await api().get_tags();
  buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib();
  toast("已添加到「" + containerPath.join(" / ") + "」：" + name);
}

/* ----- 重命名标签（弹窗：名称 + 内容 + 示例图管理） ----- */
function openTagRename(path, old_en, content, name) {
  tagRenCtx = { path: Array.isArray(path) ? path.slice() : [path], old_en };
  $("#trTitle").textContent = `编辑标签（在「${tagRenCtx.path.join(" / ")}」）`;
  $("#trName").value = name || "";
  $("#trContent").value = content || "";
  $("#tagRenameMask").hidden = false;
  /* 示例图：拖拽区 + 缩略图 */
  const ib = $("#trImgs");
  ib.ondragover = e => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); ib.classList.add("drop"); } };
  ib.ondragleave = () => ib.classList.remove("drop");
  ib.ondrop = e => { ib.classList.remove("drop"); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); trAddFiles(e.dataTransfer.files); } };
  trRender();
  trColorRender();
  setTimeout(() => $("#trName").focus(), 50);
}
function closeTagRename() { $("#tagRenameMask").hidden = true; }
function trTag() { return findTag(tagRenCtx.path[0], tagRenCtx.old_en); }
async function trRender() {
  const box = $("#trImgs"); if (!box) return;
  box.innerHTML = "";
  const t = trTag();
  const imgs = (t && t[2]) ? t[2] : [];
  if (!imgs.length) { box.innerHTML = `<div class="hint" style="padding:6px 0">还没有示例图——点「＋添加图片」或直接把图片拖到这里</div>`; return; }
  imgs.forEach((rel, i) => {
    const d = document.createElement("div");
    d.className = "tr-img";
    d.innerHTML = `<img alt=""><div class="tr-img-bar"><span class="cv" title="设为封面（卡片缩略图用这张）">★</span><span class="rm" title="删除这张">🗑</span></div>`;
    api().tag_image(rel, 120).then(b => { if (b) d.querySelector("img").src = b; });
    d.querySelector(".cv").onclick = async () => {
      const r = await api().set_cover_tag_image(tagRenCtx.path, tagRenCtx.old_en, i);
      if (r) { state.tags = await api().get_tags(); renderTagLib(); trRender(); toast("已设为封面"); }
    };
    d.querySelector(".rm").onclick = async () => {
      const r = await api().remove_tag_image(tagRenCtx.path, tagRenCtx.old_en, i);
      if (r) { state.tags = await api().get_tags(); renderTagLib(); trRender(); }
    };
    box.appendChild(d);
  });
}
async function trAddFiles(files) {
  if (!files || !files.length) return;
  let n = 0;
  for (const f of files) {
    if (!f.type || !f.type.startsWith("image/")) continue;
    const du = await fileToB64(f);
    const b64 = du.split(",")[1] || "";
    const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
    if (await api().add_tag_image(tagRenCtx.path, tagRenCtx.old_en, b64, ext)) n++;
  }
  const fi = $("#trImgFile"); if (fi) fi.value = "";
  if (n) { state.tags = await api().get_tags(); renderTagLib(); trRender(); toast("已添加 " + n + " 张示例图"); }
}
/* 编辑弹窗里的「标签颜色」：独立/混合模式下给单张卡设色（与卡片 hover 🎨 同套后端） */
function trCurColor() { const t = trTag(); return (t && t[3]) ? t[3] : ""; }
function trColorRender() {
  const sw = $("#trColorSw"); if (!sw) return;
  const c = trCurColor();
  sw.style.background = c || "transparent";
  sw.classList.toggle("empty", !c);
  const clearBtn = $("#trColorClear"); if (clearBtn) clearBtn.hidden = !c;
  const hint = $("#trColorHint");
  if (hint) {
    const m = state.settings.tag_color_mode;
    hint.textContent = (m === "individual" || m === "hybrid")
      ? "颜色会显示在标签卡片左侧色条与底色；混合模式下未单独设色的卡片继承所属分类底色"
      : "提示：当前未开启独立上色，需到 设置→📚标签库→标签染色 选「每个标签独立」或「混合」后卡片才显示此颜色";
  }
}
async function trSetColor(c) {
  const r = await api().set_tag_color(tagRenCtx.path, tagRenCtx.old_en, c);
  if (r !== false) { state.tags = await api().get_tags(); renderTagLib(); renderTags(); trColorRender(); }
}
function trPickColor() { openColorPop($("#trColorSw"), trCurColor(), c => trSetColor(c)); }
function trClearColor() { trSetColor(""); }
async function saveTagRename() {
  const name = $("#trName").value.trim();
  const content = $("#trContent").value.trim();
  if (!name) { toast("请填写标签名称"); return; }
  const { path, old_en } = tagRenCtx;
  const r = await api().rename_tag(path, old_en, content || name, name);
  if (r === false) { toast("标签不存在"); return; }
  closeTagRename();
  state.tags = await api().get_tags(); buildZh(); renderTabs(); renderTags();
  renderTagLibSide(); renderTagLib(); tagLibSel.clear();
  toast("已重命名标签：" + name);
}

/* ----- 删除分类 ----- */
async function tagLibDeleteCategory(name) {
  const ok = await uiConfirm("删除分类", `确定删除整个分类 <b>${name}</b> 吗？<br><span class="hint">该分类下所有标签会一并删除，且不可恢复。</span>`, { danger: true, okText: "删除" });
  if (!ok) return;
  const done = await api().delete_category(name);
  if (done) {
    state.tags = await api().get_tags(); buildZh();
    if (tagLibPath && tagLibPath[0] === name) tagLibPath = null;
    renderTagLibSide(); renderTagLib(); toast("已删除分类：" + name);
  } else toast("删除失败（分类不存在）");
}

/* 用户新建分类 */
async function addCategory() {
  const name = await uiPrompt("新建分类", { label: "分类名称：", placeholder: "如：我的常用" });
  if (!name) return;
  const ok = await api().add_category(name.trim());
  if (ok === false) { toast("分类已存在或名称无效"); return; }
  state.tags = await api().get_tags();
  buildZh(); renderTabs(); renderTags();
  toast("已添加分类：" + name);
}
/* 智能建标签：
   输入中文 → 先反查标签库，查不到标记 _tr（待翻成英文）
   输入英文 → 先查标签库中文对照，查不到标记 _t2（待翻成中文） */
function mkTag(text) {
  const s = String(text).trim();
  if (hasZh(s)) {
    const en = state.zhRev && state.zhRev[s];
    if (en) return { en, zh: s, w: 1 };
    return { en: s, zh: s, w: 1, _tr: true };
  }
  const zh = (state.zhMap && state.zhMap[s]) || "";
  return { en: s, zh, w: 1, _t2: !zh };
}

/* 批量翻译：多条合并成一次请求（换行分隔）+ 多路并发；
   返回条数与输入不符时自动退回逐条，确保不错位 */
async function translateBatch(texts, direction) {
  const out = new Array(texts.length).fill("");
  if (!texts.length) return out;
  const CHUNK = 15, CONC = 4;
  const chunks = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    chunks.push({ start: i, items: texts.slice(i, i + CHUNK) });
  }
  async function runChunk(ch) {
    try {
      const r = await api().translate_text(ch.items.join("\n"), null, direction);
      if (r && r.success && r.translated_text) {
        const lines = String(r.translated_text).split(/\r?\n/).map(s => s.trim());
        if (lines.length === ch.items.length) {          // 条数一致才批量回填
          lines.forEach((s, k) => { out[ch.start + k] = s; });
          return;
        }
      }
    } catch (e) { }
    for (let k = 0; k < ch.items.length; k++) {          // 退回逐条
      try {
        const r = await api().translate_text(ch.items[k], null, direction);
        if (r && r.success && r.translated_text) out[ch.start + k] = String(r.translated_text).trim();
      } catch (e) { }
    }
  }
  let idx = 0;
  async function worker() { while (idx < chunks.length) await runChunk(chunks[idx++]); }
  await Promise.all(Array.from({ length: Math.min(CONC, chunks.length) }, worker));
  return out;
}

/* 自动翻译（双向）：
   _tr  → 中文翻成英文
   _t2  → 英文翻成中文（含之前遗留的"未翻译"词，下次加词时一起补翻） */
async function translatePending(arr, rerender) {
  const pend1 = arr.filter(t => t._tr);                       // 中文 → 英文
  const pend2 = arr.filter(t => !t._tr && (t._t2 || !t.zh));  // 英文 → 中文
  if (!pend1.length && !pend2.length) return;
  toast("自动翻译中…");
  let ok = 0;
  if (pend1.length) {
    const res = await translateBatch(pend1.map(t => t.en), "zh2en");
    pend1.forEach((t, i) => {
      const v = res[i];
      if (v) { t.zh = t.en; t.en = v; ok++; }
      delete t._tr;
    });
  }
  if (pend2.length) {
    const res = await translateBatch(pend2.map(t => t.en), "en2zh");
    pend2.forEach((t, i) => {
      const v = res[i];
      if (v && hasZh(v)) { t.zh = v; ok++; delete t._t2; }
      // 没翻出中文就保留标记，下次再加词时会重试
    });
  }
  rerender();
  if (ok) { toast(`自动翻译完成（${ok} 个）`); saveProgress(); }
  else toast("自动翻译失败，可稍后点「中 → 英」重试");
}
/* 一键翻译：把一组标签里缺的那一半语言补齐（双向）
   缺中文 → 翻成中文；en 位置还是中文 → 翻成英文 */
async function translateAll(arr, rerender) {
  if (!arr || !arr.length) { toast("还没有标签"); return; }
  let n = 0;
  arr.forEach(t => {
    if (t.fixed) return;                       // 触发词这类固定项不翻
    if (t._tr) { n++; return; }                // 已标记待翻英文
    if (!t.zh) { t._t2 = true; n++; }          // 缺中文 → 翻中文
    else if (hasZh(t.en)) { t._tr = true; n++; } // en 位置是中文 → 翻英文
  });
  if (!n) { toast("这些标签都有中英文对照了"); return; }
  await translatePending(arr, rerender);
}

/* 一键翻译全部：把当前文件夹里所有图的标签一次补齐中英文对照 */
async function translateAllFolder() {
  const paths = Object.keys(state.capData).filter(p => (state.capData[p].tags || []).length);
  if (!paths.length) { toast("还没有任何打标记录"); return; }
  let total = 0;
  paths.forEach(p => (state.capData[p].tags || []).forEach(t => {
    if (t._tr || !t.zh) total++;
    else if (hasZh(t.en)) total++;
  }));
  if (!total) { toast("所有标签都有中英文对照了"); return; }
  const ok = await uiConfirm("翻译全部标签",
    `将补齐 <b>${paths.length}</b> 张图里 <b>${total}</b> 个标签的中英文对照。<br>` +
    `· 英文标签缺中文对照的 → 补翻中文<br>` +
    `· 中文标签还没翻出英文的 → 补翻英文<br>` +
    `· 已经有中英文对照的不会动`,
    { okText: "开始翻译" });
  if (!ok) return;

  toast("翻译中，请稍候…");
  let done = 0;
  const jobs1 = [], jobs2 = [];
  paths.forEach(p => (state.capData[p].tags || []).forEach(t => {
    if (t._tr) jobs1.push(t);
    else if (!t.zh || t._t2) jobs2.push(t);
  }));
  if (jobs1.length) {                               // 中文 → 英文
    const res = await translateBatch(jobs1.map(t => t.en), "zh2en");
    jobs1.forEach((t, i) => {
      const v = res[i];
      if (v) { t.zh = t.en; t.en = v; done++; }
      delete t._tr;
    });
  }
  if (jobs2.length) {                               // 英文 → 中文
    const res = await translateBatch(jobs2.map(t => t.en), "en2zh");
    jobs2.forEach((t, i) => {
      const v = res[i];
      if (v && hasZh(v)) { t.zh = v; done++; delete t._t2; }
    });
  }
  saveProgress(); renderCapTags(); renderThumbs();
  toast(done ? `翻译完成，共补齐 ${done} 个标签` : "没有翻译成功，稍后可重试");
}

/* 入库前自动补翻译：统计 + 批量翻译缺中文/缺英文的标签 */
function countUntranslated(arr) {
  return (arr || []).filter(t => !t.fixed && (t._tr || !t.zh)).length;
}
async function translatePendingArrays(arrays) {
  const jobs1 = [], jobs2 = [];
  (arrays || []).forEach(arr => (arr || []).forEach(t => {
    if (t.fixed) return;
    if (t._tr) jobs1.push(t);                    // 中文 → 英文
    else if (!t.zh || t._t2) jobs2.push(t);      // 英文 → 中文
  }));
  if (!jobs1.length && !jobs2.length) return 0;
  let done = 0;
  if (jobs1.length) {
    const res = await translateBatch(jobs1.map(t => t.en), "zh2en");
    jobs1.forEach((t, i) => { const v = res[i]; if (v) { t.zh = t.en; t.en = v; done++; } delete t._tr; });
  }
  if (jobs2.length) {
    const res = await translateBatch(jobs2.map(t => t.en), "en2zh");
    jobs2.forEach((t, i) => { const v = res[i]; if (v && hasZh(v)) { t.zh = v; done++; delete t._t2; } });
  }
  return done;
}

function focusArr() { return state.focus === "pos" ? state.posTags : state.negTags; }

function addTagTo(arr, en) {
  const parts = String(en || "").split(/[,，]/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  parts.forEach(p => { if (!arr.some(t => t.en === p)) { arr.push(mkTag(p)); added++; } });
  return added;
}

function insertTag(en) {
  if (state.mode === "caption") { addCapTag(en); return; }
  const arr = focusArr();
  const n = addTagTo(arr, en);
  if (!n) { toast("已有该标签"); return; }
  renderPromptBox(state.focus);
  translatePending(arr, () => renderPromptBox(state.focus));
}

function enText(t) { return t.w && t.w !== 1 ? `(${t.en}:${t.w.toFixed(1)})` : t.en; }

/* 标词显示模式：三处（打标框 / 标签库 / 打标库）可各自独立设置 */
function dispOf(key) { return (state.settings && state.settings[key]) || "both"; }
function dispTag(t, mode) {
  const en = t.en || "", zh = (t.zh || "").trim();
  if (mode === "zh") return zh || en;
  if (mode === "en") return en || zh;
  return zh ? `${en}（${zh}）` : en;
}

function renderChips(box, arr, which, opts = {}) {
  box.innerHTML = "";
  arr.forEach((t, i) => {
    const el = document.createElement("span");
    el.className = "pchip"
      + (opts.fixedIdx === i ? " trigger" : "")
      + (state.sel && state.sel.which === which && state.sel.idx === i ? " sel" : "");
    const dMode = dispOf("disp_cap");
    const main = (dMode === "zh" && t.zh) ? t.zh : enText(t);
    el.innerHTML = `<span class="en">${main}<span class="del">✕</span></span>`
      + (dMode === "both" ? `<span class="zh">${t.zh ? "🈶 " + t.zh : "🈶 未翻译"}</span>` : "");
    el.onclick = e => {
      if (e.target.classList.contains("del")) {
        if (opts.onDel) { opts.onDel(i); return; }
        arr.splice(i, 1);
        if (state.sel && state.sel.which === which) state.sel = null;
        opts.rerender(); saveProgress();
        return;
      }
      state.sel = { which, idx: i };
      opts.rerender();
    };
    box.appendChild(el);
  });
  let emptyDiv = null;
  if (!arr.length) {
    emptyDiv = document.createElement("div");
    emptyDiv.className = "empty"; emptyDiv.textContent = opts.emptyText || "";
    box.appendChild(emptyDiv);
  }
  const inp = document.createElement("input");
  inp.className = "taginput";
  inp.placeholder = opts.placeholder || "输入后回车添加（可逗号分隔多个）…";
  // 输入框有内容时隐藏提示文字，清空后恢复
  const syncEmpty = () => { if (emptyDiv) emptyDiv.style.display = inp.value.trim() ? "none" : ""; };
  inp.addEventListener("input", syncEmpty);
  inp.addEventListener("focus", syncEmpty);
  inp.addEventListener("blur", syncEmpty);
  /* 重新渲染会重建输入框，需要把光标送回去 */
  const refocus = () => { const ni = box.querySelector(".taginput"); if (ni) ni.focus(); };

  let idleTimer = null;
  /* 停顿自动入框：停止输入 N 秒后把输入框里的内容整体加进去 */
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (!state.settings.auto_add_idle) return;
    const sec = Math.min(5, Math.max(0.5, Number(state.settings.idle_sec) || 1.5));
    idleTimer = setTimeout(() => {
      if (!inp.isConnected) return;                 // 该输入框已被重新渲染替换
      const cur = inp.value.trim();
      if (!cur) return;
      const n = addTagTo(arr, cur);
      inp.value = "";
      state.sel = null; opts.rerender(); saveProgress(); refocus();
      if (!n) toast("已有该标签"); else translatePending(arr, opts.rerender);
    }, sec * 1000);
  };

  inp.onkeydown = e => {
    if (e.key === "Enter" && e.target.value.trim()) {
      clearTimeout(idleTimer);
      const n = addTagTo(arr, e.target.value);
      e.target.value = "";
      if (!n) toast("已有该标签");
      state.sel = null; opts.rerender(); saveProgress(); refocus();
      translatePending(arr, opts.rerender);
    }
  };
  // 自动添加：开启后打逗号（英文 , 或中文 ，）即把前面的内容入框并自动翻译
  inp.addEventListener("input", () => {
    syncEmpty();
    if (state.settings.auto_add_tag && /[,，]/.test(inp.value)) {
      const parts = inp.value.split(/[,，]/);
      const rest = parts.pop();                     // 最后一段继续留在输入框
      const toAdd = parts.join(",");
      if (toAdd.trim()) {
        const n = addTagTo(arr, toAdd);
        inp.value = rest;
        state.sel = null; opts.rerender(); saveProgress(); refocus();
        if (!n) toast("已有该标签"); else translatePending(arr, opts.rerender);
        return;
      }
    }
    scheduleIdle();
  });
  box.appendChild(inp);
  box.onclick = e => { if (e.target === box) inp.focus(); };
}

function renderPromptBox(which) {
  const arr = which === "pos" ? state.posTags : state.negTags;
  renderChips($("#" + which + "Box"), arr, which, {
    emptyText: "点击左侧标签添加到这里，或在框内输入",
    rerender: () => renderPromptBox(which)
  });
  $("#cnt" + (which === "pos" ? "Pos" : "Neg")).textContent = arr.length + " 个标签";
  syncGlobalPanel();
}

/* 把当前正/反向提示词同步给「全局填入」面板（任何软件里按热键就能填） */
let gpSyncTimer = null;
function syncGlobalPanel() {
  clearTimeout(gpSyncTimer);
  gpSyncTimer = setTimeout(() => {
    try { api().gp_sync(tagsToText(state.posTags), tagsToText(state.negTags)); }
    catch (e) { }
  }, 200);
}

function adjust(delta) {
  const s = state.sel;
  if (!s) { toast("先点选一个标签再调权重"); return; }
  const arr = s.which === "pos" ? state.posTags : s.which === "neg" ? state.negTags : cur().tags;
  const t = arr[s.idx];
  if (!t) { state.sel = null; return; }
  t.w = Math.min(2, Math.max(0.1, Math.round(((t.w || 1) + delta) * 10) / 10));
  if (Math.abs(t.w - 1) < 1e-3) t.w = 1;
  if (s.which === "cap") { renderCapTags(); saveProgress(); }
  else renderPromptBox(s.which);
}

function tagsToText(arr) { return arr.map(enText).join(", "); }

async function copyPrompt(which) {
  let text;
  if (which === "all") {
    const p = tagsToText(state.posTags), n = tagsToText(state.negTags);
    text = [p && "Positive: " + p, n && "Negative: " + n].filter(Boolean).join("\n");
    if (!text) { toast("没有内容可复制"); return; }
  } else {
    text = tagsToText(which === "pos" ? state.posTags : state.negTags);
    if (!text) { toast("没有内容可复制"); return; }
  }
  try { await navigator.clipboard.writeText(text); toast("已复制：" + text.slice(0, 60) + (text.length > 60 ? " …" : "")); }
  catch (e) { toast("复制失败，内容：" + text); }
}

/* 独立清空：只清指定的那一区（pos / neg） */
async function clearPrompt(which) {
  const isPos = which === "pos";
  const arr = isPos ? state.posTags : state.negTags;
  const name = isPos ? "正向提示词" : "反向提示词";
  if (!arr || !arr.length) { toast(name + "已经是空的"); return; }
  const ok = await uiConfirm(`清空${name}`,
    `将清空${name}里的 <b>${arr.length}</b> 个标签。<br>另一区不受影响。`,
    { okText: "清空", danger: true });
  if (!ok) return;
  if (isPos) state.posTags = []; else state.negTags = [];
  state.sel = null;
  renderPromptBox("pos"); renderPromptBox("neg");
  toast(`已清空${name}`);
}

/* ---------------- 翻译 ---------------- */
async function doTranslate(which) {
  const arr = which === "pos" ? state.posTags : state.negTags;
  let targets = [];
  if (state.sel && state.sel.which === which) targets = [arr[state.sel.idx]];
  else targets = arr.filter(t => hasZh(t.en));
  if (!targets.length) { toast("没有需要翻译的中文标签（可先点选一个）"); return; }
  toast("翻译中…");
  let ok = 0;
  const res = await translateBatch(targets.map(t => t.en), "zh2en");
  targets.forEach((t, i) => {
    const v = res[i];
    if (v) {
      t.en = v;
      t.zh = t.zh || (state.zhMap && state.zhMap[v]) || "";
      ok++;
    }
  });
  renderPromptBox(which);
  toast(ok ? "已翻译 " + ok + " 个标签" : "翻译失败，请稍后重试");
}

/* ---------------- 打标模式 ---------------- */
async function openFolder() {
  const folder = await api().pick_folder();
  if (!folder) return;
  state.folder = folder;
  $("#folderName").textContent = folder;
  $("#folderName").title = folder;
  await loadImages(folder);
}

async function loadImages(folder) {
  const list = await api().load_folder(folder) || [];
  state.images = list.map(x => ({ path: x.path, name: x.name }));
  // 后端已合并：未导出进度 > 同名 .txt；前端已有的编辑结果优先保留
  list.forEach(x => {
    const c = state.capData[x.path];
    if (!c || !(c.tags && c.tags.length)) {
      state.capData[x.path] = { tags: x.tags || [], trigger: (c && c.trigger) || "" };
    }
  });
  state.imgIndex = 0;
  renderThumbs();
  if (state.images.length) await goto(0);
  else { $("#bigimg").innerHTML = `<div class="empty">文件夹里没有图片</div>`; $("#imgIdx").textContent = ""; }
  updateProgressText();
}

/* 已打标数量 / 总数 */
function doneCount() {
  return state.images.filter(im => ((state.capData[im.path] || {}).tags || []).length).length;
}
function updateProgressText() {
  if (!state.images.length) { $("#capProgress").textContent = ""; return; }
  $("#capProgress").textContent = `已打标 ${doneCount()}/${state.images.length}`;
}

/* 跳到下一张还没打标的图 */
function gotoNextEmpty() {
  if (!state.images.length) { toast("先打开一个文件夹"); return; }
  for (let k = 1; k <= state.images.length; k++) {
    const i = (state.imgIndex + k) % state.images.length;
    if (!((state.capData[state.images[i].path] || {}).tags || []).length) { goto(i); return; }
  }
  toast("全部都打完标了");
}

function curPath() { const im = state.images[state.imgIndex]; return im ? im.path : ""; }
function curName() { const im = state.images[state.imgIndex]; return im ? im.name : ""; }
function cur() {
  const p = curPath();
  if (!p) return { tags: [], trigger: "" };
  if (!state.capData[p]) state.capData[p] = { tags: [], trigger: "" };
  return state.capData[p];
}
function effTrigger() { return cur().trigger || state.globalTrigger; }

async function goto(i) {
  state.imgIndex = i;
  renderThumbs();
  await showImg();
  const p = curPath();
  if (p && !state.capData[p]) {
    const tags = await api().read_caption(p);
    state.capData[p] = { tags: tags || [], trigger: "" };
  }
  renderCapTags();
}

function renderThumbs() {
  const box = $("#thumbs");
  const keepScroll = box.scrollLeft;          // 重建前记住位置，避免每次切图都弹回最左
  box.innerHTML = "";
  state.images.forEach((im, i) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb-wrap" + (i === state.imgIndex ? " active" : "");
    wrap.title = im.name;
    wrap.onclick = () => goto(i);

    const d = document.createElement("img");
    d.className = "thumb";
    thumbImg("thumb", im.preview || im.path, 160).then(b => { if (b) d.src = b; });

    const n = ((state.capData[im.path] || {}).tags || []).length;
    const badge = document.createElement("span");
    badge.className = "thumb-badge";
    badge.textContent = n ? "✓ " + n : "";

    wrap.appendChild(d); wrap.appendChild(badge);
    box.appendChild(wrap);
  });
  updateProgressText();
  scrollThumbIntoView(keepScroll);
}

/* 缩略图条跟着当前打标的图走：把它滚到可视区域中间 */
function scrollThumbIntoView(keepScroll) {
  const strip = $("#thumbs");
  const wrap = strip && strip.children[state.imgIndex];
  if (!wrap) return;
  strip.scrollLeft = keepScroll || 0;          // 先恢复原位置，再平滑滚到当前张
  const r = wrap.getBoundingClientRect();
  const sr = strip.getBoundingClientRect();
  const delta = (r.left + r.right) / 2 - (sr.left + sr.right) / 2;   // 目标：居中
  if (Math.abs(delta) < 2) return;
  try { strip.scrollBy({ left: delta, behavior: "smooth" }); }
  catch (e) { strip.scrollLeft += delta; }
}

async function showImg() {
  const im = state.images[state.imgIndex];
  if (!im) return;
  $("#imgIdx").textContent = im.name;
  const b = await api().preview(im.preview || im.path, 900);
  $("#bigimg").innerHTML = b ? `<img src="${b}">` : `<div class="empty">无法预览</div>`;
}
function prevImg() { if (state.images.length) goto((state.imgIndex - 1 + state.images.length) % state.images.length); }
function nextImg() { if (state.images.length) goto((state.imgIndex + 1) % state.images.length); }

function addCapTag(en) {
  const c = cur();
  const n = addTagTo(c.tags, en);
  if (!n) { toast("已有该标签"); return; }
  renderCapTags(); saveProgress();
  translatePending(c.tags, renderCapTags);
}

function renderCapTags() {
  const c = cur();
  const tg = effTrigger();
  const list = tg ? [{ en: tg, zh: "触发词", w: 1, fixed: true }, ...c.tags.filter(t => t.en !== tg)] : c.tags;
  renderChips($("#capTags"), list, "cap", {
    emptyText: "点击左侧标签添加到这里",
    fixedIdx: tg ? 0 : -1,
    rerender: renderCapTags,
    onDel: (i) => {
      const t = list[i];
      if (t.fixed) {
        if (c.trigger === tg) c.trigger = "";
        if (state.globalTrigger === tg) state.globalTrigger = "";
        renderCapTags(); saveProgress(); return;
      }
      c.tags = c.tags.filter(x => x.en !== t.en);
      if (state.sel && state.sel.which === "cap") state.sel = null;
      renderCapTags(); saveProgress();
    }
  });
  $("#capCnt").textContent = list.length + " 个";
  updateProgressText();
  refreshBadge(state.imgIndex);
}

/* 只更新某一张缩略图的角标（避免整排重绘） */
function refreshBadge(i) {
  const wrap = $("#thumbs").children[i];
  if (!wrap) return;
  const b = wrap.querySelector(".thumb-badge");
  if (!b) return;
  const n = ((state.capData[state.images[i].path] || {}).tags || []).length;
  b.textContent = n ? "✓ " + n : "";
}

function setTrigger() {
  const v = $("#triggerInput").value.trim();
  if (!v) { toast("请输入触发词"); return; }
  if ($("#triggerOnly").checked) { cur().trigger = v; toast("已设为「仅本张」触发词"); }
  else { state.globalTrigger = v; toast("已设为全局触发词（整个文件夹共用）"); }
  addCapTag(v);
  $("#triggerInput").value = "";
}

function clearCaption() { const c = cur(); c.tags = []; c.trigger = ""; renderCapTags(); saveProgress(); }

async function clearAllCaptions() {
  if (!state.images.length) { toast("先打开一个文件夹"); return; }
  const ok = await uiConfirm("清空全部标签",
    `将清空当前文件夹里所有 <b>${state.images.length}</b> 张图的标签。<br>重新「统一导出」前可重新打标。`,
    { danger: true, okText: "全部清空" });
  if (!ok) return;
  for (const im of state.images) state.capData[im.path] = { tags: [], trigger: "" };
  renderCapTags(); saveProgress();
  toast("已清空全部 " + state.images.length + " 张图的标签");
}

/* 删除当前文件夹的全部打标记录（整条移除，不只是清空） */
async function deleteAllRecords() {
  if (!state.images.length) { toast("先打开一个文件夹"); return; }
  const paths = state.images.map(im => im.path);
  const has = paths.filter(p => state.capData[p]).length;
  if (!has) { toast("这个文件夹还没有任何打标记录"); return; }
  const ok = await uiConfirm("清除本次打标",
    `· 清除当前显示的图片和它的标签<br>` +
    `· 清除本文件夹共 <b>${has}</b> 张图的打标记录<br>` +
    `· 已导出的 .txt 保留不动<br>` +
    `· 打标库里已存的内容保留不动<br>` +
    `· 图片本体不动` +
    `<div class="hint" style="margin-top:8px">此操作不可撤销。</div>`,
    { danger: true, okText: "全部删除" });
  if (!ok) return;
  const n = await api().remove_progress(paths);
  // 内存里同步清掉
  for (const p of paths) delete state.capData[p];
  // 回到「还没打开文件夹」的状态：大图、缩略图、进度全部清空
  state.images = []; state.imgIndex = 0; state.folder = "";
  $("#folderName").textContent = "";
  $("#imgIdx").textContent = "";
  $("#bigimg").innerHTML = `<div class="empty">打开文件夹后在这里看图</div>`;
  renderThumbs();
  renderCapTags();                       // 渲染时会给当前图重建一条空记录
  delete state.capData[curPath()];       // 再删掉，避免空记录被写回磁盘
  toast(`已清除本次打标：${n} 条记录已删除（.txt 与打标库未动）`);
}

/* 重新打标：把改动同步回打标库（仅 recaption 模式有效） */
function syncRecaption() {
  if (!state.recaptionActive) return;
  const p = curPath(); if (!p) return;
  const c = cur();
  api().repo_update(p, c.tags, effTrigger());
}

let saveTimer;
function saveProgress() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (api()) api().save_progress(state.capData); }, 400);
  syncRecaption();
}

async function exportAll() {
  const chk = await api().export_check(state.capData) || {};
  if (!chk.total) { toast("还没有给任何图片打标"); return; }

  /* 有同名 .txt 时先问一句：覆盖还是跳过（取消 = 什么都不做） */
  let mode = "overwrite";
  if (chk.existing) {
    const pick = await uiConfirm("同名文件已存在",
      `本次要导出 <b>${chk.total}</b> 个 .txt，其中 <b>${chk.existing}</b> 个位置<b>已经存在同名 .txt</b>。<br>` +
      `<div style="margin-top:8px">· <b>覆盖</b>：用新的提示词替换旧文件内容（旧内容不可恢复）<br>` +
      `· <b>跳过</b>：这些文件不动，只写还没有 .txt 的图片</div>`,
      { buttons: [{ label: "跳过不覆盖", value: "skip" }, { label: "覆盖", value: "overwrite", danger: true }] });
    if (!pick) { toast("已取消导出"); return; }
    mode = pick;
  }

  const raw = await api().export_all(state.capData, mode);
  const r = (typeof raw === "number") ? { written: raw, failed: 0, skipped: 0, overwritten: 0, folders: [] } : (raw || {});
  const n = r.written || 0;
  if (!n) { toast(r.skipped ? `全部 ${r.skipped} 个同名 .txt 已跳过，没写入任何文件` : "还没有给任何图片打标"); return; }

  const folders = r.folders || [];
  const one = folders.length === 1;
  const listHtml = folders.length
    ? folders.map(f => `<div style="font-family:Consolas,monospace;font-size:12px;word-break:break-all;margin:3px 0">📁 ${f}</div>`).join("")
    : `<div class="hint">（没能确定位置，.txt 与图片同名、放在图片旁边）</div>`;
  let extra = "";
  if (r.overwritten) extra += `<div style="margin-top:6px">♻️ 覆盖更新 ${r.overwritten} 个已有 .txt</div>`;
  if (r.skipped) extra += `<div style="margin-top:6px">⏭️ 跳过 ${r.skipped} 个已存在的 .txt（未改动）</div>`;
  if (r.failed) extra += `<div style="color:var(--danger);margin-top:6px">⚠ 有 ${r.failed} 个写入失败（可能图片被占用或只读）</div>`;
  const html =
    `✅ 已导出 <b>${n}</b> 个 .txt（与图片同名，放在图片旁边）<br>` +
    `<div style="margin-top:8px">导出位置${one ? "" : `（${folders.length} 处）`}：</div>` +
    listHtml + extra;

  const buttons = [{ label: "好的", value: true }];
  if (one) buttons.unshift({ label: "📂 打开该文件夹", value: "open" });
  const pick = await uiConfirm("导出完成", html, { buttons, okText: "好的", noCancel: true });
  if (pick === "open") { try { await api().open_folder(folders[0]); } catch (e) { } }
}

function askApplyAll() {
  if (!state.images.length) { toast("先打开一个文件夹"); return; }
  const c = cur();
  if (!c.tags.length) { toast("当前图片还没有标签"); return; }
  $("#applyInfo").textContent = `将给 ${state.images.length} 张图追加：${tagsToText(c.tags)}`;
  $("#applyMask").hidden = false;
}
function closeApply() { $("#applyMask").hidden = true; }
async function doApplyAll() {
  const onlyEmpty = $("#applyOnlyEmpty").checked;
  const c = cur();
  const paths = state.images
    .filter(im => !onlyEmpty || !(state.capData[im.path] && state.capData[im.path].tags.length))
    .map(im => im.path);
  const r = await api().apply_all(paths, c.tags);
  for (const p of paths) {
    if (!state.capData[p]) state.capData[p] = { tags: [], trigger: "" };
    c.tags.forEach(t => { if (!state.capData[p].tags.some(x => x.en === t.en)) state.capData[p].tags.push({ ...t }); });
  }
  closeApply(); renderCapTags();
  toast(`已追加到 ${paths.length} 张图（新增 ${r ? r.added : 0} 个标签），需再点「统一导出」写入 .txt`);
}

/* ---------------- 打标库 ---------------- */
async function saveToRepo() {
  const p = curPath();
  if (!p) { toast("没有正在打标的图片"); return; }
  const c = cur();
  if (!c.tags.length) { toast("当前图片还没有标签"); return; }
  const miss = countUntranslated(c.tags);
  if (miss) {
    toast(`自动翻译 ${miss} 个未翻译标签…`);
    await translatePendingArrays([c.tags]);
    renderCapTags(); saveProgress();
  }
  await api().repo_save(p, c.tags, effTrigger());
  toast("已存入打标库：" + curName());
}

/* 把当前文件夹里所有已打标的图一次性存入打标库 */
async function saveAllToRepo() {
  if (!state.images.length) { toast("先打开一个文件夹"); return; }
  const items = [];
  state.images.forEach(im => {
    const c = state.capData[im.path] || { tags: [], trigger: "" };
    if (c.tags && c.tags.length) {
      items.push({ path: im.path, tags: c.tags, trigger: c.trigger || state.globalTrigger || "" });
    }
  });
  if (!items.length) { toast("这个文件夹还没有任何图片打过标"); return; }
  const skip = state.images.length - items.length;
  const ok = await uiConfirm("全部存入打标库",
    `将把当前文件夹里已打标的 <b>${items.length}</b> 张图存入打标库。` +
    (skip ? `<br>另有 <b>${skip}</b> 张没打标，会跳过。` : ""),
    { okText: "存入" });
  if (!ok) return;
  const miss = items.reduce((s, x) => s + countUntranslated(x.tags), 0);
  if (miss) {
    toast(`自动翻译 ${miss} 个未翻译标签…`);
    await translatePendingArrays(items.map(x => x.tags));
    renderCapTags(); renderThumbs(); saveProgress();
  }
  const n = await api().repo_save_all(items);
  if (!n) { toast("存入失败，请检查图片是否还可读"); return; }
  toast(`已存入 ${n} 张到打标库` + (n < items.length ? `（${items.length - n} 张失败）` : ""));
}

let repoTarget = null;

async function loadRepo() {
  const kw = $("#repoSearch").value.trim();
  state.repoAll = await api().repo_list(kw, "") || [];
  state.repoFolders = await api().repo_folders() || [];
  applyRepoFolderFilter();
  renderRepoSide();
  renderRepo();
}
/* 当前所在文件夹：""=全部  "__none"=未分类  其它=该文件夹 */
function applyRepoFolderFilter() {
  const all = state.repoAll || [], f = state.repoFolder;
  state.repo = f === "__none" ? all.filter(x => !x.repo_folder)
    : (f ? all.filter(x => x.repo_folder === f) : all);
}
function selectRepoFolder(v) {
  state.repoFolder = v;
  applyRepoFolderFilter();
  renderRepoSide(); renderRepo();
}

/* 左侧文件夹栏：点击进入、右键管理、拖卡片进来移动（文件管理器逻辑） */
function renderRepoSide() {
  const box = $("#repoSide"); if (!box) return;
  const all = state.repoAll || [];
  const cnt = {}; let noneN = 0;
  all.forEach(x => { const f = x.repo_folder; if (f) cnt[f] = (cnt[f] || 0) + 1; else noneN++; });
  box.innerHTML = "";
  const mk = (label, value, n, icon) => {
    const d = document.createElement("div");
    d.className = "side-item" + (state.repoFolder === value ? " on" : "");
    d.innerHTML = `<span>${icon} ${label}</span><span class="cnt">${n}</span>`;
    d.onclick = () => selectRepoFolder(value);
    return d;
  };
  box.appendChild(mk("全部", "", all.length, "🗂"));
  const noneItem = mk("未分类", "__none", noneN, "📄");
  box.appendChild(noneItem);
  (state.repoFolders || []).forEach(f => {
    const item = mk(f, f, cnt[f] || 0, "📁");
    item.addEventListener("contextmenu", e => openRepoCtx(e, f));
    box.appendChild(item);
  });
  /* 拖拽目标：文件夹与「未分类」 */
  const bindDrop = (el, folder) => {
    el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("drop"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop"));
    el.addEventListener("drop", e => dropToFolder(e, folder, el));
  };
  bindDrop(noneItem, "__none");
  [...box.querySelectorAll(".side-item")].forEach((el, i) => {
    if (i > 1) bindDrop(el, el.querySelector("span").textContent.replace(/^📁\s*/, ""));
  });
  const nb = document.createElement("button");
  nb.className = "btn tiny side-new"; nb.textContent = "＋ 新建文件夹";
  nb.onclick = () => createRepoFolder();
  box.appendChild(nb);
  const tip = document.createElement("div");
  tip.className = "side-tip"; tip.textContent = "右键文件夹：重命名 / 删除；拖卡片到这里移动";
  box.appendChild(tip);
}

/* 右键菜单 */
let ctxFolder = null;
function openRepoCtx(e, folder) {
  e.preventDefault(); e.stopPropagation();
  closeItemCtx();
  ctxFolder = folder || null;
  const m = $("#repoCtx");
  /* 空白处右键只留「新建文件夹」；文件夹上右键才有重命名/删除 */
  $("#repoCtxRename").style.display = ctxFolder ? "" : "none";
  $("#repoCtxDel").style.display = ctxFolder ? "" : "none";
  m.hidden = false;
  m.style.left = Math.min(e.clientX, window.innerWidth - 180) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - 150) + "px";
}
function closeRepoCtx() { const m = $("#repoCtx"); if (m) m.hidden = true; }
document.addEventListener("click", () => { closeRepoCtx(); closeItemCtx(); });
document.addEventListener("contextmenu", e => {
  if (!e.target.closest || !e.target.closest(".repo-side")) closeRepoCtx();
}, true);
function ctxNewFolder() { closeRepoCtx(); createRepoFolder(); }
function ctxRenameFolder() { const f = ctxFolder; closeRepoCtx(); if (f) renameRepoFolder(f); }
function ctxDeleteFolder() { const f = ctxFolder; closeRepoCtx(); if (f) deleteRepoFolder(f); }

async function renameRepoFolder(name) {
  const nv = await uiPrompt("重命名文件夹", { label: "新名称：", value: name });
  if (!nv || nv === name) return;
  const r = await api().repo_rename_folder(name, nv);
  if (r === "dup") { toast("已有同名文件夹"); return; }
  if (r === false) { toast("重命名失败"); return; }
  if (state.repoFolder === name) state.repoFolder = nv;
  await loadRepo();
  toast("已重命名为「" + nv + "」");
}
async function deleteRepoFolder(name) {
  const n = (state.repoAll || []).filter(x => x.repo_folder === name).length;
  const ok = await uiConfirm("删除文件夹",
    `删除文件夹「${name}」？<br>其中 <b>${n}</b> 条会移到「未分类」，图片和标签都不会丢。`,
    { okText: "删除", danger: true });
  if (!ok) return;
  await api().repo_delete_folder(name);
  if (state.repoFolder === name) state.repoFolder = "";
  await loadRepo();
  toast("已删除文件夹「" + name + "」");
}
async function dropToFolder(e, folder, el) {
  e.preventDefault(); el.classList.remove("drop");
  let paths = [];
  try { paths = JSON.parse(e.dataTransfer.getData("text/plain") || "[]"); } catch (_) { }
  if (!paths || !paths.length) return;
  await api().repo_move_to_folder(paths, folder === "__none" ? "" : folder);
  state.repoSelected.clear();
  await loadRepo();
  toast(`已移动 ${paths.length} 项到「${folder === "__none" ? "未分类" : folder}」`);
}

/* 卡片滚动入场：进入视口才加 .in 播放淡入上移；初始可见批次保留 --i 交错，滚动触发的清零延迟 */
let repoRevealObs = null;
function repoObserve(el, t0) {
  if (noAnim()) { el.dataset.shown = "1"; el.classList.add("in"); return; }  // 关动画：直接显现，不挂观察器
  if (!("IntersectionObserver" in window)) { el.classList.add("in"); return; }
  if (!repoRevealObs) {
    repoRevealObs = new IntersectionObserver(ents => {
      ents.forEach(en => {
        const el = en.target;
        if (en.isIntersecting) {
          /* 仅首次显现用交错延迟；之后每次滚进都立即播放 */
          if (!el.dataset.shown) {
            if (performance.now() - Number(el.dataset.t0 || 0) > 150) el.style.setProperty("--i", 0);
            el.dataset.shown = "1";
          }
          el.classList.add("in");
        } else {
          el.classList.remove("in");   // 滚出视口即复位，下次进入再播（不做一次性）
        }
      });
    }, { rootMargin: "0px 0px 60px 0px" });
  }
  el.dataset.t0 = String(t0);
  repoRevealObs.observe(el);
}

async function renderRepo() {
  const box = $("#repoGrid"); box.innerHTML = "";
  const t0 = performance.now();
  $("#repoCnt").textContent = state.repo.length + " 项";
  if (!state.repo.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1">仓库还是空的，打完标点「存入库」</div>`;
    return;
  }
  state.repo.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "repo-item" + (state.repoSelected.has(r.path) ? " sel" : "");
    el.style.setProperty("--i", Math.min(i, 24));   // 入场交错序号（封顶，避免末尾等太久）
    const trig = r.trigger || "";
    const rm = dispOf("disp_repo");
    const arr = trig ? [{ en: trig, zh: "触发词" }, ...r.tags.filter(t => t.en !== trig)] : r.tags;
    const preview = arr.map(t => dispTag(t, rm)).join(", ");
    const folderBadge = r.repo_folder ? `📁 ${r.repo_folder}` : (r.folder || "未知来源");
    el.innerHTML = `
      <div class="pick ${state.repoSelected.has(r.path) ? "on show" : "show"}">${state.repoSelected.has(r.path) ? "✓" : ""}</div>
      <div class="repo-thumb">🖼️</div>
      <div class="repo-info">
        <div class="repo-name">${r.name}</div>
        <div class="repo-src">${folderBadge}</div>
        <div class="repo-tags">${preview}</div>
      </div>` +
      (state.repoSelMode ? "" :
        `<div class="repo-acts">
          <button class="btn tiny ghost" data-act="view">查看</button>
          <button class="btn tiny ghost" data-act="recap" title="重新打标这张图">🔁 重打</button>
          <button class="btn tiny ghost danger" data-act="del">删除</button>
        </div>`);
    thumbImg("repo_image", r.path, 480).then(b => {
      if (!b) return;
      const th = el.querySelector(".repo-thumb");
      const im = new Image();
      im.onload = () => th.classList.add("ld");   // 图片解码完成再淡入，避免闪现
      im.src = b;
      th.textContent = "";
      th.appendChild(im);
    });
    /* 拖拽移动：选中状态下拖=移动已选，否则移动本张 */
    el.draggable = true;
    el.addEventListener("dragstart", e => {
      const paths = (state.repoSelected.has(r.path) && state.repoSelected.size > 1)
        ? [...state.repoSelected] : [r.path];
      e.dataTransfer.setData("text/plain", JSON.stringify(paths));
      e.dataTransfer.effectAllowed = "move";
    });
    /* 文件管理器式：单击选中 / Ctrl 加减 / Shift 连选 / 双击查看 / 右键菜单 */
    el.onclick = e => {
      if (e.target.closest(".repo-acts")) return;          // 点的是操作按钮
      if (state.repoSelMode) { toggleSelect(r.path); return; }
      const i = state.repo.indexOf(r);
      if (e.ctrlKey || e.metaKey) {
        if (state.repoSelected.has(r.path)) state.repoSelected.delete(r.path);
        else state.repoSelected.add(r.path);
      } else if (e.shiftKey && state.lastRepoIdx != null) {
        const a = Math.min(state.lastRepoIdx, i), b = Math.max(state.lastRepoIdx, i);
        state.repoSelected.clear();
        for (let k = a; k <= b; k++) state.repoSelected.add(state.repo[k].path);
      } else {
        state.repoSelected.clear(); state.repoSelected.add(r.path);
      }
      state.lastRepoIdx = i;
      refreshRepoSelection();
    };
    el.ondblclick = () => openRepoView(r);
    el.addEventListener("contextmenu", e => openItemCtx(e, r));
    if (state.repoSelMode) {
      el.onclick = () => toggleSelect(r.path);
    } else {
      el.querySelectorAll("button").forEach(b => {
        b.onclick = () => {
          const act = b.dataset.act;
          if (act === "view") openRepoView(r);
          else if (act === "recap") recaptionOne(r);
          else if (act === "del") openRepoDel(r);
        };
      });
    }
    box.appendChild(el);
    repoObserve(el, t0);
  });
  syncThumbHeights();
}

/* 按当前列宽给缩略图算 4:3 高度（aspect-ratio 在网格里有行高计算 bug，改用显式像素） */
function syncThumbHeights() {
  const el = $("#repoGrid") && $("#repoGrid").querySelector(".repo-item");
  if (!el) return;
  const w = el.clientWidth;
  if (w > 0) document.documentElement.style.setProperty("--thumb-h", Math.round(w * 0.75) + "px");
}
window.addEventListener("resize", () => { syncThumbHeights(); });

/* ---------- 打标库：新建文件夹 ---------- */
async function createRepoFolder() {
  const name = await uiPrompt("新建文件夹", { label: "文件夹名称：", placeholder: "用于给打标库内容分组" });
  if (!name) return;
  const ok = await api().repo_create_folder(name.trim());
  if (ok === false) { toast("文件夹已存在"); return; }
  await loadRepo();
  toast("已创建文件夹：" + name);
}

/* ---------- 打标库：批量选择 ---------- */
function toggleSelMode() {
  state.repoSelMode = !state.repoSelMode;
  if (!state.repoSelMode) { state.repoSelected.clear(); $("#repoBatch").hidden = true; }
  else { $("#repoBatch").hidden = false; $("#selCount").textContent = "已选 0 项"; }
  const b = $("#btnSelMode");
  b.textContent = state.repoSelMode ? "退出选择" : "选择";
  b.classList.toggle("accent", state.repoSelMode);
  renderRepo();
}
function toggleSelect(path) {
  if (state.repoSelected.has(path)) state.repoSelected.delete(path);
  else state.repoSelected.add(path);
  refreshRepoSelection();
}

/* 只刷新选中高亮，不重建整个网格（避免每次点击都重新加载图片） */
function refreshRepoSelection() {
  const items = document.querySelectorAll("#repoGrid .repo-item");
  items.forEach((el, i) => {
    const r = state.repo[i]; if (!r) return;
    const on = state.repoSelected.has(r.path);
    el.classList.toggle("sel", on);
    const pick = el.querySelector(".pick");
    if (pick) { pick.classList.toggle("on", on); pick.textContent = on ? "✓" : ""; }
  });
  const c = $("#selCount"); if (c) c.textContent = "已选 " + state.repoSelected.size + " 项";
}

/* ---------- 卡片右键菜单（文件管理器逻辑） ---------- */
function closeItemCtx() { const m = $("#repoItemCtx"); if (m) m.hidden = true; }
function openItemCtx(e, r) {
  e.preventDefault(); e.stopPropagation();
  closeRepoCtx();
  if (!state.repoSelected.has(r.path)) {
    state.repoSelected.clear(); state.repoSelected.add(r.path);
    state.lastRepoIdx = state.repo.indexOf(r);
    refreshRepoSelection();
  }
  const paths = state.repoSelected.size ? [...state.repoSelected] : [r.path];
  const n = paths.length, multi = n > 1;
  const m = $("#repoItemCtx");
  m.innerHTML = "";
  const add = (label, fn, danger) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.style.color = "var(--danger)";
    b.onclick = () => { closeItemCtx(); fn(); };
    m.appendChild(b);
  };
  const sep = () => { const s = document.createElement("div"); s.className = "ctx-sep"; m.appendChild(s); };
  add(multi ? `查看（第 1 / ${n} 项）` : "查看", () => openRepoView(r));
  add(multi ? `复制图片路径（${n} 项）` : "复制图片路径", () => copyRepoPaths(paths));
  sep();
  add(multi ? `📥 调用到正向提示词（${n} 项）` : "📥 调用到正向提示词",
    () => repoToPrompt(state.repo.filter(x => paths.includes(x.path)), "pos"));
  add(multi ? `📥 调用到反向提示词（${n} 项）` : "📥 调用到反向提示词",
    () => repoToPrompt(state.repo.filter(x => paths.includes(x.path)), "neg"));
  sep();
  add("移动到：未分类", () => moveItemsTo(paths, ""));
  (state.repoFolders || []).forEach(f => add("移动到：" + f, () => moveItemsTo(paths, f)));
  add("移动到：＋新建文件夹…", () => moveItemsNew(paths));
  sep();
  add(multi ? `删除 ${n} 项` : "删除", () => delRepoItems(paths), true);
  m.hidden = false;
  m.style.left = Math.min(e.clientX, window.innerWidth - 220) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - 40 - n * 30) + "px";
}
/* 打标库 → 正/负向提示词：把记录里的标签追加过去（按 en 去重，触发词排第一个） */
function selectedRepoItems() {
  return (state.repo || []).filter(r => state.repoSelected.has(r.path));
}
function repoTagList(r) {
  const tags = (r && r.tags) ? r.tags : [];
  const trig = (r && r.trigger) ? String(r.trigger).trim() : "";
  if (!trig) return tags.map(t => ({ ...t }));
  return [{ en: trig, zh: "触发词" }, ...tags.filter(t => t.en !== trig).map(t => ({ ...t }))];
}
async function repoToPrompt(rs, which) {
  const list = Array.isArray(rs) ? rs : [rs];
  if (!list.length) { toast("没有选中任何打标库条目"); return; }
  const arr = which === "pos" ? state.posTags : state.negTags;
  const name = which === "pos" ? "正向" : "反向";
  let added = 0;
  list.forEach(r => repoTagList(r).forEach(t => {
    if (t.en && !arr.some(x => x.en === t.en)) { arr.push({ ...t }); added++; }
  }));
  if (!added) { toast(`这些标签已经在${name}提示词里了`); return; }
  switchMode("prompt");                       // 调完直接切到提示词模式，省得手动切
  renderPromptBox(which);
  translatePending(arr, () => renderPromptBox(which));
  toast(`已调用 ${added} 个标签到${name}提示词（原有内容保留）`);
}

async function copyRepoPaths(paths) {
  const txt = (paths || []).join("\n");
  try {
    await navigator.clipboard.writeText(txt);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) { }
    ta.remove();
  }
  toast("已复制 " + (paths || []).length + " 个路径");
}
async function moveItemsTo(paths, folder) {
  await api().repo_move_to_folder(paths, folder || "");
  state.repoSelected.clear();
  await loadRepo();
  toast(`已移动 ${paths.length} 项到「${folder || "未分类"}」`);
}
async function moveItemsNew(paths) {
  const f = await uiPrompt("新建并移动到文件夹", { label: "文件夹名称：", placeholder: "新建后把选中项移进去" });
  if (!f) return;
  await api().repo_create_folder(f);
  await moveItemsTo(paths, f);
}
async function delRepoItems(paths) {
  const how = await uiConfirm("删除条目",
    `选中 <b>${paths.length}</b> 项，请选择删除方式：<br>` +
    `<span class="hint">仅移除记录 = 只从库中删掉，图片副本保留；<br>` +
    `连同图片副本 = 连打标库里保存的图片一起删，不可恢复（原图不受影响）。</span>`,
    {
      buttons: [
        { label: "仅移除记录", value: "rec" },
        { label: "连同图片副本一起删除", value: "all", danger: true },
      ]
    });
  if (!how) return;
  if (how === "all") {
    const ok = await uiConfirm("⚠️ 删除库内图片副本",
      `将永久删除这 <b>${paths.length}</b> 张图在打标库里的图片副本，<b>不可恢复</b>。<br>` +
      `你电脑里的原图不受影响，只删除打标库内保存的那一份。`,
      { okText: "确认删除", danger: true });
    if (!ok) return;
  }
  const alsoImage = how === "all";
  for (const p of paths) await api().repo_delete(p, alsoImage);
  state.repoSelected.clear();
  await loadRepo();
  toast(`已删除 ${paths.length} 项` + (alsoImage ? "（含库内图片副本）" : "（图片副本保留）"));
}

/* ---------- 打标库：批量删除 / 移动到文件夹 ---------- */
async function deleteSelected() {
  if (!state.repoSelected.size) { toast("先选择条目"); return; }
  const paths = [...state.repoSelected];
  await delRepoItems(paths);
  if (state.repoSelMode) toggleSelMode();   // 退出批量选择条
}
async function moveSelected() {
  if (!state.repoSelected.size) { toast("先选择条目"); return; }
  const folders = await api().repo_folders() || [];
  const f = await uiPrompt("移动到文件夹", {
    label: "输入文件夹名称（新名称即创建，已有则移入）：",
    placeholder: folders.length ? "已有：" + folders.join("、") : "还没有任何文件夹",
  });
  if (!f) return;
  await api().repo_move_to_folder([...state.repoSelected], f.trim());
  state.repoSelected.clear(); toggleSelMode(); loadRepo();
  toast("已移动到「" + f.trim() + "」");
}

/* ---------- 打标库：所选图片「再次打标」 ---------- */
async function recaptionSelected() {
  if (!state.repoSelected.size) { toast("先选择要打标的图片"); return; }
  const entries = state.repo.filter(r => state.repoSelected.has(r.path));
  state.recaptionActive = true;
  state.recaptionPaths = [...state.repoSelected];
  state.images = []; state.capData = {};
  for (const r of entries) {
    const cp = await api().repo_copy_path(r.path);
    state.images.push({ path: r.path, name: r.name, preview: cp });
    state.capData[r.path] = { tags: (r.tags || []).map(t => ({ ...t })), trigger: r.trigger || "" };
  }
  state.imgIndex = 0;
  switchMode("caption");
  $("#btnExport").style.display = "none";
  $("#btnApply").style.display = "none";
  $("#btnFinishRecap").hidden = false;
  renderThumbs(); await goto(0);
  toast("正在对打标库中 " + entries.length + " 张图重新打标，改完点「✓ 完成打标」");
}

/* 单张卡片「重新打标」：设为唯一选中后复用批量重打流程 */
async function recaptionOne(r) {
  state.repoSelected.clear();
  state.repoSelected.add(r.path);
  await recaptionSelected();
}

function exitRecaption() {
  (state.recaptionPaths || []).forEach(p => delete state.capData[p]);
  state.recaptionActive = false; state.recaptionPaths = [];
  state.images = []; state.imgIndex = 0;
  $("#btnExport").style.display = "";
  $("#btnApply").style.display = "";
  $("#btnFinishRecap").hidden = true;
  switchMode("repo"); loadRepo();
  toast("已保存回打标库");
}

async function openRepoView(r) {
  repoTarget = r;
  $("#rvName").textContent = r.name;
  $("#rvSrc").textContent = `📁 ${r.folder || "未知来源"}　·　${r.trigger ? "触发词：" + r.trigger : "无触发词"}`;
  const box = $("#rvTags"); box.innerHTML = "";
  (r.tags || []).forEach(t => {
    const s = document.createElement("span");
    s.className = "pchip" + (t.en === r.trigger ? " trigger" : "");
    const rm2 = dispOf("disp_repo");
    s.innerHTML = rm2 === "both"
      ? `<span class="en">${enText(t)}</span><span class="zh">${t.zh ? "🈶 " + t.zh : "🈶 未翻译"}</span>`
      : `<span class="en">${(rm2 === "zh" && t.zh) ? t.zh : enText(t)}</span>`;
    box.appendChild(s);
  });
  $("#rvImg").innerHTML = `<div style="font-size:40px">🖼️</div>`;
  $("#rvTranslate").hidden = !countUntranslated(r.tags || []);
  const m = $("#repoViewMask");
  m.hidden = false;
  void m.offsetWidth;          // 强制回流，让起始态（透明+下移）先生效，再加 .show 触发过渡
  m.classList.add("show");
  const b = await api().repo_image(r.path, 520);
  if (b) $("#rvImg").innerHTML = `<img src="${b}" style="max-width:100%;max-height:280px;object-fit:contain">`;
}
function closeRepoView() {
  const m = $("#repoViewMask");
  m.classList.remove("show");
  setTimeout(() => { m.hidden = true; }, noAnim() ? 0 : 200);   // 关动画时立即隐藏
}

function openRepoDel(r) {
  repoTarget = r;
  $("#rdName").textContent = `${r.name}　（📁 ${r.folder || "未知来源"}）`;
  $("#repoDelMask").hidden = false;
}
function closeRepoDel() { $("#repoDelMask").hidden = true; }
/* 查看弹窗：补翻译该条目并写回打标库 */
async function translateRepoView() {
  if (!repoTarget) return;
  const btn = $("#rvTranslate");
  btn.disabled = true; btn.textContent = "翻译中…";
  const done = await translatePendingArrays([repoTarget.tags]);
  btn.disabled = false; btn.textContent = "🌐 补翻译";
  if (done) {
    await api().repo_update(repoTarget.path, repoTarget.tags, repoTarget.trigger || "");
    btn.hidden = true;
    await openRepoView(repoTarget);
    loadRepo();
    toast(`已补翻 ${done} 个标签`);
  } else {
    btn.hidden = true;
    toast("没有需要翻译的标签");
  }
}
async function doRepoDel(alsoImage) {
  if (!repoTarget) return;
  const r = repoTarget;
  if (alsoImage) {
    /* 不可逆操作：先关掉选择弹窗，再弹二次确认 */
    closeRepoDel();
    const ok = await uiConfirm("⚠️ 删除库内图片副本",
      `将永久删除「${r.name}」在打标库里的图片副本，<b>不可恢复</b>。<br>` +
      `你电脑里的原图不受影响，只删除打标库内保存的那一份。`,
      { okText: "确认删除", danger: true });
    if (!ok) { openRepoDel(r); return; }
  }
  const n = r.name;
  await api().repo_delete(r.path, alsoImage);
  repoTarget = null; closeRepoDel(); loadRepo();
  toast(alsoImage ? `已删除 ${n} 及其库内图片副本` : `已从库中移除 ${n}，图片副本保留`);
}

/* 打标库：一键翻译当前视图里所有未翻译的标签 */
async function translateRepoPending() {
  const list = state.repo || [];
  if (!list.length) { toast("打标库是空的"); return; }
  const targets = list.filter(r => countUntranslated(r.tags));
  const miss = targets.reduce((s, r) => s + countUntranslated(r.tags), 0);
  if (!miss) { toast("当前视图没有未翻译的标签"); return; }
  const scope = state.repoFolder === "__none" ? "未分类"
    : (state.repoFolder ? `文件夹「${state.repoFolder}」` : "全部");
  const ok = await uiConfirm("翻译未翻译的标签",
    `范围：<b>${scope}</b>（共 ${list.length} 条）<br>` +
    `其中 <b>${targets.length}</b> 条有 <b>${miss}</b> 个未翻译标签。<br>` +
    `<span class="hint">缺中文的补中文，英文位是中文的翻英文；触发词不参与，已翻好的不重翻。</span>`,
    { okText: "开始翻译" });
  if (!ok) return;
  toast(`翻译中…共 ${miss} 个标签`);
  const done = await translatePendingArrays(targets.map(r => r.tags));
  for (const r of targets) await api().repo_update(r.path, r.tags, r.trigger || "");
  await loadRepo();
  toast(`已翻译 ${done} 个标签` + (done < miss ? `（${miss - done} 个失败，可再点一次重试）` : ""));
}

async function askClearRepo() {
  const all = state.repoAll || state.repo || [];
  if (!all.length) { toast("仓库已经是空的"); return; }
  const n = all.length;
  /* 与「清除本次打标」同一套文案：先说明动什么、不动什么，再选删除方式 */
  const how = await uiConfirm("清空打标库",
    `· 清空打标库共 <b>${n}</b> 条记录与标签<br>` +
    `· 已导出的 .txt 保留不动<br>` +
    `· 图片本体不动（你电脑里的原图不受影响）` +
    `<div class="hint" style="margin-top:8px">此操作不可撤销。</div>`,
    {
      buttons: [
        { label: "只清记录 · 图片副本保留", value: "rec" },
        { label: "连图片副本一起清空", value: "all", danger: true },
      ]
    });
  if (!how) return;
  /* 二次确认，防手误 */
  const alsoImage = how === "all";
  const ok = await uiConfirm("⚠️ 再次确认：清空打标库",
    `即将 <b>永久清空</b> 打标库里的 <b>${n}</b> 条记录` +
    (alsoImage ? `，以及它们保存在库内的图片副本，<b>不可恢复</b>` : `（库内图片副本保留）`) +
    `。<br><br>确定要继续吗？`,
    { okText: "确认清空", danger: true });
  if (!ok) return;
  for (const r of all) await api().repo_delete(r.path, alsoImage);
  state.repoSelected.clear();
  await loadRepo();
  toast(`已清空仓库：${n} 条` + (alsoImage ? "（含库内图片副本）" : "（图片副本保留）"));
}

/* ---------------- 手动添加到打标库 ---------------- */
let addDraft = { paths: [], tags: [] };

function openRepoAdd() {
  addDraft = { paths: [], tags: [] };
  $("#addImgs").innerHTML = "";
  $("#addImgCount").textContent = "";
  $("#addTagInput").value = "";
  $("#addTrigger").value = "";
  renderAddTags();
  $("#repoAddMask").hidden = false;
}
function closeRepoAdd() { $("#repoAddMask").hidden = true; }

async function pickAddImages() {
  const ps = await api().pick_images();
  if (!ps || !ps.length) return;
  addDraft.paths = ps;
  $("#addImgCount").textContent = `已选 ${ps.length} 张`;
  const box = $("#addImgs"); box.innerHTML = "";
  ps.forEach(p => {
    const wrap = document.createElement("div");
    wrap.className = "add-img";
    wrap.title = p;
    thumbImg("thumb", p, 160).then(b => { if (b) wrap.innerHTML = `<img src="${b}">`; });
    box.appendChild(wrap);
  });
}

function renderAddTags() {
  renderChips($("#addTagsBox"), addDraft.tags, "add", {
    emptyText: "输入标签后回车添加",
    rerender: renderAddTags
  });
}

async function submitRepoAdd() {
  if (!addDraft.paths.length) { toast("先选择图片"); return; }
  const trig = $("#addTrigger").value.trim();
  const miss = countUntranslated(addDraft.tags);
  if (miss) {
    toast(`自动翻译 ${miss} 个未翻译标签…`);
    await translatePendingArrays([addDraft.tags]);
    renderAddTags();
  }
  const items = await api().repo_add_manual(addDraft.paths, addDraft.tags, trig);
  if (!items || !items.length) { toast("添加失败，请检查图片是否可读"); return; }
  closeRepoAdd();
  loadRepo();
  toast(`已添加 ${items.length} 条到打标库`);
}

/* ---------------- 设置 ---------------- */
const GROUP_NAME = {
  custom: "自定义（自己填接口）",
  dont_need_api_key: "免费 · 无需密钥",
  need_api_key: "需要密钥",
  offline_api: "离线",
};

function renderApiSelect() {
  const sel = $("#setApi");
  const groups = (state.apis && state.apis.apis) || [];
  let html = "";
  groups.forEach(g => {
    html += `<optgroup label="${GROUP_NAME[g.type] || g.type || "其它"}">`;
    (g.children || []).forEach(it => {
      const label = it.key === "custom_openai" ? "✨ " + (it.name || it.key) : (it.name || it.key);
      html += `<option value="${it.key}">${label}</option>`;
    });
    html += `</optgroup>`;
  });
  sel.innerHTML = html;
  const def = state.settings.default_api || "alibaba_free";
  const keys = [];
  groups.forEach(g => (g.children || []).forEach(it => keys.push(it.key)));
  sel.value = keys.includes(def) ? def : (keys[0] || "");
  renderApiConfig();
}

function renderApiConfig() {
  const key = $("#setApi").value;
  const groups = (state.apis && state.apis.apis) || [];
  let item = null;
  for (const g of groups) for (const it of (g.children || [])) if (it.key === key) item = it;
  const box = $("#apiConfig");
  const cfg = item && item.config ? item.config : [];
  if (!cfg.length) {
    box.innerHTML = `<div class="hint" style="margin:0 0 10px">该引擎为内置免费接口，无需填写密钥</div>`;
    return;
  }
  box.innerHTML = `<div class="label">${item.name || key} 的密钥</div>` +
    cfg.map(c => `<input class="input" data-key="${c.key}" placeholder="${c.name || c.key}" value="${c.value || ""}" style="margin-bottom:6px;width:100%">`).join("");
}

function openSettings() { $("#mask").hidden = false; }
function closeSettings() { $("#mask").hidden = true; }

async function saveSettings() {
  const apiKey = $("#setApi").value;
  const config = {};
  document.querySelectorAll("#apiConfig input[data-key]").forEach(i => { config[i.dataset.key] = i.value.trim(); });
  await api().save_translate_api_config(apiKey, config);
  await api().save_settings({
    default_api: apiKey, separator: $("#setSep").value,
    theme: $("#setTheme").value, auto_add_tag: $("#setAutoAdd").checked,
    auto_add_idle: $("#setAutoIdle").checked,
    idle_sec: Math.min(5, Math.max(0.5, Number($("#setIdleSec").value) || 1.5)),
    disp_cap: $("#setDispCap").value, disp_lib: $("#setDispLib").value, disp_repo: $("#setDispRepo").value,
    thumb_auto_clean: Number($("#setThumbAuto").value), thumb_mem_cache: $("#setThumbMem").checked,
    taglib_view: $("#setTaglibView").value,
    tag_color_mode: $("#setColorMode").value,
    lazy_render: $("#setLazyRender").checked,
    no_anim: $("#setNoAnim").checked,
  });
  state.settings = await api().get_settings();
  applyTheme(state.settings.theme);
  /* 标词显示立即生效 */
  renderTags(); renderPromptBox("pos"); renderPromptBox("neg"); renderCapTags();
  if (state.mode === "repo") loadRepo();
  /* 标签库界面切换：同步页签显隐，处理「正停在标签库却改成弹窗」的情况 */
  tagLibView = state.settings.taglib_view || "tab";
  applyTagLibView();
  /* 标签染色模式切换：立即重渲染侧栏色点、网格与主界面标签颜色 */
  renderTagLibSide(); renderTagLib(); renderTabs(); renderTags();
  /* 懒渲染 / 动画开关：立即生效；动画状态变了只重渲染当前可见的网格
     （其他模式下次进入会自行渲染，不必此刻重建隐藏网格） */
  applyLazyRender();
  const wasNoAnim = document.body.classList.contains("no-anim");
  applyNoAnim();
  if (wasNoAnim !== noAnim()) {
    if (state.mode === "taglib") renderTagLib();
    else if (state.mode === "repo") loadRepo();
  }
  if (tagLibView === "tab") {
    if (!$("#tagLibMask").hidden) closeTagLib();   // 弹窗打开中 → 归位节点
  } else {
    if (state.mode === "taglib") { switchMode("prompt"); openTagLib(); }  // 当前是页签 → 退回并改弹窗
  }
  closeSettings(); toast("设置已保存");
}

/* ---------- 缩略图缓存 ---------- */
/* 会话内缓存：同一张图只向后端要一次，避免重复 base64 编码 */
const _thumbMem = new Map();
const _MEM_MAX = 300;                       // 最多记 300 张，超了丢掉最早的
async function thumbImg(fn, path, size) {
  const memOn = state.settings.thumb_mem_cache !== false;
  const key = fn + "|" + path + "|" + size;
  if (memOn && _thumbMem.has(key)) return _thumbMem.get(key);
  const b = await api()[fn](path, size);
  if (memOn && b) {
    if (_thumbMem.size >= _MEM_MAX) _thumbMem.delete(_thumbMem.keys().next().value);
    _thumbMem.set(key, b);
  }
  return b;
}

async function refreshThumbCacheInfo() {
  const info = await api().thumb_cache_info() || { files: 0, mb: 0 };
  $("#thumbCacheInfo").textContent = `当前占用：${info.files} 个文件 / ${info.mb} MB`;
}

async function clearThumbCache() {
  const info = await api().thumb_cache_info() || { files: 0, mb: 0 };
  if (!info.files) { toast("缓存已经是空的"); return; }
  const ok = await uiConfirm("清理缩略图缓存",
    `将删除 <b>${info.files}</b> 个缓存文件（约 ${info.mb} MB）。<br>` +
    `<span class="hint">只影响显示用的小图，原图、标签、打标库都不受影响；下次打开会自动重新生成。</span>`,
    { okText: "清理", danger: true });
  if (!ok) return;
  const n = await api().thumb_cache_clear();
  _thumbMem.clear();                        // 内存里那份也一起清，避免用到已删的
  await refreshThumbCacheInfo();
  toast(`已清理 ${n} 个缓存文件`);
}

/* 数据维护（奥术秘典导入 / 备份 / 清色 / YAML 重建）已拆到 插件\taglib_tools，
   由 boot() 扫描插件目录后动态注入，主程序不再内置这些函数。 */

/* ---------------- 模式切换 ---------------- */
/* 顶栏滑动指示器：对齐当前激活按钮（用 rect 相对 padding box，避免 offsetLeft 的边框/内边距歧义） */
function syncModeInd(instant = false) {
  const ind = $("#modeInd"), box = document.querySelector(".modes");
  const btn = box && box.querySelector(".mode-btn.active");
  if (!ind || !box || !btn) return;
  if (instant) ind.style.transition = "none";
  const base = box.getBoundingClientRect().left + parseFloat(getComputedStyle(box).borderLeftWidth || 0);
  ind.style.width = btn.getBoundingClientRect().width + "px";
  ind.style.transform = `translateX(${btn.getBoundingClientRect().left - base}px)`;
  if (instant) {
    void ind.offsetWidth;               // 提交无过渡的初始位置，避免首次从 0 滑入
    ind.style.transition = "";
    if (!ind.classList.contains("ready")) requestAnimationFrame(() => ind.classList.add("ready"));
  }
}
/* 视图切换入场：先摘类并强制回流，保证连点同一模式也能重播 */
function playViewEnter(el) {
  if (noAnim() || !el || el.style.display === "none") return;
  el.classList.remove("mode-enter");
  void el.offsetWidth;
  el.classList.add("mode-enter");
}

async function switchMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach(x => x.classList.toggle("active", x.dataset.mode === mode));
  syncModeInd();
  $("#viewPrompt").style.display = mode === "prompt" ? "" : "none";
  $("#viewCaption").style.display = mode === "caption" ? "" : "none";
  $("#viewRepo").style.display = mode === "repo" ? "" : "none";
  $("#viewTagLib").style.display = mode === "taglib" ? "" : "none";
  $("#tagPanel").style.display = (mode === "repo" || mode === "taglib") ? "none" : "";
  const viewId = { prompt: "viewPrompt", caption: "viewCaption", repo: "viewRepo", taglib: "viewTagLib" }[mode];
  playViewEnter($("#" + viewId));
  const tp = $("#tagPanel");
  if (tp.style.display !== "none") playViewEnter(tp);
  $("#tip").textContent = mode === "caption" ? "打标模式：← → 翻页 · Tab 下一张未打标 · Ctrl+S 暂存"
    : mode === "repo" ? "打标库：查看 / 重打 / 删除"
    : mode === "taglib" ? "标签库：右键 / 拖拽 / 多选管理标签" : "";
  if (mode === "repo") loadRepo();
  if (mode === "taglib") openTagLib();
  // 离开打标库：退出批量选择
  if (mode !== "repo" && state.repoSelMode) toggleSelMode();
  // 离开打标模式：退出「再次打标」会话（改动已逐次同步回库）
  if (mode !== "caption" && state.recaptionActive) {
    (state.recaptionPaths || []).forEach(p => delete state.capData[p]);
    state.recaptionActive = false; state.recaptionPaths = [];
    $("#btnExport").style.display = ""; $("#btnApply").style.display = "";
    $("#btnFinishRecap").hidden = true;
  }
}

/* ---------------- 事件 ---------------- */
document.querySelectorAll(".mode-btn").forEach(b => { b.onclick = () => switchMode(b.dataset.mode); });
/* ---------- 全局提示词面板：顶栏按钮开关 ---------- */
async function refreshGpBtn() {
  try {
    const s = await api().gp_status();
    $("#btnGp").classList.toggle("accent", !!(s && s.visible));
    $("#btnGp").textContent = s && s.visible ? "📋 全局粘贴板（开发中）" : "📋 全局粘贴板（开发中）";
  } catch (e) { }
}
$("#btnGp").onclick = async () => {
  try {
    const s = await api().gp_status();
    if (s && s.visible) await api().gp_hide(); else await api().gp_show();
    await refreshGpBtn();
  } catch (e) { }
};

$("#btnTheme").onclick = async () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(t);
  if (api()) await api().save_settings({ theme: t });
};
$("#btnSettings").onclick = () => {
  renderApiSelect();
  $("#setSep").value = state.settings.separator || ", ";
  $("#setAutoAdd").checked = !!state.settings.auto_add_tag;
  $("#setAutoIdle").checked = !!state.settings.auto_add_idle;
  $("#setIdleSec").value = state.settings.idle_sec || 1.5;
  $("#setDispCap").value = state.settings.disp_cap || "both";
  $("#setDispLib").value = state.settings.disp_lib || "both";
  $("#setDispRepo").value = state.settings.disp_repo || "both";
  $("#setTaglibView").value = state.settings.taglib_view || "tab";
  $("#setColorMode").value = state.settings.tag_color_mode || "off";
  $("#setLazyRender").checked = state.settings.lazy_render !== false;
  $("#setNoAnim").checked = !!state.settings.no_anim;
  const _ta = state.settings.thumb_auto_clean;
  $("#setThumbAuto").value = String(_ta === undefined || _ta === null ? 30 : _ta);
  $("#setThumbMem").checked = state.settings.thumb_mem_cache !== false;
  refreshThumbCacheInfo();
  renderRingSwatches();
  switchSetSec("api");          // 默认停在「翻译」
  $("#mask").hidden = false;
};
/* 设置：左侧分类切换 */
function switchSetSec(sec) {
  document.querySelectorAll("#setNav .set-nav-item").forEach(el =>
    el.classList.toggle("on", el.dataset.sec === sec));
  document.querySelectorAll(".set-sec").forEach(el =>
    el.classList.toggle("on", el.dataset.sec === sec));
}
document.querySelectorAll("#setNav .set-nav-item").forEach(el => {
  el.onclick = () => switchSetSec(el.dataset.sec);
});
$("#mask").onclick = e => { if (e.target.id === "mask") closeSettings(); };
$("#repoViewMask").onclick = e => { if (e.target.id === "repoViewMask") closeRepoView(); };
/* 标签库已并入主视图，无遮罩可关 */
$("#repoDelMask").onclick = e => { if (e.target.id === "repoDelMask") closeRepoDel(); };
$("#applyMask").onclick = e => { if (e.target.id === "applyMask") closeApply(); };
$("#repoAddMask").onclick = e => { if (e.target.id === "repoAddMask") closeRepoAdd(); };
$("#addTagInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.value.trim()) {
    const n = addTagTo(addDraft.tags, e.target.value);
    e.target.value = "";
    if (!n) toast("已有该标签");
    renderAddTags();
    translatePending(addDraft.tags, renderAddTags);
  }
});
$("#setApi").onchange = renderApiConfig;
bindPickerEvents();
/* 输入弹窗：回车=确定 */
$("#upInput").addEventListener("keydown", e => { if (e.key === "Enter") uiPromptResolve(true); });
/* 缩略图条：滚轮只左右滚，不带动页面上下滚 */
$("#thumbs").addEventListener("wheel", e => {
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!d) return;
  e.preventDefault();
  $("#thumbs").scrollLeft += d;
}, { passive: false });
$("#search").addEventListener("input", renderTags);
$("#repoSearch").addEventListener("input", loadRepo);
/* 卡片区空白处右键：只有「添加标图」（卡片上右键仍是完整菜单） */
function openRepoBlankCtx(e) {
  e.preventDefault(); e.stopPropagation();
  closeRepoCtx();
  const m = $("#repoItemCtx");
  m.innerHTML = "";
  const b = document.createElement("button");
  b.textContent = "➕ 添加标图…";
  b.onclick = () => { closeItemCtx(); openRepoAdd(); };
  m.appendChild(b);
  m.hidden = false;
  m.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
  m.style.top = Math.min(e.clientY, window.innerHeight - 70) + "px";
}
$("#repoGrid").addEventListener("contextmenu", e => {
  const t = e.target;
  if (t === $("#repoGrid") || (t.classList && t.classList.contains("empty"))) openRepoBlankCtx(e);
});
/* 左侧文件夹栏空白处右键：新建文件夹 */
$("#repoSide").addEventListener("contextmenu", e => {
  if (!e.target.closest(".side-item")) openRepoCtx(e, null);
});
/* 打标库：空白处点击取消选中；Ctrl+A 全选；Delete 删除选中 */
$("#repoGrid").addEventListener("click", e => {
  if (e.target === $("#repoGrid") || (e.target.classList && e.target.classList.contains("empty"))) {
    state.repoSelected.clear(); refreshRepoSelection();
  }
});
document.addEventListener("keydown", e => {
  if (state.mode !== "repo") return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (!$("#uiPromptMask").hidden || !$("#uiConfirmMask").hidden) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    state.repoSelected.clear();
    state.repo.forEach(r => state.repoSelected.add(r.path));
    refreshRepoSelection();
    return;
  }
  if (e.key === "Delete" && state.repoSelected.size) {
    e.preventDefault();
    delRepoItems([...state.repoSelected]);
  }
});
$("#posBox").addEventListener("click", () => state.focus = "pos");
$("#negBox").addEventListener("click", () => state.focus = "neg");

/* 拖拽：标签库的标签可直接拖入 正向/负向/打标 */
function enableDrop(boxSel, getArr, rerender) {
  const box = $(boxSel);
  box.addEventListener("dragover", e => {
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    box.classList.add("dragover");
  });
  box.addEventListener("dragleave", () => box.classList.remove("dragover"));
  box.addEventListener("drop", e => {
    e.preventDefault(); box.classList.remove("dragover");
    const en = e.dataTransfer.getData("text/plain");
    if (!en) return;
    const n = addTagTo(getArr(), en);
    if (!n) { toast("已有该标签"); return; }
    rerender(); saveProgress();
    translatePending(getArr(), rerender);
  });
}
enableDrop("#posBox", () => state.posTags, () => renderPromptBox("pos"));
enableDrop("#negBox", () => state.negTags, () => renderPromptBox("neg"));
enableDrop("#capTags", () => cur().tags, renderCapTags);
$("#capAdd").addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.value.trim()) { addCapTag(e.target.value.trim()); e.target.value = ""; }
});

/* 正/负向独立输入框：回车填入 + 搜索联想（与打标一致，支持中文自动翻译） */
function bindSuggest(inputSel, listSel, getArr, rerender) {
  const inp = $(inputSel), list = $(listSel);
  const hide = () => { list.style.display = "none"; };
  inp.addEventListener("input", () => {
    const kw = inp.value.trim().toLowerCase();
    if (!kw) { hide(); return; }
    const res = [];
    state.tags.forEach(c => (c.children || []).forEach(g => (g.tags || []).forEach(t => {
      if (res.length < 8 && (t[0].toLowerCase().includes(kw) || String(t[1]).includes(kw))) res.push(t);
    })));
    if (!res.length) { hide(); return; }
    list.innerHTML = "";
    res.forEach(t => {
      const d = document.createElement("div");
      d.className = "sug-item";
      d.innerHTML = `<span class="sug-en">${t[0]}</span><span class="sug-zh">${t[1]}</span>`;
      d.onmousedown = () => {
        const n = addTagTo(getArr(), t[0]);
        inp.value = ""; hide(); rerender();
        if (!n) toast("已有该标签");
        translatePending(getArr(), rerender);
      };
      list.appendChild(d);
    });
    list.style.display = "block";
  });
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter" && inp.value.trim()) {
      const n = addTagTo(getArr(), inp.value);
      inp.value = ""; hide();
      if (!n) toast("已有该标签");
      rerender(); translatePending(getArr(), rerender);
    }
    if (e.key === "Escape") hide();
  });
  inp.addEventListener("blur", () => setTimeout(hide, 150));
}
/* 正/负向输入框：回车入框 + 联想（此前删 @ 悬浮窗时误删了这两行调用） */
bindSuggest("#posAdd", "#posSug", () => state.posTags, () => renderPromptBox("pos"));
bindSuggest("#negAdd", "#negSug", () => state.negTags, () => renderPromptBox("neg"));
$("#triggerInput").addEventListener("keydown", e => { if (e.key === "Enter") setTrigger(); });

document.addEventListener("keydown", e => {
  if (state.mode === "caption" && state.images.length) {
    if (e.key === "ArrowLeft") prevImg();
    if (e.key === "ArrowRight") nextImg();
    if (e.key === "Tab") { e.preventDefault(); gotoNextEmpty(); }
    if (e.ctrlKey && e.key === "s") { e.preventDefault(); saveProgress(); toast("已暂存，全部打完点「统一导出」"); }
  }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault(); adjust(e.key === "ArrowUp" ? 0.1 : -0.1);
  }
  if (e.key === "Escape") { $("#mask").hidden = true; if (!$("#uiConfirmMask").hidden) uiConfirmResolve(false); if (!$("#uiPromptMask").hidden) uiPromptResolve(false); if (!$("#ringPickerMask").hidden) closeRingPicker(false); closeRepoView(); closeRepoDel(); closeApply(); closeRepoAdd(); closeTagCreate(); closeTagRename(); closeTagLib(); closeTagImages(); closeColorPop(); closeMenus(); }
});
/* 标签库右键菜单借用了打标库的 #repoItemCtx：空白处左键关闭已由打标库的
   document click 监听（closeRepoCtx/closeItemCtx）负责；这里只补一条：
   在"非标签库卡片/分类"上右键时，也清掉菜单（卡片/分类自己的 handler 会重开） */
document.addEventListener("contextmenu", e => {
  const t = e.target;
  if (!(t.closest && (t.closest(".taglib-chip") || (t.closest("#tagLibSide") && t.closest(".side-item"))))) closeItemCtx();
}, true);

/* 环境检查：pywebview 是页面加载后才注入的，必须等一会儿再判断，
   否则每次启动都会误弹（原来放在 DOMContentLoaded 里就是这个 bug） */

/* 侧栏可拖拽调宽：在 .repo-main 的 .repo-side 后插入分隔条；拖动时改 .repo-side 宽度，
   右侧 grid 是 flex:1 + auto-fill 网格，会自动跟随剩余宽度重新排布 */
function enableSideResizer() {
  document.querySelectorAll(".repo-main").forEach(main => {
    if (main.querySelector(":scope > .col-resizer")) return;
    const side = main.querySelector(":scope > .repo-side");
    if (!side) return;
    const rz = document.createElement("div");
    rz.className = "col-resizer";
    rz.title = "拖动调整分类栏宽度";
    side.after(rz);
    rz.addEventListener("mousedown", e => {
      e.preventDefault();
      rz.classList.add("drag");
      main.classList.add("resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const rect = main.getBoundingClientRect();        // 拖拽期间容器不动，缓存一次，避免每帧强制同步布局
      let w = null, raf = 0;
      const apply = () => { raf = 0; if (w != null) side.style.width = w + "px"; };
      const onMove = ev => {
        w = Math.max(120, Math.min(ev.clientX - rect.left, rect.width - 260));
        if (!raf) raf = requestAnimationFrame(apply);   // 每帧只重排一次，避免抖动
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (raf) cancelAnimationFrame(raf);
        apply();
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        rz.classList.remove("drag");
        main.classList.remove("resizing");
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}
enableSideResizer();

setTimeout(() => {
  if (window.pywebview || window.__wlFatal) return;   // 正常程序或已报致命错，不再提示
  toast("请用启动脚本打开本程序（此页面需要 pywebview 环境）");
}, 6000);
