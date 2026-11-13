/* 照片库 —— 主程序插件（主模式形式）
   纯插件、主程序零改动：运行时把本插件注册成顶栏模式按钮 + 主区整块视图。
   本文件顶部与 comfy_panel\panel.js 顶部是同一份幂等引导，两个插件互不依赖，
   删掉任一个，另一个的顶栏按钮与主视图仍照常工作。 */

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

/* ============ 独立纯照片库（浏览器 localStorage，不碰主程序 data\） ============ */
var PL_KEY = "chip_photo_library_v1";
var PL_SEL = "chip_photo_selected";
var PL_FOLDERS = "chip_photo_folders_v1";   // 文件夹引用：只存路径，不存图
var _plItems = [];
var _plFolders = [];                        // [{path, ts}]，图片每次从磁盘现读

function plApi() {
  /* 主程序桌面窗口里才有 pywebview（纯浏览器预览没有文件系统能力） */
  return (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
}

function plFoldersLoad() {
  try {
    var raw = localStorage.getItem(PL_FOLDERS);
    _plFolders = raw ? (JSON.parse(raw) || []) : [];
    if (!Array.isArray(_plFolders)) _plFolders = [];
  } catch (e) { _plFolders = []; }
}

function plFoldersSave() {
  try { localStorage.setItem(PL_FOLDERS, JSON.stringify(_plFolders)); } catch (e) {}
}

function plSay(msg) {
  try { if (typeof toast === "function") toast(msg); } catch (e) {}
}

function plLoad() {
  try {
    var raw = localStorage.getItem(PL_KEY);
    _plItems = raw ? (JSON.parse(raw) || []) : [];
    if (!Array.isArray(_plItems)) _plItems = [];
  } catch (e) { _plItems = []; }
}

function plSave() {
  try {
    localStorage.setItem(PL_KEY, JSON.stringify(_plItems));
    return true;
  } catch (e) {
    plSay("本地存储满了：删掉几张，或到 ComfyUI 联动里用「从磁盘挑一张」");
    return false;
  }
}

window.plGetSelected = function () {
  try {
    var raw = localStorage.getItem(PL_SEL);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
};

function plSetSel(item) {
  try {
    if (item) localStorage.setItem(PL_SEL, JSON.stringify({ name: item.name, data: item.data }));
    else localStorage.removeItem(PL_SEL);
  } catch (e) {}
  plRender();
}

/* 选中项大小：按 data URL 的 base64 长度估算 */
function plSizeText(data) {
  var s = String(data || "");
  var k = s.indexOf("base64,");
  var bytes = k >= 0 ? Math.round((s.length - k - 7) * 0.75) : s.length;
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

function plRender() {
  var g = document.getElementById("plGrid");
  var c = document.getElementById("plCnt");
  var em = document.getElementById("plEmpty");
  var emTxt = document.getElementById("plEmptyTxt");
  var sel = document.getElementById("plSel");
  var meta = document.getElementById("plSelMeta");
  var thumb = document.getElementById("plSelThumb");
  var panel = document.getElementById("plPanel");
  var qEl = document.getElementById("plSearch");
  var cur = window.plGetSelected();
  var q = String((qEl && qEl.value) || "").trim().toLowerCase();
  /* 只过滤已加载的库内照片，不动存储、不碰文件夹引用 */
  var list = q ? _plItems.filter(function (it) {
    return String(it.name || "").toLowerCase().indexOf(q) >= 0;
  }) : _plItems;

  if (panel) {
    panel.setAttribute("data-has-sel", cur ? "1" : "0");
    panel.setAttribute("data-has-any", (_plItems.length || _plFolders.length) ? "1" : "0");
  }
  if (c) c.textContent = (q ? list.length + " / " + _plItems.length : String(_plItems.length)) + " 张";
  if (em) em.style.display = list.length ? "none" : "";
  if (emTxt) emTxt.textContent = (q && _plItems.length) ? "没有匹配的照片" : "库里还没有照片";
  if (sel) sel.textContent = cur ? cur.name : "未选中任何照片";
  if (thumb) {
    if (cur && cur.data) thumb.src = cur.data;
    else thumb.removeAttribute("src");
  }
  if (meta) {
    meta.textContent = cur ? plSizeText(cur.data) : "";
    if (cur && cur.data) {
      var probe = new Image();
      probe.onload = function () {
        var now = window.plGetSelected();
        if (!now || now.data !== cur.data) return;   /* 选中已变，丢弃过期信息 */
        meta.textContent = probe.naturalWidth + "×" + probe.naturalHeight + " · " + plSizeText(cur.data);
      };
      probe.src = cur.data;
    }
  }
  /* 库内没照片但有文件夹引用时，「全部照片」区整个隐藏（避免空盒子占位） */
  var libCard = document.getElementById("plLibCard");
  if (libCard) libCard.style.display = (!_plItems.length && _plFolders.length) ? "none" : "";
  if (!g) return;
  g.innerHTML = "";
  list.forEach(function (it) {
    var on = cur && cur.name === it.name && cur.data === it.data;
    var d = document.createElement("div");
    d.style.cssText = "width:112px;border:1px solid "
      + (on ? "var(--accent)" : "var(--border)")
      + ";border-radius:8px;padding:4px;cursor:pointer;background:var(--panel2)";
    d.title = it.name || "";
    d.innerHTML = `<img src="${it.data}" style="width:100%;height:88px;object-fit:cover;border-radius:5px;display:block">`
      + `<div class="hint" style="margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.name || ""}</div>`;
    d.onclick = function () { plSetSel(on ? null : it); };
    g.appendChild(d);
  });
}

function plCompress(file) {
  return new Promise(function (resolve, reject) {
    var rd = new FileReader();
    rd.onerror = function () { reject(new Error("读取失败")); };
    rd.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error("不是有效图片")); };
      img.onload = function () {
        var w = img.width, h = img.height, max = 1024;
        var k = Math.min(1, max / Math.max(w, h));
        var cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(w * k));
        cv.height = Math.max(1, Math.round(h * k));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(rd.result);
    };
    rd.readAsDataURL(file);
  });
}

async function plAdd() {
  var inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/*";
  inp.multiple = true;
  inp.style.display = "none";
  document.body.appendChild(inp);
  inp.onchange = async function () {
    var files = Array.from(inp.files || []);
    inp.remove();
    if (!files.length) return;
    var added = 0;
    var old = _plItems.slice();
    for (var i = 0; i < files.length; i++) {
      try {
        var data = await plCompress(files[i]);
        _plItems.unshift({ name: files[i].name, data: data, ts: Date.now() });
        added++;
      } catch (e) { /* 单张失败跳过 */ }
    }
    if (!plSave()) { _plItems = old; plRender(); return; }
    plSay("已添加 " + added + " 张照片");
    plRender();
  };
  inp.click();
}

function plClearSel() { plSetSel(null); }

/* ============ 文件夹读取：只引用路径，图片从磁盘现读 ============ */
function plWaitApi(timeout) {
  /* 等主程序桥就绪（pywebview.api 注入是异步的），最多等 timeout 毫秒 */
  timeout = timeout || 6000;
  return new Promise(function (resolve) {
    var t0 = Date.now();
    (function poll() {
      var api = plApi();
      if (api) return resolve(api);
      if (Date.now() - t0 > timeout) return resolve(null);
      setTimeout(poll, 150);
    })();
  });
}

async function plAddFolder() {
  plSay("正在连接主程序…");
  var api = await plWaitApi(6000);
  var folder = "";
  var nativeOk = false;
  if (api && api.pick_folder) {
    try { folder = await api.pick_folder(); nativeOk = true; } catch (e) { nativeOk = false; }
  }
  if (!nativeOk) {
    /* 没有原生选文件夹能力（纯浏览器预览/旧版程序）：用主程序样式的输入框代替 */
    if (typeof uiPrompt === "function") {
      folder = await uiPrompt("添加文件夹（手填路径）", {
        label: "输入本机文件夹的完整路径：",
        placeholder: "如 D:\\图库\\2026",
      });
    } else {
      plSay("请在主程序桌面窗口里使用「添加文件夹」"); return;
    }
  }
  folder = String(folder || "").trim();
  if (!folder) return;   /* 用户取消或没填 */
  if (_plFolders.some(function (f) { return f.path === folder; })) { plSay("该文件夹已添加过"); return; }
  if (!api || (!api.list_images && !api.list_images_recursive)) { plSay("文件夹读取需要在主程序桌面窗口里使用"); return; }
  plSay("正在读取文件夹（含子文件夹）…");
  var imgs = [];
  try {
    imgs = (api.list_images_recursive ? (await api.list_images_recursive(folder)) : (await api.list_images(folder))) || [];
  } catch (e) { imgs = []; }
  if (!imgs.length) { plSay("文件夹里没有图片（或路径无效）：" + folder); return; }
  _plFolders.unshift({ path: folder, ts: Date.now(), warn: false });
  plFoldersSave();
  plRenderFolders();
  plSay("已添加：" + folder + "（" + imgs.length + " 张，只引用不存盘）");
}

function plRemoveFolder(path) {
  _plFolders = _plFolders.filter(function (f) { return f.path !== path; });
  plFoldersSave();
  plRenderFolders();
  plSay("已移除文件夹引用（磁盘文件不受影响）");
}

/* 点文件夹里的图：现读原图（最长边1024）作为选中，送 ComfyUI 用 */
async function plPickFolderImage(path, name) {
  var api = plApi();
  if (!api || !api.preview) { plSay("需要在主程序桌面窗口里使用"); return; }
  plSay("正在读取图片…");
  var data = "";
  try { data = await api.preview(path, 1024); } catch (e) {}
  if (!data) { plSay("读取失败（文件可能被移动或删除）：" + name); return; }
  plSetSel({ name: name, data: data });
  plMarkFolderSel(path);
  plSay("已选中：" + name);
}

/* 双击文件夹图：全屏灯箱看原图（现读磁盘，最长边 1200） */
function plShowBig(path, name) {
  var api = plApi();
  if (!api || !api.preview) return;
  plSay("正在读取原图…");
  api.preview(path, 1200).then(function (b64) {
    if (!b64) { plSay("读取失败（文件可能被移动或删除）：" + name); return; }
    var old = document.getElementById("plBigView");
    if (old) old.remove();
    var ov = document.createElement("div");
    ov.id = "plBigView";
    ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out";
    ov.title = "点击任意处或按 Esc 关闭";
    var img = document.createElement("img");
    img.src = b64;
    img.alt = name || "";
    img.style.cssText = "max-width:94vw;max-height:90vh;object-fit:contain;border-radius:8px;box-shadow:0 12px 48px rgba(0,0,0,.6)";
    ov.appendChild(img);
    var nm = document.createElement("div");
    nm.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);color:#ddd;font-size:12px;opacity:.85;pointer-events:none";
    nm.textContent = (name || "") + "　·　点任意处 / Esc 关闭";
    ov.appendChild(nm);
    ov.onclick = function () { ov.remove(); };
    document.body.appendChild(ov);
    plSay("");
  }).catch(function () {});
}

window.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    var ov = document.getElementById("plBigView");
    if (ov) ov.remove();
  }
});

function plMarkFolderSel(path) {
  document.querySelectorAll("#plFolderList [data-plpath]").forEach(function (el) {
    var on = el.getAttribute("data-plpath") === path;
    el.style.borderColor = on ? "var(--accent)" : "var(--border)";
  });
}

async function plRenderFolders() {
  var card = document.getElementById("plFolderCard");
  var list = document.getElementById("plFolderList");
  var cnt = document.getElementById("plFolderCnt");
  if (!card || !list) return;
  if (!_plFolders.length) { card.style.display = "none"; list.innerHTML = ""; if (cnt) cnt.textContent = "0 张"; return; }
  card.style.display = "";
  list.innerHTML = "";
  var api = plApi();
  var total = 0;
  var cur = window.plGetSelected();
  for (var fi = 0; fi < _plFolders.length; fi++) {
    var f = _plFolders[fi];
    /* 路径存在性检测：失效则标记警告并持久保存；恢复后自动解除 */
    var exists = null;   // null = 无法判断（纯浏览器预览/旧版程序）
    if (api && api.path_exists) {
      try { exists = !!(await api.path_exists(f.path)); } catch (e) { exists = null; }
    }
    if (exists === false && !f.warn) { f.warn = true; plFoldersSave(); plSay("有文件夹路径找不到了：" + f.path); }
    if (exists === true && f.warn) { f.warn = false; plFoldersSave(); plSay("文件夹已恢复：" + f.path); }
    var warn = f.warn === true;
    var block = document.createElement("div");
    block.style.cssText = "margin-bottom:10px;border:1px solid "
      + (warn ? "rgba(245,158,11,.55)" : "transparent")
      + ";border-radius:8px;padding:" + (warn ? "8px 10px" : "0");
    var head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px";
    var nm = document.createElement("span");
    nm.className = "hint";
    nm.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;"
      + (warn ? "color:#f59e0b;font-weight:600" : "");
    nm.textContent = (warn ? "路径不存在或已移动：" : "") + f.path;
    var rm = document.createElement("button");
    rm.className = "btn tiny ghost danger";
    rm.textContent = "移除";
    rm.title = "移除这个文件夹的引用（不删文件）";
    rm.onclick = function () { plRemoveFolder(f.path); };
    head.appendChild(nm); head.appendChild(rm);
    block.appendChild(head);

    var well = document.createElement("div");
    well.className = "pl-well";
    well.style.maxHeight = "260px";
    block.appendChild(well);

    var imgs = [];
    if (exists !== false && api && (api.list_images || api.list_images_recursive)) {
      try {
        imgs = (api.list_images_recursive ? (await api.list_images_recursive(f.path)) : (await api.list_images(f.path))) || [];
      } catch (e) { imgs = []; }
    }
    if (exists === false) {
      var warnEl = document.createElement("div");
      warnEl.style.cssText = "padding:10px 12px;border:1px dashed rgba(245,158,11,.6);border-radius:8px;color:#f59e0b;font-size:11.5px;line-height:1.6";
      warnEl.innerHTML = "<b>找不到这个文件夹</b>　磁盘上的路径已不存在（被移动 / 删除 / 盘没挂上）。"
        + "文件夹下的图片无法显示；确认后点右侧「移除」清掉这条引用，或把文件夹放回原路径后自动恢复。";
      well.appendChild(warnEl);
    } else if (!imgs.length) {
      var emp = document.createElement("span");
      emp.className = "hint";
      emp.textContent = "读不到图片（文件夹为空 / 已被移动 / 纯浏览器预览模式）";
      well.appendChild(emp);
    }
    total += imgs.length;
    var todo = [];   // {el: img元素, path}——先建卡片再分批取图，避免一次几百个调用卡界面
    imgs.slice(0, 600).forEach(function (im) {
      var d = document.createElement("div");
      d.setAttribute("data-plpath", im.path);
      d.style.cssText = "width:112px;border:1px solid var(--border);border-radius:8px;padding:4px;cursor:pointer;background:var(--panel2)";
      d.title = im.name + "　（" + im.path + "）　单击选中 · 双击看原图";
      d.innerHTML = `<img style="width:100%;height:88px;min-height:88px;object-fit:cover;border-radius:5px;display:block;background:var(--bg)">`
        + `<div class="hint" style="margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${im.name || ""}</div>`;
      var imgEl = d.querySelector("img");
      d.onclick = function () { plPickFolderImage(im.path, im.name); };
      d.ondblclick = function (ev) { ev.preventDefault(); plShowBig(im.path, im.name); };
      well.appendChild(d);
      todo.push({ el: imgEl, path: im.path });
    });
    well.scrollTop = 0;
    /* 分批加载缩略图：一批 12 个，主程序 thumb 带磁盘缓存，重复显示不重复压图 */
    (function loadBatch(i) {
      if (i >= todo.length || !api || !api.thumb) return;
      var grp = todo.slice(i, i + 12);
      Promise.all(grp.map(function (t) {
        return api.thumb(t.path, 320).catch(function () { return ""; });
      })).then(function (arr) {
        arr.forEach(function (b64, k) { if (b64 && grp[k]) grp[k].el.src = b64; });
        setTimeout(function () { loadBatch(i + 12); }, 0);
      });
    })(0);
    list.appendChild(block);
  }
  if (cnt) cnt.textContent = total + " 张";
  var plPanelEl = document.getElementById("plPanel");
  if (plPanelEl) plPanelEl.setAttribute("data-has-any", (_plItems.length || _plFolders.length) ? "1" : "0");
  /* 恢复选中高亮 */
  if (cur && cur.name) {
    var els = document.querySelectorAll("#plFolderList [data-plpath]");
    /* 选中项是文件夹图时按名字粗略匹配高亮 */
    for (var i = 0; i < els.length; i++) {
      var nmEl = els[i].querySelector(".hint:last-child") || els[i].lastElementChild;
      if (nmEl && nmEl.textContent === cur.name) els[i].style.borderColor = "var(--accent)";
    }
  }
}

async function plDelSel() {
  var cur = window.plGetSelected();
  if (!cur) { plSay("先点一张照片选中"); return; }
  _plItems = _plItems.filter(function (x) { return !(x.name === cur.name && x.data === cur.data); });
  plSetSel(null);
  plSave();
  plSay("已删除");
}

async function plClearAll() {
  if (!_plItems.length && !_plFolders.length) { plSay("库里本来就是空的"); return; }
  var ok = true;
  try {
    if (typeof uiConfirm === "function") {
      ok = await uiConfirm("清空照片库",
        `确定清空吗？将删除 <b>${_plItems.length}</b> 张库内照片和 <b>${_plFolders.length}</b> 个文件夹引用（<b>不删除磁盘上的任何文件</b>）。`,
        { danger: true, okText: "清空" });
    }
  } catch (e) {}
  if (!ok) return;
  _plItems = [];
  _plFolders = [];
  plFoldersSave();
  plSetSel(null);
  plSave();
  plRenderFolders();
  plSay("照片库已清空（磁盘文件不受影响）");
}

(function plInit() {
  plLoad();
  plFoldersLoad();
  plRender();
  plRenderFolders();
  /* 桥就绪后重刷一次：刚开窗时 pywebview.api 可能还没注入，缩略图读不到 */
  plWaitApi(8000).then(function (api) { if (api && _plFolders.length) plRenderFolders(); });
})();

/* 注册为顶栏主模式 */
window.__chipModeRegister({
  mode: "photo", pluginId: "photo_library", viewId: "viewPhoto",
  label: "照片库", title: "照片库", marker: "#plGrid",
  tip: "照片库：添加 / 点选 / 删除，选中图可送进 ComfyUI 工作流",
  onEnter: function () { plLoad(); plRender(); }
});
