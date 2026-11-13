"""WeiLin 提示词工具 —— 入口（pywebview 独立桌面窗口）"""
import ctypes
import functools
import json
import sys
import time
import traceback
from pathlib import Path

if getattr(sys, "frozen", False):
    ROOT = Path(sys._MEIPASS)          # 打包后：ui/、physton/ 在临时解压目录里
else:
    ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import webview

from core import storage, caption as cap, repo, tags_import, global_panel

APP_NAME = "chip提示词"          # 窗口标题（正式名字定下来后只改这一处）

# 自定义翻译接口（OpenAI 兼容）：填接口地址 + Key + 模型名即可用
CUSTOM_API_KEY = "custom_openai"
CUSTOM_API_FIELDS = [
    {"key": "api_base", "name": "接口地址（如 https://api.openai.com/v1，或中转站地址）", "default": "https://api.openai.com/v1"},
    {"key": "api_key", "name": "API Key（sk-…）", "default": ""},
    {"key": "model", "name": "模型名（如 gpt-4o-mini / deepseek-chat / qwen-plus）", "default": "gpt-4o-mini"},
]


def CUSTOM_API_GROUP(saved=None):
    saved = saved or {}
    cfg = saved.get(CUSTOM_API_KEY, {})
    return {
        "type": "custom",
        "name": "自定义",
        "children": [{
            "key": CUSTOM_API_KEY,
            "name": "自定义（OpenAI 兼容）",   # 不带 emoji：GBK 控制台 print 会炸（\u2728 无法编码）
            "config": [dict(c, value=cfg.get(c["key"], c.get("default", ""))) for c in CUSTOM_API_FIELDS],
        }],
    }


def alert(msg):
    """原生错误弹窗（无控制台时也能看到报错）"""
    text = str(msg)
    if len(text) > 1500:
        text = "…" + text[-1500:]
    try:
        ctypes.windll.user32.MessageBoxW(0, text, APP_NAME + " · 出错了", 0x10)
    except Exception:
        pass


def _hook(exc_type, exc, tb):
    alert("".join(traceback.format_exception(exc_type, exc, tb)))


# 注意：不能在 import 时就挂全局钩子——否则任何 `import app` 的脚本
# （比如自检/测试用的 python -c）一出错都会弹窗。挂到 main() 里才生效。


def guard(func):
    """接口方法出错：弹窗提示 + 返回 None，避免静默失败"""
    @functools.wraps(func)
    def wrapper(*a, **k):
        try:
            return func(*a, **k)
        except Exception:
            alert(f"接口 {func.__name__} 出错：\n" + traceback.format_exc())
            return None
    return wrapper


# ---------------- 插件发现（只读清单与入口文本，不执行插件代码） ----------------
def _plugin_roots():
    """插件目录候选：源码启动读项目根 插件\\（与 com 同级）；打包后读 exe 旁边 插件\\。
    刻意不把插件打进 exe —— 增删插件不需要重新打包，删掉文件夹功能即消失。"""
    if getattr(sys, "frozen", False):
        return [Path(sys.executable).parent / "插件"]
    return [ROOT.parent / "插件"]


def _scan_plugins():
    out, seen = [], set()
    for root in _plugin_roots():
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir() or d.name.startswith((".", "__")):
                continue
            mf = d / "plugin.json"
            if not mf.is_file():
                continue
            try:
                cfg = json.loads(mf.read_text(encoding="utf-8"))
                pid = str(cfg.get("id") or d.name)
                if pid in seen:
                    continue
                entry = cfg.get("entry") or {}
                html_name, js_name = str(entry.get("html") or ""), str(entry.get("js") or "")
                # 只接受纯文件名，杜绝 ../ 路径穿越读到任意文件
                def _safe(n):
                    return bool(n) and "/" not in n and "\\" not in n and ".." not in n
                if not _safe(html_name) or not _safe(js_name):
                    continue
                hp, jp = d / html_name, d / js_name
                if not hp.is_file() or not jp.is_file():
                    continue
                html, js = hp.read_text(encoding="utf-8"), jp.read_text(encoding="utf-8")
                if len(html) > 200_000 or len(js) > 500_000:   # 防止误读超大文件卡住界面
                    continue
                seen.add(pid)
                out.append({
                    "id": pid,
                    "name": str(cfg.get("name") or pid),
                    "version": str(cfg.get("version") or ""),
                    "icon": str(cfg.get("icon") or "🧩"),
                    "desc": str(cfg.get("desc") or ""),
                    "html": html, "js": js,
                })
            except Exception as e:
                print(f"[插件] 跳过 {d.name}：{e!r}")
                continue
    return out


class Api:
    """前端通过 window.pywebview.api.xxx() 调用"""

    def list_plugins(self):
        """返回已检测到的插件（含面板 HTML/JS 文本）；没有插件返回 []"""
        try:
            return _scan_plugins()
        except Exception as e:
            print(f"[插件] 扫描失败：{e!r}")
            return []

    # ---------------- 标签库 ----------------
    def get_tags(self):
        return tags_import.ensure_imported()

    def import_aoshu(self, folder, dry_run=False):
        """从 NovelAI 奥术秘典「咒语库」导入提示词+示例图；dry_run 只统计不落盘"""
        try:
            return tags_import.import_aoshu(folder, dry_run=dry_run)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def log_error(self, msg):
        """前端错误落盘，便于无控制台排查"""
        try:
            with open(storage.DATA / "前端错误.log", "a", encoding="utf-8") as f:
                f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + str(msg) + "\n")
        except Exception:
            pass
        return True

    def add_category(self, name):
        return tags_import.add_category(name)

    # ---- 标签库备份：导出 / 导入 ----
    def gp_sync(self, pos, neg):
        """前端提示词变化时，同步给全局填入面板 + 落盘给 ComfyUI 插件读"""
        global_panel.set_text(pos, neg)
        try:
            import time
            storage.save_json("提示词同步.json", {
                "pos": pos or "", "neg": neg or "", "ts": int(time.time())})
        except Exception:
            pass
        return True

    def gp_status(self):
        return global_panel.status()

    def gp_show(self):
        global_panel.show()
        return True

    def gp_hide(self):
        global_panel.hide()
        return True

    def thumb_cache_info(self):
        return cap.thumb_cache_info()

    def thumb_cache_clear(self):
        return cap.thumb_cache_clear()

    def pick_save_path(self, default_name):
        """系统「另存为」对话框，返回选中路径（取消返回空）"""
        import webview
        r = webview.windows[0].create_file_dialog(
            webview.SAVE_DIALOG, save_filename=default_name,
            file_types=("JSON 文件 (*.json)",))
        return (r[0] if isinstance(r, (list, tuple)) and r else (r or "")) if r else ""

    def pick_open_path(self):
        """系统「打开文件」对话框，返回选中路径（取消返回空）"""
        import webview
        r = webview.windows[0].create_file_dialog(
            webview.OPEN_DIALOG, file_types=("JSON 文件 (*.json)", "所有文件 (*.*)"))
        return (r[0] if isinstance(r, (list, tuple)) and r else (r or "")) if r else ""

    def tags_export(self, path):
        return tags_import.export_backup(path)

    def tags_backup_info(self, path):
        """预览备份内容（不写入）：返回 {cats, tags} 或 None（格式不对）"""
        r = tags_import.read_backup(path)
        if not r:
            return None
        return {"cats": r[1], "tags": r[2]}

    def tags_import_apply(self, path):
        return tags_import.apply_backup(path)

    def show_in_folder(self, path):
        try:
            import subprocess
            subprocess.Popen(["explorer", "/select,", str(path)])
            return True
        except Exception:
            return False

    def add_tag(self, container_path, en, zh=""):
        return tags_import.add_tag(container_path, en, zh)

    def delete_tag(self, container_path, en):
        return tags_import.delete_tag(container_path, en)

    def delete_category(self, name):
        return tags_import.delete_category(name)

    def rename_category(self, old, new):
        return tags_import.rename_category(old, new)

    def rename_tag(self, container_path, old_en, new_en, new_zh):
        return tags_import.rename_tag(container_path, old_en, new_en, new_zh)

    def move_tag(self, old_path, en, new_path):
        return tags_import.move_tag(old_path, en, new_path)

    # ---------------- 标签库：容器（任意层级分组）管理 ----------------
    def add_group(self, parent_path, name):
        return tags_import.add_group(parent_path, name)

    def rename_group(self, path, new_name):
        return tags_import.rename_group(path, new_name)

    def delete_group(self, path):
        return tags_import.delete_group(path)

    def set_group_color(self, path, color):
        return tags_import.set_group_color(path, color)

    # ---------------- 标签示例图（给每个标签挂参考图，对齐奥术秘典的「词条预览图」） ----------------
    def add_tag_image(self, container_path, en, b64, ext="jpg"):
        return tags_import.add_tag_image(container_path, en, b64, ext)

    def add_tag_image_file(self, container_path, en, path):
        return tags_import.add_tag_image_file(container_path, en, path)

    def remove_tag_image(self, container_path, en, index):
        return tags_import.remove_tag_image(container_path, en, index)

    def reorder_tag_image(self, container_path, en, index, new_index):
        return tags_import.reorder_tag_image(container_path, en, index, new_index)

    def set_cover_tag_image(self, container_path, en, index):
        return tags_import.set_cover_tag_image(container_path, en, index)

    def replace_tag_image(self, container_path, en, index, b64, ext="jpg"):
        return tags_import.replace_tag_image(container_path, en, index, b64, ext)

    def replace_tag_image_file(self, container_path, en, index, path):
        return tags_import.replace_tag_image_file(container_path, en, index, path)

    # ---------------- 标签染色（两种逻辑：按分类统一 / 每标签独立） ----------------
    def set_category_color(self, cat_name, color):
        return tags_import.set_category_color(cat_name, color)

    def set_tag_color(self, container_path, en, color):
        return tags_import.set_tag_color(container_path, en, color)

    def clear_all_tag_colors(self):
        return tags_import.clear_all_tag_colors()

    def tag_image(self, rel, size=160):
        """按相对路径返回示例图缩略图（base64），失败返回空串"""
        from core import caption
        p = Path(rel)
        if not p.is_absolute():
            p = storage.DATA / rel
        if not p.exists():
            return ""
        return caption.thumb_b64(str(p), size)

    def search_tags(self, keyword):
        return tags_import.search(keyword)

    # ---------------- 收藏标签 ----------------
    def fav_list(self):
        """返回收藏标签快照列表 [[en, zh, [图片], 颜色], ...]"""
        return storage.get_favorites()

    def fav_add(self, tag):
        """收藏一个标签（传标签快照数组）；按英文去重，最新收藏排最前，返回新列表"""
        items = storage.get_favorites()
        snap = self._fav_snap(tag)
        if not snap:
            return items
        items = [x for x in items
                 if not (isinstance(x, (list, tuple)) and x and str(x[0] or "").strip() == snap[0])]
        items.insert(0, snap)
        storage.save_favorites(items)
        return items

    def fav_remove(self, en):
        """按英文取消收藏，返回新列表"""
        en = str(en or "").strip()
        items = [x for x in storage.get_favorites()
                 if not (isinstance(x, (list, tuple)) and x and str(x[0] or "").strip() == en)]
        storage.save_favorites(items)
        return items

    @staticmethod
    def _fav_snap(tag):
        """把前端传来的标签规整成 4 元素快照；无效返回 None"""
        if isinstance(tag, (list, tuple)) and tag:
            en = str(tag[0] or "").strip()
            if not en:
                return None
            zh = str(tag[1] or "") if len(tag) > 1 else ""
            imgs = tag[2] if len(tag) > 2 and isinstance(tag[2], list) else []
            color = str(tag[3] or "") if len(tag) > 3 else ""
            return [en, zh, imgs, color]
        if isinstance(tag, dict):
            en = str(tag.get("en") or "").strip()
            if not en:
                return None
            imgs = tag.get("imgs") if isinstance(tag.get("imgs"), list) else []
            return [en, str(tag.get("zh") or ""), imgs, str(tag.get("color") or "")]
        return None

    # ---------------- 设置 ----------------
    def get_settings(self):
        return storage.get_settings()

    def save_settings(self, patch):
        return storage.save_settings(patch or {})

    # ---------------- 翻译（老插件 39 引擎） ----------------
    def get_translate_apis(self):
        from physton.get_translate_apis import get_translate_apis
        data = get_translate_apis()
        saved = storage.get_settings().get("api_configs") or {}
        for group in data.get("apis", []):
            for item in group.get("children", []):
                cfg = saved.get(item.get("key"), {})
                for c in item.get("config") or []:
                    c["value"] = cfg.get(c.get("key"), c.get("default", ""))
        data.setdefault("apis", []).append(CUSTOM_API_GROUP(saved))
        return data

    def save_translate_api_config(self, api, config):
        cfgs = storage.get_settings().get("api_configs") or {}
        cfgs[api] = config or {}
        storage.save_settings({"api_configs": cfgs})
        return True

    def translate_text(self, text, api=None, direction="zh2en"):
        """direction: zh2en（中文→英文）/ en2zh（英文→中文）"""
        from physton.translate import translate
        s = storage.get_settings()
        api = api or s.get("default_api", "alibaba_free")   # 首次启动用内置免费接口
        cfg = (s.get("api_configs") or {}).get(api, {})
        pair = ("en_US", "zh_CN") if direction == "en2zh" else ("zh_CN", "en_US")
        try:
            return translate(str(text or ""), pair[0], pair[1], api, cfg)
        except Exception as e:
            return {"success": False, "message": str(e), "translated_text": ""}

    # ---------------- 打标模式 ----------------
    def pick_folder(self):
        try:
            res = webview.windows[0].create_file_dialog(
                webview.FOLDER_DIALOG,
                directory=storage.get_settings().get("last_folder") or "",
            )
            if res:
                folder = res[0] if isinstance(res, (list, tuple)) else res
                storage.save_settings({"last_folder": folder})
                return folder
        except Exception:
            pass
        return ""

    def list_images(self, folder):
        storage.save_settings({"last_folder": folder or ""})
        return cap.list_images(folder)

    def list_images_recursive(self, folder):
        """列出文件夹及其所有子文件夹里的图片（含嵌套），最多 3000 张"""
        storage.save_settings({"last_folder": folder or ""})
        return cap.list_images_recursive(folder)

    def path_exists(self, path):
        """路径是否存在（文件夹）。照片库用来标记失效的文件夹引用"""
        try:
            import os
            return bool(path) and os.path.isdir(str(path))
        except Exception:
            return False

    def load_folder(self, folder):
        """打开文件夹：一次性返回每张图 + 它已有的标签（半成品续打）
        优先级：未导出的暂存进度 > 已存在的同名 .txt"""
        storage.save_settings({"last_folder": folder or ""})
        imgs = cap.list_images(folder)
        prog = storage.get_progress()
        zh = tags_import.zh_index()
        out = []
        for im in imgs:
            p = im["path"]
            item = prog.get(p)
            if item and (item.get("tags") or item.get("trigger")):
                tags = item.get("tags") or []
            else:
                tags = cap.read_caption(p, zh)
                if tags:
                    prog[p] = {"tags": tags, "trigger": ""}
            out.append({"path": p, "name": im["name"], "tags": tags})
        storage.save_progress(prog)
        return out

    def thumb(self, path, size=160):
        return cap.thumb_b64(path, size)

    def preview(self, path, size=900):
        return cap.thumb_b64(path, size)

    def read_caption(self, path):
        return cap.read_caption(path, tags_import.zh_index())

    def get_progress(self):
        return storage.get_progress()

    def save_progress(self, progress):
        storage.save_progress(progress or {})
        return True

    def remove_progress(self, paths):
        """删除指定图片的打标记录（整条移除，不是清空）；返回删除条数"""
        cur = storage.get_progress()
        n = 0
        for p in paths or []:
            if p in cur:
                del cur[p]
                n += 1
        if n:
            storage.save_progress(cur)
        return n

    def export_check(self, progress):
        """导出前检查：几个待写、几个是已存在的同名 .txt"""
        return cap.export_check(progress or {})

    def export_all(self, progress, mode="overwrite"):
        sep = storage.get_settings().get("separator", ", ")
        storage.save_progress(progress or {})
        r = cap.export_all(progress or {}, sep, mode or "overwrite")
        # 兼容旧返回（纯数字）与新版（详情）
        if isinstance(r, dict):
            return r
        return {"written": r or 0, "failed": 0, "skipped": 0,
                "overwritten": 0, "folders": []}

    def open_folder(self, path):
        """在资源管理器里打开文件夹"""
        try:
            import os
            os.startfile(str(path))
            return True
        except Exception:
            try:
                import subprocess
                subprocess.Popen(["explorer", str(path)])
                return True
            except Exception:
                return False

    def apply_all(self, paths, tags):
        """给全部（或指定）图片追加标签"""
        prog = storage.get_progress()
        n = 0
        for p in paths or []:
            item = prog.setdefault(str(p), {"tags": [], "trigger": ""})
            for t in tags or []:
                if not any(x.get("en") == t.get("en") for x in item["tags"]):
                    item["tags"].append(t)
                    n += 1
        storage.save_progress(prog)
        return {"added": n}

    # ---------------- 打标库（通用存储） ----------------
    def repo_save(self, path, tags, trigger="", repo_folder=""):
        return repo.save_entry(path, tags or [], trigger, repo_folder)

    def repo_save_all(self, entries):
        """批量存库：entries = [{path, tags, trigger}]，只存有标签的，返回成功条数"""
        n = 0
        for e in entries or []:
            if not (e or {}).get("path"):
                continue
            tags = e.get("tags") or []
            if not tags:
                continue
            try:
                if repo.save_entry(e["path"], tags, e.get("trigger", ""), e.get("repo_folder", "")):
                    n += 1
            except Exception:
                continue
        return n

    def pick_images(self):
        """多选图片文件（手动添加进打标库用）"""
        try:
            res = webview.windows[0].create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=True,
                file_types=("图片文件 (*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif)",),
            )
            if res:
                return [str(x) for x in res]
        except Exception:
            pass
        return []

    def repo_add_manual(self, paths, tags, trigger="", repo_folder=""):
        """手动把外部图片（+ 标词）加入打标库，可一次多张共用同一套标签"""
        out = []
        for p in paths or []:
            item = repo.save_entry(p, tags or [], trigger, repo_folder)
            if item:
                out.append(item)
        return out

    def repo_create_folder(self, name):
        return repo.create_repo_folder(name)

    def repo_delete_folder(self, name):
        return repo.delete_repo_folder(name)

    def repo_rename_folder(self, old, new):
        return repo.rename_repo_folder(old, new)

    def repo_move_to_folder(self, paths, folder):
        return repo.move_to_folder(paths, folder)

    def repo_update(self, path, tags, trigger=""):
        return repo.update_entry(path, tags, trigger)

    def repo_copy_path(self, path):
        return repo.copy_path(path)

    def repo_list(self, keyword="", folder=""):
        if folder == "__none":
            items = repo.list_entries(keyword, "")
            return [x for x in items if not x.get("repo_folder")]
        return repo.list_entries(keyword, folder)

    def repo_folders(self):
        return repo.folders()

    def repo_delete(self, path, also_image=False):
        return repo.delete_entry(path, also_image)

    def repo_image(self, path, size=520):
        return repo.entry_image_b64(path, size)

    def repo_clean(self):
        return {"removed": repo.clean_orphans()}


def main():
    # 输出保护：万一以后带控制台运行（python 而非 pythonw），
    # GBK 控制台打不出 emoji 等字符会直接 UnicodeEncodeError，这里强制 UTF-8
    import sys as _sys
    for _s in (_sys.stdout, _sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    # 真正跑程序才挂全局错误弹窗（import app 不挂，测试脚本出错不再弹窗）
    sys.excepthook = _hook
    # 启动前按设置自动清理过期缩略图缓存（删掉不影响任何数据，下次显示自动重建）
    try:
        days = int(storage.get_settings().get("thumb_auto_clean") or 0)
        if days == -1:
            cap.thumb_cache_clear()          # 每次启动全清
        elif days > 0:
            cap.thumb_cache_clear(days)
    except Exception:
        pass
    # 全局填入面板：常驻右下角，任何软件的输入框里都能一键整段填入
    try:
        global_panel.start()
    except Exception:
        pass
    try:
        # 所有对外接口统一包一层错误弹窗
        for name in dir(Api):
            if name.startswith("_"):
                continue
            fn = getattr(Api, name)
            if callable(fn):
                setattr(Api, name, guard(fn))

        api = Api()
        index = ROOT / "ui" / "index.html"
        webview.create_window(
            APP_NAME,
            url=str(index),
            js_api=api,
            width=1320,
            height=860,
            min_size=(1020, 700),
        )
        webview.start(debug=False)
    except Exception:
        alert("程序启动失败：\n" + traceback.format_exc())


if __name__ == "__main__":
    main()
