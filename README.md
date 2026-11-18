# Folia × Wallpaper Engine 壁纸桥接

在 Folia 播放页浏览并使用本机 Wallpaper Engine 壁纸。支持原视频、静态图片、场景静态底图，以及手动选择或跟随桌面壁纸。

当前版本为 **1.3.0**，模组 ID 为 `wallpaper-engine-live`。版本以 [mod.json](./mod.json) 为准。

## 功能

- 扫描 Steam 创意工坊壁纸库及 Wallpaper Engine 本地、自带项目。
- 在播放页提供「壁纸库」标签页，包含缩略图、标题、类型标签、搜索、按类型筛选、分页和当前选择高亮。
- 提供上一张、下一张、刷新列表和跟随当前桌面壁纸命令。
- 默认使用手动选择，重启后保留选择。也可切换为「跟随桌面壁纸」。
- 视频壁纸循环播放原视频，静态图片显示原图。
- 场景壁纸按需提取可用的静态底图，支持部分 PKG/TEX 格式及本地缓存。无法提取时使用项目普通图片或静态预览资源。
- 可选「同步到桌面」，通过 Wallpaper Engine 官方命令行打开所选项目，默认关闭。
- 可调暗化、模糊及暂停时是否保留壁纸。模糊默认值为 0。
- 提供背景源文件、分辨率、显示尺寸、DPR、滤镜和缓存状态等诊断信息。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 桌面环境，已在 Windows 11 验证 |
| Folia | 桌面版，需 Folium 1.6 或以上。清单适用范围为 `>=0.7.0 <0.8.0`，实际还需满足 Folium 接口要求 |
| 本版实测 | Folia 0.7.29 / Folium 1.9 |
| Wallpaper Engine | Steam 版，已安装并具有可读取的壁纸项目 |
| 桌面同步 | Wallpaper Engine 必须已经运行 |

浏览壁纸和仅在 Folia 中切换背景时，Wallpaper Engine 可以处于未运行状态。「跟随桌面壁纸」读取其已保存的当前选择。

运行模组无需另外安装解包工具。`ffprobe` 是可选的尺寸探测工具，缺少时可在背景加载后查看浏览器实际解码尺寸。

## 安装与升级

1. 从本仓库页面选择 **Code → Download ZIP**，解压源码压缩包。
2. 退出 Folia。升级前备份已有的 `wallpaper-engine-live` 模组目录及模组自身数据。
3. 将解压后包含 `mod.json` 的文件夹重命名为 `wallpaper-engine-live`，放入 `%APPDATA%\Folia\mods\`。
4. 确认目录结构如下，`mod.json` 应直接位于该模组目录中。

```text
%APPDATA%\Folia\mods\wallpaper-engine-live\
├─ mod.json
├─ main.cjs
├─ client.mjs
├─ background.mjs
├─ picker.mjs
├─ library.cjs
├─ media.cjs
├─ desktop.cjs
├─ pkgReader.cjs
├─ texContainer.cjs
├─ textureDecode.cjs
├─ sceneCandidates.cjs
├─ sceneCache.cjs
└─ sceneWorker.cjs
```

5. 启动 Folia，在「设置 → 模组」打开模组系统，启用「Wallpaper Engine 实时背景」。
6. 在 Folia 原生确认框中确认启用。升级改变文件内容后，Folia 会要求重新确认。
7. 打开播放页的「壁纸库」标签页，或执行「浏览 Wallpaper Engine 壁纸」命令。

声明的权限为 `stageLayers` 和 `filesystem.data`，分别用于播放页背景层和模组自身数据。Folium 的主进程入口具有 Node.js 能力，请在启用前阅读源码。

## 使用方法

### 浏览和选择

在「壁纸库」标签页输入标题搜索，使用类型按钮筛选视频、图片、场景等项目。点击缩略图即可切换 Folia 背景，并进入手动模式。缩略图来自项目预览资源。

可用按钮或命令切到上一张、下一张。新增、删除或更新本地壁纸后，使用「刷新列表」重新扫描。无法读取的项目 JSON 会跳过并计数。

### 选择模式

- **手动选择**为默认模式。首次使用时以当前桌面项目作为初始选择，之后保存手动选择。
- **跟随桌面壁纸**会轮询 Wallpaper Engine 的已保存配置，随当前桌面项目更新。

### 同步到桌面

默认关闭「同步到桌面」。开启后，点击项目或执行上一张、下一张，会同时调用 Wallpaper Engine 打开项目。需要先启动 Wallpaper Engine。

同步失败时界面显示错误，Folia 的选择会保留。「在 Wallpaper Engine 中打开」提供一次单独的桌面打开操作。

官方调用使用 `wallpaper64.exe`，缺失时使用 `wallpaper32.exe`。参数通过独立 argv 传入，支持带空格的项目路径。控制进程返回码 0 表示命令进程正常退出，完整效果可在 Wallpaper Engine 中确认。[官方命令行说明](https://help.wallpaperengine.io/en/functionality/cli.html)

### 外观和诊断

「壁纸外观」设置包含暗化 0–80、模糊 0–20 px，以及暂停时保留壁纸。背景以 `object-fit: cover` 铺满，模糊默认关闭。

展开「背景诊断：源文件与分辨率」可核对实际来源和尺寸。日志以 `[wallpaper-engine-live]` 开头。诊断信息会显示本机资源路径，公开反馈前请检查并去除个人信息。

### 命令

- 浏览 Wallpaper Engine 壁纸
- 上一张壁纸
- 下一张壁纸
- 刷新壁纸列表
- 跟随当前桌面壁纸
- 刷新 Wallpaper Engine 壁纸

## 场景资源与缓存

场景项目选中后进入后台加载状态。模组先复制所需 PKG 到自己的缓存目录，再读取 `scene.json`、模型、材质和 TEX。背景选择结合图层顺序、可见性、尺寸、画幅和名称，跳过粒子、图集、遮罩和隐藏层。

本地解码支持 PNG/JPEG 直通、LZ4、DXT1/BC1、DXT3/BC2、DXT5/BC3 及部分原始像素格式。图片按有效像素尺寸输出。找不到合适纹理时，尝试项目内普通媒体，最后使用预览资源。界面会显示实际来源和分辨率。

缓存位于 `%APPDATA%\Folia\mods-cache\wallpaper-engine-live\scene-textures-v1`。缓存键包含项目标识和场景包的文件状态，重选时可直接命中。长期缓存上限约 384 MiB，超过 30 天未使用的结果会在后续缓存访问时清理。处理中的包副本上限为 1 GiB，完成后会清理。

可通过 Folia 模组详情清空模组缓存，下次选择时重新提取。PKG、TEX 和提取结果均在本地处理。

## 已知限制

- **场景动画无法在 Folia 内完整复现。** 当前版本显示一张静态底图或项目预览。独立图层可能缺少人物、前景或其他合成内容，动画、粒子、着色器、交互和视差由 Wallpaper Engine 完整呈现。
- **回退到项目自带预览图时，放大后可能模糊。** 柔焦、渐变等原始底图也会保留本身的画面效果。
- BC7、TEX 内嵌 MP4、超尺寸和未知纹理变体会跳过。部分模型、粒子或程序生成的场景没有合适的静态底图。
- 网页壁纸仅显示预览，HTML 和 JavaScript 通过外部打开操作交给 Wallpaper Engine。程序壁纸也仅显示可用的普通媒体或预览。
- 视频能否播放取决于当前 Folia/Electron 对源文件编码的支持。
- 多显示器跟随读取配置中的首个选中项，桌面同步未指定显示器时使用 Wallpaper Engine 的默认行为。
- 库扫描有深度和数量限制。所选项目失效后需要刷新列表并重新选择。

## 开发与验证

源码使用 Folium 注册表和主进程 RPC，运行时无需 npm 依赖。本仓库以 `mod.json` 管理模组版本。

使用 Node.js 24 或以上版本运行自动测试。

```powershell
node --test tests/*.test.cjs
```

安装后的验证步骤如下。

1. 确认模组状态为 `loaded`，打开壁纸库并测试搜索、筛选和当前项目高亮。
2. 保持桌面同步关闭，分别选择原视频、静态图片和场景，核对诊断里的实际源文件与分辨率。
3. 选择另一张场景后切回，检查缓存状态 `scene.cache` 是否为 `hit`。
4. 重启 Folia，确认手动选择和同步开关已保存。
5. Wallpaper Engine 运行时测试桌面同步，再关闭同步确认仅切换 Folia。
6. Wallpaper Engine 未运行时浏览并切换背景，再开启同步检查错误提示。

## 更新日志

1.3.0 增加本地场景静态纹理提取、后台处理、选层评分及缓存。1.2.0 增加壁纸库、搜索筛选、持久化选择和桌面同步。完整历史见 [CHANGELOG.md](./CHANGELOG.md)。

## 卸载与回滚

在 Folia 模组面板停用即可恢复原背景。需要卸载时，退出 Folia 后删除 `%APPDATA%\Folia\mods\wallpaper-engine-live`。

恢复旧版本时，将升级前备份的模组目录放回原位置，再通过 Folia 原生确认启用。模组缓存可从模组详情清理。整份 Folia 配置只在确有需要时单独恢复，以免覆盖后续设置。

## 协议与参考

本项目代码使用 [MIT License](./LICENSE)。壁纸和第三方项目内容的权利由各自作者保留，使用本模组需自行安装相应应用并准备本地壁纸。

Folia 接口、纹理容器及压缩格式参考以下资料。

- [Folia 源码与模组示例](https://github.com/chthollyphile/folia-major)
- [RePKG 包读取实现](https://github.com/notscuffed/repkg/blob/master/RePKG.Application/Package/PackageReader.cs)
- [RePKG 纹理读取实现](https://github.com/notscuffed/repkg/blob/master/RePKG.Application/Texture/TexImageReader.cs)
- [LZ4 Block Format](https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md)
- [Microsoft BC 纹理格式说明](https://learn.microsoft.com/en-us/windows/win32/direct3d11/texture-block-compression-in-direct3d-11)
