/* ComfyUI 联动 —— 主程序插件（主模式形式）
   纯插件、主程序零改动：运行时把本插件注册成顶栏模式按钮 + 主区整块视图。
   依赖主程序全局：switchMode / renderPlugins / syncModeInd / playViewEnter / state / toast。
   本文件顶部与 photo_library\panel.js 顶部是同一份幂等引导，两个插件互不依赖。 */

/* ============ 主模式引导（幂等，两个插件共享一份注册表） ============ */
(function chipModesBoot() {
  /* 小窗口顶栏适配：主模式按钮变多后，窄视口下顶栏会被挤成两行/文字折行。
     修复由插件注入响应式 CSS（主程序零改动），只压缩间距字号、隐藏重复按钮，
     不动 .modes 的定位方式（#modeInd 靠 getBoundingClientRect 定位，不能改成滚动容器）。 */
  window.__chipModeCssText = [
      "@media (max-width:1200px){",
      "  .top{gap:8px;padding:0 10px}",
      "  .brand{font-size:13px;white-space:nowrap;gap:6px}",
      "  .brand::before{width:17px;height:17px}",
      "  .modes{flex:0 0 auto;gap:0;padding:2px}",
      "  .mode-btn{flex:0 0 auto;white-space:nowrap;padding:5px 9px;font-size:12px}",
      "  .top-actions{flex:0 0 auto;gap:4px;margin-left:auto}",
      "  .top-actions .btn{flex:0 0 auto;white-space:nowrap;padding:4px 8px;font-size:11px}",
      "  #tip{display:none}",
      "}",
      "@media (max-width:1040px){",
      "  .brand{font-size:0;gap:0}",
      "  #btnTagLib,#btnGp{display:none}",
      "  .mode-btn{padding:5px 7px}",
      "  .top-actions .btn{padding:4px 6px}",
      "}",
      "@media (max-width:900px){",
      "  .top{gap:5px;padding:0 6px}",
      "  .mode-btn{padding:4px 5px;font-size:11px}",
      "  .top-actions .btn{padding:3px 5px;font-size:11px}",
      "  #btnTheme{display:none}",
      "}"
    ].join("\n");
  window.__chipModeEnsureCss = function () {
    if (document.getElementById("chipModesCss")) return;
    var css = document.createElement("style");
    css.id = "chipModesCss";
    css.textContent = window.__chipModeCssText;
    document.head.appendChild(css);
  };
  window.__chipModeEnsureCss();

  var REG = window.__chipModes || (window.__chipModes = {});
  var ALL = window.__chipModesAll || (window.__chipModesAll = {});   // 永久快照，供插件装回时恢复

  window.__chipModeRegister = function (cfg) {
    ALL[cfg.mode] = cfg;
    REG[cfg.mode] = cfg;
    setTimeout(function () { if (window.__chipModeApply) window.__chipModeApply(); }, 0);
    return cfg;
  };

  if (window.__chipModesPatched) return;
  window.__chipModesPatched = true;

  function ensureDOM(cfg) {
    var modes = document.querySelector(".modes");
    if (modes && !modes.querySelector('.mode-btn[data-mode="' + cfg.mode + '"]')) {
      var b = document.createElement("button");
      b.className = "mode-btn";
      b.dataset.mode = cfg.mode;
      b.textContent = cfg.label;
      b.onclick = function () { return window.switchMode(cfg.mode); };
      modes.appendChild(b);                       // 追加到「标签库」之后
    }
    var main = document.querySelector("main.main") || document.querySelector("main");
    var sec = document.getElementById(cfg.viewId);
    if (main && !sec) {
      sec = document.createElement("section");
      sec.className = "panel col-right";
      sec.id = cfg.viewId;
      sec.style.display = "none";
      main.appendChild(sec);
    }
    return sec;
  }

  function dropMissing() {
    var list = (typeof pluginList !== "undefined" && Array.isArray(pluginList)) ? pluginList : null;
    if (!list) return;
    /* 插件装回：从永久快照恢复注册，按钮与视图由 apply() 重新建 */
    Object.keys(ALL).forEach(function (m) {
      if (REG[m]) return;
      if (list.some(function (p) { return p && p.id === ALL[m].pluginId; })) REG[m] = ALL[m];
    });
    Object.keys(REG).forEach(function (m) {
      var cfg = REG[m];
      if (list.some(function (p) { return p && p.id === cfg.pluginId; })) return;
      var b = document.querySelector('.mode-btn[data-mode="' + m + '"]'); if (b) b.remove();
      var s = document.getElementById(cfg.viewId); if (s) s.remove();
      delete REG[m];
      if (typeof state !== "undefined" && state.mode === m) window.switchMode("prompt");
    });
    if (!Object.keys(REG).length) {
      var c = document.getElementById("chipModesCss");
      if (c) c.remove();                               // 插件全删 → 样式一起消失
    }
  }

  function apply() {
    var body = document.getElementById("pluginBody"), nav = document.getElementById("pluginNav");
    if (!body || !nav) return;
    dropMissing();
    if (Object.keys(REG).length && window.__chipModeEnsureCss) window.__chipModeEnsureCss();
    Object.keys(REG).forEach(function (m) {
      var cfg = REG[m], sec = ensureDOM(cfg);
      var panes = Array.prototype.slice.call(body.querySelectorAll(".plugin-pane"));
      var navs = Array.prototype.slice.call(nav.querySelectorAll(".plugin-nav-item"));
      var idx = -1;
      panes.forEach(function (p, i) {
        if (idx < 0 && (p.dataset.chipPlugin === cfg.pluginId || p.querySelector(cfg.marker))) idx = i;
      });
      if (idx < 0) return;
      var pane = panes[idx];
      if (sec && !sec.dataset.cmFilled) {
        var head = document.createElement("div");
        head.className = "panel-head";
        head.innerHTML = `<h3>${cfg.title}</h3>`;
        sec.appendChild(head);
        while (pane.firstChild) sec.appendChild(pane.firstChild);   // 移动节点，事件与 id 都保留
        sec.dataset.cmFilled = "1";
      }
      pane.remove();                                   // 浮层里不再有这一页
      if (navs[idx]) navs[idx].remove();
    });
    var left = body.querySelectorAll(".plugin-pane").length;
    nav.hidden = left < 2;
    var lp = body.querySelector(".plugin-pane"); if (lp) lp.classList.add("on");
    var ln = nav.querySelector(".plugin-nav-item"); if (ln) ln.classList.add("on");
    if (typeof syncModeInd === "function") syncModeInd(true);
  }
  window.__chipModeApply = apply;

  var origSwitch = window.switchMode;
  window.switchMode = async function (mode) {
    var cfg = REG[mode];
    if (!cfg) {
      /* 内建模式：先收起所有主模式视图，其余完全交给原函数（保留 loadRepo 等副作用） */
      Object.keys(REG).forEach(function (m) {
        var el = document.getElementById(REG[m].viewId); if (el) el.style.display = "none";
      });
      return await origSwitch.apply(this, arguments);
    }
    if (typeof state !== "undefined") state.mode = mode;
    document.querySelectorAll(".mode-btn").forEach(function (x) {
      x.classList.toggle("active", x.dataset.mode === mode);
    });
    if (typeof syncModeInd === "function") syncModeInd();
    ["viewPrompt", "viewCaption", "viewRepo", "viewTagLib"].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.style.display = "none";
    });
    Object.keys(REG).forEach(function (m) {
      var el = document.getElementById(REG[m].viewId);
      if (el) el.style.display = (m === mode ? "" : "none");
    });
    var tp = document.getElementById("tagPanel");
    if (tp) tp.style.display = "none";               // 主模式全宽，隐藏左侧标签栏
    var tip = document.getElementById("tip");
    if (tip) tip.textContent = cfg.tip || "";
    if (typeof playViewEnter === "function") playViewEnter(document.getElementById(cfg.viewId));
    if (cfg.onEnter) { try { cfg.onEnter(); } catch (e) {} }
  };

  var origRender = window.renderPlugins;
  window.renderPlugins = function () {
    var r = origRender.apply(this, arguments);
    /* 热检测重建浮层后，再次把主模式插件从浮层摘掉 */
    try { apply(); } catch (e) {}
    return r;
  };
  setTimeout(apply, 0);                              // 首次：等当前 renderPlugins 跑完
})();

/* ============ 联动面板逻辑（纯 fetch，不调主程序后端 Api） ============ */
var _cpHost = "127.0.0.1:8188";
/* ComfyUI 常用端口：秋叶启动器常带 --port 8189，官方默认 8188。
   连接失败时依次探测，命中 /chip/ping 就自动改地址并记住，省得手动填。 */
var CP_PORTS = [8188, 8189, 8199, 8181, 8080, 8000];
var _cpImgs = [];
var _cpSel = null;
var _cpLastState = "";
var _cpTimer = null;
var _cpOfflineTicks = 0;   // 离线轮询计数：ComfyUI 晚启动时低频自动重探
var _cpProbing = false;
var _cpImgB64 = null;        // 待注入「图像输入」节点的 base64（送图/主程序选图均会设置）
var _cpLoras = [];           // 面板选的 LoRA 堆：[{name, model, clip}]，注入 CR LoRA Stack 各槽位

function cpSay(msg) {
  try { if (typeof toast === "function") toast(msg); } catch (e) {}
  var el = document.getElementById("cpConn");
  if (el && msg) el.textContent = msg;
}

function cpBase() {
  var h = (_cpHost || "").trim() || "127.0.0.1:8188";
  if (!/^https?:\/\//i.test(h)) h = "http://" + h;
  return h.replace(/\/+$/, "");
}

function cpLoadHost() {
  try {
    var v = localStorage.getItem("chip_comfy_host");
    if (v) _cpHost = v;
  } catch (e) {}
  var el = document.getElementById("cpHost");
  if (el) el.value = _cpHost;
}

function cpSaveHost() {
  var el = document.getElementById("cpHost");
  _cpHost = (el && el.value.trim()) || "127.0.0.1:8188";
  try { localStorage.setItem("chip_comfy_host", _cpHost); } catch (e) {}
  cpSay("已保存地址：" + _cpHost);
}

async function cpReq(path, body) {
  var opt = { method: body ? "POST" : "GET" };
  if (body) {
    opt.headers = { "Content-Type": "application/json" };
    opt.body = JSON.stringify(body);
  }
  var r = await fetch(cpBase() + path, opt);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

/* 试一个地址能否 ping 通 /chip/ping；返回 {ok,name} 或 null */
async function cpPingAt(host) {
  var h = String(host || "").trim();
  if (!/^https?:\/\//i.test(h)) h = "http://" + h;
  h = h.replace(/\/+$/, "");
  try {
    var r = await fetch(h + "/chip/ping", { method: "GET" });
    if (!r.ok) return null;
    var d = await r.json();
    return (d && d.ok) ? { host: h, name: d.name || "" } : null;
  } catch (e) { return null; }
}

/* 依次探测常见端口，返回第一个命中的地址 */
async function cpFindPort() {
  var cur = cpBase(), tried = {};
  var list = [cur];
  CP_PORTS.forEach(function (p) {
    var h = "http://127.0.0.1:" + p;
    if (list.indexOf(h) < 0) list.push(h);
  });
  for (var i = 0; i < list.length; i++) {
    var h = list[i];
    if (tried[h]) continue;
    tried[h] = 1;
    var hit = await cpPingAt(h);
    if (hit) return hit;
  }
  return null;
}

function cpSetHost(host) {
  var h = String(host || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  _cpHost = h;
  var el = document.getElementById("cpHost");
  if (el) el.value = h;
  try { localStorage.setItem("chip_comfy_host", h); } catch (e) {}
}

async function cpTest() {
  cpSaveHost();
  var el = document.getElementById("cpConn");
  if (el) el.textContent = "连接中…";
  try {
    var r = await cpReq("/chip/ping");
    if (r && r.ok) {
      if (el) el.textContent = "已连接 ✓ " + (r.name || "");
      cpSay("已连接 ComfyUI 联动桥");
      cpPoll(); cpRefresh();
      return;
    }
  } catch (e) {}

  /* 当前地址不通 → 自动扫端口（含 8189） */
  if (el) el.textContent = "当前地址不通，正在自动找 ComfyUI 端口…";
  var hit = await cpFindPort();
  if (hit) {
    cpSetHost(hit.host);
    if (el) el.textContent = "已找到 ✓ " + _cpHost + " · " + (hit.name || "");
    cpSay("已自动切换到 " + _cpHost);
    cpPoll(); cpRefresh();
    return;
  }
  if (el) el.textContent = "连不上：Failed to fetch";
  try {
    if (typeof toast === "function") toast("没找到 ComfyUI：请确认 ComfyUI 已启动，且 comfy_bridge 装在 custom_nodes 的直接子目录并重启过");
  } catch (x) {}
}

/* 调用主程序「提示词模式」里编辑好的正/反向提示词：
   同页运行，直接读全局 state.posTags/negTags，用主程序自己的 tagsToText 转文本（含权重等） */
function cpPullPrompt() {
  var pos = "", neg = "";
  try {
    if (typeof tagsToText === "function" && typeof state !== "undefined" && state) {
      pos = tagsToText(state.posTags || []);
      neg = tagsToText(state.negTags || []);
    }
  } catch (e) {}
  if (!pos && !neg) { cpSay("提示词模式里正向/反向都是空的，没有可调用的内容"); return; }
  var pe = document.getElementById("cpPos"), ne = document.getElementById("cpNeg");
  if (pos && pe) pe.value = pos;
  if (neg && ne) ne.value = neg;
  cpSay("已调用提示词模式：正向" + (pos ? " " + pos.length + " 字" : "空")
      + " · 反向" + (neg ? " " + neg.length + " 字" : "空"));
}

/* 预设尺寸：选中即填入宽/高框（之后再手改也行）；选“自定义”不动 */
function cpApplyPreset() {
  var sel = document.getElementById("cpPreset");
  if (!sel) return;
  var v = String(sel.value || "").trim();
  if (!v) return;
  var p = v.split("x");
  var w = parseInt(p[0], 10), h = parseInt(p[1], 10);
  if (!w || !h) return;
  var wEl = document.getElementById("cpW"), hEl = document.getElementById("cpH");
  if (wEl) wEl.value = w;
  if (hEl) hEl.value = h;
}

/* 切换宽高（横竖互换），等价 Comfyroll「切换宽高」开关 */
function cpSwapWH() {
  var wEl = document.getElementById("cpW"), hEl = document.getElementById("cpH");
  if (!wEl || !hEl) return;
  var t = wEl.value;
  wEl.value = hEl.value;
  hEl.value = t;
  cpSay("已切换宽高（横竖互换）");
}

/* 收集「提示词与参数」卡片内容，组成 chip 对象（只带非空的），随开始请求注入联动节点 */
function cpCollectChip() {
  function v(id) { var el = document.getElementById(id); return el ? el.value.trim() : ""; }
  var chip = {};
  var pos = v("cpPos"), neg = v("cpNeg");
  if (pos) chip.positive = pos;
  if (neg) chip.negative = neg;
  var seed = v("cpSeed"), steps = v("cpSteps"), cfg = v("cpCfg"), w = v("cpW"), h = v("cpH");
  /* 随机模式：每次点开始都换一个新种子（0 ~ 2^53 安全整数内）；
     勾了随机就忽略手填的种子框；没勾才用手填值 */
  var randEl = document.getElementById("cpSeedRand");
  if (randEl && randEl.checked) {
    chip.seed = Math.floor(Math.random() * 4503599627370496); // 2^52
  } else if (seed !== "") {
    chip.seed = parseInt(seed, 10) || 0;
  }
  if (steps !== "") chip.steps = parseInt(steps, 10) || 20;
  if (cfg !== "") chip.cfg = parseFloat(cfg) || 0;
  if (w !== "") chip.width = parseInt(w, 10) || 1024;
  if (h !== "") chip.height = parseInt(h, 10) || 1024;
  var ck = v("cpCkpt");
  if (ck) chip.checkpoint = ck;
  if (_cpLoras.length) {
    chip.loras = _cpLoras.map(function (l) {
      return { name: l.name, model_weight: parseFloat(l.model) || 1.0, clip_weight: parseFloat(l.clip) || 1.0 };
    });
    chip.lora = _cpLoras[0].name;                              // 兼容旧的单 LoRA 节点
    chip.lora_strength = parseFloat(_cpLoras[0].model) || 1.0;
  }
  if (_cpImgB64) chip.image_b64 = _cpImgB64;
  return chip;
}

async function cpStart() {
  try {
    var chip = cpCollectChip();
    var payload = chip && Object.keys(chip).length ? { chip: chip } : {};
    var sel = document.getElementById("cpWfSel");
    var wf = sel ? sel.value : "";
    /* 默认（下拉未选库里的图）：直接读 ComfyUI 界面上正在编辑的画布 */
    if (!wf || wf === "__canvas__") { await cpRunCanvas(); return; }
    var r = await cpReq("/chip/start", payload);
    cpSay(r && r.ok ? "已提交工作流" : (r && r.msg || "启动失败"));
    cpPoll();
  } catch (e) { cpSay("启动失败：" + (e && e.message || e)); }
}

async function cpRunCanvas() {
  try {
    var chip = cpCollectChip();
    var payload = chip && Object.keys(chip).length ? { chip: chip } : {};
    var r = await cpReq("/chip/start_canvas", payload);
    if (r && r.ok) {
      cpSay(r.msg || "已读取当前画布并提交");
      cpPoll();
    } else {
      cpSay(r && r.msg || "运行当前画布失败");
    }
  } catch (e) { cpSay("运行当前画布失败：" + (e && e.message || e)); }
}

function cpLoadWorkflow() {
  var loc = (document.getElementById("cpWfLoc") || {}).value || "";
  loc = loc.trim();
  if (!loc) {                       // 留空 → 选本机文件
    var el = document.getElementById("cpWfFile");
    if (el) el.click();
    return;
  }
  if (/^https?:\/\//i.test(loc)) {
    cpSubmitWorkflow({ url: loc }, "已链接：" + loc);
  } else {
    cpSubmitWorkflow({ path: loc }, "已链接：" + loc);
  }
}

var _cpLastPayload = null;

async function cpSubmitWorkflow(payload, label) {
  try {
    var r = await cpReq("/chip/workflow", payload);
    var name = document.getElementById("cpWfName");
    if (r && r.ok) {
      if (name) name.textContent = label + (r.api_format ? "（API 格式✓）" : "（注意：需 API 格式）");
    } else {
      if (name) name.textContent = "";      // 失败不留成功假象
    }
    cpSay(r && r.msg || "已载入工作流");
    cpPoll();
    /* 载入成功后检查缺失的模型/LoRA：列出 ComfyUI 实际识别到的候选，让你确认替代 */
    if (r && r.ok) {
      _cpLastPayload = payload;
      cpCheckMissing(payload);
    }
  } catch (e) {
    var name2 = document.getElementById("cpWfName");
    if (name2) name2.textContent = "";
    cpSay("载入失败：" + (e && e.message || e));
  }
}

/* 检查本机缺失的模型/LoRA，渲染选择区；无缺失则隐藏 */
async function cpCheckMissing(payload) {
  var box = document.getElementById("cpRemap");
  if (!box) return;
  box.style.display = "none"; box.innerHTML = "";
  try {
    var r = await cpReq("/chip/workflow/check", payload);
    if (!r || !r.ok || !r.missing || !r.missing.length) return;
    var html = '<div class="cp-remap-head">本机<b>缺失 ' + r.missing.length +
      ' 个模型/LoRA</b>（下拉为 ComfyUI 实际识别到的可用项，已按文件名预选近似项）。'
      + '确认替代后点「确认替换并载入」，桥会写入自己的解析副本，<b>不改你的 .json</b>：</div>';
    r.missing.forEach(function (m, i) {
      var opts = '<option value="">— 保留原值（可能报错）—</option>';
      (m.candidates || []).forEach(function (c) {
        var sel = (c === m.suggest) ? " selected" : "";
        opts += '<option value="' + _cpEsc(c) + '"' + sel + '>' + _cpEsc(c) + "</option>";
      });
      var plug = (m.plugin && m.plugin !== m.class) ? (" · " + _cpEsc(m.plugin)) : "";
      html += '<div class="cp-remap-row" data-i="' + i + '">'
        + '<div class="cp-remap-label">节点 ' + _cpEsc(m.node) + '（' + _cpEsc(m.class) + plug
        + '）的 ' + _cpEsc(m.input) + '：<b>' + _cpEsc(m.value) + '</b><span class="cp-tag">缺失</span></div>'
        + '<select class="cp-remap-sel" data-i="' + i + '">' + opts + "</select>"
        + "</div>";
    });
    html += '<div class="cp-remap-actions">'
      + '<button class="btn tiny accent" onclick="cpConfirmRemap()">确认替换并载入</button>'
      + '<button class="btn tiny ghost" onclick="cpCancelRemap()">取消</button></div>';
    box.innerHTML = html;
    box._missing = r.missing;
    box.style.display = "flex";
  } catch (e) { /* 检查失败不阻塞载入 */ }
}

function cpConfirmRemap() {
  var box = document.getElementById("cpRemap");
  if (!box || !box._missing) return;
  var sel = box.querySelectorAll(".cp-remap-sel");
  var remap = {};
  sel.forEach(function (s) {
    if (!s.value) return;
    var m = box._missing[+s.dataset.i];
    if (m) remap[m.value] = s.value;
  });
  box.style.display = "none";
  var payload = Object.assign({}, _cpLastPayload, { remap: remap });
  var loc = (document.getElementById("cpWfLoc") || {}).value || "";
  var label = loc.trim() ? ("已链接：" + loc.trim()) : "已载入（已替换缺失资源）";
  cpSubmitWorkflow(payload, label);
}

function cpCancelRemap() {
  var box = document.getElementById("cpRemap");
  if (box) box.style.display = "none";
}

function _cpEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

async function cpWfFileChosen(ev) {
  var f = ev.target.files && ev.target.files[0];
  if (!f) return;
  try {
    var text = await f.text();
    var obj = JSON.parse(text);
    await cpSubmitWorkflow(obj, "已载入：" + f.name);
  } catch (e) {
    cpSay("载入失败：" + (e && e.message || e));
  } finally {
    ev.target.value = "";
  }
}

/* 拉取 ComfyUI 工作流库列表，填下拉；选中即直接载入 */
async function cpLoadWorkflows() {
  try {
    var r = await cpReq("/chip/workflows");
    var sel = document.getElementById("cpWfSel");
    if (!sel) return;
    if (!r || !r.ok) { cpSay(r && r.msg || "读取工作流列表失败"); return; }
    var keep = sel.value;
    var arr = r.workflows || [];
    var html = '<option value="__canvas__">🖥 运行当前画布（默认）</option>' +
               '<option value="">— 从 ComfyUI 工作流库选择 —</option>';
    for (var i = 0; i < arr.length; i++)
      html += '<option value="' + _cpEsc(arr[i].path) + '">' + _cpEsc(arr[i].name) + "</option>";
    sel.innerHTML = html;
    /* 默认选中「运行当前画布」；之前选了库里某张则保留 */
    sel.value = keep ? keep : "__canvas__";
    cpSay(arr.length ? "工作流库共 " + arr.length + " 个" : "工作流库为空（在 ComfyUI 里「保存」过工作流就会有）");
  } catch (e) { cpSay("读取工作流列表失败：" + (e && e.message || e)); }
}

function cpWfSelChange() {
  var sel = document.getElementById("cpWfSel");
  if (!sel || !sel.value || sel.value === "__canvas__") {
    if (sel && sel.value === "__canvas__") cpSay("已切回默认：开始 = 运行当前画布");
    return;
  }
  var name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : sel.value;
  cpSubmitWorkflow({ path: sel.value }, "已链接：" + name);
}

async function cpRefreshWorkflowState() {
  try {
    var r = await cpReq("/chip/workflow");
    var name = document.getElementById("cpWfName");
    if (name && r) name.textContent = r.msg || "";
  } catch (e) {}
}

async function cpStop() {
  try {
    var r = await cpReq("/chip/stop", {});
    cpSay(r && r.ok ? "已发送中断" : (r && r.msg || "中断失败"));
    cpPoll();
  } catch (e) { cpSay("中断失败：" + (e && e.message || e)); }
}

async function cpPoll() {
  try {
    var r = await cpReq("/chip/status");
    var st = document.getElementById("cpState");
    var bar = document.getElementById("cpBar");
    if (st) st.textContent = (r && r.state || "离线")
      + (r && r.online ? `（运行中 ${r.running} · 排队 ${r.pending}）` : "");
    if (bar) bar.style.width = (r && r.progress || 0) + "%";
    /* 仅 UI 状态联动：右上角离线标识 ↔ 主操作「开始」禁用态 */
    var pnl = document.getElementById("cpPanel");
    if (pnl) pnl.dataset.conn = (r && r.online) ? "online" : "offline";
    var btnStart = document.getElementById("cpStart");
    if (btnStart) btnStart.disabled = !(r && r.online);
    var now = (r && r.state) || "";
    if (_cpLastState === "执行中" && now !== "执行中") cpRefresh();
    _cpLastState = now;
    _cpOfflineTicks = 0;
  } catch (e) {
    _cpOfflineTicks++;
    /* ComfyUI 晚启动：每 ~10 次轮询（约 15 秒）重新扫一次端口，命中即自动切过去 */
    if (_cpOfflineTicks >= 10 && !_cpProbing) {
      _cpOfflineTicks = 0;
      _cpProbing = true;
      cpFindPort().then(function (h) {
        if (h) {
          cpSetHost(h.host);
          var el = document.getElementById("cpConn");
          if (el) el.textContent = "已自动连接 ✓ " + _cpHost + " · " + (h.name || "");
          cpPoll(); cpRefresh();
        }
      }).catch(function () {}).then(function () { _cpProbing = false; });
    }
    var st2 = document.getElementById("cpState");
    var bar2 = document.getElementById("cpBar");
    if (st2) st2.textContent = "离线（ComfyUI 未开或没装节点包）";
    if (bar2) bar2.style.width = "0%";
    var pnl2 = document.getElementById("cpPanel");
    if (pnl2) pnl2.dataset.conn = "offline";
    var sb2 = document.getElementById("cpStart");
    if (sb2) sb2.disabled = true;
  }
}

async function cpRefresh() {
  try {
    var r = await cpReq("/chip/images");
    _cpImgs = (r && Array.isArray(r.images)) ? r.images : [];
    cpRender();
    if (r && r.ok === false && r.msg) cpSay(r.msg);
  } catch (e) { cpSay("读取生成图失败：" + (e && e.message || e)); }
}

function cpClear() {
  _cpImgs = []; _cpSel = null; cpRender();
  cpSay("已清空显示（不影响 ComfyUI 里的文件）");
}

/* 双击缩略图：全屏灯箱看原图（b64 就是 ComfyUI 原图字节，无损） */
function cpShowBig(it) {
  if (!it || !it.b64) return;
  var old = document.getElementById("cpBigView");
  if (old) old.remove();
  var ov = document.createElement("div");
  ov.id = "cpBigView";
  ov.className = "cp-big";
  ov.title = "点击任意处或按 Esc 关闭";
  var img = document.createElement("img");
  img.src = it.b64;
  img.alt = it.name || "";
  ov.appendChild(img);
  var nm = document.createElement("div");
  nm.className = "cp-big-name";
  nm.textContent = (it.name || "") + "　·　点任意处 / Esc 关闭";
  ov.appendChild(nm);
  ov.onclick = function () { ov.remove(); };
  document.body.appendChild(ov);
}

window.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    var ov = document.getElementById("cpBigView");
    if (ov) ov.remove();
  }
});

/* 把下拉里选中的 LoRA 加入「堆」列表（可叠多个，每个带模型/CLIP强度），注入 CR LoRA Stack 槽位 */
function cpAddLora() {
  var sel = document.getElementById("cpLora");
  var name = sel ? sel.value : "";
  if (!name) { cpSay("先在下拉里选一个 LoRA 再点「添加」"); return; }
  if (_cpLoras.some(function (l) { return l.name === name; })) { cpSay("这个 LoRA 已经在堆里了"); return; }
  _cpLoras.push({ name: name, model: 1, clip: 1 });
  cpRenderLoras();
  cpSay("已加入 LoRA堆（共 " + _cpLoras.length + " 个）");
}

function cpRenderLoras() {
  var box = document.getElementById("cpLoraList");
  if (!box) return;
  box.innerHTML = "";
  _cpLoras.forEach(function (l, i) {
    var row = document.createElement("div");
    row.className = "cp-row";
    row.style.cssText = "gap:6px;align-items:center;background:rgba(255,255,255,.05);border-radius:8px;padding:5px 8px";
    var name = document.createElement("span");
    name.textContent = (i + 1) + ". " + l.name;
    name.title = l.name;
    name.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px";
    row.appendChild(name);
    function numField(label, key) {
      var wrap = document.createElement("span");
      wrap.style.cssText = "display:flex;align-items:center;gap:3px;flex:0 0 auto";
      var lb = document.createElement("span");
      lb.textContent = label; lb.style.cssText = "font-size:11px;opacity:.7";
      var inp = document.createElement("input");
      inp.type = "number"; inp.step = "0.01"; inp.value = l[key];
      inp.className = "cp-in"; inp.style.cssText = "width:62px;padding:2px 5px";
      inp.oninput = function () { l[key] = parseFloat(inp.value) || 0; };
      wrap.appendChild(lb); wrap.appendChild(inp);
      return wrap;
    }
    row.appendChild(numField("模型", "model"));
    row.appendChild(numField("CLIP", "clip"));
    var del = document.createElement("button");
    del.className = "btn tiny ghost"; del.textContent = "✕"; del.title = "从这个堆里移除";
    del.onclick = function () { _cpLoras.splice(i, 1); cpRenderLoras(); };
    row.appendChild(del);
    box.appendChild(row);
  });
}

/* 拉取 ComfyUI 本地的模型/LoRA 真实列表，填充下拉；选「不选」则沿用画布上的值 */
async function cpLoadOptions() {
  try {
    var r = await cpReq("/chip/options");
    if (!r || !r.ok) { cpSay(r && r.msg || "读取模型/LoRA 列表失败"); return; }
    function fill(sel, arr, placeholder) {
      if (!sel || !Array.isArray(arr)) return;
      var keep = sel.value;
      var html = '<option value="">' + (placeholder || "— 不选（用画布上的）—") + "</option>";
      for (var i = 0; i < arr.length; i++)
        html += '<option value="' + _cpEsc(arr[i]) + '">' + _cpEsc(arr[i]) + "</option>";
      sel.innerHTML = html;
      sel.value = keep || "";
    }
    fill(document.getElementById("cpCkpt"), r.checkpoints || []);
    fill(document.getElementById("cpLora"), r.loras || [], "— 选择后点「添加」—");
    cpSay("已拉取 " + (r.checkpoints || []).length + " 个模型 / " + (r.loras || []).length + " 个 LoRA");
  } catch (e) { cpSay("读取选项失败：" + (e && e.message || e)); }
}

function cpRender() {
  var g = document.getElementById("cpGrid");
  var c = document.getElementById("cpCnt");
  var em = document.getElementById("cpEmpty");
  if (c) c.textContent = _cpImgs.length + " 张";
  if (!g) return;
  g.innerHTML = "";
  if (em) em.style.display = _cpImgs.length ? "none" : "";
  _cpImgs.forEach(function (it) {
    var d = document.createElement("div");
    d.className = "cp-shot" + (_cpSel && _cpSel.id === it.id ? " is-sel" : "");
    d.title = it.name || "";
    d.innerHTML = `<img src="${it.b64}" alt="">`
      + `<div class="cp-shot-name">${it.name || ""}</div>`;
    d.onclick = function () { _cpSel = it; cpRender(); };
    d.ondblclick = function (ev) { ev.preventDefault(); cpShowBig(it); };
    g.appendChild(d);
  });
}

/* 把 dataURL 等比缩小到最长边不超过 maxDim，转 JPEG，控制送图体积（避免撑大 /prompt） */
function cpShrink(dataUrl, maxDim) {
  maxDim = maxDim || 1024;
  try {
    var img = new Image();
    img.src = dataUrl;
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;
    var s = Math.min(1, maxDim / Math.max(w, h));
    if (s >= 1 && /^data:image\/jpeg/.test(dataUrl)) return dataUrl;
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.88);
  } catch (e) { return dataUrl; }
}

async function cpUpload(data, name) {
  if (!data) { cpSay("没有可用的图片"); return; }
  try {
    var shrunk = cpShrink(data, 1024);
    var r = await cpReq("/chip/upload", { data: shrunk, name: name || "image.png" });
    if (r && r.ok) { _cpImgB64 = data; cpSay("已送图（将注入「图像输入」节点）：" + (r.name || name)); }
    else cpSay(r && r.msg || "送图失败");
  } catch (e) { cpSay("送图失败：" + (e && e.message || e)); }
}

/* 主程序侧「程序选图」入口：把选中的图（dataURL）交给插件，走与手动送图同一条路
   （上传共享 + 记下 base64，开始时节点的「图像输入」会注入它）。主程序调用：
   window.cpSendImage(dataUrl, name) */
window.cpSendImage = function (dataUrl, name) {
  if (!dataUrl) { cpSay("没有可用的图片"); return; }
  return cpUpload(dataUrl, name || "program.png");
};

function cpSendPhoto() {
  var item = null;
  try {
    var raw = localStorage.getItem("chip_photo_selected");
    if (raw) item = JSON.parse(raw);
  } catch (e) {}
  if (!item && typeof window.plGetSelected === "function") {
    try { item = window.plGetSelected(); } catch (e) {}
  }
  if (!item || !item.data) {
    cpSay("照片库里还没有选中图（请到「照片库」里选一张）");
    return;
  }
  return cpUpload(item.data, item.name);
}

function cpSendDisk() {
  var inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.style.display = "none";
  document.body.appendChild(inp);
  inp.onchange = function () {
    var f = inp.files && inp.files[0];
    if (!f) { inp.remove(); return; }
    var rd = new FileReader();
    rd.onload = function () { cpUpload(String(rd.result), f.name); inp.remove(); };
    rd.onerror = function () { cpSay("读取图片失败"); inp.remove(); };
    rd.readAsDataURL(f);
  };
  inp.click();
}

function cpSendGen() {
  if (!_cpSel) { cpSay("先点一张生成图选中，再送进工作流"); return; }
  return cpUpload(_cpSel.b64, _cpSel.name);
}

(function cpInit() {
  cpLoadHost();
  cpRender();
  if (_cpTimer) clearInterval(_cpTimer);
  _cpTimer = setInterval(cpPoll, 1500);
  /* 启动即自动找端口：即使上次存的是 8188、实际跑在 8189 也能自己切过去 */
  cpPingAt(cpBase()).then(function (hit) {
    if (hit) { cpPoll(); cpRefresh(); return; }
    return cpFindPort().then(function (h2) {
      if (h2) {
        cpSetHost(h2.host);
        var el = document.getElementById("cpConn");
        if (el) el.textContent = "已自动找到 ✓ " + _cpHost;
      }
      cpPoll(); cpRefresh(); cpRefreshWorkflowState();
    });
  });
  cpRefreshWorkflowState();
  cpLoadOptions();
  cpLoadWorkflows();
})();

/* 注册为顶栏主模式 */
window.__chipModeRegister({
  mode: "comfy", pluginId: "comfy_panel", viewId: "viewComfy",
  label: "ComfyUI", title: "ComfyUI 联动", marker: "#cpHost",
  tip: "ComfyUI 联动：连接 / 开始 / 停止 / 送图 / 看生成图",
  onEnter: function () { cpPoll(); cpRefresh(); }
});
