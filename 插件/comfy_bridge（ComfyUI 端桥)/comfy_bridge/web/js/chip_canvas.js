import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

/* 读取「ComfyUI 当前界面」的工作流：
   面板点「运行当前画布」时，桥会通过 WebSocket 广播一条 chip-canvas-request；
   收到后把当前画布（graphToPrompt）POST 回桥的 /chip/canvas，桥再注入联动值并排队。
   这样面板不必依赖文件/历史，直接跑你屏幕上正在编辑的那张图。 */
function toPrompt(app) {
  return new Promise((resolve, reject) => {
    try {
      const r = app.graphToPrompt();
      if (r && typeof r.then === "function") {
        r.then(resolve).catch(reject);   // 新版：返回 Promise
      } else {
        resolve(r);                      // 旧版：直接返回 {output, workflow}
      }
    } catch (e) {
      reject(e);
    }
  });
}

app.registerExtension({
  name: "comfy_bridge.canvas_pull",
  setup() {
    api.addEventListener("chip-canvas-request", async () => {
      try {
        const p = await toPrompt(app);
        await fetch("/chip/canvas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: p.output, workflow: p.workflow }),
        });
      } catch (e) {
        console.warn("[chip] 推送当前画布失败：", e);
      }
    });

    /* 浏览器排队通道：桥把注入好的图发回来，由网页自己 api.queuePrompt——
       与用户手点「运行」同一条路径，节点高亮/运行按钮/预览/原生报错弹窗全正常 */
    api.addEventListener("chip-canvas-submit", async (e) => {
      const d = (e && e.detail) || {};
      const report = (body) => {
        fetch("/chip/queued", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).catch(() => {});
      };
      try {
        const r = await api.queuePrompt(0, {
          output: d.prompt,
          workflow: d.workflow || {},
        });
        const pid = (r && (r.prompt_id || (r.responses && r.responses[0] && r.responses[0].prompt_id))) || "";
        report({ ok: true, prompt_id: pid });
      } catch (err) {
        let msg = (err && err.response) ? JSON.stringify(err.response) : String(err || "排队失败");
        try {
          const j = JSON.parse(msg);
          if (j.node_errors) msg = "工作流有节点校验失败：" + JSON.stringify(j.node_errors).slice(0, 400);
          else if (j.error && j.error.message) msg = j.error.message;
        } catch (_) {}
        report({ ok: false, msg });
      }
    });
  },
});
