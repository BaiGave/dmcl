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

## 生成后

```bash
cursor <项目目录>
.\gradlew build
.\gradlew runClient
```

## 路线图

- [x] 一键生成 + 构建 + 客户端验证
- [x] GUI 桌面应用
- [ ] 项目管理（扫描/添加已有项目，一键构建/启动）
- [ ] 单文件 exe 打包
