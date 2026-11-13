"""全局提示词面板（常驻，任何软件的输入框都能填）

仿老插件「WeiLin全局提示词」：
- 面板里两个多行文本框（正向 / 反向），程序里提示词一变就同步进来（面板里也可以直接改）
- 点「替换为正向提示词 / 替换为反向提示词」→ 用文本框里的内容（以面板为准）
  → 写系统剪贴板 → 把 Ctrl+V 发到当前前台输入框（微信 / 记事本 / WebUI 都行）
- 右上角 − 收成小圆钮、× 隐藏面板（程序顶栏「📋 全局填入」可再打开）
- 置顶 + 不抢焦点（WS_EX_NOACTIVATE），点面板不会弄丢光标
- 纯 ctypes 原生 Win32，无第三方依赖
"""
import ctypes
import ctypes.wintypes as wt
import threading
import time

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

# ---- 窗口样式常量 ----
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_CHILD = 0x40000000
WS_VSCROLL = 0x00200000
WS_EX_NOACTIVATE = 0x08000000      # 关键：不激活（不抢焦点）
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080      # 不出现在任务栏
WS_EX_CLIENTEDGE = 0x00000200      # 输入框边框

WM_SETFONT = 0x0030
WM_COMMAND = 0x0111
WM_DESTROY = 0x0002
WM_CTLCOLORSTATIC = 0x0138         # 静态文字上色（深色背景 + 白字）

BS_PUSHBUTTON = 0x00000000
BS_MULTILINE = 0x00002000          # 按钮文字换行
SS_LEFT = 0x00000000
ES_LEFT = 0x0000
ES_MULTILINE = 0x0004
ES_AUTOVSCROLL = 0x0040

VK_CONTROL = 0x11                  # 模拟 Ctrl+V 用
KEYEVENTF_KEYUP = 0x0002
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

# 控件 ID（WM_COMMAND 里区分按钮）
ID_FILL_POS = 1
ID_FILL_NEG = 2
ID_PILL = 5                        # 收起后的小圆钮
ID_MINI = 6                        # 收起 −
ID_CLOSE = 7                       # 关闭 ×

# ---- 显式声明函数签名（64 位下句柄必须按指针传，否则会被截断） ----
WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_longlong, wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint), ("style", ctypes.c_uint),
        ("lpfnWndProc", WNDPROC), ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
        ("hInstance", wt.HINSTANCE),
        ("hIcon", ctypes.c_void_p), ("hCursor", ctypes.c_void_p),
        ("hbrBackground", wt.HBRUSH), ("lpszMenuName", wt.LPCWSTR),
        ("lpszClassName", wt.LPCWSTR), ("hIconSm", ctypes.c_void_p),
    ]


kernel32.GetModuleHandleW.restype = wt.HMODULE
kernel32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
kernel32.GlobalAlloc.restype = wt.HANDLE
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [wt.HANDLE]
kernel32.GlobalUnlock.restype = ctypes.c_int
kernel32.GlobalUnlock.argtypes = [wt.HANDLE]

user32.CreateWindowExW.restype = wt.HWND
user32.CreateWindowExW.argtypes = [
    ctypes.c_uint32, wt.LPCWSTR, wt.LPCWSTR, ctypes.c_uint32,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wt.HWND, wt.HMENU, wt.HINSTANCE, ctypes.c_void_p]
user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int,
                                ctypes.c_int, ctypes.c_int, ctypes.c_uint]
user32.SetForegroundWindow.argtypes = [wt.HWND]
user32.SetWindowTextW.argtypes = [wt.HWND, wt.LPCWSTR]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetFocus.restype = wt.HWND
user32.SetFocus.argtypes = [wt.HWND]
user32.GetForegroundWindow.restype = wt.HWND
user32.SendMessageW.restype = ctypes.c_longlong
user32.SendMessageW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
user32.DefWindowProcW.restype = ctypes.c_longlong
user32.DefWindowProcW.argtypes = [wt.HWND, ctypes.c_uint, wt.WPARAM, wt.LPARAM]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wt.MSG)]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wt.MSG)]
user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, ctypes.c_uint, ctypes.c_uint]
gdi32.CreateFontW.restype = wt.HANDLE
gdi32.CreateSolidBrush.restype = wt.HBRUSH
gdi32.CreateSolidBrush.argtypes = [ctypes.c_uint32]       # COLORREF
gdi32.SetTextColor.restype = ctypes.c_uint32
gdi32.SetTextColor.argtypes = [ctypes.c_void_p, ctypes.c_uint32]   # (HDC, COLORREF)
gdi32.SetBkColor.restype = ctypes.c_uint32
gdi32.SetBkColor.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
# 剪贴板：句柄必须按指针传，否则 64 位下被截断成 32 位，写不进去
user32.OpenClipboard.restype = ctypes.c_int
user32.OpenClipboard.argtypes = [wt.HWND]
user32.EmptyClipboard.restype = ctypes.c_int
user32.SetClipboardData.restype = wt.HANDLE
user32.SetClipboardData.argtypes = [ctypes.c_uint, wt.HANDLE]
user32.CloseClipboard.restype = ctypes.c_int

# 配色（深色，贴近主程序）
_BG = 0x00241F1E        # COLORREF 是 0x00BBGGRR；深灰蓝 1E2428 → BB=28,G=24,R=1E
_TEXT = 0x00F0E6E6      # 接近白
_MUTED = 0x00968A8A     # 次要文字
_ACCENT = 0x00A87A3D    # 品牌色（淡金）

# 面板句柄与内容
_panel = {"hwnd": None, "edit_pos": None, "edit_neg": None, "btns": [],
          "title": None, "mini": None, "close": None, "pill": None,
          "target": None, "collapsed": False, "visible": False,
          "W": 380, "H": 232}
_thread = None
_font = None
_font_title = None
_brush = None


def status():
    """给前端查询：面板是否运行 / 当前是否可见"""
    return {"running": is_running(), "visible": bool(_panel.get("visible"))}


def set_text(pos, neg):
    """同步面板文本框（程序里提示词变化时调用；正在面板里编辑的那一框不动）"""
    for key, val in (("edit_pos", pos or ""), ("edit_neg", neg or "")):
        h = _panel.get(key)
        if not h:
            continue
        if user32.GetFocus() == h:          # 用户正在这框里打字，别覆盖
            continue
        if _ctrl_text(h) != val:
            user32.SetWindowTextW(h, val)


def _ctrl_text(h):
    n = user32.GetWindowTextLengthW(h)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(h, buf, n + 1)
    return buf.value


def _set_clipboard(text):
    """把文本放进系统剪贴板"""
    try:
        user32.OpenClipboard(None)
        user32.EmptyClipboard()
        buf = ctypes.create_unicode_buffer(text)
        size = (len(text) + 1) * 2
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        p = kernel32.GlobalLock(h)
        ctypes.memmove(p, buf, size)
        kernel32.GlobalUnlock(h)
        user32.SetClipboardData(CF_UNICODETEXT, h)
        user32.CloseClipboard()
        return True
    except Exception:
        try:
            user32.CloseClipboard()
        except Exception:
            pass
        return False


def _send_paste(hwnd):
    """把 Ctrl+V 发到指定窗口（先把前台焦点还给它）"""
    try:
        if hwnd:
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.08)
        user32.keybd_event(VK_CONTROL, 0, 0, 0)
        user32.keybd_event(ord("V"), 0, 0, 0)
        user32.keybd_event(ord("V"), 0, KEYEVENTF_KEYUP, 0)
        user32.keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
        return True
    except Exception:
        return False


def _fill(kind):
    """kind: pos / neg —— 用面板文本框里的内容（以面板为准）填入前台输入框"""
    h = _panel.get("edit_pos" if kind == "pos" else "edit_neg")
    text = _ctrl_text(h).strip() if h else ""
    if not text:
        return
    if not _set_clipboard(text):
        return
    # 面板不抢焦点，点按钮那一刻的前台窗口就是用户正在用的输入框
    target = user32.GetForegroundWindow() or _panel.get("target")
    _send_paste(target)


def _show():
    hwnd = _panel.get("hwnd")
    if not hwnd:
        return
    _panel["target"] = user32.GetForegroundWindow()
    _set_collapsed(False)
    user32.ShowWindow(hwnd, 1)                          # SW_SHOWNORMAL
    user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002)  # HWND_TOPMOST
    _panel["visible"] = True


def _hide():
    hwnd = _panel.get("hwnd")
    if hwnd:
        user32.ShowWindow(hwnd, 0)
    _panel["visible"] = False


def _set_collapsed(collapsed):
    """True=收成小圆钮；False=展开完整面板。窗口尺寸跟着变"""
    hwnd = _panel.get("hwnd")
    if not hwnd:
        return
    W, H = _panel["W"], _panel["H"]
    show_full = 0 if collapsed else 1        # SW_HIDE / SW_SHOW
    show_pill = 1 if collapsed else 0
    for c in (_panel.get("edit_pos"), _panel.get("edit_neg"), *_panel.get("btns", []),
              _panel.get("title"), _panel.get("mini"), _panel.get("close")):
        if c:
            user32.ShowWindow(c, show_full)
    if _panel.get("pill"):
        user32.ShowWindow(_panel["pill"], show_pill)
    cw, ch = (136, 56) if collapsed else (W, H)
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    user32.SetWindowPos(hwnd, -1, sw - cw - 24, sh - ch - 90, cw, ch, 0x0004)  # SWP_NOZORDER
    _panel["collapsed"] = collapsed


def _make_font(height=14, weight=400):
    return gdi32.CreateFontW(
        height, 0, 0, 0, weight, 0, 0, 0, 1, 0, 0, 0, 0, "Microsoft YaHei UI")


def _create_window(hinst):
    cls_name = "WLGlobalPanelCls"
    global _font, _font_title, _brush

    def wndproc(hwnd, msg, wparam, lparam):
        if msg == WM_COMMAND:
            low = wparam & 0xFFFF
            if low == ID_FILL_POS:
                _fill("pos")
            elif low == ID_FILL_NEG:
                _fill("neg")
            elif low == ID_PILL:
                _set_collapsed(False)        # 点小圆钮 → 展开
            elif low == ID_MINI:
                _set_collapsed(True)         # 点 − → 收起
            elif low == ID_CLOSE:
                _hide()                      # 点 × → 隐藏（顶栏「📋 全局填入」可再打开）
            return 0
        elif msg == WM_CTLCOLORSTATIC:       # 静态文字：深色底 + 白字
            hdc = wparam
            gdi32.SetTextColor(hdc, _TEXT)
            gdi32.SetBkColor(hdc, _BG)
            return _brush
        elif msg == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    proc = WNDPROC(wndproc)
    wc = WNDCLASSEXW()
    wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
    wc.lpfnWndProc = proc
    wc.hInstance = hinst
    wc.lpszClassName = cls_name
    _brush = gdi32.CreateSolidBrush(_BG)
    wc.hbrBackground = _brush
    user32.RegisterClassExW(ctypes.byref(wc))

    W, H = _panel["W"], _panel["H"]
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    hwnd = user32.CreateWindowExW(
        WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        cls_name, "全局提示词",
        WS_POPUP | WS_VISIBLE,
        sw - W - 24, sh - H - 90, W, H,
        None, None, hinst, None)
    if not hwnd:
        return None

    _font = _make_font(14)
    _font_title = _make_font(15, 600)

    bw = 96                              # 右侧按钮宽
    ew = W - 24 - bw - 8                 # 文本框宽

    # 标题 + 收起 − / 关闭 ×
    title = user32.CreateWindowExW(
        0, "STATIC", "全局提示词", WS_CHILD | WS_VISIBLE | SS_LEFT,
        14, 10, 200, 22, hwnd, None, hinst, None)
    if title:
        user32.SendMessageW(title, WM_SETFONT, _font_title, 1)
    _panel["title"] = title
    mini = user32.CreateWindowExW(
        0, "BUTTON", "−", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        W - 76, 8, 28, 24, hwnd, ctypes.c_void_p(ID_MINI), hinst, None)
    if mini:
        user32.SendMessageW(mini, WM_SETFONT, _font, 1)
    _panel["mini"] = mini
    close = user32.CreateWindowExW(
        0, "BUTTON", "×", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
        W - 44, 8, 28, 24, hwnd, ctypes.c_void_p(ID_CLOSE), hinst, None)
    if close:
        user32.SendMessageW(close, WM_SETFONT, _font, 1)
    _panel["close"] = close

    # 两个多行文本框（正向 / 反向），各配一行小标注 + 右侧「替换为…」按钮
    rows = [("正向提示词", "edit_pos", ID_FILL_POS, "替换为\r\n正向提示词", 40),
            ("反向提示词", "edit_neg", ID_FILL_NEG, "替换为\r\n反向提示词", 40 + 94)]
    _panel["btns"] = []
    for label, key, cid, btxt, y in rows:
        cap = user32.CreateWindowExW(
            0, "STATIC", label, WS_CHILD | WS_VISIBLE | SS_LEFT,
            14, y, ew, 18, hwnd, None, hinst, None)
        if cap:
            user32.SendMessageW(cap, WM_SETFONT, _font, 1)
        edit = user32.CreateWindowExW(
            WS_EX_CLIENTEDGE, "EDIT", "",
            WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_LEFT | ES_MULTILINE | ES_AUTOVSCROLL,
            14, y + 20, ew, 66, hwnd, None, hinst, None)
        if edit:
            user32.SendMessageW(edit, WM_SETFONT, _font, 1)
        _panel[key] = edit
        b = user32.CreateWindowExW(
            0, "BUTTON", btxt,
            WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON | BS_MULTILINE,
            14 + ew + 8, y + 22, bw, 64, hwnd, ctypes.c_void_p(cid), hinst, None)
        if b:
            user32.SendMessageW(b, WM_SETFONT, _font, 1)
        _panel["btns"].append(b)

    # 收起后显示的小圆钮（平时藏着）
    pill = user32.CreateWindowExW(
        0, "BUTTON", "📋 填入", WS_CHILD | BS_PUSHBUTTON,
        8, 8, 120, 36, hwnd, ctypes.c_void_p(ID_PILL), hinst, None)
    if pill:
        user32.SendMessageW(pill, WM_SETFONT, _font, 1)
    _panel["pill"] = pill

    _panel["hwnd"] = hwnd
    _panel["proc"] = proc
    _hide()          # 默认关闭：启动时只在后台待命，顶栏「📋 打开面板」再唤出
    return hwnd


def _panel_thread():
    """面板线程：建窗口（常驻显示）+ 跑消息循环"""
    hinst = kernel32.GetModuleHandleW(None)
    if not _create_window(hinst):
        return
    msg = wt.MSG()
    while True:
        r = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
        if r == 0 or r == -1:
            break
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def start():
    """启动全局提示词面板（后台线程，常驻显示；已启动则忽略）"""
    global _thread
    if _thread and _thread.is_alive():
        return False
    _thread = threading.Thread(target=_panel_thread, daemon=True)
    _thread.start()
    return True


def show():
    """顶栏「📋 全局填入」打开面板"""
    _show()


def hide():
    """顶栏「📋 全局填入」关闭面板（进程仍在，只是看不见）"""
    _hide()


def is_running():
    return bool(_thread and _thread.is_alive())
