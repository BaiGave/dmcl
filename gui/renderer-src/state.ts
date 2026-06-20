export interface WorkbenchState {
  mods: Array<Record<string, unknown>>;
  currentModId: string | null;
  filter: string;
  loaderFilter: string;
  matrixFilter: string;
  search: string;
  selectedLoader: string;
  selectedMc: string;
  selectedMappings: string;
  selectedSideLayout: string;
  modidTouched: boolean;
  groupTouched: boolean;
  generationCancelled: boolean;
  activeAbort: AbortController | null;
  batchAbortControllers: AbortController[] | null;
  nameComposing: boolean;
  dirTouched: boolean;
  projectsRoot: string;
  versionsCache: Record<string, string[]>;
  versionsLoading: Record<string, Promise<string[]>>;
  detailCache: Record<string, { mod: Record<string, unknown>; matrix: Record<string, unknown>; fetchedAt: number }>;
  detailRequestId: number;
  modsFetchedAt: number;
  buildBatch: {
    modId: string;
    modName: string;
    jobIds: string[];
    done: Record<string, boolean>;
  } | null;
}

export const state: WorkbenchState = {
  mods: [],
  currentModId: null,
  filter: "all",
  loaderFilter: "all",
  matrixFilter: "all",
  search: "",
  selectedLoader: "",
  selectedMc: "",
  selectedMappings: "",
  selectedSideLayout: "unified",
  modidTouched: false,
  groupTouched: false,
  generationCancelled: false,
  activeAbort: null,
  batchAbortControllers: null,
  nameComposing: false,
  dirTouched: false,
  projectsRoot: "",
  versionsCache: {},
  versionsLoading: {},
  detailCache: {},
  detailRequestId: 0,
  modsFetchedAt: 0,
  buildBatch: null,
};

export let pathRefreshTimer: ReturnType<typeof setTimeout> | null = null;

export function setPathRefreshTimer(t: ReturnType<typeof setTimeout> | null): void {
  pathRefreshTimer = t;
}
