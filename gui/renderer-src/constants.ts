export const LOADERS = [
  { id: "fabric", label: "Fabric", icon: "Fa", hint: "轻量、更新快" },
  { id: "neoforge", label: "NeoForge", icon: "NF", hint: "现代分支" },
  { id: "forge", label: "Forge", icon: "Fo", hint: "经典生态" },
] as const;

export const LOADER_LABELS: Record<string, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
};

export const STATUS_LABELS: Record<string, string> = {
  active: "开发中",
  paused: "暂停",
  released: "已发布",
};
