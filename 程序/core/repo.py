"""打标库：通用存储——复制图片进库 + 索引（不绑定当前文件夹，跨项目复用）"""
import hashlib
import shutil
import time
from pathlib import Path

from . import storage


def _copy_name(src: Path):
    """库内文件名：按原图路径 hash 命名，同一张图重复存库只保留一份副本"""
    key = hashlib.md5(str(src).encode("utf-8")).hexdigest()[:16]
    return f"{key}{src.suffix.lower()}"


def save_entry(img_path, tags, trigger="", repo_folder=""):
    """把图片复制进库并写入索引；同一原图覆盖更新"""
    src = Path(img_path)
    if not src.exists():
        return None
    images = storage.repo_images_dir()
    dst = images / _copy_name(src)
    try:
        if not dst.exists():
            shutil.copy2(src, dst)
    except Exception:
        return None

    index = storage.get_repo_index()
    path = str(src)
    item = {
        "path": path,                    # 唯一标识：原图完整路径
        "name": src.name,
        "folder": src.parent.name,
        "repo_folder": str(repo_folder or ""),   # 用户自建文件夹
        "image": dst.name,               # 库内副本文件名
        "trigger": str(trigger or ""),
        "tags": [dict(t) for t in (tags or [])],
        "time": int(time.time()),
    }
    for i, old in enumerate(index):
        if old.get("path") == path:
            index[i] = item
            break
    else:
        index.append(item)
    storage.save_repo_index(index)
    return item


def list_entries(keyword="", folder=""):
    items = storage.get_repo_index()
    kw = (keyword or "").strip().lower()
    if folder:
        items = [x for x in items if x.get("repo_folder", "") == folder]
    if kw:
        items = [
            x for x in items
            if kw in str(x.get("name", "")).lower()
            or kw in " ".join(t.get("en", "") for t in x.get("tags", [])).lower()
            or kw in " ".join(t.get("zh", "") for t in x.get("tags", [])).lower()
        ]
    return items


def folders():
    """用户自建文件夹列表（纯字符串）"""
    return sorted(storage.get_repo_folders())


def get_entry(path):
    for x in storage.get_repo_index():
        if x.get("path") == path:
            return x
    return None


def create_repo_folder(name):
    name = (name or "").strip()
    if not name:
        return False
    fs = storage.get_repo_folders()
    if name in fs:
        return False
    fs.append(name)
    storage.save_repo_folders(fs)
    return True


def delete_repo_folder(name):
    fs = [f for f in storage.get_repo_folders() if f != name]
    storage.save_repo_folders(fs)
    index = storage.get_repo_index()
    for x in index:
        if x.get("repo_folder") == name:
            x["repo_folder"] = ""
    storage.save_repo_index(index)
    return True


def rename_repo_folder(old, new):
    """重命名文件夹：不存在返回 False，重名返回 'dup'，成功返回 True"""
    old = (old or "").strip()
    new = (new or "").strip()
    if not old or not new:
        return False
    fs = storage.get_repo_folders()
    if old not in fs:
        return False
    if old != new and new in fs:
        return "dup"
    fs = [new if f == old else f for f in fs]
    storage.save_repo_folders(fs)
    index = storage.get_repo_index()
    for x in index:
        if x.get("repo_folder") == old:
            x["repo_folder"] = new
    storage.save_repo_index(index)
    return True


def move_to_folder(paths, folder):
    index = storage.get_repo_index()
    for x in index:
        if x.get("path") in (paths or []):
            x["repo_folder"] = folder or ""
    storage.save_repo_index(index)
    return True


def update_entry(path, tags, trigger=""):
    index = storage.get_repo_index()
    for x in index:
        if x.get("path") == path:
            x["tags"] = [dict(t) for t in (tags or [])]
            x["trigger"] = str(trigger or "")
            storage.save_repo_index(index)
            return True
    return False


def copy_path(path):
    item = get_entry(path)
    if not item:
        return ""
    return str(storage.repo_images_dir() / str(item.get("image", "")))


def delete_entry(path, also_delete_image=False):
    """删除：also_delete_image=False 只移除记录（保留副本）"""
    index = storage.get_repo_index()
    item = get_entry(path)
    if not item:
        return False
    index = [x for x in index if x.get("path") != path]
    storage.save_repo_index(index)
    if also_delete_image:
        img = storage.repo_images_dir() / str(item.get("image", ""))
        if img.exists():
            try:
                img.unlink()
            except Exception:
                pass
    return True


def clear_all():
    storage.save_repo_index([])


def entry_image_b64(path, size=520):
    """库内副本的 base64（用于「查看」）"""
    item = get_entry(path)
    if not item:
        return ""
    from . import caption  # 局部导入避免循环
    img = storage.repo_images_dir() / str(item.get("image", ""))
    return caption.thumb_b64(str(img), size)


def clean_orphans():
    """清理没有索引引用的图片副本"""
    index = storage.get_repo_index()
    used = {x.get("image") for x in index}
    removed = 0
    for f in storage.repo_images_dir().iterdir():
        if f.is_file() and f.name not in used:
            try:
                f.unlink()
                removed += 1
            except Exception:
                pass
    return removed
