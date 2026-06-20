import { icon } from "./icons";

export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function showError(msg: string): void {
  const box = $("error-box");
  const txt = $("error-text");
  if (txt) txt.textContent = msg;
  if (box) box.style.display = "block";
}

export function hideError(): void {
  const box = $("error-box");
  if (box) box.style.display = "none";
}

export function setText(id: string, value: string): void {
  const el = $(id);
  if (el) el.textContent = value;
}

export type NoticeKind = "info" | "success" | "warning" | "error";

export function notify(message: string, kind: NoticeKind = "info"): void {
  const stack = $("toast-stack");
  if (!stack) {
    console.log("[dmcl]", message);
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.innerHTML = icon(kind === "success" ? "check" : kind) + '<span></span>';
  const text = toast.querySelector("span");
  if (text) text.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-4px)";
    toast.style.transition = "opacity 0.18s ease, transform 0.18s ease";
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

export function showView(name: string): void {
  document.body.dataset.view = name;
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `view-${name}`);
  });
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.view === name);
  });
}

export function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

export function showModal(title: string, content: string): void {
  showLogModal(title, content);
}

let lastLogModalText = "";

export function showLogModal(title: string, content: string, options?: { copyLabel?: string }): void {
  const titleEl = $("modal-title");
  const log = $("modal-log");
  const overlay = $("modal-overlay");
  const copyBtn = $("modal-copy-log") as HTMLButtonElement | null;
  const sourceCancel = $("modal-source-cancel") as HTMLButtonElement | null;
  if (sourceCancel) sourceCancel.hidden = true;
  lastLogModalText = content;
  if (titleEl) titleEl.textContent = title;
  if (log) {
    log.textContent = content;
    log.scrollTop = 0;
  }
  if (copyBtn) {
    copyBtn.hidden = !content.trim();
    copyBtn.textContent = options?.copyLabel ?? "复制全部";
  }
  logModalReturnFocus = document.activeElement as HTMLElement | null;
  overlay?.classList.add("visible");
  const modal = overlay?.querySelector<HTMLElement>(".modal");
  requestAnimationFrame(() => (copyBtn && !copyBtn.hidden ? copyBtn : modal)?.focus());
}

export function getLastLogModalText(): string {
  return lastLogModalText;
}

let logModalReturnFocus: HTMLElement | null = null;

export function closeModal(): void {
  $("modal-overlay")?.classList.remove("visible");
  logModalReturnFocus?.focus();
  logModalReturnFocus = null;
}

export interface ConfirmActionOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
}

let confirmReturnFocus: HTMLElement | null = null;

export function confirmAction(options: ConfirmActionOptions): Promise<boolean> {
  const overlay = $("confirm-modal");
  const title = $("confirm-title");
  const message = $("confirm-message");
  const detail = $("confirm-detail");
  const confirm = $("confirm-accept") as HTMLButtonElement | null;
  const cancel = $("confirm-cancel") as HTMLButtonElement | null;
  if (!overlay || !title || !message || !detail || !confirm || !cancel) {
    return Promise.resolve(false);
  }

  confirmReturnFocus = document.activeElement as HTMLElement | null;
  title.textContent = options.title;
  message.textContent = options.message;
  detail.textContent = options.detail || "";
  detail.hidden = !options.detail;
  confirm.textContent = options.confirmLabel || (options.danger ? "确认删除" : "确认");
  confirm.className = `btn ${options.danger ? "btn-danger" : "btn-primary"}`;
  overlay.classList.add("visible");

  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      overlay.classList.remove("visible");
      confirm.onclick = null;
      cancel.onclick = null;
      overlay.onclick = null;
      document.removeEventListener("keydown", onKeydown, true);
      confirmReturnFocus?.focus();
      resolve(value);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    };
    confirm.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    overlay.onclick = (event) => { if (event.target === overlay) finish(false); };
    document.addEventListener("keydown", onKeydown, true);
    requestAnimationFrame(() => cancel.focus());
  });
}
