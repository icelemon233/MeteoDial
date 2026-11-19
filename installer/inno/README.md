# MeteoDial Windows 安装器

事务引擎使用 Inno Setup 7.1.0，原生场景界面与 Cinna Windows 工具系列共用 C++ / GDI+ 实现。程序信息、既有安装标识及资料目录在 `product.json`，天气主题的日夜图存放在 `assets/`。

在项目根目录运行 `npm run package`。主要入口会先打包真实 Electron 载荷，再生成 `installers/MeteoDial-<版本>-windows-x64-setup.exe`。`INNOSETUP_ISCC` 与 `CINNA_ZIG` 可以指定已有的固定版本工具链。

## 隔离验证

`test.ps1` 验证当前用户安装、快捷方式、原地升级、0.1 登记迁移、取消选择与卸载。`test-custom.ps1` 驱动真正的原生场景，检查升级取消后的逐文件恢复、全新安装取消和成功安装。两者接受 `-PayloadDirectory`、`-Version`，使用独立 QA 注册、安装目录、快捷方式与互斥体。`test-responsiveness.ps1` 可记录安装期间前台绘制和消息派发情况。

此项目的适配保留了系列的 `ui/InstallerUi.cpp`、`ui/BackendBridge.h`、`ui-api.iss` 及事务恢复实现。`legacy-weather.iss` 处理旧版独有的快捷方式位置和选项。程序运行时通过同路径实例的 `--request-exit` 正常退出，早期 NSIS 安装的 0.1.0 提示由用户正常关闭。

