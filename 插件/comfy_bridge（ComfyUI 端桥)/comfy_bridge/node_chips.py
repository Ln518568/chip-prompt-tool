"""chip-prompt-tool 联动节点包（节点原生接入工作流）。

一套「联动」小节点，作为主程序面板与 ComfyUI 之间的数据桥梁（每个节点只管一件事，
输出连到标准节点对应控件，最小化对原工作流的改动）：
- 提示词(联动)：一个节点输出 正向/负向 两条 STRING（取代原来的两个独立提示词节点），值由面板注入
- 种子、步数、CFG：纯注入节点（无控件，值由面板注入）
- 全注入(联动)：一个节点同时输出 正向/负向提示词、种子、步数、CFG、Latent、模型、LoRA堆、图像、UNET模型（取代上面分散的节点；原各节点仍保留）
- Latent(联动)：由面板注入 宽/高，输出 ComfyUI 通用 LATENT（与标准「空Latent」同类型同格式）
- ChipCheckpoint 大模型选择：下拉真实模型，输出 ckpt_name（连到加载器模型控件）
- ChipLoRA LoRA堆(联动)：无控件，把面板多选的 LoRA 打包成堆（LORA_STACK 输出，格式同 Comfyroll 的 CR LoRA Stack）；
  可选输入「lora_stack」可接另一个堆（堆串堆），也能直接接 Comfyroll 的堆
- ChipApplyLoRA 应用LoRA堆(联动)：接 模型/CLIP + 任意 LoRA堆（本包或 Comfyroll 的），按顺序叠加后输出 模型/CLIP
- ChipInputImage 图像输入：输出 IMAGE，由面板把选中的图注入（hidden 输入，节点上无控件）
- ChipOutputImage 生成图返回：把工作流最后的 IMAGE 写临时目录（不落盘），供面板取回显示
"""

CATEGORY = "chip-prompt-tool/联动"


def _filename_list(kind):
    """ComfyUI 扫描到的真实文件列表（模型/LoRA），用于下拉；失败返回 []。"""
    try:
        from folder_paths import get_filename_list
        return list(get_filename_list(kind))
    except Exception:
        return []


def _make_bridge(name, key, out_type, desc, out_label=None):
    """生成「纯注入」小节点：无控件，值由面板在「开始」时经 hidden 输入注入。
    每个节点只输出一个值，独立接到标准节点对应控件上。
    out_label：输出口旁的中文显示名（RETURN_NAMES，纯显示，不影响连线类型）。"""
    class _Bridge:
        @classmethod
        def INPUT_TYPES(cls):
            return {"required": {},
                    "hidden": {key: (out_type, {"multiline": out_type == "STRING"})}}

        RETURN_TYPES = (out_type,)
        RETURN_NAMES = (out_label or key,)
        FUNCTION = "run"
        CATEGORY = CATEGORY

        def run(self, **kw):
            v = kw.get(key)
            if v is None:
                v = "" if out_type == "STRING" else (0 if out_type == "INT" else 0.0)
            return (v,)

    _Bridge.__name__ = name
    _Bridge.__doc__ = desc
    return _Bridge


class ChipPrompt:
    """提示词(联动)：一个节点同时输出 正向 / 负向 两条 STRING，分别连到
    正 / 负 CLIP文本编码 的 text。值由面板在「开始」时注入（hidden 输入）。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {},
                "hidden": {"positive": ("STRING", {"multiline": True}),
                           "negative": ("STRING", {"multiline": True})}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("正向提示词", "负向提示词")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, positive="", negative=""):
        return (positive or "", negative or "")


ChipSeed = _make_bridge("ChipSeed", "seed", "INT",
                        "种子：值由面板注入，输出连 KSampler 的 seed。",
                        out_label="种子")
ChipSteps = _make_bridge("ChipSteps", "steps", "INT",
                         "步数：值由面板注入，输出连 KSampler 的 steps。",
                         out_label="步数")
ChipCFG = _make_bridge("ChipCFG", "cfg", "FLOAT",
                       "CFG：值由面板注入，输出连 KSampler 的 cfg。",
                       out_label="CFG")


class ChipLatent:
    """Latent(联动)：无控件，由面板在「开始」时注入 宽/高，输出 ComfyUI 通用 LATENT
    （与标准「空Latent」同类型、同数据格式，可直连 KSampler 的 latent_image 或任何吃
    Latent 的节点）。面板没填宽高时默认 512×512；宽高自动向下对齐到 8 的倍数。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {},
                "hidden": {"width": ("INT",), "height": ("INT",)}}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("Latent",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, width=512, height=512):
        import torch
        w = int(width) or 512
        h = int(height) or 512
        if w % 8:  # 必须 8 的倍数（VAE 下采样），否则 ComfyUI 报尺寸错
            w = max(8, (w // 8) * 8)
        if h % 8:
            h = max(8, (h // 8) * 8)
        latent = torch.zeros([1, 4, h // 8, w // 8])
        return ({"samples": latent},)


class ChipOutputImage:
    """生成图返回：把工作流最后的 IMAGE 接进来，写进 ComfyUI 临时目录（不落盘到输出），
    历史记录里就会带上 images，桥的 /chip/images 据此把生成图取回主程序面板显示。
    （工作流里已有「保存图像」节点的话，不加这个也能显示。）"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",)}}

    RETURN_TYPES = ()
    FUNCTION = "out"
    OUTPUT_NODE = True
    CATEGORY = CATEGORY

    def out(self, images):
        import os
        import numpy as np
        from PIL import Image
        import folder_paths

        output_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        results = []
        for batch_number, image in enumerate(images):
            arr = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            filename = f"chip_output_{batch_number:05d}_.png"
            img.save(os.path.join(output_dir, filename), compress_level=1)
            results.append({"filename": filename, "subfolder": "", "type": "temp"})
        return {"ui": {"images": results}, "result": ()}


_LORA_SLOTS = 8  # LoRA 堆槽位数；想更多直接改这个数字（面板多选也能加对应数量）


def _make_model_chip(name, key, folder_kind, out_label, desc):
    """生成「模型选择(联动)」节点工厂：下拉 ComfyUI 真实扫描列表，输出该值。
    输出类型必须用「真实候选列表」而不是 "COMBO" 字符串：这版 ComfyUI 的
    validate_node_input 把目标输入的候选列表原样与来源输出类型比较，
    "COMBO" != 列表 会误判 Return type mismatch。列表相等（同源扫描）即通过。"""
    class _Chip:
        @classmethod
        def INPUT_TYPES(cls):
            return {"required": {key: (_filename_list(folder_kind),)}}

        RETURN_TYPES = (_filename_list(folder_kind),)
        RETURN_NAMES = (out_label,)
        FUNCTION = "run"
        CATEGORY = CATEGORY

        def run(self, **kw):
            return (kw.get(key) or "",)

    _Chip.__name__ = name
    _Chip.__doc__ = desc
    return _Chip


ChipCheckpoint = _make_model_chip(
    "ChipCheckpoint", "ckpt_name", "checkpoints", "模型",
    "大模型选择：下拉是 ComfyUI 真实扫描到的 Checkpoint；输出 ckpt_name（连到加载器的"
    "模型 控件）。连法：右键加载器的 模型 控件「转换为输入」（或把线拖到控件文字上"
    "自动转），再连过来——原工作流零改动。面板选的模型会覆盖节点上的值。")

ChipUNET = _make_model_chip(
    "ChipUNET", "unet_name", "diffusion_models", "UNET模型",
    "UNET选择：下拉是 ComfyUI 真实扫描到的 diffusion_models（UNET/diffusion 加载器的"
    "候选）；输出 unet_name（连到 UNET加载器 的 unet_name 输入）。连法与 大模型选择 相同："
    "把加载器的 UNET名称 控件「转换为输入」后连过来。面板选的值会覆盖节点上的值。"
    "注意：UNET加载器通常还要接一个 CLIP加载器（clip_name 不在本节点管理范围）。")


class ChipLoRA:
    """LoRA堆(联动)：无控件，把面板多选的 LoRA 打包成一个「堆」输出（LORA_STACK 类型，
    条目格式与 Comfyroll 的 CR LoRA Stack 一致：{lora_name, strength_model, strength_clip}）。
    可选输入 lora_stack 可接另一个堆（堆串堆），也可直接接 Comfyroll 的堆；
    输出可接 Comfyroll「应用LoRA堆」或本包「应用LoRA堆(联动)」。槽位值全部由面板注入。"""
    @classmethod
    def INPUT_TYPES(cls):
        hidden = {}
        for i in range(1, _LORA_SLOTS + 1):
            hidden["switch_%d" % i] = ("STRING",)
            hidden["lora_name_%d" % i] = ("STRING",)
            hidden["model_weight_%d" % i] = ("FLOAT",)
            hidden["clip_weight_%d" % i] = ("FLOAT",)
        return {"required": {},
                "optional": {"lora_stack": ("LORA_STACK",)},
                "hidden": hidden}

    RETURN_TYPES = ("LORA_STACK",)
    RETURN_NAMES = ("LoRA堆",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, **kw):
        stack = list(kw.get("lora_stack") or [])
        for i in range(1, _LORA_SLOTS + 1):
            if kw.get("switch_%d" % i) != "On":
                continue
            name = kw.get("lora_name_%d" % i)
            if not name:
                continue
            stack.append({
                "lora_name": name,
                "strength_model": float(kw.get("model_weight_%d" % i) or 1.0),
                "strength_clip": float(kw.get("clip_weight_%d" % i) or 1.0),
            })
        return (stack,)


class ChipApplyLoRA:
    """应用LoRA堆(联动)：接 模型/CLIP + 一个 LoRA堆（本包「LoRA堆(联动)」或 Comfyroll
    「CR LoRA Stack」的输出都行），按顺序把堆里所有 LoRA 叠加到模型上，输出 模型/CLIP。
    堆为空（没接或空堆）时原样透传。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "clip": ("CLIP",)},
                "optional": {"lora_stack": ("LORA_STACK",)}}

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "apply"
    CATEGORY = CATEGORY

    def apply(self, model, clip, lora_stack=None):
        import folder_paths, comfy.sd
        m, c = model, clip
        for entry in (lora_stack or []):
            if not isinstance(entry, dict):
                continue
            name = entry.get("lora_name")
            if not name:
                continue
            path = folder_paths.get_full_path("loras", name)
            if not path:
                raise ValueError(f"应用LoRA堆(联动)：找不到 LoRA 文件：{name}")
            m, c = comfy.sd.load_lora_for_models(
                m, c, path,
                float(entry.get("strength_model", 1.0)),
                float(entry.get("strength_clip", 1.0)))
        return (m, c)


class ChipInputImage:
    """图像输入：输出 IMAGE。base64 由主程序面板注入（hidden 输入），节点上无控件。"""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "hidden": {"image_data": ("STRING", {"multiline": True})}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图像",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, image_data=""):
        import io
        import base64
        import torch
        import numpy as np
        from PIL import Image
        if not image_data:
            return (torch.zeros((1, 64, 64, 3)),)
        try:
            b64 = image_data.split(",", 1)[-1] if "," in image_data else image_data
            raw = base64.b64decode(b64)
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            arr = np.array(img).astype(np.float32) / 255.0
            return (torch.from_numpy(arr)[None,],)
        except Exception:
            return (torch.zeros((1, 64, 64, 3)),)


class ChipAll:
    """全注入(联动)：一个节点输出全部联动值（正向/负向提示词、种子、步数、CFG、Latent、
    模型、LoRA堆、图像、UNET模型），取代分散的多个联动节点；原各联动节点保留。
    值由面板在「开始」时注入，没填的走兜底（Latent 默认 512×512、图像 64×64 占位）。
    模型下拉是 ComfyUI 真实列表；2026-11-15 追加 unet_name（diffusion_models）下拉，
    两个模型输出口「Checkpoint模型」「UNET模型」排在输出列表最上面（按用户要求；
    注意：输出口顺序变更会使旧工作流里原有的连线错位，需重连一次）。"""
    @classmethod
    def INPUT_TYPES(cls):
        hidden = {}
        for i in range(1, _LORA_SLOTS + 1):
            hidden["switch_%d" % i] = ("STRING",)
            hidden["lora_name_%d" % i] = ("STRING",)
            hidden["model_weight_%d" % i] = ("FLOAT",)
            hidden["clip_weight_%d" % i] = ("FLOAT",)
        hidden["positive"] = ("STRING", {"multiline": True})
        hidden["negative"] = ("STRING", {"multiline": True})
        hidden["seed"] = ("INT",)
        hidden["steps"] = ("INT",)
        hidden["cfg"] = ("FLOAT",)
        hidden["width"] = ("INT",)
        hidden["height"] = ("INT",)
        hidden["image_data"] = ("STRING", {"multiline": True})
        return {
            "required": {"ckpt_name": (_filename_list("checkpoints"),),
                         "unet_name": (_filename_list("diffusion_models"),)},
            "optional": {"lora_stack": ("LORA_STACK",)},
            "hidden": hidden,
        }

    RETURN_TYPES = (tuple(_filename_list("checkpoints")),
                    tuple(_filename_list("diffusion_models")),
                    "STRING", "STRING", "INT", "INT", "FLOAT", "LATENT",
                    "LORA_STACK", "IMAGE")
    RETURN_NAMES = ("Checkpoint模型", "UNET模型", "正向提示词", "负向提示词",
                    "种子", "步数", "CFG", "Latent", "LoRA堆", "图像")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, ckpt_name="", unet_name="", lora_stack=None, image_data="", **kw):
        import io
        import base64
        import torch
        import numpy as np
        from PIL import Image

        positive = kw.get("positive") or ""
        negative = kw.get("negative") or ""
        seed = kw.get("seed") or 0
        steps = kw.get("steps") or 0
        cfg = kw.get("cfg") or 0.0

        w = int(kw.get("width") or 512) or 512
        h = int(kw.get("height") or 512) or 512
        if w % 8:
            w = max(8, (w // 8) * 8)
        if h % 8:
            h = max(8, (h // 8) * 8)
        latent = torch.zeros([1, 4, h // 8, w // 8])

        stack = list(lora_stack or [])
        for i in range(1, _LORA_SLOTS + 1):
            if kw.get("switch_%d" % i) != "On":
                continue
            name = kw.get("lora_name_%d" % i)
            if not name:
                continue
            stack.append({
                "lora_name": name,
                "strength_model": float(kw.get("model_weight_%d" % i) or 1.0),
                "strength_clip": float(kw.get("clip_weight_%d" % i) or 1.0),
            })

        if image_data:
            try:
                b64 = image_data.split(",", 1)[-1] if "," in image_data else image_data
                raw = base64.b64decode(b64)
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                arr = np.array(img).astype(np.float32) / 255.0
                image = torch.from_numpy(arr)[None,]
            except Exception:
                image = torch.zeros((1, 64, 64, 3))
        else:
            image = torch.zeros((1, 64, 64, 3))

        return (ckpt_name, unet_name, positive, negative, seed, steps, cfg,
                {"samples": latent}, stack, image)


NODE_CLASS_MAPPINGS = {
    "ChipAll": ChipAll,
    "ChipPrompt": ChipPrompt,
    "ChipSeed": ChipSeed,
    "ChipSteps": ChipSteps,
    "ChipCFG": ChipCFG,
    "ChipLatent": ChipLatent,
    "ChipCheckpoint": ChipCheckpoint,
    "ChipUNET": ChipUNET,
    "ChipLoRA": ChipLoRA,
    "ChipApplyLoRA": ChipApplyLoRA,
    "ChipInputImage": ChipInputImage,
    "ChipOutputImage": ChipOutputImage,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ChipAll": "全注入(联动)",
    "ChipPrompt": "提示词(联动)",
    "ChipSeed": "种子(联动)",
    "ChipSteps": "步数(联动)",
    "ChipCFG": "CFG(联动)",
    "ChipLatent": "Latent(联动)",
    "ChipCheckpoint": "大模型选择(联动)",
    "ChipUNET": "UNET选择(联动)",
    "ChipLoRA": "LoRA堆(联动)",
    "ChipApplyLoRA": "应用LoRA堆(联动)",
    "ChipInputImage": "图像输入(联动)",
    "ChipOutputImage": "生成图返回(联动)",
}
