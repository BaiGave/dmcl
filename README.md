# DMCL

**Developer Minecraft Launcher** — Minecraft 模组开发工作台。

面向新手的模组开发环境一键搭建：选择 Minecraft 版本和加载器（Fabric / Forge / NeoForge），自动生成项目并完成构建与客户端验证。

## 功能

- 交互式向导：选加载器 → 选 MC 版本 → 填模组信息 → 一键生成
- 版本数据全部来自官方 API（Mojang / FabricMC / Forge / NeoForge），无需手动维护
- 自动下载官方模板并完成改造（模组 ID、包名、版本号等）
- 国内镜像加速：Gradle / Maven 自动切换国内源
- JDK 自动化：按 MC 版本判断所需 Java → 自动下载并注入 `org.gradle.java.home`
  - 缓存至 `~/.dmcl/jdks/`（兼容读取旧版 `~/.mcdev/jdks/`）
- 生成后自动 `gradlew build` + `runClient` 完整验证
- GUI 桌面应用（Electron）：双击 `启动.bat` 即用
- **模组工作台**：管理开发中的模组，查看加载器/版本支持矩阵
- 一键生成其它 MC 版本或加载器变体（自动复制源码）
- 构建队列、日志持久化、批量构建、导出开发目录 JSON
- 自动初始化 git 仓库

## 使用

```bash
npm install
npm run dev          # CLI 交互模式
npm run gui          # GUI 桌面应用
```

> **新手推荐**：直接双击项目根目录的 `启动.bat`。

非交互模式：

```bash
npm run dev -- --yes --loader fabric --mc 1.21.4 --modid mymod --name "My Mod"
```

| 参数 | 说明 |
| --- | --- |
| `--loader` | `fabric` / `forge` / `neoforge` |
| `--mc` | Minecraft 版本 |
| `--modid` | 模组 ID |
| `--name` | 模组显示名 |
| `--group` | Java 包名 |
| `--dir` | 输出目录 |
| `--no-mirror` | 不使用国内镜像 |
| `--mappings` | `yarn` / `mojmap` / `parchment` |
| `--build` | 生成后执行构建 + 客户端验证 |
| `--yes` / `-y` | 非交互模式 |

## 工作台

启动 GUI 后默认进入 **我的模组** 列表：

| 功能 | 说明 |
| --- | --- |
| 模组列表 | 显示开发中模组、支持的加载器/版本、构建健康度 |
| 支持矩阵 | 加载器 × MC 版本网格，➕ 一键生成变体，✅ 查看已有变体 |
| 变体操作 | 构建、启动客户端、打开文件夹、Cursor 打开、查看日志 |
| 导入/扫描 | 自动识别 `gradle.properties` + `fabric.mod.json` / `mods.toml` |
| 构建队列 | 同一时刻一个 Gradle 任务，其余排队；底部状态栏显示进度 |
| 导出目录 | 导出 `~/.dmcl/catalog.json` 供对外展示开发中模组 |

数据存储：`~/.dmcl/workspace.json`，构建日志：`~/.dmcl/logs/`。

### 项目目录结构

所有模组项目默认放在 **dcml 仓库内的 `projects/` 目录**：

```
dcml/
  projects/
    mymod/                      # 模组 ID
      fabric-1.21.4/            # 变体：{加载器}-{MC版本}
      neoforge-1.21.1/
```

- 新建模组时默认路径已填好，也可在高级选项中浏览改为其它位置
- 启动或刷新列表时会**自动检测**变体目录是否仍在；若在默认位置找到会自动找回
- 路径丢失的变体可点击「重新定位」手动指定，或用「清理失效」批量移除
- **移除后不会自动重新导入**（加入排除列表）；只有手动「扫描导入」才会发现新项目
- 侧边栏「外部项目」页可管理监视目录，并对所有已注册项目增删改查（改路径/移除）

## 生成后

```bash
cursor <项目目录>
.\gradlew build
.\gradlew runClient
```

## 路线图

- [x] 一键生成 + 构建 + 客户端验证
- [x] GUI 桌面应用
- [x] 项目管理（扫描/添加已有项目，一键构建/启动）
- [x] 支持矩阵与一键生成其它版本/加载器变体
- [x] 构建队列与日志持久化
- [x] 导出开发目录（JSON）
- [ ] 单文件 exe 打包
