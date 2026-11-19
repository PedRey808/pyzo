// BatteryTray — процент заряда беспроводных устройств прямо на панели задач Windows.
//
// Источники данных:
//   * Bluetooth-устройства (наушники, мыши, клавиатуры, геймпады): свойство PnP
//     {104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2 — то же, что показывает «Параметры → Bluetooth».
//   * Xbox-геймпады (беспроводной адаптер / Bluetooth): XInputGetBatteryInformation
//     (только 4 уровня, поэтому показывается приблизительно: «~60%»).
//
// Сборка (MinGW-w64):
//   x86_64-w64-mingw32-g++ -std=c++17 -O2 -s -static -municode -mwindows battery_tray.cpp
//       -o BatteryTray.exe -lsetupapi -lgdiplus -lshell32 -ladvapi32 -lole32

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <windows.h>
#include <initguid.h>
#include <devpkey.h>
#include <setupapi.h>
#include <shellapi.h>
#include <gdiplus.h>
#include <xinput.h>

#include <algorithm>
#include <cwchar>
#include <cwctype>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace gp = Gdiplus;

// Уровень заряда Bluetooth-устройства (DEVPROP_TYPE_BYTE, 0..100).
DEFINE_DEVPROPKEY(PKEY_BtBattery, 0x104ea319, 0x6ee2, 0x4701, 0xbd, 0x47, 0x8d, 0xdb, 0xf4, 0x25, 0xbb, 0xe5, 2);
// Признак «подключено» у Bluetooth-узлов (DEVPROP_TYPE_BOOLEAN).
DEFINE_DEVPROPKEY(PKEY_IsConnected, 0x83da6326, 0x97a6, 0x4088, 0x94, 0x53, 0xa1, 0x92, 0x3f, 0x57, 0x3b, 0x29, 15);

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------
static const wchar_t* kAppName = L"BatteryTray";
static const wchar_t* kMainClass = L"BatteryTrayMain";
static const wchar_t* kOverlayClass = L"BatteryTrayOverlay";
static const wchar_t* kRunKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";

enum : UINT {
    WM_APP_TRAY = WM_APP + 1,
    WM_APP_DATA = WM_APP + 2,
};

enum : UINT_PTR {
    TIMER_LAYOUT = 1,
    TIMER_DEVCHANGE = 2,
};

enum : UINT {
    ID_REFRESH = 100,
    ID_OVERLAY,
    ID_LEFT,
    ID_RIGHT,
    ID_RESET,
    ID_NOTIFY,
    ID_AUTOSTART,
    ID_OPENINI,
    ID_EXIT,
};

enum class Kind { Generic, Headphones, Mouse, Keyboard, Gamepad };

struct Device {
    std::wstring id;
    std::wstring name;
    int level = 0;       // 0..100
    bool approx = false; // XInput отдаёт только 4 уровня
    Kind kind = Kind::Generic;
};

struct Settings {
    int offsetX = 0;
    int intervalSec = 30;
    int lowThreshold = 15;
    bool overlay = true;
    bool notify = true;
    std::vector<std::wstring> exclude; // подстроки имён в нижнем регистре
};

// ---------------------------------------------------------------------------
// Глобальное состояние
// ---------------------------------------------------------------------------
static HINSTANCE g_inst;
static HWND g_main;
static HWND g_overlay;
static UINT g_msgTaskbarCreated;
static Settings g_cfg;
static std::wstring g_iniPath;
static std::wstring g_exePath;

static CRITICAL_SECTION g_lock;
static std::vector<Device> g_shared; // пишет рабочий поток, читает UI
static std::vector<Device> g_devices; // копия для UI-потока
static HANDLE g_wakeEvent;
static volatile LONG g_quit;
static HANDLE g_worker;

static HICON g_trayIcon;
static bool g_lightTheme;
static std::set<std::wstring> g_notified;
static std::wstring g_lastSignature;
static float g_scale = 1.0f;

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
static std::wstring Lower(std::wstring s) {
    for (auto& c : s) c = (wchar_t)towlower(c);
    return s;
}

static bool StartsWithI(const std::wstring& s, const wchar_t* prefix) {
    size_t n = wcslen(prefix);
    return s.size() >= n && _wcsnicmp(s.c_str(), prefix, n) == 0;
}

static bool ContainsAny(const std::wstring& lowerHay, std::initializer_list<const wchar_t*> needles) {
    for (auto n : needles)
        if (lowerHay.find(n) != std::wstring::npos) return true;
    return false;
}

static std::wstring Trim(const std::wstring& s) {
    size_t a = s.find_first_not_of(L" \t\r\n");
    if (a == std::wstring::npos) return L"";
    size_t b = s.find_last_not_of(L" \t\r\n");
    return s.substr(a, b - a + 1);
}

// ---------------------------------------------------------------------------
// Настройки (battery-tray.ini рядом с exe)
// ---------------------------------------------------------------------------
static int IniInt(const wchar_t* key, int def) {
    wchar_t buf[32];
    GetPrivateProfileStringW(L"Settings", key, L"", buf, 32, g_iniPath.c_str());
    if (!buf[0]) return def;
    return _wtoi(buf);
}

static void IniSetInt(const wchar_t* key, int v) {
    WritePrivateProfileStringW(L"Settings", key, std::to_wstring(v).c_str(), g_iniPath.c_str());
}

static void WriteDefaultIni() {
    if (GetFileAttributesW(g_iniPath.c_str()) != INVALID_FILE_ATTRIBUTES) return;
    // UTF-16 LE с BOM — тогда в Exclude можно писать имена на кириллице.
    const wchar_t* text =
        L"; Настройки BatteryTray. После правки: меню в трее → «Обновить сейчас».\r\n"
        L"[Settings]\r\n"
        L"; Сдвиг по горизонтали в пикселях (минус — левее, плюс — правее)\r\n"
        L"OffsetX=0\r\n"
        L"; Как часто опрашивать устройства, секунд (минимум 5)\r\n"
        L"IntervalSec=30\r\n"
        L"; Порог низкого заряда, %\r\n"
        L"LowThreshold=15\r\n"
        L"; 1 — показывать проценты на панели задач, 0 — только иконка в трее\r\n"
        L"ShowOverlay=1\r\n"
        L"; 1 — уведомлять, когда заряд ниже порога\r\n"
        L"Notify=1\r\n"
        L"; Скрыть устройства: части имён через точку с запятой, например: AirPods;Xbox\r\n"
        L"Exclude=\r\n";
    HANDLE f = CreateFileW(g_iniPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD w;
    WORD bom = 0xFEFF;
    WriteFile(f, &bom, sizeof bom, &w, nullptr);
    WriteFile(f, text, (DWORD)(wcslen(text) * sizeof(wchar_t)), &w, nullptr);
    CloseHandle(f);
}

static void LoadSettings() {
    g_cfg.offsetX = IniInt(L"OffsetX", 0);
    g_cfg.intervalSec = (std::max)(5, IniInt(L"IntervalSec", 30));
    g_cfg.lowThreshold = (std::min)(100, (std::max)(0, IniInt(L"LowThreshold", 15)));
    g_cfg.overlay = IniInt(L"ShowOverlay", 1) != 0;
    g_cfg.notify = IniInt(L"Notify", 1) != 0;

    g_cfg.exclude.clear();
    wchar_t buf[2048];
    GetPrivateProfileStringW(L"Settings", L"Exclude", L"", buf, 2048, g_iniPath.c_str());
    std::wstring all = buf, part;
    for (size_t i = 0; i <= all.size(); ++i) {
        if (i == all.size() || all[i] == L';') {
            part = Lower(Trim(part));
            if (!part.empty()) g_cfg.exclude.push_back(part);
            part.clear();
        } else {
            part += all[i];
        }
    }
}

// ---------------------------------------------------------------------------
// Автозапуск
// ---------------------------------------------------------------------------
static bool AutostartEnabled() {
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_READ, &k) != ERROR_SUCCESS) return false;
    wchar_t val[MAX_PATH * 2] = {};
    DWORD size = sizeof val, type = 0;
    LONG r = RegQueryValueExW(k, kAppName, nullptr, &type, (BYTE*)val, &size);
    RegCloseKey(k);
    return r == ERROR_SUCCESS && type == REG_SZ && Lower(val).find(Lower(g_exePath)) != std::wstring::npos;
}

static void SetAutostart(bool on) {
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
    if (on) {
        std::wstring cmd = L"\"" + g_exePath + L"\"";
        RegSetValueExW(k, kAppName, 0, REG_SZ, (const BYTE*)cmd.c_str(), (DWORD)((cmd.size() + 1) * sizeof(wchar_t)));
    } else {
        RegDeleteValueW(k, kAppName);
    }
    RegCloseKey(k);
}

static bool ReadLightTheme() {
    DWORD v = 0, size = sizeof v;
    if (RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
                     L"SystemUsesLightTheme", RRF_RT_REG_DWORD, nullptr, &v, &size) != ERROR_SUCCESS)
        return false;
    return v != 0;
}

// ---------------------------------------------------------------------------
// Опрос устройств (рабочий поток)
// ---------------------------------------------------------------------------
static bool GetProp(HDEVINFO h, SP_DEVINFO_DATA* d, const DEVPROPKEY& key, DEVPROPTYPE want, std::vector<BYTE>& out) {
    DEVPROPTYPE type = 0;
    DWORD req = 0;
    SetupDiGetDevicePropertyW(h, d, &key, &type, nullptr, 0, &req, 0);
    if (req == 0) return false;
    out.assign(req + sizeof(wchar_t), 0); // запас под терминатор строки
    if (!SetupDiGetDevicePropertyW(h, d, &key, &type, out.data(), req, &req, 0)) return false;
    return type == want;
}

static std::wstring GetStrProp(HDEVINFO h, SP_DEVINFO_DATA* d, const DEVPROPKEY& key, std::vector<BYTE>& buf) {
    if (!GetProp(h, d, key, DEVPROP_TYPE_STRING, buf)) return L"";
    return std::wstring((const wchar_t*)buf.data());
}

struct Node {
    std::wstring inst, name, cls;
    int battery = -1;
    int connected = -1; // -1 неизвестно, 0 нет, 1 да
};

static Kind GuessKind(const std::vector<Node>& nodes, const std::wstring& name) {
    bool audio = false, mouse = false, kbd = false, pad = false;
    for (auto& n : nodes) {
        std::wstring c = Lower(n.cls);
        if (c == L"audioendpoint" || c == L"media") audio = true;
        if (c == L"mouse") mouse = true;
        if (c == L"keyboard") kbd = true;
        if (c == L"xnacomposite" || c == L"xboxcomposite") pad = true;
    }
    std::wstring ln = Lower(name);
    if (pad || ContainsAny(ln, {L"controller", L"gamepad", L"xbox", L"dualsense", L"dualshock", L"joy-con", L"геймпад"}))
        return Kind::Gamepad;
    if (audio || ContainsAny(ln, {L"headset", L"headphone", L"buds", L"airpods", L"earbud", L"наушник", L"гарнитур"}))
        return Kind::Headphones;
    if (mouse || ContainsAny(ln, {L"mouse", L"мыш"})) return Kind::Mouse;
    if (kbd || ContainsAny(ln, {L"keyboard", L"клавиатур"})) return Kind::Keyboard;
    return Kind::Generic;
}

static bool Excluded(const std::wstring& name, const std::vector<std::wstring>& exclude) {
    std::wstring ln = Lower(name);
    for (auto& e : exclude)
        if (ln.find(e) != std::wstring::npos) return true;
    return false;
}

static void ScanBluetooth(std::vector<Device>& out, const std::vector<std::wstring>& exclude) {
    HDEVINFO h = SetupDiGetClassDevsW(nullptr, nullptr, nullptr, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    if (h == INVALID_HANDLE_VALUE) return;

    // Узлы одного физического устройства объединяем по ContainerId.
    std::map<std::wstring, std::vector<Node>> groups;
    std::vector<BYTE> buf;
    SP_DEVINFO_DATA d{};
    d.cbSize = sizeof d;
    for (DWORD i = 0; SetupDiEnumDeviceInfo(h, i, &d); ++i) {
        Node n;
        wchar_t inst[512];
        if (SetupDiGetDeviceInstanceIdW(h, &d, inst, 512, nullptr)) n.inst = inst;

        std::wstring key;
        if (GetProp(h, &d, DEVPKEY_Device_ContainerId, DEVPROP_TYPE_GUID, buf)) {
            const GUID& g = *(const GUID*)buf.data();
            wchar_t s[64];
            swprintf(s, 64, L"%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X", (unsigned long)g.Data1, g.Data2,
                     g.Data3, g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3], g.Data4[4], g.Data4[5], g.Data4[6],
                     g.Data4[7]);
            key = s;
        }
        // Корневой контейнер «этот компьютер» — не объединяем, иначе всё железо попадёт в одну кучу.
        if (key.empty() || key == L"00000000-0000-0000-FFFF-FFFFFFFFFFFF") key = L"inst:" + n.inst;

        if (GetProp(h, &d, PKEY_BtBattery, DEVPROP_TYPE_BYTE, buf)) n.battery = buf[0];
        if (GetProp(h, &d, PKEY_IsConnected, DEVPROP_TYPE_BOOLEAN, buf))
            n.connected = (*(const DEVPROP_BOOLEAN*)buf.data() != DEVPROP_FALSE) ? 1 : 0;

        n.name = GetStrProp(h, &d, DEVPKEY_Device_FriendlyName, buf);
        if (n.name.empty()) n.name = GetStrProp(h, &d, DEVPKEY_Device_DeviceDesc, buf);

        wchar_t cls[128] = {};
        if (SetupDiGetDeviceRegistryPropertyW(h, &d, SPDRP_CLASS, nullptr, (PBYTE)cls, sizeof cls - sizeof(wchar_t),
                                              nullptr))
            n.cls = cls;

        groups[key].push_back(std::move(n));
    }
    SetupDiDestroyDeviceInfoList(h);

    for (auto& kv : groups) {
        auto& nodes = kv.second;
        int battery = -1;
        bool connTrue = false, connFalse = false;
        std::wstring batteryNodeName, mainName;
        for (auto& n : nodes) {
            if (n.battery >= 0 && n.battery > battery) {
                battery = n.battery;
                batteryNodeName = n.name;
            }
            if (n.connected == 1) connTrue = true;
            if (n.connected == 0) connFalse = true;
            // Основной узел устройства: BTHENUM\DEV_xxx или BTHLE\DEV_xxx — у него «человеческое» имя.
            if (!n.name.empty() && mainName.empty() &&
                (StartsWithI(n.inst, L"BTHENUM\\DEV_") || StartsWithI(n.inst, L"BTHLE\\DEV_")))
                mainName = n.name;
        }
        if (battery < 0 || battery > 100) continue;
        if (connFalse && !connTrue) continue; // сопряжено, но сейчас не подключено — значение устарело

        Device dev;
        dev.id = kv.first;
        dev.name = !mainName.empty() ? mainName : (!batteryNodeName.empty() ? batteryNodeName : L"Bluetooth");
        dev.level = battery;
        dev.kind = GuessKind(nodes, dev.name);
        if (Excluded(dev.name, exclude)) continue;
        out.push_back(std::move(dev));
    }
}

typedef DWORD(WINAPI* PFN_XInputGetBatteryInformation)(DWORD, BYTE, XINPUT_BATTERY_INFORMATION*);

static void ScanXInput(std::vector<Device>& out, const std::vector<std::wstring>& exclude) {
    static PFN_XInputGetBatteryInformation fn = nullptr;
    static bool tried = false;
    if (!tried) {
        tried = true;
        HMODULE m = LoadLibraryW(L"xinput1_4.dll");
        if (m) fn = (PFN_XInputGetBatteryInformation)(void*)GetProcAddress(m, "XInputGetBatteryInformation");
    }
    if (!fn) return;

    for (DWORD user = 0; user < 4; ++user) {
        XINPUT_BATTERY_INFORMATION bi{};
        if (fn(user, BATTERY_DEVTYPE_GAMEPAD, &bi) != ERROR_SUCCESS) continue;
        if (bi.BatteryType == BATTERY_TYPE_DISCONNECTED || bi.BatteryType == BATTERY_TYPE_WIRED) continue;
        static const int levels[] = {5, 30, 65, 100}; // EMPTY, LOW, MEDIUM, FULL
        Device dev;
        dev.id = L"xinput:" + std::to_wstring(user);
        dev.name = L"Xbox-геймпад " + std::to_wstring(user + 1);
        dev.level = levels[bi.BatteryLevel > 3 ? 3 : bi.BatteryLevel];
        dev.approx = true;
        dev.kind = Kind::Gamepad;
        if (Excluded(dev.name, exclude)) continue;
        out.push_back(std::move(dev));
    }
}

static DWORD WINAPI WorkerProc(LPVOID) {
    while (!g_quit) {
        EnterCriticalSection(&g_lock);
        std::vector<std::wstring> exclude = g_cfg.exclude;
        DWORD intervalMs = (DWORD)g_cfg.intervalSec * 1000;
        LeaveCriticalSection(&g_lock);

        std::vector<Device> list;
        ScanBluetooth(list, exclude);
        ScanXInput(list, exclude);
        std::stable_sort(list.begin(), list.end(),
                         [](const Device& a, const Device& b) { return (int)a.kind < (int)b.kind; });

        EnterCriticalSection(&g_lock);
        g_shared = std::move(list);
        LeaveCriticalSection(&g_lock);
        PostMessageW(g_main, WM_APP_DATA, 0, 0);

        WaitForSingleObject(g_wakeEvent, intervalMs);
    }
    return 0;
}

static void RequestRefresh() { SetEvent(g_wakeEvent); }

// ---------------------------------------------------------------------------
// Отрисовка
// ---------------------------------------------------------------------------
static const wchar_t* Glyph(Kind k) {
    // Коды одинаковы в «Segoe Fluent Icons» (Win11) и «Segoe MDL2 Assets» (Win10).
    switch (k) {
        case Kind::Headphones: return L"";
        case Kind::Mouse: return L"";
        case Kind::Keyboard: return L"";
        case Kind::Gamepad: return L"";
        default: return L""; // Bluetooth
    }
}

static std::wstring LevelText(const Device& d) {
    return (d.approx ? L"~" : L"") + std::to_wstring(d.level) + L"%";
}

static gp::Color TextColor(bool low) {
    if (low) return g_lightTheme ? gp::Color(255, 196, 43, 28) : gp::Color(255, 255, 99, 99);
    return g_lightTheme ? gp::Color(255, 0, 0, 0) : gp::Color(255, 255, 255, 255);
}

static bool TaskbarInfo(RECT& tb, UINT& edge, RECT& monitor) {
    APPBARDATA abd{};
    abd.cbSize = sizeof abd;
    if (!SHAppBarMessage(ABM_GETTASKBARPOS, &abd)) return false;
    tb = abd.rc;
    edge = abd.uEdge;
    MONITORINFO mi{};
    mi.cbSize = sizeof mi;
    GetMonitorInfoW(MonitorFromRect(&tb, MONITOR_DEFAULTTOPRIMARY), &mi);
    monitor = mi.rcMonitor;
    return true;
}

static bool FullscreenAppActive(const RECT& taskbarMonitor) {
    QUERY_USER_NOTIFICATION_STATE st;
    if (SUCCEEDED(SHQueryUserNotificationState(&st)) &&
        (st == QUNS_BUSY || st == QUNS_RUNNING_D3D_FULL_SCREEN || st == QUNS_PRESENTATION_MODE))
        return true;

    HWND fg = GetForegroundWindow();
    if (!fg) return false;
    wchar_t cls[64] = {};
    GetClassNameW(fg, cls, 64);
    if (!wcscmp(cls, L"Progman") || !wcscmp(cls, L"WorkerW") || !wcscmp(cls, L"Shell_TrayWnd") ||
        !wcscmp(cls, L"Shell_SecondaryTrayWnd"))
        return false;
    RECT r;
    if (!GetWindowRect(fg, &r)) return false;
    return r.left <= taskbarMonitor.left && r.top <= taskbarMonitor.top && r.right >= taskbarMonitor.right &&
           r.bottom >= taskbarMonitor.bottom;
}

struct FontSet {
    gp::FontFamily* iconFamily = nullptr;
    gp::FontFamily* textFamily = nullptr;
    gp::Font* icon = nullptr;
    gp::Font* text = nullptr;
};

static FontSet& Fonts() {
    static FontSet fs;
    static float builtFor = 0;
    if (builtFor != g_scale) {
        delete fs.icon;
        delete fs.text;
        delete fs.iconFamily;
        delete fs.textFamily;
        fs.iconFamily = new gp::FontFamily(L"Segoe Fluent Icons");
        if (fs.iconFamily->GetLastStatus() != gp::Ok) {
            delete fs.iconFamily;
            fs.iconFamily = new gp::FontFamily(L"Segoe MDL2 Assets");
        }
        fs.icon = new gp::Font(fs.iconFamily, 15.0f * g_scale, gp::FontStyleRegular, gp::UnitPixel);
        fs.textFamily = new gp::FontFamily(L"Segoe UI Variable Text");
        if (fs.textFamily->GetLastStatus() != gp::Ok) {
            delete fs.textFamily;
            fs.textFamily = new gp::FontFamily(L"Segoe UI");
        }
        fs.text = new gp::Font(fs.textFamily, 12.5f * g_scale, gp::FontStyleRegular, gp::UnitPixel);
        builtFor = g_scale;
    }
    return fs;
}

struct ItemLayout {
    std::wstring glyph, text;
    bool low;
    float iconW, textW, width;
};

static void HideOverlay() {
    if (IsWindowVisible(g_overlay)) ShowWindow(g_overlay, SW_HIDE);
    g_lastSignature.clear();
}

static void RenderOverlay(bool force) {
    RECT tb, mon;
    UINT edge;
    if (!g_cfg.overlay || g_devices.empty() || !TaskbarInfo(tb, edge, mon)) return HideOverlay();

    // Автоскрытие панели задач: от неё на экране остаётся пара пикселей.
    RECT vis;
    if (!IntersectRect(&vis, &tb, &mon) || (vis.right - vis.left) < 10 || (vis.bottom - vis.top) < 10)
        return HideOverlay();
    if (FullscreenAppActive(mon)) return HideOverlay();

    const bool horizontal = (edge == ABE_BOTTOM || edge == ABE_TOP);

    // Ориентир — левый (или верхний) край области уведомлений.
    RECT notify{};
    bool haveNotify = false;
    if (HWND tray = FindWindowW(L"Shell_TrayWnd", nullptr)) {
        if (HWND nw = FindWindowExW(tray, nullptr, L"TrayNotifyWnd", nullptr)) {
            if (GetWindowRect(nw, &notify) && notify.right > notify.left && notify.bottom > notify.top) {
                RECT tmp;
                haveNotify = IntersectRect(&tmp, &notify, &tb) != 0;
                if (horizontal && notify.left < tb.left + (tb.right - tb.left) / 2) haveNotify = false;
            }
        }
    }

    FontSet& fs = Fonts();
    gp::StringFormat fmt(gp::StringFormat::GenericTypographic());
    fmt.SetFormatFlags(fmt.GetFormatFlags() | gp::StringFormatFlagsMeasureTrailingSpaces | gp::StringFormatFlagsNoWrap);

    std::vector<ItemLayout> items;
    std::wstring sig;
    {
        gp::Bitmap probe(1, 1, PixelFormat32bppPARGB);
        gp::Graphics g(&probe);
        g.SetTextRenderingHint(gp::TextRenderingHintAntiAlias);
        for (auto& d : g_devices) {
            ItemLayout it;
            it.glyph = Glyph(d.kind);
            it.text = LevelText(d);
            it.low = d.level <= g_cfg.lowThreshold;
            gp::RectF b1, b2;
            g.MeasureString(it.glyph.c_str(), -1, fs.icon, gp::PointF(0, 0), &fmt, &b1);
            g.MeasureString(it.text.c_str(), -1, fs.text, gp::PointF(0, 0), &fmt, &b2);
            it.iconW = b1.Width;
            it.textW = b2.Width;
            it.width = it.iconW + 5.0f * g_scale + it.textW;
            items.push_back(it);
            sig += it.glyph + it.text + (it.low ? L"!" : L"") + L"|";
        }
    }

    const float pad = 8.0f * g_scale, gap = 14.0f * g_scale, lineH = 26.0f * g_scale;
    int x, y, w, h;
    if (horizontal) {
        float total = pad * 2;
        for (size_t i = 0; i < items.size(); ++i) total += items[i].width + (i ? gap : 0);
        w = (int)(total + 0.5f);
        h = tb.bottom - tb.top;
        int anchor = haveNotify ? notify.left : tb.right - (int)(230 * g_scale);
        x = anchor - w + g_cfg.offsetX;
        y = tb.top;
    } else {
        w = tb.right - tb.left;
        h = (int)(pad * 2 + lineH * items.size() + 0.5f);
        int anchor = haveNotify ? notify.top : tb.bottom - (int)(120 * g_scale);
        x = tb.left;
        y = anchor - h + g_cfg.offsetX;
    }
    sig += std::to_wstring(x) + L"," + std::to_wstring(y) + L"," + std::to_wstring(w) + L"," + std::to_wstring(h) +
           (g_lightTheme ? L"L" : L"D");

    if (!force && sig == g_lastSignature && IsWindowVisible(g_overlay)) {
        // Только поднимаем поверх панели задач — она любит перекрывать нас после клика.
        SetWindowPos(g_overlay, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        return;
    }
    if (w <= 0 || h <= 0) return HideOverlay();

    HDC screen = GetDC(nullptr);
    HDC mem = CreateCompatibleDC(screen);
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof bi.bmiHeader;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP dib = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    if (!dib) {
        DeleteDC(mem);
        ReleaseDC(nullptr, screen);
        return;
    }
    ZeroMemory(bits, (size_t)w * h * 4);
    {
        gp::Bitmap bmp(w, h, w * 4, PixelFormat32bppPARGB, (BYTE*)bits);
        gp::Graphics g(&bmp);
        g.SetTextRenderingHint(gp::TextRenderingHintAntiAlias);
        g.SetSmoothingMode(gp::SmoothingModeAntiAlias);

        gp::StringFormat center(&fmt);
        center.SetLineAlignment(gp::StringAlignmentCenter);

        for (size_t i = 0; i < items.size(); ++i) {
            auto& it = items[i];
            float ix, iy, ih;
            if (horizontal) {
                ix = pad;
                for (size_t j = 0; j < i; ++j) ix += items[j].width + gap;
                iy = 0;
                ih = (float)h;
            } else {
                ix = ((float)w - it.width) / 2;
                iy = pad + lineH * i;
                ih = lineH;
            }
            gp::SolidBrush iconBrush(TextColor(false));
            gp::SolidBrush textBrush(TextColor(it.low));
            g.DrawString(it.glyph.c_str(), -1, fs.icon, gp::RectF(ix, iy + 1.0f * g_scale, it.iconW + 2, ih), &center,
                         it.low ? &textBrush : &iconBrush);
            g.DrawString(it.text.c_str(), -1, fs.text,
                         gp::RectF(ix + it.iconW + 5.0f * g_scale, iy, it.textW + 2, ih), &center, &textBrush);
        }
    }

    HGDIOBJ old = SelectObject(mem, dib);
    POINT dst{x, y}, src{0, 0};
    SIZE size{w, h};
    BLENDFUNCTION bf{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    UpdateLayeredWindow(g_overlay, screen, &dst, &size, mem, &src, 0, &bf, ULW_ALPHA);
    SelectObject(mem, old);
    DeleteObject(dib);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);

    ShowWindow(g_overlay, SW_SHOWNOACTIVATE);
    SetWindowPos(g_overlay, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    g_lastSignature = sig;
}

// ---------------------------------------------------------------------------
// Иконка в трее
// ---------------------------------------------------------------------------
static HICON MakeTrayIcon() {
    int s = GetSystemMetrics(SM_CXSMICON);
    if (s <= 0) s = 16;
    int minLevel = -1;
    for (auto& d : g_devices) minLevel = minLevel < 0 ? d.level : (std::min)(minLevel, d.level);
    bool low = minLevel >= 0 && minLevel <= g_cfg.lowThreshold;

    gp::Bitmap bmp(s, s, PixelFormat32bppARGB);
    {
        gp::Graphics g(&bmp);
        g.SetSmoothingMode(gp::SmoothingModeAntiAlias);
        g.Clear(gp::Color(0, 0, 0, 0));
        float u = s / 16.0f;
        gp::Color fg = g_lightTheme ? gp::Color(255, 0, 0, 0) : gp::Color(255, 255, 255, 255);
        gp::Pen pen(fg, 1.3f * u);
        gp::RectF body(1.0f * u, 4.5f * u, 12.0f * u, 7.0f * u);
        g.DrawRectangle(&pen, body);
        gp::SolidBrush nub(fg);
        g.FillRectangle(&nub, gp::RectF(13.4f * u, 6.5f * u, 1.8f * u, 3.0f * u));
        if (minLevel >= 0) {
            gp::SolidBrush fill(low ? gp::Color(255, 232, 72, 85) : fg);
            float fw = (12.0f * u - 2.6f * u) * (std::max)(minLevel, 8) / 100.0f;
            g.FillRectangle(&fill, gp::RectF(2.3f * u, 5.8f * u, fw, 4.4f * u));
        }
    }
    HICON icon = nullptr;
    bmp.GetHICON(&icon);
    return icon;
}

static void FillTip(wchar_t* tip, size_t cap) {
    std::wstring s;
    if (g_devices.empty()) s = L"BatteryTray: устройства не найдены";
    for (auto& d : g_devices) {
        if (!s.empty()) s += L"\n";
        s += d.name + L": " + LevelText(d);
    }
    if (s.size() >= cap) s = s.substr(0, cap - 2) + L"…";
    wcsncpy(tip, s.c_str(), cap - 1);
    tip[cap - 1] = 0;
}

static void UpdateTray(bool add) {
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof nid;
    nid.hWnd = g_main;
    nid.uID = 1;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
    nid.uCallbackMessage = WM_APP_TRAY;

    HICON old = g_trayIcon;
    g_trayIcon = MakeTrayIcon();
    nid.hIcon = g_trayIcon ? g_trayIcon : LoadIconW(nullptr, IDI_APPLICATION);
    FillTip(nid.szTip, ARRAYSIZE(nid.szTip));

    if (add) {
        Shell_NotifyIconW(NIM_ADD, &nid);
        nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &nid);
    } else if (!Shell_NotifyIconW(NIM_MODIFY, &nid)) {
        Shell_NotifyIconW(NIM_ADD, &nid);
        nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &nid);
    }
    if (old) DestroyIcon(old);
}

static void RemoveTray() {
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof nid;
    nid.hWnd = g_main;
    nid.uID = 1;
    Shell_NotifyIconW(NIM_DELETE, &nid);
}

static void Balloon(const std::wstring& title, const std::wstring& text) {
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof nid;
    nid.hWnd = g_main;
    nid.uID = 1;
    nid.uFlags = NIF_INFO;
    nid.dwInfoFlags = NIIF_WARNING;
    wcsncpy(nid.szInfoTitle, title.c_str(), ARRAYSIZE(nid.szInfoTitle) - 1);
    wcsncpy(nid.szInfo, text.c_str(), ARRAYSIZE(nid.szInfo) - 1);
    Shell_NotifyIconW(NIM_MODIFY, &nid);
}

static void CheckLowBattery() {
    std::set<std::wstring> present;
    for (auto& d : g_devices) {
        present.insert(d.id);
        if (d.level <= g_cfg.lowThreshold) {
            if (g_cfg.notify && !g_notified.count(d.id))
                Balloon(L"Низкий заряд", d.name + L": " + LevelText(d) + L". Пора на зарядку.");
            g_notified.insert(d.id);
        } else if (d.level > g_cfg.lowThreshold + 5) {
            g_notified.erase(d.id);
        }
    }
    for (auto it = g_notified.begin(); it != g_notified.end();)
        it = present.count(*it) ? std::next(it) : g_notified.erase(it);
}

// ---------------------------------------------------------------------------
// Меню и оконные процедуры
// ---------------------------------------------------------------------------
static void ShowMenu() {
    HMENU m = CreatePopupMenu();
    if (g_devices.empty()) {
        AppendMenuW(m, MF_STRING | MF_GRAYED, 0, L"Устройства с батареей не найдены");
    } else {
        for (auto& d : g_devices)
            AppendMenuW(m, MF_STRING | MF_GRAYED, 0, (d.name + L"  —  " + LevelText(d)).c_str());
    }
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING, ID_REFRESH, L"Обновить сейчас");
    AppendMenuW(m, MF_STRING | (g_cfg.overlay ? MF_CHECKED : 0), ID_OVERLAY, L"Показывать на панели задач");
    AppendMenuW(m, MF_STRING | (g_cfg.overlay ? 0 : MF_GRAYED), ID_LEFT, L"Сдвинуть левее  ←");
    AppendMenuW(m, MF_STRING | (g_cfg.overlay ? 0 : MF_GRAYED), ID_RIGHT, L"Сдвинуть правее  →");
    AppendMenuW(m, MF_STRING | (g_cfg.overlay ? 0 : MF_GRAYED), ID_RESET, L"Сбросить сдвиг");
    AppendMenuW(m, MF_STRING | (g_cfg.notify ? MF_CHECKED : 0), ID_NOTIFY, L"Предупреждать о низком заряде");
    AppendMenuW(m, MF_STRING | (AutostartEnabled() ? MF_CHECKED : 0), ID_AUTOSTART, L"Запускать вместе с Windows");
    AppendMenuW(m, MF_STRING, ID_OPENINI, L"Открыть настройки…");
    AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(m, MF_STRING, ID_EXIT, L"Выход");

    POINT pt;
    GetCursorPos(&pt);
    SetForegroundWindow(g_main);
    TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_RIGHTALIGN, pt.x, pt.y, 0, g_main, nullptr);
    PostMessageW(g_main, WM_NULL, 0, 0);
    DestroyMenu(m);
}

static void OnCommand(UINT id) {
    switch (id) {
        case ID_REFRESH:
            EnterCriticalSection(&g_lock);
            LoadSettings();
            LeaveCriticalSection(&g_lock);
            RequestRefresh();
            break;
        case ID_OVERLAY:
            g_cfg.overlay = !g_cfg.overlay;
            IniSetInt(L"ShowOverlay", g_cfg.overlay);
            break;
        case ID_LEFT:
            g_cfg.offsetX -= (int)(10 * g_scale);
            IniSetInt(L"OffsetX", g_cfg.offsetX);
            break;
        case ID_RIGHT:
            g_cfg.offsetX += (int)(10 * g_scale);
            IniSetInt(L"OffsetX", g_cfg.offsetX);
            break;
        case ID_RESET:
            g_cfg.offsetX = 0;
            IniSetInt(L"OffsetX", 0);
            break;
        case ID_NOTIFY:
            g_cfg.notify = !g_cfg.notify;
            IniSetInt(L"Notify", g_cfg.notify);
            break;
        case ID_AUTOSTART:
            SetAutostart(!AutostartEnabled());
            break;
        case ID_OPENINI:
            ShellExecuteW(nullptr, L"open", L"notepad.exe", (L"\"" + g_iniPath + L"\"").c_str(), nullptr, SW_SHOWNORMAL);
            break;
        case ID_EXIT:
            DestroyWindow(g_main);
            return;
    }
    RenderOverlay(true);
}

static LRESULT CALLBACK MainProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == g_msgTaskbarCreated && g_msgTaskbarCreated) {
        UpdateTray(true);
        RenderOverlay(true);
        return 0;
    }
    switch (msg) {
        case WM_APP_DATA:
            EnterCriticalSection(&g_lock);
            g_devices = g_shared;
            LeaveCriticalSection(&g_lock);
            UpdateTray(false);
            CheckLowBattery();
            RenderOverlay(false);
            return 0;
        case WM_APP_TRAY:
            switch (LOWORD(lp)) {
                case WM_CONTEXTMENU:
                case WM_RBUTTONUP:
                case NIN_SELECT:
                case NIN_KEYSELECT:
                case WM_LBUTTONUP:
                    ShowMenu();
                    break;
            }
            return 0;
        case WM_COMMAND:
            OnCommand(LOWORD(wp));
            return 0;
        case WM_TIMER:
            if (wp == TIMER_LAYOUT) {
                RenderOverlay(false);
            } else if (wp == TIMER_DEVCHANGE) {
                KillTimer(hwnd, TIMER_DEVCHANGE);
                RequestRefresh();
            }
            return 0;
        case WM_DEVICECHANGE:
            if (wp == 0x0007 /* DBT_DEVNODES_CHANGED */) SetTimer(hwnd, TIMER_DEVCHANGE, 3000, nullptr);
            return TRUE;
        case WM_SETTINGCHANGE:
        case WM_DISPLAYCHANGE:
        case WM_THEMECHANGED:
            g_lightTheme = ReadLightTheme();
            UpdateTray(false);
            RenderOverlay(true);
            return 0;
        case WM_DESTROY:
            KillTimer(hwnd, TIMER_LAYOUT);
            RemoveTray();
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static LRESULT CALLBACK OverlayProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------
static void EnableDpiAwareness() {
    typedef BOOL(WINAPI * PFN)(HANDLE);
    if (HMODULE u = GetModuleHandleW(L"user32.dll")) {
        if (auto fn = (PFN)(void*)GetProcAddress(u, "SetProcessDpiAwarenessContext"))
            if (fn((HANDLE)-2 /* DPI_AWARENESS_CONTEXT_SYSTEM_AWARE */)) return;
    }
    SetProcessDPIAware();
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
    HANDLE single = CreateMutexW(nullptr, TRUE, L"Local\\BatteryTray.SingleInstance");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        MessageBoxW(nullptr, L"BatteryTray уже запущен — ищи иконку батарейки в трее.", kAppName, MB_ICONINFORMATION);
        return 0;
    }

    g_inst = inst;
    EnableDpiAwareness();
    {
        HDC dc = GetDC(nullptr);
        g_scale = GetDeviceCaps(dc, LOGPIXELSY) / 96.0f;
        ReleaseDC(nullptr, dc);
    }

    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    g_exePath = path;
    g_iniPath = g_exePath.substr(0, g_exePath.find_last_of(L"\\/") + 1) + L"battery-tray.ini";
    WriteDefaultIni();
    LoadSettings();
    g_lightTheme = ReadLightTheme();

    gp::GdiplusStartupInput gsi;
    ULONG_PTR gdipToken = 0;
    gp::GdiplusStartup(&gdipToken, &gsi, nullptr);

    InitializeCriticalSection(&g_lock);
    g_wakeEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    g_msgTaskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof wc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpfnWndProc = MainProc;
    wc.lpszClassName = kMainClass;
    RegisterClassExW(&wc);
    wc.lpfnWndProc = OverlayProc;
    wc.lpszClassName = kOverlayClass;
    RegisterClassExW(&wc);

    g_main = CreateWindowExW(WS_EX_TOOLWINDOW, kMainClass, kAppName, WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, inst,
                             nullptr);
    g_overlay = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE,
                                kOverlayClass, L"BatteryTray Overlay", WS_POPUP, 0, 0, 0, 0, nullptr, nullptr, inst,
                                nullptr);
    if (!g_main || !g_overlay) return 1;

    UpdateTray(true);
    SetTimer(g_main, TIMER_LAYOUT, 750, nullptr);
    g_worker = CreateThread(nullptr, 0, WorkerProc, nullptr, 0, nullptr);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    InterlockedExchange(&g_quit, 1);
    SetEvent(g_wakeEvent);
    if (g_worker) {
        WaitForSingleObject(g_worker, 3000);
        CloseHandle(g_worker);
    }
    if (g_trayIcon) DestroyIcon(g_trayIcon);
    gp::GdiplusShutdown(gdipToken);
    if (single) CloseHandle(single);
    return 0;
}
