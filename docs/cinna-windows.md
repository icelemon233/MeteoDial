# Cinna Windows conventions

MeteoDial follows the Windows shell used by NetworkToolbox and LanDrop. The project keeps its window metrics in `desktop/window-shell.json`. The 44 DIP title bar, 224/56 DIP sidebar, settings entry and light/dark themes use the same geometry across pages. Weather maps keep their scientific colour scales and show the source and valid time.

The weather edition shows Cinna holding a barometer. The title bar, tray, shortcuts and day/night installer scenes use assets from the same design. `installer/inno/ui` contains the native installer interface. Inno Setup 7.1.0 handles file installation, cancellation and rollback.

## Windows upgrades

MeteoDial was named Guanxiang through version 0.2.0. The installer keeps the application ID `org.guanxiang.weather`, the executable name `Guanxiang.exe` and the user profile under `%APPDATA%\观象`. New installations use a MeteoDial program folder. An upgrade follows the registered installation directory and the user's shortcut choices.

0.1.0 used an NSIS uninstall entry and a Chinese Start menu link. 0.2.0 used the Inno entry and Guanxiang links. The installer verifies the old directory and link targets before migrating an owned shortcut. A successful installation writes the new entries. Cancelling an upgrade restores replaced program files through the Inno transaction and rollback journal.

## 系列约定与历史版本

窗口尺寸由 `desktop/window-shell.json` 统一维护。观象使用持气压计的 Cinna 角色图，安装程序沿用系列的原生场景、安装设置抽屉和事务回退流程。

从 Guanxiang 0.2.0 或更早版本升级时，安装器沿用登记目录、应用标识与用户资料，按原来的选项迁移快捷方式。全新安装使用 MeteoDial 文件夹。内部可执行文件沿用 `Guanxiang.exe`，便于已有启动入口和维护命令继续工作。

[主窗实图](./previews/weather-home.png) · [安装首页实图](./previews/installer-home.png)
