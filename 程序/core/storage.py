"""本地 JSON 存储：设置 / 标签库 / 收藏标签 / 历史 / 模板 / 打标进度 / 打标库索引"""
import json
import sys
from pathlib import Path

if getattr(sys, "frozen", False):
    # 打包后：数据放 exe 旁边，绝不能写临时解压目录（否则每次运行都丢）
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(parents=True, exist_ok=True)

DEFAULT_SETTINGS = {
    "default_api": "alibaba_free",   # 首次启动用内置免费接口
    "separator": ", ",
    "theme": "dark",
    "last_folder": "",
    "last_image": "",
    "disp_cap": "both",     # 打标框标词显示：both/zh/en
    "disp_lib": "both",     # 标签库
    "disp_repo": "both",    # 打标库
    "thumb_auto_clean": 30,  # 启动时自动清理生成超过 N 天的缩略图缓存（0 = 从不）
    "thumb_mem_cache": True, # 会话内缓存已编码的缩略图，避免重复 base64
    "tag_color_mode": "off",  # 标签染色：off / category（同分类同色）/ individual（每标签独立）
    "lazy_render": True,      # 海量卡片懒渲染（content-visibility）：标签/打标网格只渲染视口内卡片
    "no_anim": False,         # 关闭界面动画：body.no-anim 全局禁用 animation/transition，卡片直接显现
}


def _load(name, default):
    p = DATA / name
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return default
    return default


def save_json(name, obj):
    """写 data\\<name>（对外接口，供各模块落盘共享数据）"""
    _save(name, obj)


def _save(name, obj):
    """写 data\\<name>。Windows 上文件可能被杀软/同步工具瞬时独占，
    直接 write_text 会抛 PermissionError 并弹到用户界面，这里短重试兜底。"""
    import time
    text = json.dumps(obj, ensure_ascii=False, indent=2)
    p = DATA / name
    last = None
    for i in range(6):
        try:
            p.write_text(text, encoding="utf-8")
            return
        except PermissionError as e:
            last = e
            time.sleep(0.05 * (i + 1))
    raise last


# ---------- 设置 ----------
def get_settings():
    s = DEFAULT_SETTINGS.copy()
    s.update(_load("settings.json", {}))
    return s


def save_settings(patch):
    cur = get_settings()
    cur.update(patch or {})
    _save("settings.json", cur)
    return cur


# ---------- 标签库 ----------
def get_tags():
    return _load("tags.json", [])


def save_tags(tags):
    _save("tags.json", tags)


# ---------- 收藏标签 ----------
def get_favorites():
    """收藏标签快照列表：[[en, zh, [图片相对路径...], 颜色], ...]"""
    return _load("收藏标签.json", [])


def save_favorites(items):
    _save("收藏标签.json", items)


# ---------- 历史 / 模板 ----------
def get_history():
    return _load("history.json", [])


def save_history(items):
    _save("history.json", items)


def get_templates():
    return _load("templates.json", [])


def save_templates(items):
    _save("templates.json", items)


# ---------- 打标 ----------
def get_progress():
    """{图片完整路径: {"tags":[{en,zh,w}], "trigger":""}}"""
    return _load("打标进度.json", {})


def save_progress(progress):
    _save("打标进度.json", progress)


def get_repo_index():
    """打标库通用存储索引"""
    return _load("打标库索引.json", [])


def save_repo_index(items):
    _save("打标库索引.json", items)


def get_repo_folders():
    """打标库用户自建文件夹列表（纯字符串）"""
    return _load("打标库文件夹.json", [])


def save_repo_folders(items):
    _save("打标库文件夹.json", items)


def repo_images_dir():
    d = DATA / "打标库"
    d.mkdir(parents=True, exist_ok=True)
    return d


def thumb_cache_dir():
    d = DATA / "缩略图缓存"
    d.mkdir(parents=True, exist_ok=True)
    return d
