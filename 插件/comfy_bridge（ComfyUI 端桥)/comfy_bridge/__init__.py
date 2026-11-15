"""chip-prompt-tool 联动桥 · ComfyUI 节点包（独立文件夹，无 plugin.json）

放在 ComfyUI\\custom_nodes\\comfy_bridge\\，重启 ComfyUI 生效。
本包自带 /chip/* HTTP 路由（带 CORS 头），主程序插件通过 fetch 调用，
因此主程序不需要起任何服务、也不需要新增后端接口。
"""
from .node_chips import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import chip_routes

# 前端扩展（web/js/*.js）：给联动节点输出口按类型上色
WEB_DIRECTORY = "./web"

try:
    chip_routes.register()
except Exception as e:
    print(f"[chip-prompt-tool 联动桥] 路由注册失败（节点仍可用）：{e!r}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
