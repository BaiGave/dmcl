# mcdev-wizard

面向新手的 Minecraft 模组开发环境一键搭建工具。选择 Minecraft 版本和模组加载器（Fabric / Forge / NeoForge），自动生成一个开箱即用的模组开发项目。

## 功能

- 交互式向导：选加载器 → 选 MC 版本 → 填模组信息 → 一键生成
- 版本数据全部来自官方 API（Mojang / FabricMC / Forge / NeoForge），无需手动维护
- 自动下载官方模板（fabric-example-mod / Forge MDK / NeoForge MDK）并完成改造：
  - 模组 ID、显示名、主类名、Java 包名全部替换
  - `gradle.properties` 中各组件版本号自动对齐所选 MC 版本
- 国内镜像加速：Gradle 下载源自动切换腾讯云镜像（可选）
- JDK 检测：按 MC 版本判断所需 Java 版本，未满足时给出下载指引
- 生成 `.vscode` 配置与扩展推荐，配合 Cursor / VS Code 开箱即用
- 自动初始化 git 仓库

## 使用

```bash
npm install
npm run dev          # 交互模式
```

非交互模式（适合脚本/CI）：

```bash
npm run dev -- --yes --loader fabric --mc 1.21.4 --modid mymod --name "My Mod"
```

| 参数 | 说明 |
| --- | --- |
| `--loader` | `fabric` / `forge` / `neoforge` |
| `--mc` | Minecraft 版本，如 `1.21.4` |
| `--modid` | 模组 ID（小写字母/数字/下划线） |
| `--name` | 模组显示名（默认按 modid 生成） |
| `--group` | Java 包名（默认 `com.example.<modid>`） |
| `--dir` | 输出目录（默认 `./<modid>`） |
| `--no-mirror` | 不使用国内镜像 |
| `--yes` / `-y` | 非交互模式 |

## 生成后

```bash
cursor <项目目录>      # 用 Cursor 打开，按提示安装 Java 扩展
.\gradlew build       # 首次构建会下载并反编译 Minecraft，约 5~20 分钟
.\gradlew runClient   # 启动带模组的开发版客户端
```

## MC 版本与 JDK 对照

| MC 版本 | 所需 JDK |
| --- | --- |
| 26.x（新版本号方案） | 25 |
| 1.20.5 ~ 1.21.x | 21 |
| 1.18 ~ 1.20.4 | 17 |
| 1.17.x | 16 |
| ≤ 1.16 | 8 |

## 架构

```
src/
├── index.ts          # CLI 入口（交互 + 非交互）
├── types.ts          # 公共类型
├── meta/             # 各官方 API 的版本元数据查询
│   ├── mojang.ts     # 正式版版本列表
│   ├── fabric.ts     # loader / yarn / Fabric API 版本
│   ├── forge.ts      # promotions（recommended/latest）
│   └── neoforge.ts   # NeoForge 版本与 MDK 模板定位
├── loaders/          # 三个加载器的脚手架适配器
└── core/             # 下载、解压、模板改造、镜像、JDK、.vscode
```

模板改造采用通用策略：自动探测模板根包名 → 全局替换占位符（包名、模组 ID、类名、显示名）→ 迁移包目录 → 重命名文件，因此对模板内部结构变化有较强适应性。

## 路线图

- [ ] JDK 自动下载安装（Adoptium API）
- [ ] Maven 仓库国内镜像注入
- [ ] GUI 壳（Electron / Tauri，复用现有核心）
- [ ] 生成后可选自动执行首次 `gradlew build`
