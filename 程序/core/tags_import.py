"""标签库：优先读 data/tags.json；首次启动从内置资源（assets）或老插件 YAML 导入"""
import base64
import json
import re
import sys
import uuid
from pathlib import Path

import yaml

from . import storage

if getattr(sys, "frozen", False):
    BASE = Path(sys._MEIPASS)                 # 打包后：内置资源在临时解压目录
    GROUP_TAGS = BASE / "assets" / "group_tags"
else:
    BASE = Path(__file__).resolve().parent.parent
    GROUP_TAGS = Path(r"E:\桌面\03\WeiLin-ComfyUI-prompt-all-in-one\group_tags")

BUILTIN_TAGS = BASE / "assets" / "tags.json"  # 随 exe 内置的标签库（换电脑也能用）


def load_yaml(lang="zh_CN"):
    """YAML → [{name:分类, children:[{name:分组, color, tags:[[en, zh]]}]}]"""
    p = GROUP_TAGS / f"{lang}.yaml"
    if not p.exists():
        return []
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or []
    out = []
    for cat in data:
        children = []
        for g in cat.get("groups", []) or []:
            tags = [[str(k), str(v)] for k, v in (g.get("tags") or {}).items()]
            children.append({
                "name": g.get("name", ""),
                "color": g.get("color", ""),
                "tags": tags,
            })
        out.append({"name": cat.get("name", ""), "children": children})
    return out


def ensure_imported(force=False):
    """首次启动：优先用内置 tags.json，其次读 YAML（老插件/内置资源）"""
    tags = storage.get_tags()
    if tags and not force:
        return tags
    tags = []
    if not force and BUILTIN_TAGS.exists():
        try:
            tags = json.loads(BUILTIN_TAGS.read_text(encoding="utf-8"))
        except Exception:
            tags = []
    if not tags:
        tags = load_yaml()
    if tags:
        storage.save_tags(tags)
    return tags


def count_tags(tags):
    """统计分类数与标词数（递归，含任意层级）"""
    n = 0
    def _w(node):
        nonlocal n
        n += len(node.get("tags", []) or [])
        for ch in node.get("children", []) or []:
            _w(ch)
    for cat in tags or []:
        _w(cat)
    return len(tags or []), n


def export_backup(path):
    """导出标签库备份（JSON）：分类 + 分组 + 中英文标词，含自建内容"""
    tags = ensure_imported()
    data = {
        "_app": "提示词工具",
        "_type": "tags_backup",
        "version": 1,
        "tags": tags,
    }
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(tags)


def read_backup(path):
    """读取备份文件：返回 (tags, 分类数, 标词数)；格式不对返回 None"""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return None
    tags = data.get("tags") if isinstance(data, dict) else data
    if not isinstance(tags, list) or not tags:
        return None
    if not all(isinstance(c, dict) and c.get("name") for c in tags):
        return None
    cats, n = count_tags(tags)
    return [tags, cats, n]


def apply_backup(path):
    """把备份写回标签库"""
    r = read_backup(path)
    if not r:
        return False
    storage.save_tags(r[0])
    return True


def zh_index():
    """英文 → 中文 全量映射（给从 txt 读回的标签补中文）"""
    tags = storage.get_tags() or ensure_imported()
    m = {}
    def _w(node):
        for t in node.get("tags", []) or []:
            if isinstance(t, dict):
                continue
            en = t[0]
            zh = t[1] if len(t) > 1 else ""
            m.setdefault(en, zh)
        for ch in node.get("children", []) or []:
            _w(ch)
    for cat in tags:
        _w(cat)
    return m


def search(keyword, limit=200):
    """按中文或英文搜索标签，返回 [[en, zh, 分类, 路径]]（递归，覆盖任意层级）"""
    kw = (keyword or "").strip().lower()
    if not kw:
        return []
    tags = storage.get_tags() or ensure_imported()
    out = []
    def _walk(node, path):
        for t in node.get("tags", []) or []:
            if isinstance(t, dict):
                continue
            en = t[0]; zh = t[1] if len(t) > 1 else ""
            if kw in en.lower() or kw in str(zh).lower():
                out.append([en, zh, path[0], path])
                if len(out) >= limit:
                    return True
        for ch in node.get("children", []) or []:
            if _walk(ch, path + [ch.get("name", "")]):
                return True
        return False
    for cat in tags:
        if _walk(cat, [cat.get("name", "")]):
            break
    return out


_ILLEGAL = re.compile(r'[\\/:*?"<>|]')


def safe_name(s):
    return _ILLEGAL.sub("_", str(s or ""))


# ---------------- 递归容器辅助（路径式定位：path = [分类名, 二级名, 三级名, ...]） ----------------
def _find_node(tags, path):
    """按路径定位容器节点；找不到返回 None"""
    if not path:
        return None
    node = next((c for c in tags if c.get("name") == path[0]), None)
    for name in path[1:]:
        if not node or not isinstance(node, dict):
            return None
        children = node.get("children") or []
        node = next((g for g in children if g.get("name") == name), None)
    return node


def _find_parent(tags, path):
    """返回 (父节点, 末段名)；path 至少长度 2"""
    if len(path or []) < 2:
        return None, None
    parent = _find_node(tags, path[:-1])
    return parent, path[-1]


def _en_exists(node, en):
    """en 是否出现在 node 子树里（用于分类内唯一性判断）"""
    if not isinstance(node, dict):
        return False
    for t in node.get("tags", []) or []:
        if t and t[0] == en:
            return True
    for ch in node.get("children", []) or []:
        if _en_exists(ch, en):
            return True
    return False


def _walk_purge(node):
    """递归删除节点子树里的所有标签示例图"""
    for t in node.get("tags", []) or []:
        _purge_tag_images(t)
    for ch in node.get("children", []) or []:
        _walk_purge(ch)


def add_category(name):
    """新增一个空分类（用户自建）"""
    name = (name or "").strip()
    if not name:
        return False
    tags = ensure_imported()
    if any(c.get("name") == name for c in tags):
        return False
    tags.append({"name": name, "children": []})
    storage.save_tags(tags)
    return True


def add_tag(container_path, en, zh=""):
    """在指定容器路径下添加标签；返回 True / 'dup'（分类内重复）/ False（容器不存在）"""
    en = (en or "").strip(); zh = (zh or "").strip()
    if not en and not zh:
        return False
    if not en:
        en = zh
    if not isinstance(container_path, list) or not container_path:
        return False
    tags = ensure_imported()
    node = _find_node(tags, container_path)
    if not node:
        return False
    cat = _find_node(tags, [container_path[0]])   # 分类内英文唯一（对齐原「同分类不可重名」）
    if cat and _en_exists(cat, en):
        return "dup"
    node.setdefault("tags", []).append([en, zh])
    storage.save_tags(tags)
    return True


def delete_tag(container_path, en):
    """删除指定容器下某个标签（清示例图）；返回 True / False"""
    en = (en or "").strip()
    if not en or not isinstance(container_path, list) or not container_path:
        return False
    tags = ensure_imported()
    node = _find_node(tags, container_path)
    if not node:
        return False
    found = next((t for t in node.get("tags", []) if t and t[0] == en), None)
    if not found:
        return False
    _purge_tag_images(found)
    node["tags"] = [t for t in node.get("tags", []) if not (t and t[0] == en)]
    storage.save_tags(tags)
    return True


def delete_category(name):
    """删除整个分类（级联删除其下所有标签与子分类）；返回 True / False"""
    name = (name or "").strip()
    if not name:
        return False
    tags = ensure_imported()
    cat = next((c for c in tags if c.get("name") == name), None)
    if not cat:
        return False
    _walk_purge(cat)
    tags = [c for c in tags if c.get("name") != name]
    storage.save_tags(tags)
    return True


def add_group(parent_path, name):
    """在 parent_path 容器下新增子容器（即下一级分类）；返回 True / 'dup' / False"""
    name = (name or "").strip()
    if not name or not isinstance(parent_path, list) or not parent_path:
        return False
    tags = ensure_imported()
    parent = _find_node(tags, parent_path)
    if not parent:
        return False
    children = parent.setdefault("children", [])
    if any(g.get("name") == name for g in children):
        return "dup"
    children.append({"name": name, "color": "", "children": [], "tags": []})
    storage.save_tags(tags)
    return True


def rename_group(path, new_name):
    """重命名某层容器；path 为完整容器路径（长度 1 = 顶级分类）；返回 True / 'dup' / False"""
    new_name = (new_name or "").strip()
    if not isinstance(path, list) or len(path) < 1 or not new_name:
        return False
    tags = ensure_imported()
    if len(path) == 1:
        name = path[0]
        idx = next((i for i, c in enumerate(tags) if c.get("name") == name), None)
        if idx is None:
            return False
        if any(c.get("name") == new_name for i, c in enumerate(tags) if i != idx):
            return "dup"
        tags[idx]["name"] = new_name
        storage.save_tags(tags)
        return True
    parent, name = _find_parent(tags, path)
    if not parent:
        return False
    children = parent.setdefault("children", [])
    idx = next((i for i, g in enumerate(children) if g.get("name") == name), None)
    if idx is None:
        return False
    if any(g.get("name") == new_name for i, g in enumerate(children) if i != idx):
        return "dup"
    children[idx]["name"] = new_name
    storage.save_tags(tags)
    return True


def delete_group(path):
    """删除某层容器（级联删除其下标签与子容器）；path 长度 1 = 顶级分类；返回 True / False"""
    if not isinstance(path, list) or len(path) < 1:
        return False
    if len(path) == 1:
        return delete_category(path[0])
    tags = ensure_imported()
    parent, name = _find_parent(tags, path)
    if not parent:
        return False
    children = parent.get("children", [])
    target = next((g for g in children if g.get("name") == name), None)
    if not target:
        return False
    _walk_purge(target)
    parent["children"] = [g for g in children if g.get("name") != name]
    storage.save_tags(tags)
    return True


def set_group_color(path, color):
    """给某层容器设置颜色；color 空串表示清除；返回 True / False"""
    color = (color or "").strip()
    if not isinstance(path, list) or not path:
        return False
    tags = ensure_imported()
    node = _find_node(tags, path)
    if not node:
        return False
    if color:
        node["color"] = color
    else:
        node.pop("color", None)
    storage.save_tags(tags)
    return True


def _purge_tag_images(tag):
    """删除标签时顺手删掉它关联的示例图文件"""
    if not tag or len(tag) < 3:
        return
    for rel in (tag[2] or []):
        try:
            (storage.DATA / rel).unlink()
        except OSError:
            pass


def _find_tag(tags, container_path, en):
    """在指定容器路径的子树中查找标签（递归，覆盖任意层级）"""
    if not isinstance(container_path, list) or not container_path:
        return None
    node = _find_node(tags, container_path)
    if not node:
        return None
    return _find_tag_in_subtree(node, en)


def _find_tag_in_subtree(node, en):
    for t in node.get("tags", []) or []:
        if t and t[0] == en:
            return t
    for ch in node.get("children", []) or []:
        r = _find_tag_in_subtree(ch, en)
        if r:
            return r
    return None


def add_tag_image(container_path, en, b64, ext="jpg"):
    """给标签追加一张示例图；存到 data/tag_images/，把相对路径写入 t[2]；返回最新列表或 None"""
    tags = ensure_imported()
    t = _find_tag(tags, container_path, en)
    if not t:
        return None
    if len(t) < 3:
        t.append([])
    d = storage.DATA / "tag_images"
    d.mkdir(parents=True, exist_ok=True)
    ext = (ext or "jpg").lower().lstrip(".")
    if ext not in ("jpg", "jpeg", "png", "webp", "gif", "bmp"):
        ext = "jpg"
    prefix = "_".join(str(x) for x in container_path) if isinstance(container_path, list) else str(container_path)
    fn = re.sub(r'[\\/:*?"<>|\s]', "_", f"{prefix}_{en}_{uuid.uuid4().hex[:8]}.{ext}")
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None
    (d / fn).write_bytes(raw)
    t[2].append("tag_images/" + fn)
    storage.save_tags(tags)
    return t[2]


def add_tag_image_file(container_path, en, path):
    """从磁盘文件追加示例图（文件选择框用）"""
    p = Path(path)
    if not p.exists():
        return None
    ext = p.suffix.lstrip(".") or "jpg"
    try:
        raw = p.read_bytes()
    except Exception:
        return None
    return add_tag_image(container_path, en, base64.b64encode(raw).decode(), ext)


def remove_tag_image(container_path, en, index):
    """删除标签的第 index 张示例图；返回最新列表或 None"""
    tags = ensure_imported()
    t = _find_tag(tags, container_path, en)
    if not t or len(t) < 3 or not (0 <= index < len(t[2])):
        return None
    rel = t[2].pop(index)
    try:
        (storage.DATA / rel).unlink()
    except OSError:
        pass
    storage.save_tags(tags)
    return t[2]


def _tag_images(container_path, en):
    """返回标签的示例图列表（不存在则建空列表），找不到返回 None"""
    t = _find_tag(ensure_imported(), container_path, en)
    if not t:
        return None
    if len(t) < 3:
        t.append([])
    return t[2]


def reorder_tag_image(container_path, en, index, new_index):
    """把第 index 张移到 new_index（用于调整顺序）；返回最新列表或 None"""
    imgs = _tag_images(container_path, en)
    if imgs is None or not (0 <= index < len(imgs)) or not (0 <= new_index < len(imgs)):
        return None
    imgs.insert(new_index, imgs.pop(index))
    storage.save_tags(ensure_imported())
    return imgs


def set_cover_tag_image(container_path, en, index):
    """把第 index 张设为封面（移到最前，作为卡片缩略图）"""
    return reorder_tag_image(container_path, en, index, 0)


def replace_tag_image(container_path, en, index, b64, ext="jpg"):
    """替换第 index 张示例图（删旧文件、写新文件、占位不变）；返回最新列表或 None"""
    imgs = _tag_images(container_path, en)
    if imgs is None or not (0 <= index < len(imgs)):
        return None
    d = storage.DATA / "tag_images"
    d.mkdir(parents=True, exist_ok=True)
    ext = (ext or "jpg").lower().lstrip(".")
    if ext not in ("jpg", "jpeg", "png", "webp", "gif", "bmp"):
        ext = "jpg"
    prefix = "_".join(str(x) for x in container_path) if isinstance(container_path, list) else str(container_path)
    fn = re.sub(r'[\\/:*?"<>|\s]', "_", f"{prefix}_{en}_{uuid.uuid4().hex[:8]}.{ext}")
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None
    (d / fn).write_bytes(raw)
    try:
        (storage.DATA / imgs[index]).unlink()
    except OSError:
        pass
    imgs[index] = "tag_images/" + fn
    storage.save_tags(ensure_imported())
    return imgs


def replace_tag_image_file(container_path, en, index, path):
    """从磁盘文件替换第 index 张（文件选择框用）"""
    p = Path(path)
    if not p.exists():
        return None
    ext = p.suffix.lstrip(".") or "jpg"
    try:
        raw = p.read_bytes()
    except Exception:
        return None
    return replace_tag_image(container_path, en, index, base64.b64encode(raw).decode(), ext)


def set_category_color(cat_name, color):
    """给整个分类设置统一颜色（存到 cat.color）；color 为空串表示清除；返回 True / False"""
    cat_name = (cat_name or "").strip()
    color = (color or "").strip()
    tags = ensure_imported()
    cat = next((c for c in tags if c.get("name") == cat_name), None)
    if not cat:
        return False
    if color:
        cat["color"] = color
    else:
        cat.pop("color", None)
    storage.save_tags(tags)
    return True


def set_tag_color(container_path, en, color):
    """给单张标签设独立颜色；color 空串表示清除；返回 True / False"""
    en = (en or "").strip(); color = (color or "").strip()
    if not en or not isinstance(container_path, list) or not container_path:
        return False
    tags = ensure_imported()
    node = _find_node(tags, container_path)
    if not node:
        return False
    t = next((x for x in node.get("tags", []) if x and x[0] == en), None)
    if not t:
        return False
    while len(t) < 3: t.append([])
    if color:
        if len(t) < 4: t.append(color)
        else: t[3] = color
    else:
        if len(t) >= 4: t[3] = ""
    storage.save_tags(tags)
    return True


# ---------------- 导入 NovelAI 奥术秘典「咒语库」 ----------------
import shutil as _shutil

_AOSHU_EXCLUDE = {"排序", "修饰词缀"}   # 根目录里的配置/排序 ini，不是提示词


def _read_text_robust(path):
    """先读字节，再按 utf-8-sig→utf-8→gbk/cp936 顺序挑能正确解码的编码。
    奥术秘典的 .ini 多为 GBK，写死 utf-8 会把中文键（英文=、[中文名]）吞掉导致提示词丢失。"""
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gbk", "cp936"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", errors="ignore")


def _parse_aoshu_ini(ini_path):
    """容错解析奥术秘典 .ini。
    返回 [(en, zh), ...]：[中文名] 段为 zh，`英文=` 为 en；无 '=' 的脏行（如 作者：xxx）忽略。
    英文尾部多余逗号会被清掉；无英文的条目跳过。"""
    tags = []
    cur_zh, cur_en = None, ""
    try:
        text = _read_text_robust(ini_path)
    except Exception:
        return tags
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            if cur_zh is not None:
                en = cur_en.strip().rstrip(",").strip()
                if en:
                    tags.append((en, cur_zh))
            cur_zh = line[1:-1].strip()
            cur_en = ""
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            if k.strip() == "英文":
                cur_en = v.strip()
        # 其他（描述=… / 作者：…）忽略
    if cur_zh is not None:
        en = cur_en.strip().rstrip(",").strip()
        if en:
            tags.append((en, cur_zh))
    return tags


def _aoshu_img_candidates(preview_dir, sub_name, zh):
    norm = re.sub(r'[\\/:*?"<>|\s]', "_", zh).strip("_")
    return [f"{sub_name}_{zh}.png", f"{sub_name}_{norm}.png"]


def _copy_aoshu_image(src_path):
    d = storage.DATA / "tag_images"
    d.mkdir(parents=True, exist_ok=True)
    ext = Path(src_path).suffix.lstrip(".").lower() or "png"
    if ext not in ("jpg", "jpeg", "png", "webp", "gif", "bmp"):
        ext = "png"
    fn = re.sub(r'[\\/:*?"<>|\s]', "_", f"aoshu_{uuid.uuid4().hex[:10]}.{ext}")
    _shutil.copy2(src_path, d / fn)
    return "tag_images/" + fn


def import_aoshu(source_dir, exclude=None, dry_run=False):
    """从 NovelAI 奥术秘典「咒语库」导入提示词 + 示例图到当前标签库。
    source_dir 可为 咒语库 文件夹本身，或奥术秘典根目录（自动找 咒语库 子目录）。
    结构映射：咒语库/{分类}/{子分类}.ini → 分类→子分类→标签[en,zh]；
              {分类}/预览图/{子分类}_{中文名}.png → 该标签示例图。
    返回统计 dict。"""
    src = Path(source_dir)
    if not src.exists():
        return {"ok": False, "error": f"源目录不存在：{source_dir}"}
    spell = src / "咒语库" if (src / "咒语库").is_dir() else src
    if not spell.is_dir():
        return {"ok": False, "error": "未找到 咒语库 文件夹"}

    excl = set(_AOSHU_EXCLUDE)
    if exclude:
        excl.update(exclude)

    # 1) 解析（只读，不落盘）
    plan = []
    matched = missing = 0
    for cat_dir in sorted(p for p in spell.iterdir() if p.is_dir()):
        cat_name = cat_dir.name
        if cat_name in excl:
            continue
        preview_dir = cat_dir / "预览图"
        cat_node = {"name": cat_name, "children": []}
        for ini in sorted(cat_dir.glob("*.ini")):
            sub_name = ini.stem
            if sub_name in excl:
                continue
            sub_node = {"name": sub_name, "tags": []}
            for en, zh in _parse_aoshu_ini(ini):
                img_src = None
                if preview_dir.is_dir():
                    for c in _aoshu_img_candidates(preview_dir, sub_name, zh):
                        p = preview_dir / c
                        if p.is_file():
                            img_src = str(p)
                            break
                if img_src:
                    matched += 1
                else:
                    missing += 1
                sub_node["tags"].append((en, zh, img_src))
            if sub_node["tags"]:
                cat_node["children"].append(sub_node)
        if cat_node["children"]:
            plan.append(cat_node)

    cats = len(plan)
    tags_total = sum(len(s["tags"]) for c in plan for s in c["children"])

    if dry_run:
        return {"ok": True, "dry_run": True, "cats": cats, "tags": tags_total,
                "images": matched, "missing": missing}

    # 2) 合并进现有标签库（先备份）
    tags = storage.get_tags() or []
    if not isinstance(tags, list):
        tags = []
    try:
        if (storage.DATA / "tags.json").exists():
            _shutil.copy2(storage.DATA / "tags.json", storage.DATA / "tags.json.bak")
    except Exception:
        pass

    added = skipped = imgs_added = 0

    def find_child(node, name):
        for ch in node.get("children", []) or []:
            if ch.get("name") == name:
                return ch
        return None

    def en_exists(node, en):
        return any(t and t[0] == en for t in (node.get("tags", []) or []))

    for cat in plan:
        existing = next((c for c in tags if c.get("name") == cat["name"]), None)
        if not existing:
            existing = {"name": cat["name"], "children": [], "tags": []}
            tags.append(existing)
        for sub in cat["children"]:
            sub_node = find_child(existing, sub["name"])
            if not sub_node:
                sub_node = {"name": sub["name"], "children": [], "tags": []}
                existing.setdefault("children", []).append(sub_node)
            for en, zh, img_src in sub["tags"]:
                if en_exists(sub_node, en):
                    skipped += 1
                    continue
                t = [en, zh]
                if img_src:
                    t.append([_copy_aoshu_image(img_src)])
                    imgs_added += 1
                sub_node.setdefault("tags", []).append(t)
                added += 1

    storage.save_tags(tags)
    return {"ok": True, "cats": cats, "tags": added, "skipped": skipped,
            "images": imgs_added, "matched": matched, "missing": missing}


def clear_all_tag_colors():
    """清除所有分类/分组颜色与所有标签独立颜色；返回 (分类色数, 标签色数, 分组色数)"""
    tags = ensure_imported()
    n_cat = n_tag = n_grp = 0
    def _walk(node, is_cat):
        nonlocal n_cat, n_tag, n_grp
        if node.pop("color", None):
            if is_cat: n_cat += 1
            else: n_grp += 1
        for t in node.get("tags", []) or []:
            if isinstance(t, dict) or len(t) < 4:
                continue
            if t[3]:
                t[3] = ""
                n_tag += 1
        for ch in node.get("children", []) or []:
            _walk(ch, False)
    for cat in tags:
        _walk(cat, True)
    storage.save_tags(tags)
    return [n_cat, n_tag, n_grp]


def rename_category(old, new):
    """重命名分类；返回 True / 'dup'（新名已存在）/ False（旧名不存在/空）"""
    old = (old or "").strip(); new = (new or "").strip()
    if not old or not new:
        return False
    tags = ensure_imported()
    idx = next((i for i, c in enumerate(tags) if c.get("name") == old), None)
    if idx is None:
        return False
    if any(c.get("name") == new for i, c in enumerate(tags) if i != idx):
        return "dup"
    tags[idx]["name"] = new
    storage.save_tags(tags)
    return True


def rename_tag(container_path, old_en, new_en, new_zh):
    """改标签：new_en=内容, new_zh=名称；返回 True / False"""
    old_en = (old_en or "").strip(); new_en = (new_en or "").strip(); new_zh = (new_zh or "").strip()
    if not old_en:
        return False
    if not new_en and not new_zh:
        return False
    if not new_en:
        new_en = new_zh
    if not isinstance(container_path, list) or not container_path:
        return False
    tags = ensure_imported()
    node = _find_node(tags, container_path)
    if not node:
        return False
    t = next((x for x in node.get("tags", []) if x and x[0] == old_en), None)
    if not t:
        return False
    t[1] = new_zh
    if new_en != old_en:
        t[0] = new_en
    storage.save_tags(tags)
    return True


def move_tag(old_path, en, new_path):
    """跨容器移动标签（保留 zh 与示例图）；返回 True / 'dup' / False"""
    en = (en or "").strip()
    if not en or not isinstance(old_path, list) or not isinstance(new_path, list) or not old_path or not new_path:
        return False
    tags = ensure_imported()
    onode = _find_node(tags, old_path)
    nnode = _find_node(tags, new_path)
    if not onode or not nnode:
        return False
    entry = next((t for t in onode.get("tags", []) if t and t[0] == en), None)
    if not entry:
        return False
    if old_path == new_path:
        return False
    target = nnode
    if target.get("children") and not target.get("tags"):
        target = target["children"][0]        # 拖到分类上时落到其首个子容器
    if any(t[0] == en for t in target.get("tags", [])):
        return "dup"
    onode["tags"] = [t for t in onode.get("tags", []) if t[0] != en]
    target.setdefault("tags", []).append(entry)
    storage.save_tags(tags)
    return True
