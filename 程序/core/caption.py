"""打标模式核心：目录扫描 / 标签解析与读写 / 统一导出 / 缩略图"""
import base64
import hashlib
import re
from io import BytesIO
from pathlib import Path

from PIL import Image

from . import storage

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}
TAG_RE = re.compile(r"^\(?\s*(.+?)\s*(?::\s*([\d.]+))?\s*\)?$")


def list_images(folder):
    """列出文件夹里的图片（仅本层）：[{path, name}]"""
    if not folder:
        return []
    p = Path(folder)
    if not p.is_dir():
        return []
    return [
        {"path": str(f), "name": f.name}
        for f in sorted(p.iterdir())
        if f.is_file() and f.suffix.lower() in IMAGE_EXT and not f.name.startswith(".")
    ]


def list_images_recursive(folder, limit=3000):
    """列出文件夹及其所有子文件夹里的图片（递归）：[{path, name}]，最多 limit 张"""
    if not folder:
        return []
    p = Path(folder)
    if not p.is_dir():
        return []
    out = []
    for f in sorted(p.rglob("*")):
        if not f.is_file() or f.suffix.lower() not in IMAGE_EXT or f.name.startswith("."):
            continue
        out.append({"path": str(f), "name": f.name})
        if len(out) >= limit:
            break
    return out


def caption_file(img_path):
    return str(Path(img_path).with_suffix(".txt"))


def parse_text(text, zhmap=None):
    """逗号分隔文本 → [{en, zh, w}]，支持 (tag:1.2)"""
    zhmap = zhmap or {}
    out = []
    for part in str(text or "").replace("\n", " ").split(","):
        part = part.strip()
        if not part:
            continue
        m = TAG_RE.match(part)
        if not m:
            continue
        en = m.group(1).strip()
        try:
            w = float(m.group(2)) if m.group(2) else 1.0
        except ValueError:
            w = 1.0
        out.append({"en": en, "zh": zhmap.get(en, ""), "w": w})
    return out


def to_text(tags, sep=", "):
    """[{en,zh,w}] → 英文逗号串（权重≠1 时输出 (tag:1.2)）"""
    parts = []
    for t in tags or []:
        en = str(t.get("en", "")).strip()
        if not en:
            continue
        try:
            w = float(t.get("w", 1) or 1)
        except (TypeError, ValueError):
            w = 1.0
        parts.append(f"({en}:{w:.1f})" if abs(w - 1) > 1e-6 else en)
    return sep.join(parts)


def read_caption(img_path, zhmap=None):
    """读图片同名 txt；没有则读暂存进度"""
    f = Path(caption_file(img_path))
    if f.exists():
        try:
            return parse_text(f.read_text(encoding="utf-8"), zhmap)
        except Exception:
            return []
    prog = storage.get_progress()
    item = prog.get(str(img_path)) or {}
    return item.get("tags") or []


def write_caption(img_path, tags, sep=", "):
    Path(caption_file(img_path)).write_text(to_text(tags, sep), encoding="utf-8")


def _entry_tags(item):
    """一条打标记录 → 待写入的标签（触发词排第一）"""
    tags = [dict(t) for t in ((item or {}).get("tags") or [])]
    trig = str((item or {}).get("trigger") or "").strip()
    if trig and not any(t.get("en") == trig for t in tags):
        tags.insert(0, {"en": trig, "zh": "触发词", "w": 1})
    return tags


def export_check(progress):
    """导出前检查：会写几个、其中几个是**已存在的同名 .txt**（供前端询问是否覆盖）"""
    import os
    total = 0
    existing = 0
    folders = []
    for path, item in (progress or {}).items():
        tags = _entry_tags(item)
        if not tags:
            continue
        total += 1
        if os.path.isfile(caption_file(path)):
            existing += 1
        d = os.path.dirname(str(path))
        if d and d not in folders:
            folders.append(d)
    return {"total": total, "existing": existing, "folders": folders}


def export_all(progress, sep=", ", mode="overwrite"):
    """统一导出：把每张图的标签写成各自同名 .txt，触发词排第一位

    mode="overwrite"（默认）：同名 .txt 直接覆盖
    mode="skip"：已存在的同名 .txt **跳过不动**，其余照写

    返回：{"written", "failed", "skipped", "overwritten", "folders"}
    （.txt 与图片同名、放在图片旁边，所以位置就是图片所在文件夹，去重后列出）
    """
    import os
    written = 0
    failed = 0
    skipped = 0
    overwritten = 0
    folders = []
    for path, item in (progress or {}).items():
        tags = _entry_tags(item)
        if not tags:
            continue
        try:
            f = caption_file(path)
            if os.path.isfile(f) and mode == "skip":
                skipped += 1
                continue
            if os.path.isfile(f):
                overwritten += 1
            write_caption(path, tags, sep)
            written += 1
            d = os.path.dirname(str(path))
            if d and d not in folders:
                folders.append(d)
        except Exception:
            failed += 1
            continue
    return {"written": written, "failed": failed, "skipped": skipped,
            "overwritten": overwritten, "folders": folders}


def thumb_cache_info():
    """缩略图缓存占用：文件数与体积（MB）"""
    d = storage.thumb_cache_dir()
    try:
        fs = list(d.glob("*.jpg"))
        size = sum(f.stat().st_size for f in fs)
    except Exception:
        return {"files": 0, "mb": 0}
    return {"files": len(fs), "mb": round(size / 1048576, 2)}


def thumb_cache_clear(days=None):
    """清理缩略图缓存：days=None 全清；否则只删生成超过 days 天的。
    返回删除的文件数（缓存删掉不影响任何数据，下次显示会自动重建）"""
    import time
    d = storage.thumb_cache_dir()
    now = time.time()
    removed = 0
    for f in d.glob("*.jpg"):
        try:
            if days is None or (now - f.stat().st_mtime) > days * 86400:
                f.unlink()
                removed += 1
        except Exception:
            pass
    return removed


def thumb_b64(path, size=160):
    """缩略图 base64（带磁盘缓存）"""
    p = Path(path)
    if not p.exists():
        return ""
    try:
        key = hashlib.md5(f"{path}|{p.stat().st_mtime}|{size}".encode()).hexdigest()
    except OSError:
        return ""
    cache = storage.thumb_cache_dir() / f"{key}.jpg"
    if cache.exists():
        return "data:image/jpeg;base64," + base64.b64encode(cache.read_bytes()).decode()
    try:
        im = Image.open(p)
        im = im.convert("RGB")
        im.thumbnail((size, size))
        buf = BytesIO()
        im.save(buf, "JPEG", quality=82)
        data = buf.getvalue()
        cache.write_bytes(data)
        return "data:image/jpeg;base64," + base64.b64encode(data).decode()
    except Exception:
        return ""
