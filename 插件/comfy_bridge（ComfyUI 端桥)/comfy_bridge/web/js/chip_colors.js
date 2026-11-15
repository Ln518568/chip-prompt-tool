import { app } from "/scripts/app.js";

/* 所有 chip 联动节点的输出口按类型上色：
   STRING 绿（提示词） / INT 蓝（种子·步数·宽·高） / FLOAT 青（CFG）。
   同时写进全局 link_type_colors，连线颜色跟随类型，便于辨识。 */
const TYPE_COLORS = {
  STRING: "#4ade80",
  INT: "#60a5fa",
  FLOAT: "#2dd4bf",
};

function applyGlobal(app) {
  try {
    if (app && app.canvas && app.canvas.constructor && app.canvas.constructor.link_type_colors)
      Object.assign(app.canvas.constructor.link_type_colors, TYPE_COLORS);
    if (window.LiteGraph && window.LiteGraph.LGraphCanvas && window.LiteGraph.LGraphCanvas.link_type_colors)
      Object.assign(window.LiteGraph.LGraphCanvas.link_type_colors, TYPE_COLORS);
  } catch (e) {}
}

app.registerExtension({
  name: "comfy_bridge.socket_colors",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!nodeData || !nodeData.name || !String(nodeData.name).startsWith("Chip")) return;
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;
      (this.outputs || []).forEach((o) => {
        const c = TYPE_COLORS[o.type];
        if (c) { o.colorOn = c; o.colorOff = c; }
      });
      return r;
    };
  },
  setup(app) {
    // canvas 可能还没建好，短轮询兜底
    let n = 0;
    const t = setInterval(() => {
      n++;
      applyGlobal(app);
      if (n > 20) clearInterval(t);
    }, 250);
  },
});
