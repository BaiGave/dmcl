export type IconName =
  | "workbench" | "plus" | "folder" | "external" | "settings"
  | "search" | "filter" | "more" | "refresh" | "scan" | "import"
  | "export" | "trash" | "unlink" | "build" | "play" | "terminal"
  | "copy" | "chevron-left" | "chevron-down" | "check" | "warning"
  | "error" | "info" | "clock" | "loader" | "close" | "sparkles";

const paths: Record<IconName, string> = {
  workbench: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7.5h7l2-2h9v13H3Z"/>',
  external: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2.2-.7-.5-1.2 1.1-2-2.1-2.1-2 1.1-1.2-.5L10.5 3h-3l-.7 2.2-1.2.5-2-1.1-2.1 2.1 1.1 2-.5 1.2L0 10.5v3l2.2.7.5 1.2-1.1 2 2.1 2.1 2-1.1 1.2.5.7 2.1h3l.7-2.2 1.2-.5 2 1.1 2.1-2.1-1.1-2 .5-1.2Z" transform="translate(1) scale(.92)"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  scan: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10"/>',
  import: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
  export: '<path d="M12 17V5m0 0 4 4m-4-4L8 9"/><path d="M5 19h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  unlink: '<path d="m9 15-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4-.2M15 9l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 .2M8 3l8 18"/>',
  build: '<path d="M14.7 6.3a4 4 0 0 0-5-5L7.5 3.5l3 3 2.2-2.2a4 4 0 0 0 2 2Z"/><path d="m4 20 7.5-7.5M2.5 16.5l5 5"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 16h4"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  warning: '<path d="M12 3 2.5 20h19Z"/><path d="M12 9v4M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  loader: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  sparkles: '<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2ZM18.5 14l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7ZM5 14l.6 1.8 1.9.7-1.9.6L5 19l-.6-1.9-1.9-.6 1.9-.7Z"/>',
};

export function icon(name: IconName): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    const name = el.dataset.icon as IconName;
    if (paths[name]) el.innerHTML = icon(name);
  });
}
