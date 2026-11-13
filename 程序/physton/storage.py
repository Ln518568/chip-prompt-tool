"""轻量键值存储（替换老插件依赖 webui `launch` 的 storage.py，接口保持一致）"""
import json
import os


class Storage:
    def __init__(self):
        self.storage_path = os.path.join(os.path.dirname(__file__), "storage")
        os.makedirs(self.storage_path, exist_ok=True)

    def _file(self, key):
        safe = str(key).replace("/", "_").replace("\\", "_")
        return os.path.join(self.storage_path, safe + ".json")

    def get(self, key, default=None):
        try:
            with open(self._file(key), "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default

    def set(self, key, value):
        try:
            with open(self._file(key), "w", encoding="utf-8") as f:
                json.dump(value, f, ensure_ascii=False)
        except Exception:
            pass
        return value

    def remove(self, key):
        p = self._file(key)
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:
                pass

    def has(self, key):
        return os.path.exists(self._file(key))
