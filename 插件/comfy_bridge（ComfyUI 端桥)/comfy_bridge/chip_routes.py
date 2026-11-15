"""ComfyUI 侧 /chip/* 路由：给主程序插件提供桥梁，自带 CORS 头。

主程序页面是 file://，直接 fetch ComfyUI 会被浏览器跨域拦住，所以由本节点包
注册带 CORS 的路由；路由内部再走 ComfyUI 自带的标准 HTTP API（/queue /history
/prompt /interrupt /view），不依赖 ComfyUI 内部对象，版本兼容更稳。
"""
import asyncio
import base64
import difflib
import json
import re
import time
from io import BytesIO
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_SHARED = _HERE / "shared"
_registered = False

# 最近一次从 ComfyUI 前端推回的当前画布（graphToPrompt 的 output/workflow）
_CANVAS = {}
_CANVAS_WAITERS = []   # 等待前端把画布推回的 asyncio.Event 列表
_PROMPT_SERVER = None  # register() 时记下 PromptServer 实例，用于向浏览器广播 ws 消息
_QUEUE_WAITERS = []    # 等待前端排队回执（/chip/queued）的 asyncio.Event 列表
_SUBMIT_RESULT = {}    # 前端排队结果 {ok, prompt_id, msg}

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _json(obj, status=200):
    from aiohttp import web
    return web.json_response(obj, status=status, headers=CORS)


def _base(request):
    """用请求自身的 host 回连 ComfyUI，避免硬编码端口"""
    host = request.host or "127.0.0.1:8188"
    return f"http://{host}"


async def _api(request, path, data=None, want_bytes=False, timeout=8, check=False):
    """转发到 ComfyUI 自带 API；data 不为 None 时发 POST。
    check=True 时非 2xx 抛错（把 ComfyUI 的真实报错带给面板）。"""
    import aiohttp
    url = _base(request) + path
    kw = {"timeout": aiohttp.ClientTimeout(total=timeout)}
    async with aiohttp.ClientSession(**kw) as s:
        if data is None:
            async with s.get(url) as r:
                raw = await r.read()
                if check and r.status >= 400:
                    raise RuntimeError(f"HTTP {r.status}：{raw.decode('utf-8', 'replace')[:2000]}")
        else:
            async with s.post(url, json=data) as r:
                raw = await r.read()
                if check and r.status >= 400:
                    raise RuntimeError(f"HTTP {r.status}：{raw.decode('utf-8', 'replace')[:2000]}")
        if want_bytes:
            return raw
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            return {}


# ---------------- 路由处理 ----------------
async def h_options(request):
    from aiohttp import web
    return web.Response(status=204, headers=CORS)


async def h_ping(request):
    return _json({"ok": True, "name": "chip-prompt-tool 联动桥", "ts": int(time.time())})


async def h_options(request):
    """读取 ComfyUI 本地真实的大模型 / LoRA 列表，返回给主程序做下拉选择。"""
    try:
        from folder_paths import get_filename_list
        return _json({
            "ok": True,
            "checkpoints": list(get_filename_list("checkpoints")),
            "unets": list(get_filename_list("diffusion_models")),
            "loras": list(get_filename_list("loras")),
        })
    except Exception as e:
        return _json({"ok": False, "msg": f"读取模型/LoRA 列表失败：{e}"})


async def h_status(request):
    """排队 / 执行中 / 空闲 + 队列剩余；阶段式进度（不接 WebSocket）"""
    try:
        q = await _api(request, "/queue", timeout=4)
        running = len((q or {}).get("queue_running") or [])
        pending = len((q or {}).get("queue_pending") or [])
        if running:
            state, progress = "执行中", 60
        elif pending:
            state, progress = "排队中", 20
        else:
            state, progress = "空闲", 0
        return _json({"ok": True, "online": True, "state": state, "progress": progress,
                      "running": running, "pending": pending})
    except Exception as e:
        return _json({"ok": False, "online": False, "state": "离线", "progress": 0,
                      "running": 0, "pending": 0, "error": str(e)[:150]})


_WF = _SHARED / "workflow.json"        # 自动捕获（ComfyUI 每次 Queue 写入）
_UP = _SHARED / "workflow_upload.json"   # 上传/链接解析后的图纸缓存
_SRC = _SHARED / "workflow_src.json"     # 链接源描述：{"kind":"path"|"url","value":"..."}

_http = None


def _http_session():
    global _http
    import aiohttp
    if _http is None or _http.closed:
        _http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
    return _http


async def _resolve_src():
    """按链接源（路径/URL）重新读取图纸。路径在 ComfyUI 那台机器上解析，
    URL 支持 http(s)://（含局域网 IP）。每次「开始」都重读，拿到的永远是最新版。"""
    if not _SRC.exists():
        return None
    try:
        desc = json.loads(_SRC.read_text(encoding="utf-8"))
    except Exception:
        return None
    kind, val = desc.get("kind"), desc.get("value")
    if kind == "path" and val:
        return json.loads(Path(val).read_text(encoding="utf-8"))
    if kind == "url" and val:
        async with (await _http_session()).get(val) as resp:
            resp.raise_for_status()
            return await resp.json()
    return None


async def _load_stored_workflow():
    """读取图纸优先级：链接源（实时重读）> 上传缓存 > 自动捕获。"""
    try:
        src = await _resolve_src()
        if src:
            return src
    except Exception:
        pass
    for p in (_UP, _WF):
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                pass
    return None


def _wf_loaded_msg(g, note):
    return {"ok": True, "msg": note, "api_format": isinstance(g, dict) and "prompt" in g}


def _fmt_node_errors(ne, limit=3):
    """把 /prompt 返回的 node_errors 压成一句人话。重要：ComfyUI 对「部分输出
    校验失败」仍返回 200 并只执行通过的部分，不查这里就会假报成功。"""
    if not isinstance(ne, dict) or not ne:
        return ""
    parts = []
    for nid, info in list(ne.items())[:limit]:
        cls = (info or {}).get("class_type", "")
        for err in ((info or {}).get("errors") or [])[:2]:
            parts.append(f"节点{nid}({cls}) {err.get('details') or err.get('message')}")
    return "；".join(parts)[:300]


# ---------------- UI 格式 → API 格式自动转换 ----------------
_CONTROLS = {"fixed", "increment", "decrement", "randomize"}


def _follow_source(lmap, nmap, node_id, slot):
    """穿透 Reroute 找到真实来源 (node_id, slot)；找不到返回 None。"""
    seen = set()
    while True:
        if (node_id, slot) in seen or node_id not in nmap:
            return None
        seen.add((node_id, slot))
        n = nmap[node_id]
        if n.get("type") != "Reroute":
            return node_id, slot
        ins = n.get("inputs") or []
        lk = lmap.get((ins[0] or {}).get("link")) if ins else None
        if not lk:
            return None
        node_id, slot = lk[1], lk[2]


async def _ui_to_api(request, ui, resolve=True, remap=None):
    """把 ComfyUI 普通 Save 导出的 UI 格式（nodes/links）转成 /prompt 可提交的
    API 格式。做法：拉 /object_info 按节点定义把 widgets_values 依序映射回输入，
    links 连接的输入取来源节点；Reroute 自动穿透；前端专属节点（如 PrimitiveNode）
    的值内联成常量。缺失的模型/LoRA 引用：remap 优先（用户指定），否则按文件名
    自动匹配到真实文件（不改原 json）。"""
    info = await _api(request, "/object_info", timeout=30)
    if not isinstance(info, dict) or not info:
        raise RuntimeError("拿不到 /object_info，无法转换 UI 格式")
    lmap = {l[0]: l for l in (ui.get("links") or [])
            if isinstance(l, (list, tuple)) and len(l) >= 3}
    nmap = {n.get("id"): n for n in (ui.get("nodes") or [])}
    api = {}
    resolves = []   # [(class_type, input, old, new)] 记录自动替换，便于提示用户
    for n in (ui.get("nodes") or []):
        ntype = n.get("type")
        defn = info.get(ntype)
        if not isinstance(defn, dict):
            continue   # 前端专属节点：不留进 API 图，连接处按常量内联
        inputs_def = {}
        inp = defn.get("input") or {}
        for sect in ("required", "optional"):
            d = inp.get(sect)
            if isinstance(d, dict):
                inputs_def.update(d)
        # 已被转成输入连线（不再占 widget 位）的输入名
        linked_widgets = {c["widget"]["name"] for c in (n.get("inputs") or [])
                          if isinstance(c, dict) and isinstance(c.get("widget"), dict) and c["widget"].get("name")}
        widgets = list(n.get("widgets_values") or [])
        vals = {}
        for name, spec in inputs_def.items():
            t = spec[0] if isinstance(spec, (list, tuple)) and spec else spec
            is_widget = isinstance(t, list) or (isinstance(t, str) and
                          t in ("INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"))
            if not is_widget or name in linked_widgets:
                continue
            if not widgets:
                break
            v = widgets.pop(0)
            if isinstance(v, list) and len(v) == 2 and isinstance(v[1], str):
                v = v[0]                      # seed 的 [值, "fixed"] 形式
            # 文件类引用（LoRA/模型/VAE 等）：用户指定 > 自动按文件名匹配真实文件
            if t == "COMBO" and isinstance(v, str):
                if remap and v in remap:
                    v = remap[v]
                elif resolve:
                    opts = spec[1] if len(spec) > 1 and isinstance(spec[1], list) else []
                    rv = _resolve_asset(v, opts)
                    if rv is not None:
                        resolves.append((ntype, name, v, rv))
                        v = rv
            vals[name] = v
            if widgets and isinstance(widgets[0], str) and widgets[0] in _CONTROLS:
                widgets.pop(0)                # control_after_generate 陪跑值
        # 连线输入
        for c in (n.get("inputs") or []):
            if not isinstance(c, dict) or c.get("link") is None or not c.get("name"):
                continue
            lk = lmap.get(c["link"])
            if not lk:
                continue
            src = _follow_source(lmap, nmap, lk[1], lk[2])
            if src is None:
                continue
            sn = nmap.get(src[0])
            if sn is not None and not isinstance(info.get(sn.get("type")), dict):
                wv = sn.get("widgets_values") or []
                if wv:
                    vals[c["name"]] = wv[0]   # PrimitiveNode 等前端节点 → 内联常量
                continue
            vals[c["name"]] = [str(src[0]), int(src[1])]
        api[str(n["id"])] = {"class_type": ntype, "inputs": vals,
                             "_meta": {"title": n.get("title") or ntype}}
    if not api:
        raise RuntimeError("没有可转换的节点（画布为空或节点类型都未知）")
    return api, resolves


def _resolve_asset(value, options):
    """value 不在 options（ComfyUI 扫描到的真实文件列表）里时，自动匹配到真实文件：
    1) 精确 / 大小写·斜杠归一；2) 仅比文件名（忽略目录、扩展名）；
    3) 兜底：在同目录候选里挑文件名最像的（difflib 相似度），无同目录则全局挑。
    匹配不上或相似度过低返回 None（保持原值，由 ComfyUI 报明确缺失）。"""
    if not isinstance(value, str) or not options:
        return None
    if value in options:
        return None
    norm = value.replace("\\", "/").casefold()
    opts_norm = {o.replace("\\", "/").casefold(): o for o in options}
    if norm in opts_norm:
        return opts_norm[norm]
    base = norm.rsplit("/", 1)[-1]
    base_ne = re.sub(r"\.[a-z0-9]+$", "", base)
    for on, o in opts_norm.items():
        ob = on.rsplit("/", 1)[-1]
        ob_ne = re.sub(r"\.[a-z0-9]+$", "", ob)
        if ob == base or ob_ne == base_ne:
            return o
    # 兜底：同目录候选里挑名字最像的；否则全局挑最像的
    vdir = norm.rsplit("/", 1)[0]
    ref = base_ne or base
    pool = []
    for o in options:
        oc = o.replace("\\", "/").casefold()
        odir, ob = oc.rsplit("/", 1) if "/" in oc else ("", oc)
        ob_ne = re.sub(r"\.[a-z0-9]+$", "", ob)
        if odir == vdir:
            pool.append((o, ob_ne))
    if not pool:   # 没有同目录候选，退而求其次全局挑（但阈值更严）
        for o in options:
            ob = o.replace("\\", "/").casefold().rsplit("/", 1)[-1]
            pool.append((o, re.sub(r"\.[a-z0-9]+$", "", ob)))
    if not pool:
        return None
    best = max(pool, key=lambda x: difflib.SequenceMatcher(None, ref, x[1]).ratio())
    if difflib.SequenceMatcher(None, ref, best[1]).ratio() >= 0.34:
        return best[0]
    return None


def _looks_like_asset(val):
    """判断一个 COMBO 值是否像「模型/LoRA 文件引用」（需参与缺失检查与替换）。"""
    if not isinstance(val, str):
        return False
    if "/" in val or "\\" in val:
        return True
    return bool(re.search(r"\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$", val, re.I))


# 常见 LoRA/模型加载节点 → 所属 ComfyUI 插件（用于面板给用户说明「相关插件」）
_PLUGIN_OF = {
    "CR LoRA Stack": "ComfyUI_Comfyroll_CustomNodes",
    "CR Load LoRA": "ComfyUI_Comfyroll_CustomNodes",
    "Load LoRA": "ComfyUI 内置",
    "LoraLoader": "ComfyUI 内置",
    "LoraLoaderModelOnly": "ComfyUI 内置",
    "CheckpointLoaderSimple": "ComfyUI 内置",
    "CheckpointLoader": "ComfyUI 内置",
    "unCLIPCheckpointLoader": "ComfyUI 内置",
    "VAELoader": "ComfyUI 内置",
    "ControlNetLoader": "ComfyUI 内置",
    "DiffControlNetLoader": "ComfyUI 内置",
    "UNETLoader": "ComfyUI 内置",
    "CLIPLoader": "ComfyUI 内置",
    "TripleCLIPLoader": "ComfyUI 内置",
    "ModelLoader": "ComfyUI 内置",
}


def _plugin_of(cls):
    if not cls:
        return ""
    if cls in _PLUGIN_OF:
        return _PLUGIN_OF[cls]
    if "Lora" in cls or "LoRA" in cls:
        return "LoRA 加载节点"
    return cls


async def _apply_remap(request, prompt, remap):
    """对已是 API 格式的 prompt，按 remap（旧文件名→新文件名）替换 COMBO 输入。"""
    if not remap or not isinstance(prompt, dict):
        return prompt
    info = await _api(request, "/object_info", timeout=30)
    for nid, node in prompt.items():
        if not isinstance(node, dict):
            continue
        cls = node.get("class_type")
        defn = info.get(cls)
        if not isinstance(defn, dict):
            continue
        opts_map = {}
        for sect in ("required", "optional"):
            d = (defn.get("input") or {}).get(sect)
            if isinstance(d, dict):
                opts_map.update(d)
        for iname, spec in opts_map.items():
            if not (isinstance(spec, (list, tuple)) and spec and spec[0] == "COMBO"):
                continue
            v = (node.get("inputs") or {}).get(iname)
            if isinstance(v, str) and v in remap:
                node["inputs"][iname] = remap[v]
    return prompt


async def _to_api(request, body, resolve=True, remap=None):
    """把各种来源（path / url / 上传 JSON / 已存）统一解析为 API 格式 prompt dict，
    返回 (prompt_dict, auto_resolves)。resolve=False 时不自动匹配（用于检查缺失）。"""
    remap = remap or {}
    if not isinstance(body, dict):
        raise RuntimeError("请求体须为 JSON 对象")
    raw = None
    kind = None
    if body.get("path"):
        raw = json.loads(Path(body["path"]).read_text(encoding="utf-8"))
        kind = "path"
    elif body.get("url"):
        async with (await _http_session()).get(body["url"]) as resp:
            resp.raise_for_status()
            raw = await resp.json()
        kind = "url"
    elif "prompt" in body:
        raw = body
    elif "nodes" in body or "last_node_id" in body:
        raw = body
    else:
        raw = await _load_stored_workflow()
        if raw is None:
            raise RuntimeError("没有已载入的工作流：请提供 path / url / 工作流 JSON")
    # 转 API
    if isinstance(raw, dict) and ("nodes" in raw or "last_node_id" in raw):
        g, resolves = await _ui_to_api(request, raw, resolve=resolve, remap=remap)
        return g, resolves
    if isinstance(raw, dict) and "prompt" in raw:
        p = raw["prompt"]
        if remap:
            p = await _apply_remap(request, p, remap)
        return p, []
    if isinstance(raw, dict):
        # 顶层即 node map 的 API 格式
        if remap:
            raw = await _apply_remap(request, raw, remap)
        return raw, []
    raise RuntimeError("无法识别的工作流结构")


async def h_check(request):
    """检查工作流里引用的模型/LoRA 在本机是否存在。能自动匹配（精确/同名/模糊）的
    已被 h_set 直接替换，这里只列出「仍无法自动匹配」的项（本机没有相近文件），
    由面板让用户确认或用全部候选兜底替换后再运行。"""
    try:
        body = await request.json() or {}
        g, _ = await _to_api(request, body, resolve=True, remap={})
        info = await _api(request, "/object_info", timeout=30)
        missing = []
        for nid, node in g.items():
            cls = node.get("class_type")
            defn = info.get(cls)
            if not isinstance(defn, dict):
                continue
            opts_map = {}
            for sect in ("required", "optional"):
                d = (defn.get("input") or {}).get(sect)
                if isinstance(d, dict):
                    opts_map.update(d)
            for iname, spec in opts_map.items():
                if not (isinstance(spec, (list, tuple)) and spec and spec[0] == "COMBO"):
                    continue
                val = (node.get("inputs") or {}).get(iname)
                if not isinstance(val, str):
                    continue
                options = spec[1] if len(spec) > 1 and isinstance(spec[1], list) else []
                if val in options or not _looks_like_asset(val):
                    continue
                top = val.replace("\\", "/").split("/")[0]
                cands = [o for o in options if o.replace("\\", "/").split("/")[0] == top] or options
                missing.append({
                    "node": nid, "class": cls, "input": iname, "value": val,
                    "candidates": cands[:150],
                    "plugin": _plugin_of(cls),
                    "suggest": _resolve_asset(val, options) or (cands[0] if cands else ""),
                })
        return _json({"ok": True, "missing": missing, "count": len(missing)})
    except Exception as e:
        return _json({"ok": False, "msg": f"检查失败：{e}"})


_BRIDGE_KEYS = {
    "ChipSeed": "seed",
    "ChipSteps": "steps",
    "ChipCFG": "cfg",
}


def _inject_chip(g, chip):
    """把主程序「开始」时传来的参数注入对应联动小节点：
    提示词(联动)/全注入(联动) 的正/负、种子、步数、CFG，以及 ChipLatent 的宽/高、
    ChipCheckpoint 大模型、ChipLoRA、ChipInputImage 图片。
    面板明确选了的值覆盖节点上的值。返回 (g, injected_bool)。"""
    if not chip or not isinstance(chip, dict):
        return g, False
    n = 0
    for node in g.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        ins = node.setdefault("inputs", {})
        key = _BRIDGE_KEYS.get(ct)
        if key:
            if chip.get(key) is not None:
                ins[key] = chip[key]; n += 1
        elif ct == "CR LoRA Stack":
            # 面板 LoRA堆：按槽位注入（开关设 On + 名称 + 模型/CLIP强度）；
            # 堆上槽位不够就停，多出的槽位保持画布上的原值
            for i, lo in enumerate(chip.get("loras") or [], start=1):
                if f"lora_name_{i}" not in ins:
                    break
                ins[f"switch_{i}"] = "On"
                ins[f"lora_name_{i}"] = lo.get("name")
                ins[f"model_weight_{i}"] = lo.get("model_weight", 1.0)
                ins[f"clip_weight_{i}"] = lo.get("clip_weight", 1.0)
                n += 1
        elif ct == "ChipCheckpoint":
            if chip.get("checkpoint"):
                ins["ckpt_name"] = chip["checkpoint"]; n += 1
        elif ct == "ChipUNET":
            # 面板「UNET加载器」模式：注入 unet_name（连到 UNET加载器 的输入）
            if chip.get("unet"):
                ins["unet_name"] = chip["unet"]; n += 1
        elif ct == "ChipLoRA":
            # 面板 LoRA堆：按槽位注入（开关设 On + 名称 + 模型/CLIP强度）；槽位不够就停，多余的保持画布原值
            for i, lo in enumerate(chip.get("loras") or [], start=1):
                if f"lora_name_{i}" not in ins:
                    break
                ins[f"switch_{i}"] = "On"
                ins[f"lora_name_{i}"] = lo.get("name")
                ins[f"model_weight_{i}"] = lo.get("model_weight", 1.0)
                ins[f"clip_weight_{i}"] = lo.get("clip_weight", 1.0)
                n += 1
        elif ct == "ChipInputImage":
            b64 = chip.get("image_b64")
            if b64 and not ins.get("image_data"):
                ins["image_data"] = b64; n += 1
        elif ct == "ChipPrompt":
            # 提示词(联动)：一个节点同时注入 正向 / 负向
            if chip.get("positive") is not None:
                ins["positive"] = chip["positive"]; n += 1
            if chip.get("negative") is not None:
                ins["negative"] = chip["negative"]; n += 1
        elif ct == "ChipAll":
            # 全注入(联动)：一个节点吃下所有联动值
            if chip.get("positive") is not None:
                ins["positive"] = chip["positive"]; n += 1
            if chip.get("negative") is not None:
                ins["negative"] = chip["negative"]; n += 1
            if chip.get("seed") is not None:
                ins["seed"] = chip["seed"]; n += 1
            if chip.get("steps") is not None:
                ins["steps"] = chip["steps"]; n += 1
            if chip.get("cfg") is not None:
                ins["cfg"] = chip["cfg"]; n += 1
            if chip.get("width") is not None:
                ins["width"] = chip["width"]; n += 1
            if chip.get("height") is not None:
                ins["height"] = chip["height"]; n += 1
            if chip.get("checkpoint"):
                ins["ckpt_name"] = chip["checkpoint"]; n += 1
            if chip.get("unet"):
                # 面板「UNET加载器」模式：注入到全注入节点的 unet_name（UNET模型 输出口）
                ins["unet_name"] = chip["unet"]; n += 1
            if chip.get("image_b64"):
                ins["image_data"] = chip["image_b64"]; n += 1
            for i, lo in enumerate(chip.get("loras") or [], start=1):
                if f"lora_name_{i}" not in ins:
                    break
                ins[f"switch_{i}"] = "On"
                ins[f"lora_name_{i}"] = lo.get("name")
                ins[f"model_weight_{i}"] = lo.get("model_weight", 1.0)
                ins[f"clip_weight_{i}"] = lo.get("clip_weight", 1.0)
                n += 1
        elif ct == "ChipLatent":
            # 面板 宽/高 注入到 Latent(联动)，取代原「宽度/高度」两个 INT 节点
            if chip.get("width") is not None:
                ins["width"] = chip["width"]; n += 1
            if chip.get("height") is not None:
                ins["height"] = chip["height"]; n += 1
    return g, (n > 0)


def _inj_note(inj_chip):
    return "（已把提示词/参数注入联动小节点）" if inj_chip else ""


async def h_start(request):
    """运行工作流。优先级：实时历史 > 已存图纸（链接源/上传缓存/自动捕获）。
    这样搭好工作流、在 ComfyUI 点过一次 Queue 后，面板「开始」就能直接重跑，
    不必再进 ComfyUI 手动点；用「载入工作流」填路径/URL 时，每次开始都重新读取。"""
    try:
        body = await request.json() or {}
        chip = body.get("chip") or {}
        # 1) 实时历史里最近一次（永远是最新的那份）
        hist = await _api(request, "/history?max_items=1", timeout=5)
        if isinstance(hist, dict) and hist:
            last = list(hist.values())[0] or {}
            pr = last.get("prompt") or []
            if len(pr) >= 3 and isinstance(pr[2], dict):
                pr[2], inj_chip = _inject_chip(pr[2], chip)
                r = await _api(request, "/prompt", {"prompt": pr[2], "client_id": "chip_panel"}, timeout=15, check=True)
                ne = _fmt_node_errors((r or {}).get("node_errors"))
                if ne:
                    return _json({"ok": False, "msg": f"工作流有节点校验失败（相关输出会被忽略）：{ne}"})
                msg = "已提交工作流（用最近一次记录）" + _inj_note(inj_chip)
                return _json({"ok": True, "msg": msg, "prompt_id": (r or {}).get("prompt_id", "")})
        # 2) 回退到已存图纸（链接源重读到的可能是画布/UI 格式，必须先转 API，
        #    否则 /prompt 里混入 last_node_id 等非节点键，会触发其它插件
        #    on_prompt 钩子（Swwan/Inspire 等）遍历崩溃 → ComfyUI 500）
        wf = await _load_stored_workflow()
        if wf:
            if isinstance(wf, dict) and "prompt" in wf:
                g = wf["prompt"]
                extra = wf.get("extra_data")
            elif isinstance(wf, dict) and ("nodes" in wf or "last_node_id" in wf):
                g, _resolves = await _ui_to_api(request, wf)
                extra = None
            else:
                g = wf
                extra = None
            g, inj_chip = _inject_chip(g, chip)
            payload = {"prompt": g, "client_id": "chip_panel"}
            if extra:
                payload["extra_data"] = extra
            r = await _api(request, "/prompt", payload, timeout=15, check=True)
            ne = _fmt_node_errors((r or {}).get("node_errors"))
            if ne:
                return _json({"ok": False, "msg": f"工作流有节点校验失败（相关输出会被忽略）：{ne}"})
            msg = "已提交工作流（用已存图纸）" + _inj_note(inj_chip)
            return _json({"ok": True, "msg": msg, "prompt_id": (r or {}).get("prompt_id", "")})
        return _json({"ok": False, "msg": "没有可复用的工作流：先在 ComfyUI 点一次 Queue，或在面板「载入工作流」选一张 API 格式 .json / 填路径或 URL"})
    except Exception as e:
        return _json({"ok": False, "msg": f"启动失败：{e}"})


# ============ 读取 ComfyUI 当前画布并运行 ============
def _prune_broken_output_nodes(g):
    """移除「输出类节点但必需输入没接线」的节点（如没连图的预览节点）。
    它们不参与生成结果，留着只会让 /prompt 校验整张图失败。
    返回 (图, 移除说明列表)。被其它节点引用的一律不动。"""
    try:
        import nodes as _nodes
    except Exception:
        return g, []
    referenced = set()
    for n in g.values():
        if isinstance(n, dict):
            for v in (n.get("inputs") or {}).values():
                if isinstance(v, list) and len(v) == 2:
                    referenced.add(str(v[0]))
    removed = []
    for nid, n in list(g.items()):
        if not isinstance(n, dict) or str(nid) in referenced:
            continue
        cls = _nodes.NODE_CLASS_MAPPINGS.get(n.get("class_type"))
        if cls is None or not getattr(cls, "OUTPUT_NODE", False):
            continue
        try:
            req = (cls.INPUT_TYPES() or {}).get("required", {})
        except Exception:
            req = {}
        if any(k not in (n.get("inputs") or {}) for k in req):
            removed.append(f"{nid}({n.get('class_type')})")
            del g[nid]
    return g, removed


async def _pull_canvas():
    """让 ComfyUI 前端把当前画布推回桥：广播一条 ws 消息，前端扩展收到后
    POST /chip/canvas；这里等新推送到达（最多 5s）。返回是否等到。"""
    if _PROMPT_SERVER is None:
        return False
    try:
        # send_sync 签名是 (event, data, sid)：event 是字符串消息类型，
        # 前端 api.addEventListener("chip-canvas-request", ...) 按类型匹配
        _PROMPT_SERVER.send_sync("chip-canvas-request", {}, None)
    except Exception:
        pass
    ev = asyncio.Event()
    _CANVAS_WAITERS.append(ev)
    try:
        await asyncio.wait_for(ev.wait(), timeout=5.0)
        return True
    except asyncio.TimeoutError:
        return False
    finally:
        if ev in _CANVAS_WAITERS:
            _CANVAS_WAITERS.remove(ev)


async def h_canvas(request):
    """ComfyUI 前端扩展推回的当前画布（graphToPrompt 的 output/workflow）。"""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return _json({"ok": False, "msg": "请求体须为 JSON 对象"})
        g = body.get("prompt")
        if not isinstance(g, dict):
            return _json({"ok": False, "msg": "缺少 prompt 字段"})
        _CANVAS.clear()
        _CANVAS["prompt"] = g
        _CANVAS["workflow"] = body.get("workflow")
        _CANVAS["ts"] = time.time()
        try:
            _SHARED.mkdir(parents=True, exist_ok=True)
            (_SHARED / "canvas_last.json").write_text(
                json.dumps(_CANVAS["workflow"] or g, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
        for ev in _CANVAS_WAITERS:
            ev.set()
        return _json({"ok": True, "msg": "已接收当前画布"})
    except Exception as e:
        return _json({"ok": False, "msg": f"接收画布失败：{e}"})


async def h_queued(request):
    """ComfyUI 前端扩展用 api.queuePrompt 排队后的回执（成功/校验失败）。"""
    try:
        body = await request.json()
        if isinstance(body, dict):
            _SUBMIT_RESULT.clear()
            _SUBMIT_RESULT["body"] = body
        for ev in _QUEUE_WAITERS:
            ev.set()
        return _json({"ok": True})
    except Exception as e:
        return _json({"ok": False, "msg": str(e)})


async def _submit_via_frontend(prompt, workflow, timeout=8.0):
    """把注入好的图发回 ComfyUI 网页，由前端扩展调用 api.queuePrompt 排队——
    与用户手点「运行」同一条代码路径（带浏览器自己的 client_id 和 workflow
    extra_pnginfo），节点高亮/运行按钮状态/预览图/原生报错弹窗全部正常。
    返回回执 dict；前端扩展不在或超时返回 None（调用方回退直连提交）。"""
    if _PROMPT_SERVER is None:
        return None
    _SUBMIT_RESULT.clear()
    ev = asyncio.Event()
    _QUEUE_WAITERS.append(ev)
    try:
        _PROMPT_SERVER.send_sync("chip-canvas-submit",
                                 {"prompt": prompt, "workflow": workflow}, None)
        await asyncio.wait_for(ev.wait(), timeout=timeout)
        return _SUBMIT_RESULT.get("body")
    except asyncio.TimeoutError:
        return None
    except Exception:
        return None
    finally:
        if ev in _QUEUE_WAITERS:
            _QUEUE_WAITERS.remove(ev)


async def h_start_canvas(request):
    """读取「ComfyUI 当前界面」的工作流并运行：先拉取画布，再注入联动值，最后排队。"""
    try:
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        chip = body.get("chip") or {}
        got = await _pull_canvas()
        if not got or not _CANVAS.get("prompt"):
            return _json({"ok": False, "msg":
                "未能读取当前画布：请确认 ComfyUI 界面已打开、且联动桥 web 扩展已加载（需重启过 ComfyUI 让新扩展生效）"})
        g = _CANVAS["prompt"]
        g, pruned = _prune_broken_output_nodes(g)
        g, inj_chip = _inject_chip(g, chip)
        note = f"（自动移除了未接线的输出节点：{'、'.join(pruned)}）" if pruned else ""
        # 优先走浏览器通道：ComfyUI 网页自己排队（等价于用户点「运行」，
        # 节点高亮/运行按钮/预览图/原生校验弹窗全部正常）
        sub = await _submit_via_frontend(g, _CANVAS.get("workflow"))
        if isinstance(sub, dict):
            if sub.get("ok"):
                return _json({"ok": True, "msg": "已读取当前画布并提交" + note + _inj_note(inj_chip),
                              "prompt_id": str(sub.get("prompt_id") or "")})
            return _json({"ok": False, "msg": str(sub.get("msg") or "ComfyUI 排队失败")})
        # 回退：前端扩展不在（旧页面没刷新），桥直接提交
        payload = {"prompt": g, "client_id": "chip_panel"}
        r = await _api(request, "/prompt", payload, timeout=15, check=True)
        ne = _fmt_node_errors((r or {}).get("node_errors"))
        if ne:
            return _json({"ok": False, "msg": f"工作流有节点校验失败：{ne}"})
        return _json({"ok": True, "msg": "已读取当前画布并提交" + note + _inj_note(inj_chip),
                      "prompt_id": (r or {}).get("prompt_id", "")})
    except Exception as e:
        return _json({"ok": False, "msg": f"启动失败：{e}"})


async def h_set_workflow(request):
    """载入工作流，支持三种来源 + remap 替换：
    - {"path": "..."}      ComfyUI 那台机器上的绝对路径（即远程/局域网电脑的工作流位置）
    - {"url": "..."}       http(s):// 地址，可填局域网 IP，例如 http://192.168.1.50:8189/xxx.json
    - 直接上传的 JSON（文件选择器读来的内容，含 prompt/nodes 字段）
    - {"remap": {"旧文件名": "新文件名", ...}}  用户确认后的缺失资源替换
    前两者（无 remap 时）会记录为「链接源」，之后每次「开始」都重新读取，源文件改了
    也能立刻用上；带 remap 则写定为已解析图纸。所有替换都在桥内部完成，不动原 .json。"""
    try:
        body = await request.json()
        if not isinstance(body, dict):
            return _json({"ok": False, "msg": "请求体须为 JSON 对象"})
        _SHARED.mkdir(parents=True, exist_ok=True)   # shared/ 可能尚不存在（Errno 2 的根因）
        remap = body.get("remap")
        if remap and not isinstance(remap, dict):
            remap = {}
        try:
            g, resolves = await _to_api(request, body, resolve=True, remap=remap)
        except Exception as e:
            return _json({"ok": False, "msg": f"解析工作流失败：{e}"})
        # 链接源保留（仅当无 remap，且来自 path/url）：每次「开始」重新读取
        if not remap and (body.get("path") or body.get("url")):
            src = {"kind": "path" if body.get("path") else "url",
                   "value": body.get("path") or body.get("url")}
            _SRC.write_text(json.dumps(src, ensure_ascii=False), encoding="utf-8")
            _UP.write_text(json.dumps({"prompt": g}, ensure_ascii=False), encoding="utf-8")
            note = "已链接（" + ("路径" if body.get("path") else "URL") + "，每次开始都重新读取）"
            return _json({"ok": True, "msg": note, "api_format": True})
        # 其余：写定为已解析图纸
        _UP.write_text(json.dumps({"prompt": g}, ensure_ascii=False), encoding="utf-8")
        if _SRC.exists():
            _SRC.unlink()
        note = "已载入（开始即可运行）"
        if resolves:
            tail = "、".join(f"{c}.{n}:{o}→{nv}" for c, n, o, nv in resolves[:4])
            note += f"（已自动把缺失的模型/LoRA 按文件名匹配到真实文件：{tail}）"
        if remap:
            tail2 = "、".join(f"{k}→{v}" for k, v in list(remap.items())[:4])
            note += f"（已按你的选择替换：{tail2}）"
        return _json({"ok": True, "msg": note, "api_format": True})
    except Exception as e:
        return _json({"ok": False, "msg": f"载入失败：{e}"})


async def h_workflows(request):
    """列出 ComfyUI 用户工作流库里的 .json（user/default/workflows 等目录），
    返回 {name: 库内相对路径, path: 绝对路径}，供面板下拉直接选中载入。"""
    try:
        import folder_paths
        try:
            user_dir = Path(folder_paths.get_user_directory())
        except Exception:
            user_dir = Path("user")
        roots = [user_dir / "default" / "workflows", user_dir / "workflows"]
        out, seen = [], set()
        for root in roots:
            if not root.is_dir() or root.resolve() in seen:
                continue
            seen.add(root.resolve())
            for p in sorted(root.rglob("*.json")):
                try:
                    out.append({"name": str(p.relative_to(root)).replace("\\", "/"),
                                "path": str(p.resolve())})
                except Exception:
                    continue
        out.sort(key=lambda x: x["name"].lower())
        return _json({"ok": True, "workflows": out, "count": len(out)})
    except Exception as e:
        return _json({"ok": False, "workflows": [], "msg": f"读取工作流列表失败：{e}"})


async def h_get_workflow(request):
    src = None
    if _SRC.exists():
        try:
            d = json.loads(_SRC.read_text(encoding="utf-8"))
            src = f"{d.get('kind')}: {d.get('value')}"
        except Exception:
            pass
    up = _UP.exists()
    cap = _WF.exists()
    msg = ("已链接：" + src) if src else (("已载入面板工作流" if up else ("已捕获 ComfyUI 工作流" if cap else "尚未载入")))
    return _json({"ok": True, "uploaded": up, "captured": cap, "src": src, "msg": msg})


async def h_stop(request):
    try:
        await _api(request, "/interrupt", {}, timeout=5)
        return _json({"ok": True, "msg": "已发送中断"})
    except Exception as e:
        return _json({"ok": False, "msg": f"中断失败：{e}"})


async def h_upload(request):
    """接收主程序插件送来的图片：写成共享 input.png（供 remap / 共享图片机制使用）。"""
    try:
        body = await request.json()
        data = body.get("data") or body.get("b64") or ""
        if "," in data:
            data = data.split(",", 1)[1]
        raw = base64.b64decode(data)
        if not raw:
            return _json({"ok": False, "msg": "没有收到图片数据"})
        from PIL import Image
        im = Image.open(BytesIO(raw)).convert("RGB")
        _SHARED.mkdir(parents=True, exist_ok=True)
        buf = BytesIO()
        im.save(buf, "PNG")
        (_SHARED / "input.png").write_bytes(buf.getvalue())
        meta = {"name": body.get("name") or "image.png", "ts": int(time.time()), "size": list(im.size)}
        (_SHARED / "input.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        return _json({"ok": True, "name": meta["name"], "path": str(_SHARED / "input.png"),
                      "meta": meta})
    except Exception as e:
        return _json({"ok": False, "msg": f"写入输入图失败：{e}"})


async def h_images(request):
    """读取最近生成的图片，返回 base64（只传内存，不在主程序落盘）"""
    try:
        hist = await _api(request, "/history?max_items=8", timeout=6)
        out = []
        seen = set()
        if isinstance(hist, dict):
            for pid, item in hist.items():
                if not isinstance(item, dict):
                    continue
                # 一次生成可能同时有「保存图像」和「生成图返回(联动)」两个输出节点，
                # 内容是同一批图。优先只取专用通道 chip_output_*（面板显示、不落盘），
                # 没有才回退其它输出节点，避免同一张图显示多份。
                chip_imgs, other_imgs = [], []
                for node in (item.get("outputs") or {}).values():
                    if not isinstance(node, dict):
                        continue
                    for img in node.get("images", []) or []:
                        if not isinstance(img, dict) or not img.get("filename"):
                            continue
                        (chip_imgs if str(img.get("filename", "")).startswith("chip_output_")
                         else other_imgs).append(img)
                for img in (chip_imgs or other_imgs):
                    key = (img.get("filename"), img.get("subfolder"), img.get("type"))
                    if key in seen:
                        continue
                    seen.add(key)
                    from urllib.parse import urlencode
                    q = urlencode({
                        "filename": img.get("filename", ""),
                        "subfolder": img.get("subfolder", ""),
                        "type": img.get("type", "output"),
                    })
                    try:
                        raw = await _api(request, "/view?" + q, want_bytes=True, timeout=10)
                        if not raw:
                            continue
                        fn = str(img.get("filename") or "image.png")
                        mime = "image/png" if fn.lower().endswith(".png") else "image/jpeg"
                        out.append({
                            "id": f"{pid}-{fn}",
                            "name": fn,
                            "b64": f"data:{mime};base64," + base64.b64encode(raw).decode(),
                            "ts": int(time.time()),
                        })
                    except Exception:
                        continue
                if len(out) >= 24:
                    break
        return _json({"ok": True, "images": out[:24]})
    except Exception as e:
        return _json({"ok": False, "images": [], "msg": f"读取输出图失败：{e}"})


def register():
    """注册路由（幂等）。ComfyUI 的 PromptServer.instance.routes 是标准扩展点。

    关键适配：ComfyUI 自带 origin_only 中间件（server.py），对 Host 与 Origin
    端口不一致的跨源请求直接 403 —— 浏览器跨源 fetch 必带 Origin 头，所以
    /chip/* 路由函数根本没执行就被拦（这就是主程序一直 Failed to fetch 的根因）。
    修法：把该中间件包一层，/chip/* 请求跳过 origin 检查直接放行到路由，
    其余路径仍走原中间件，不动 ComfyUI 其它路由的安全行为。
    """
    global _registered
    if _registered:
        return
    from server import PromptServer
    from aiohttp import web

    routes = PromptServer.instance.routes
    global _PROMPT_SERVER
    _PROMPT_SERVER = PromptServer.instance
    # 静态路由优先于通配 OPTIONS，aiohttp 资源名需唯一
    routes.options("/chip/{tail:.*}")(h_options)
    routes.get("/chip/ping")(h_ping)
    routes.get("/chip/status")(h_status)
    routes.get("/chip/options")(h_options)
    routes.post("/chip/start")(h_start)
    routes.post("/chip/stop")(h_stop)
    routes.post("/chip/upload")(h_upload)
    routes.get("/chip/images")(h_images)
    routes.get("/chip/workflow")(h_get_workflow)
    routes.get("/chip/workflows")(h_workflows)
    routes.post("/chip/workflow")(h_set_workflow)
    routes.post("/chip/workflow/check")(h_check)
    routes.post("/chip/canvas")(h_canvas)
    routes.post("/chip/queued")(h_queued)
    routes.post("/chip/start_canvas")(h_start_canvas)

    # 自动捕获工作流：包装 PromptServer 的 /prompt 处理器，在 ComfyUI 每次
    # Queue 时把完整 API 格式图纸存到 shared/workflow.json。这样用户在 ComfyUI
    # 点过一次 Queue 后，面板「开始」即可直接重跑，不必再进 ComfyUI。
    try:
        svr = PromptServer.instance
        if hasattr(svr, "prompt") and callable(svr.prompt):
            _orig_prompt = svr.prompt

            async def _capture_prompt(self, request):
                try:
                    data = await request.json()
                    _SHARED.mkdir(parents=True, exist_ok=True)
                    _WF.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                except Exception:
                    pass
                finally:
                    # 还原请求体，供原函数再次读取
                    try:
                        request._read_bytes = json.dumps(data).encode("utf-8")
                    except Exception:
                        pass
                return await _orig_prompt(self, request)

            svr.prompt = _capture_prompt.__get__(svr, type(svr))
            print("[chip-prompt-tool 联动桥] 已挂接 /prompt 图纸自动捕获")
    except Exception as e:
        print(f"[chip-prompt-tool 联动桥] 图纸捕获挂接失败（不影响其它功能）：{e!r}")

    # 包一层 origin_only 中间件。节点导入发生在 aiohttp app 冻结之前
    # （AppRunner 在 server.start 阶段才创建），所以直接改冻结前的
    # app._middlewares 列表：把 origin_only 原地替换成包装版——
    # /chip/* 跳过 origin 检查放行到路由，其余路径仍走原检查逻辑。
    try:
        app = PromptServer.instance.app

        def _wrap_origin_only(orig):
            async def _chip_passthrough(request, handler):
                if request.path.startswith("/chip/"):
                    return await handler(request)      # 放行到 /chip/* 路由
                return await orig(request, handler)    # 其余照旧
            _chip_passthrough.__middleware_version__ = 1
            return _chip_passthrough

        patched = False
        mws = app._middlewares
        for i, m in enumerate(list(mws)):
            if getattr(m, "__name__", "") == "origin_only_middleware":
                mws[i] = _wrap_origin_only(m)          # FrozenList 冻结前可写
                patched = True
                break
        if not patched:
            # 兜底：app 已冻结（异常时序）才走这里
            handlers = app._middlewares_handlers
            if handlers:
                new_handlers, done = [], False
                for m, new_style in tuple(handlers):
                    if not done and getattr(m, "__name__", "") == "origin_only_middleware":
                        async def _chip_passthrough(request, handler, _orig=m):
                            if request.path.startswith("/chip/"):
                                return await handler(request)
                            return await _orig(request, handler)
                        _chip_passthrough.__middleware_version__ = 1
                        new_handlers.append((_chip_passthrough, new_style))
                        done = True
                    else:
                        new_handlers.append((m, new_style))
                app._middlewares_handlers = tuple(new_handlers)
                from aiohttp import web_app as _web_app
                _web_app._cached_build_middleware.cache_clear()
                patched = done
        if not patched:
            print("[chip-prompt-tool 联动桥] 未找到 origin_only 中间件"
                  "（若已用 --enable-cors-header 启动则无需适配）")
    except Exception as e:
        print(f"[chip-prompt-tool 联动桥] 跨源适配失败（不影响节点本体）：{e!r}")

    _registered = True
    print("[chip-prompt-tool 联动桥] /chip/* 路由已注册（带 CORS + 跨源放行适配）")
