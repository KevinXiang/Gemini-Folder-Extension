import {
  ChatRef,
  DEFAULT_PROJECT_ICON_STYLE,
  Project,
  ProjectIcon,
  ProjectIconStyle,
  StoredState
} from '../shared/types';
import {
  extractGeminiConversationIdFromUrl,
  isProjectColor,
  isProjectIconStyle,
  isRecord,
  isSafeId,
  normalizeChatUrl,
  normalizeProjectNameKey
} from '../shared/storage';
import type { ChromeBookmarkNodeLike } from '../shared/webext';

export const ROOT_FOLDER_TITLE = 'Gemini Projects';
export const CONFIG_BOOKMARK_TITLE = '_Gemini Projects Config';
export const CONFIG_URL_PREFIX = 'https://gemini.google.com/#gp-sync-v1=';
export const SYNC_META_KEY = 'gp_bookmark_sync_meta_v1';
const CHAT_PUSH_DEBOUNCE_MS = 1500;
const RECONCILE_DEBOUNCE_MS = 1500;
const MAX_CIDS_PER_PROJECT = 30;
const MAX_CONFIG_URL_LENGTH = 15_000;

export type BookmarkNode = ChromeBookmarkNodeLike;

export interface LocalStorageAdapter {
  get<T = Record<string, unknown>>(keys?: string | string[] | Record<string, unknown>): Promise<T>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface BookmarksAdapter {
  getTree(): Promise<BookmarkNode[]>;
  getSubTree(id: string): Promise<BookmarkNode[]>;
  create(details: { parentId: string; title: string; url?: string; index?: number }): Promise<BookmarkNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkNode>;
  move(id: string, destination: { parentId?: string; index?: number }): Promise<BookmarkNode>;
  remove(id: string): Promise<void>;
  onCreated(listener: (id: string, bookmark: BookmarkNode) => void): () => void;
  onChanged(listener: (id: string, changeInfo: { title: string; url?: string }) => void): () => void;
  onMoved(
    listener: (
      id: string,
      moveInfo: { parentId: string; index: number; oldParentId: string; oldIndex: number }
    ) => void
  ): () => void;
  onRemoved(
    listener: (
      id: string,
      removeInfo: { parentId: string; index: number; node: BookmarkNode }
    ) => void
  ): () => void;
  onImportBegan(listener: () => void): () => void;
  onImportEnded(listener: () => void): () => void;
}

export interface TimerAdapter {
  setTimeout(callback: () => void | Promise<void>, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export interface BookmarkSyncOptions {
  bookmarks: BookmarksAdapter;
  storage: LocalStorageAdapter;
  timers?: TimerAdapter;
  runSerialized: <T>(task: () => Promise<T>) => Promise<T>;
  getState: () => Promise<StoredState>;
  commitState: (state: StoredState) => Promise<StoredState>;
}

export interface BookmarkSyncController {
  initialize(): Promise<void>;
  pushState(state: StoredState): Promise<void>;
  pushConfigOnly(state: StoredState): Promise<void>;
  scheduleChatRefPush(): void;
  dispose(): void;
}

interface BookmarkSyncMeta {
  initialized: boolean;
  lastRootBookmarkId?: string;
}

interface CompactProjectConfig {
  id: string;
  n: string;
  i: ProjectIcon;
  s: ProjectIconStyle;
  c?: string;
  u?: 1;
  pin?: 1;
  at: number;
  ct?: number;
  cids?: string[];
}

interface DecodedProjectConfig {
  id: string;
  name: string;
  icon: ProjectIcon;
  iconStyle: ProjectIconStyle;
  color?: string;
  useIconPalette?: true;
  isPinned: boolean;
  updatedAt: number;
  createdAt?: number;
  conversationIds: string[];
}

interface BookmarkConfigPayloadV1 {
  v: 1;
  p: CompactProjectConfig[];
}

const defaultTimers: TimerAdapter = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
};

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(encoded: string): string | null {
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const binary = atob(normalized + '='.repeat(padLength));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function projectToCompactConfig(project: Project, conversationIds: string[] = []): CompactProjectConfig {
  const entry: CompactProjectConfig = {
    id: project.id,
    n: project.name,
    i: project.icon,
    s: project.iconStyle,
    at: project.updatedAt,
    ct: project.createdAt
  };
  if (project.color && isProjectColor(project.color)) entry.c = project.color;
  if (project.useIconPalette === true) entry.u = 1;
  if (project.isPinned === true) entry.pin = 1;
  if (conversationIds.length > 0) entry.cids = conversationIds;
  return entry;
}

function projectToDecodedConfig(project: Project): DecodedProjectConfig {
  return {
    id: project.id,
    name: project.name,
    icon: project.icon,
    iconStyle: project.iconStyle,
    color: project.color && isProjectColor(project.color) ? project.color : undefined,
    useIconPalette: project.useIconPalette === true ? true : undefined,
    isPinned: project.isPinned === true,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    conversationIds: []
  };
}

function encodeConfigUrl(state: StoredState): string {
  const sortedProjects = sortProjectsBySortIndex(state.projects);
  const cidsByProject = new Map<string, string[]>();
  for (const chat of Object.values(state.chatIndex)) {
    if (!chat.projectId) continue;
    const list = cidsByProject.get(chat.projectId) ?? [];
    list.push(chat.conversationId);
    cidsByProject.set(chat.projectId, list);
  }

  const buildPayload = (maxCids: number): string => {
    const payload: BookmarkConfigPayloadV1 = {
      v: 1,
      p: sortedProjects.map((project) => {
        const cids = maxCids > 0 ? (cidsByProject.get(project.id) ?? []).slice(0, maxCids) : [];
        return projectToCompactConfig(project, cids);
      })
    };
    return `${CONFIG_URL_PREFIX}${encodeBase64Url(JSON.stringify(payload))}`;
  };

  for (const limit of [MAX_CIDS_PER_PROJECT, 10, 3, 0]) {
    const candidate = buildPayload(limit);
    if (candidate.length <= MAX_CONFIG_URL_LENGTH || limit === 0) {
      return candidate;
    }
  }
  return buildPayload(0);
}

function decodeConfigUrl(url: string | undefined): DecodedProjectConfig[] | null {
  if (!url || !url.startsWith(CONFIG_URL_PREFIX)) return null;
  const decoded = decodeBase64Url(url.slice(CONFIG_URL_PREFIX.length));
  if (!decoded) return null;
  try {
    const raw: unknown = JSON.parse(decoded);
    if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.p)) return null;
    const entries: DecodedProjectConfig[] = [];
    for (const item of raw.p) {
      if (!isRecord(item)) continue;
      if (!isSafeId(item.id) || typeof item.n !== 'string' || !item.n.trim()) continue;
      const now = Date.now();
      entries.push({
        id: item.id,
        name: item.n.trim(),
        icon: (typeof item.i === 'string' && item.i ? item.i : 'default') as ProjectIcon,
        iconStyle: isProjectIconStyle(item.s) ? item.s : DEFAULT_PROJECT_ICON_STYLE,
        color: isProjectColor(item.c) ? item.c : undefined,
        useIconPalette: item.u === 1 ? true : undefined,
        isPinned: item.pin === 1,
        updatedAt: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : now,
        createdAt: typeof item.ct === 'number' && Number.isFinite(item.ct) ? item.ct : undefined,
        conversationIds: Array.isArray(item.cids)
          ? item.cids.filter((cid): cid is string => isSafeId(cid))
          : []
      });
    }
    return entries;
  } catch {
    return null;
  }
}

function isConfigBookmark(node: BookmarkNode): boolean {
  if (!node.url) return false;
  return node.title === CONFIG_BOOKMARK_TITLE || node.url.startsWith(CONFIG_URL_PREFIX);
}

function isFolder(node: BookmarkNode): boolean {
  return node.url === undefined;
}

function sortProjectsBySortIndex(projects: ReadonlyArray<Project>): Project[] {
  return [...projects].sort((a, b) => a.sortIndex - b.sortIndex || a.createdAt - b.createdAt);
}

function getBookmarkUrlForChat(chat: ChatRef): string {
  return (
    normalizeChatUrl(chat.lastUrl, chat.conversationId) ??
    `https://gemini.google.com/app/${chat.conversationId}`
  );
}

function areStatesEqual(a: StoredState, b: StoredState): boolean {
  if (a.projects.length !== b.projects.length) return false;
  for (let i = 0; i < a.projects.length; i += 1) {
    const pa = a.projects[i];
    const pb = b.projects[i];
    if (
      pa.id !== pb.id ||
      pa.name !== pb.name ||
      pa.icon !== pb.icon ||
      pa.iconStyle !== pb.iconStyle ||
      pa.color !== pb.color ||
      pa.useIconPalette !== pb.useIconPalette ||
      (pa.isPinned === true) !== (pb.isPinned === true) ||
      pa.sortIndex !== pb.sortIndex
    ) {
      return false;
    }
  }
  const aKeys = Object.keys(a.chatIndex);
  const bKeys = Object.keys(b.chatIndex);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const ca = a.chatIndex[key];
    const cb = b.chatIndex[key];
    if (!cb) return false;
    if (
      ca.title !== cb.title ||
      (ca.projectId ?? null) !== (cb.projectId ?? null) ||
      ca.lastUrl !== cb.lastUrl ||
      (ca.isPinned === true) !== (cb.isPinned === true)
    ) {
      return false;
    }
  }
  return true;
}

export function createBookmarkSync(options: BookmarkSyncOptions): BookmarkSyncController {
  const { bookmarks, storage, runSerialized, getState, commitState } = options;
  const timers = options.timers ?? defaultTimers;

  let internalWriteDepth = 0;
  let importing = false;
  let pendingImportReconcile = false;
  let listenersInstalled = false;
  let chatPushTimer: number | null = null;
  let reconcileTimer: number | null = null;
  let disposed = false;

  let knownOtherBookmarksId: string | null = null;
  const trackedRootIds = new Set<string>();
  const trackedNodeIds = new Set<string>();
  const projectFolderIdMap = new Map<string, string>();
  const unsubscribers: Array<() => void> = [];

  async function withInternalWrite<T>(fn: () => Promise<T>): Promise<T> {
    internalWriteDepth += 1;
    try {
      return await fn();
    } finally {
      internalWriteDepth -= 1;
    }
  }

  function refreshTrackedIdsFromRoot(root: BookmarkNode | null): void {
    trackedRootIds.clear();
    trackedNodeIds.clear();
    if (!root) return;
    trackedRootIds.add(root.id);
    trackedNodeIds.add(root.id);
    for (const child of root.children ?? []) {
      trackedNodeIds.add(child.id);
      for (const grandChild of child.children ?? []) {
        trackedNodeIds.add(grandChild.id);
      }
    }
  }

  function isRelevantId(id: string | undefined): boolean {
    if (!id) return false;
    return trackedNodeIds.has(id) || trackedRootIds.has(id);
  }

  async function loadMeta(): Promise<BookmarkSyncMeta> {
    const raw = (await storage.get<Record<string, unknown>>(SYNC_META_KEY))[SYNC_META_KEY];
    if (!isRecord(raw)) return { initialized: false };
    return {
      initialized: raw.initialized === true,
      lastRootBookmarkId: typeof raw.lastRootBookmarkId === 'string' ? raw.lastRootBookmarkId : undefined
    };
  }

  async function saveMeta(meta: BookmarkSyncMeta): Promise<void> {
    await storage.set({ [SYNC_META_KEY]: meta });
  }

  async function findOtherBookmarksNode(): Promise<BookmarkNode> {
    const tree = await bookmarks.getTree();
    const rootChildren = tree[0]?.children ?? [];
    const byFolderType = rootChildren.find((node) => node.folderType === 'other');
    const resolved =
      byFolderType ??
      rootChildren.find((node) => node.id === '2') ??
      rootChildren[1] ??
      rootChildren[0];
    if (!resolved) throw new Error('Could not locate Other Bookmarks folder.');
    knownOtherBookmarksId = resolved.id;
    return resolved;
  }

  async function findRootFolders(): Promise<{ otherNode: BookmarkNode; roots: BookmarkNode[] }> {
    const otherNode = await findOtherBookmarksNode();
    const roots = (otherNode.children ?? [])
      .filter((node) => isFolder(node) && node.title === ROOT_FOLDER_TITLE)
      .sort((a, b) => (a.dateAdded ?? 0) - (b.dateAdded ?? 0));
    return { otherNode, roots };
  }

  async function ensureRootFolder(): Promise<BookmarkNode> {
    const { otherNode, roots } = await findRootFolders();
    if (roots.length > 0) return roots[0];
    const created = await withInternalWrite(() =>
      bookmarks.create({ parentId: otherNode.id, title: ROOT_FOLDER_TITLE })
    );
    return { ...created, children: [] };
  }

  async function moveMatchingChildrenAndRemoveIfEmpty(
    sourceFolderId: string,
    targetFolderId: string,
    shouldMove: (node: BookmarkNode) => boolean
  ): Promise<boolean> {
    let mutated = false;
    const [freshSource] = await bookmarks.getSubTree(sourceFolderId);
    for (const child of freshSource.children ?? []) {
      if (shouldMove(child)) {
        await bookmarks.move(child.id, { parentId: targetFolderId });
        mutated = true;
      }
    }
    const [afterMove] = await bookmarks.getSubTree(sourceFolderId);
    if ((afterMove.children ?? []).length === 0) {
      await bookmarks.remove(sourceFolderId);
      mutated = true;
    }
    return mutated;
  }

  async function upsertConfigBookmark(rootId: string, state: StoredState): Promise<string> {
    const configUrl = encodeConfigUrl(state);
    const [rootBeforeConfig] = await bookmarks.getSubTree(rootId);
    const configBookmarks = (rootBeforeConfig.children ?? []).filter(isConfigBookmark);
    let primaryConfigId: string;
    if (configBookmarks.length === 0) {
      const created = await bookmarks.create({
        parentId: rootId,
        title: CONFIG_BOOKMARK_TITLE,
        url: configUrl
      });
      primaryConfigId = created.id;
    } else {
      primaryConfigId = configBookmarks[0].id;
      if (configBookmarks[0].title !== CONFIG_BOOKMARK_TITLE || configBookmarks[0].url !== configUrl) {
        await bookmarks.update(primaryConfigId, {
          title: CONFIG_BOOKMARK_TITLE,
          url: configUrl
        });
      }
      for (let i = 1; i < configBookmarks.length; i += 1) {
        await bookmarks.remove(configBookmarks[i].id);
      }
    }

    const [rootAfter] = await bookmarks.getSubTree(rootId);
    const totalChildren = (rootAfter.children ?? []).length;
    const configIndex = (rootAfter.children ?? []).findIndex((c) => c.id === primaryConfigId);
    if (configIndex !== totalChildren - 1) {
      await bookmarks.move(primaryConfigId, { parentId: rootId, index: totalChildren });
    }
    return primaryConfigId;
  }

  async function syncFolderChats(folderId: string, desiredChats: ChatRef[]): Promise<void> {
    const [folder] = await bookmarks.getSubTree(folderId);
    const children = folder.children ?? [];

    const existingByCid = new Map<string, BookmarkNode>();
    const duplicateNodes: BookmarkNode[] = [];
    for (const child of children) {
      if (!child.url || isConfigBookmark(child)) continue;
      const cid = extractGeminiConversationIdFromUrl(child.url);
      if (!cid) continue;
      if (existingByCid.has(cid)) {
        duplicateNodes.push(child);
      } else {
        existingByCid.set(cid, child);
      }
    }

    for (const dup of duplicateNodes) {
      await bookmarks.remove(dup.id);
    }

    const desiredByCid = new Map<string, ChatRef>();
    for (const chat of desiredChats) {
      desiredByCid.set(chat.conversationId, chat);
    }

    // Remove chats no longer in this project (never touch non-Gemini bookmarks or subfolders)
    for (const [cid, node] of existingByCid.entries()) {
      if (!desiredByCid.has(cid)) {
        await bookmarks.remove(node.id);
      }
    }

    // Create or update desired chat bookmarks
    for (const chat of desiredChats) {
      const targetUrl = getBookmarkUrlForChat(chat);
      const targetTitle = chat.title || 'Untitled chat';
      const existing = existingByCid.get(chat.conversationId);
      if (!existing) {
        await bookmarks.create({
          parentId: folderId,
          title: targetTitle,
          url: targetUrl
        });
      } else if (existing.title !== targetTitle || existing.url !== targetUrl) {
        await bookmarks.update(existing.id, {
          title: targetTitle,
          url: targetUrl
        });
      }
    }
  }

  async function removeProjectFolderSafely(folderId: string): Promise<void> {
    const [folder] = await bookmarks.getSubTree(folderId);
    const children = folder.children ?? [];
    let hasUserContent = false;

    for (const child of children) {
      if (child.url && extractGeminiConversationIdFromUrl(child.url)) {
        await bookmarks.remove(child.id);
      } else {
        hasUserContent = true;
      }
    }

    if (!hasUserContent) {
      await bookmarks.remove(folderId);
    }
  }

  async function pushConfigOnlyToBookmarks(state: StoredState): Promise<void> {
    await withInternalWrite(async () => {
      const { roots } = await findRootFolders();
      if (roots.length === 0) {
        if (state.projects.length > 0) {
          await pushStateToBookmarks(state);
        }
        return;
      }
      const rootId = roots[0].id;
      await upsertConfigBookmark(rootId, state);
      const [refreshed] = await bookmarks.getSubTree(rootId);
      refreshTrackedIdsFromRoot(refreshed);
    });
  }

  async function pushAssignedChatMetadataToBookmarks(state: StoredState): Promise<void> {
    await withInternalWrite(async () => {
      const { roots } = await findRootFolders();
      if (roots.length === 0) return;
      const [root] = await bookmarks.getSubTree(roots[0].id);

      for (const folder of (root.children ?? []).filter(isFolder)) {
        for (const child of folder.children ?? []) {
          if (!child.url || isConfigBookmark(child)) continue;
          const cid = extractGeminiConversationIdFromUrl(child.url);
          if (!cid) continue;
          const chat = state.chatIndex[cid];
          if (!chat || !chat.projectId) continue;
          const targetTitle = chat.title || 'Untitled chat';
          const targetUrl = getBookmarkUrlForChat(chat);
          if (child.title !== targetTitle || child.url !== targetUrl) {
            await bookmarks.update(child.id, { title: targetTitle, url: targetUrl });
          }
        }
      }

      const [refreshed] = await bookmarks.getSubTree(root.id);
      refreshTrackedIdsFromRoot(refreshed);
    });
  }

  async function pushStateToBookmarks(state: StoredState): Promise<void> {
    await withInternalWrite(async () => {
      const root = await ensureRootFolder();
      const [freshRoot] = await bookmarks.getSubTree(root.id);
      const children = freshRoot.children ?? [];

      const existingFolders = children.filter(isFolder);
      const existingById = new Map(existingFolders.map((folder) => [folder.id, folder]));
      const existingByName = new Map<string, BookmarkNode>();
      for (const folder of existingFolders) {
        const key = normalizeProjectNameKey(folder.title);
        if (!existingByName.has(key)) existingByName.set(key, folder);
      }

      const sortedProjects = sortProjectsBySortIndex(state.projects);
      const matchedFolderIds = new Set<string>();
      const projectToFolderId = new Map<string, string>();

      for (const project of sortedProjects) {
        const rememberedId = projectFolderIdMap.get(project.id);
        let folder = rememberedId ? existingById.get(rememberedId) : undefined;
        if (folder && matchedFolderIds.has(folder.id)) folder = undefined;

        if (!folder) {
          const byName = existingByName.get(normalizeProjectNameKey(project.name));
          if (byName && !matchedFolderIds.has(byName.id)) {
            folder = byName;
          }
        }

        if (folder) {
          matchedFolderIds.add(folder.id);
          projectToFolderId.set(project.id, folder.id);
          if (folder.title !== project.name) {
            await bookmarks.update(folder.id, { title: project.name });
          }
        }
      }

      for (const project of sortedProjects) {
        if (projectToFolderId.has(project.id)) continue;
        const created = await bookmarks.create({
          parentId: root.id,
          title: project.name
        });
        matchedFolderIds.add(created.id);
        projectToFolderId.set(project.id, created.id);
      }

      for (const folder of existingFolders) {
        if (!matchedFolderIds.has(folder.id)) {
          await removeProjectFolderSafely(folder.id);
        }
      }

      const chatsByProject = new Map<string, ChatRef[]>();
      for (const chat of Object.values(state.chatIndex)) {
        if (!chat.projectId) continue;
        const list = chatsByProject.get(chat.projectId) ?? [];
        list.push(chat);
        chatsByProject.set(chat.projectId, list);
      }

      for (const project of sortedProjects) {
        const folderId = projectToFolderId.get(project.id)!;
        const projectChats = (chatsByProject.get(project.id) ?? []).sort(
          (a, b) => b.updatedAt - a.updatedAt
        );
        await syncFolderChats(folderId, projectChats);
      }

      await upsertConfigBookmark(root.id, state);

      // Ensure folder order matches sortIndex and config bookmark stays at the end
      for (let idx = 0; idx < sortedProjects.length; idx += 1) {
        const folderId = projectToFolderId.get(sortedProjects[idx].id)!;
        const [currentRoot] = await bookmarks.getSubTree(root.id);
        const currentIndex = (currentRoot.children ?? []).findIndex((c) => c.id === folderId);
        if (currentIndex !== idx) {
          await bookmarks.move(folderId, { parentId: root.id, index: idx });
        }
      }

      const [rootAfterOrder] = await bookmarks.getSubTree(root.id);
      const configNode = (rootAfterOrder.children ?? []).find(isConfigBookmark);
      if (configNode) {
        const totalChildren = (rootAfterOrder.children ?? []).length;
        const configIndex = (rootAfterOrder.children ?? []).findIndex((c) => c.id === configNode.id);
        if (configIndex !== totalChildren - 1) {
          await bookmarks.move(configNode.id, { parentId: root.id, index: totalChildren });
        }
      }

      projectFolderIdMap.clear();
      for (const [projectId, folderId] of projectToFolderId.entries()) {
        projectFolderIdMap.set(projectId, folderId);
      }

      const [finalRoot] = await bookmarks.getSubTree(root.id);
      refreshTrackedIdsFromRoot(finalRoot);
      await saveMeta({ initialized: true, lastRootBookmarkId: root.id });
    });
  }

  function scheduleReconcile(): void {
    if (disposed || internalWriteDepth > 0) return;
    if (importing) {
      pendingImportReconcile = true;
      return;
    }
    if (reconcileTimer !== null) timers.clearTimeout(reconcileTimer);
    reconcileTimer = timers.setTimeout(() => {
      reconcileTimer = null;
      return runSerialized(async () => {
        if (disposed) return;
        await reconcileFromBookmarksInternal();
      }).catch((error) => {
        console.warn('[gemini-projects] bookmark reconcile failed', error);
      });
    }, RECONCILE_DEBOUNCE_MS);
  }

  function installBookmarkListeners(): void {
    if (listenersInstalled || disposed) return;
    listenersInstalled = true;
    unsubscribers.push(
      bookmarks.onCreated((_id, bookmark) => {
        if (internalWriteDepth > 0) return;
        const parentRelevant =
          !knownOtherBookmarksId ||
          isRelevantId(bookmark.parentId) ||
          (bookmark.parentId === knownOtherBookmarksId && !bookmark.url && bookmark.title === ROOT_FOLDER_TITLE);
        if (!parentRelevant) return;
        scheduleReconcile();
      }),
      bookmarks.onChanged((id, changeInfo) => {
        if (internalWriteDepth > 0) return;
        const relevant =
          !knownOtherBookmarksId ||
          isRelevantId(id) ||
          changeInfo.title === ROOT_FOLDER_TITLE ||
          changeInfo.title === CONFIG_BOOKMARK_TITLE ||
          Boolean(changeInfo.url && (changeInfo.url.startsWith(CONFIG_URL_PREFIX) || extractGeminiConversationIdFromUrl(changeInfo.url)));
        if (!relevant) return;
        scheduleReconcile();
      }),
      bookmarks.onMoved((id, moveInfo) => {
        if (internalWriteDepth > 0) return;
        const relevant =
          !knownOtherBookmarksId ||
          isRelevantId(id) ||
          isRelevantId(moveInfo.parentId) ||
          isRelevantId(moveInfo.oldParentId) ||
          moveInfo.parentId === knownOtherBookmarksId ||
          moveInfo.oldParentId === knownOtherBookmarksId;
        if (!relevant) return;
        scheduleReconcile();
      }),
      bookmarks.onRemoved((id, removeInfo) => {
        if (internalWriteDepth > 0) return;
        const relevant =
          !knownOtherBookmarksId ||
          isRelevantId(id) ||
          isRelevantId(removeInfo.parentId) ||
          (!removeInfo.node.url && removeInfo.node.title === ROOT_FOLDER_TITLE);
        if (!relevant) return;
        scheduleReconcile();
      }),
      bookmarks.onImportBegan(() => {
        importing = true;
      }),
      bookmarks.onImportEnded(() => {
        importing = false;
        if (pendingImportReconcile) {
          pendingImportReconcile = false;
          scheduleReconcile();
        }
      })
    );
  }

  function parseConfigEntriesFromRoot(root: BookmarkNode): {
    configs: DecodedProjectConfig[];
    hasConfigBookmark: boolean;
    hasDuplicateConfigs: boolean;
    hadCorruptConfig: boolean;
  } {
    const configNodes = (root.children ?? []).filter(isConfigBookmark);
    if (configNodes.length === 0) {
      return { configs: [], hasConfigBookmark: false, hasDuplicateConfigs: false, hadCorruptConfig: false };
    }
    const mergedById = new Map<string, DecodedProjectConfig>();
    let hadCorruptConfig = false;
    for (const node of configNodes) {
      const entries = decodeConfigUrl(node.url);
      if (!entries) {
        hadCorruptConfig = true;
        continue;
      }
      for (const entry of entries) {
        const existing = mergedById.get(entry.id);
        if (!existing || entry.updatedAt >= existing.updatedAt) {
          mergedById.set(entry.id, entry);
        }
      }
    }
    const mergedByName = new Map<string, DecodedProjectConfig>();
    for (const entry of mergedById.values()) {
      const nameKey = normalizeProjectNameKey(entry.name);
      const existing = mergedByName.get(nameKey);
      if (!existing || entry.updatedAt >= existing.updatedAt) {
        mergedByName.set(nameKey, entry);
      }
    }
    return {
      configs: Array.from(mergedByName.values()),
      hasConfigBookmark: true,
      hasDuplicateConfigs: configNodes.length > 1,
      hadCorruptConfig
    };
  }

  async function normalizeBookmarkRoots(): Promise<{
    root: BookmarkNode | null;
    mutatedStructure: boolean;
  }> {
    const { roots } = await findRootFolders();
    if (roots.length === 0) {
      return { root: null, mutatedStructure: false };
    }

    let mutatedStructure = false;
    const primaryRoot = roots[0];

    if (roots.length > 1) {
      await withInternalWrite(async () => {
        for (let i = 1; i < roots.length; i += 1) {
          const moved = await moveMatchingChildrenAndRemoveIfEmpty(
            roots[i].id,
            primaryRoot.id,
            (child) => isFolder(child) || isConfigBookmark(child)
          );
          if (moved) mutatedStructure = true;
        }
      });
    }

    const [freshRoot] = await bookmarks.getSubTree(primaryRoot.id);
    const folders = (freshRoot.children ?? []).filter(isFolder);
    const firstFolderByName = new Map<string, BookmarkNode>();
    const duplicateFolders: Array<{ target: BookmarkNode; duplicate: BookmarkNode }> = [];

    for (const folder of folders) {
      const key = normalizeProjectNameKey(folder.title);
      const existing = firstFolderByName.get(key);
      if (!existing) {
        firstFolderByName.set(key, folder);
      } else {
        duplicateFolders.push({ target: existing, duplicate: folder });
      }
    }

    if (duplicateFolders.length > 0) {
      await withInternalWrite(async () => {
        for (const { target, duplicate } of duplicateFolders) {
          const moved = await moveMatchingChildrenAndRemoveIfEmpty(
            duplicate.id,
            target.id,
            (child) => Boolean(child.url && extractGeminiConversationIdFromUrl(child.url))
          );
          if (moved) mutatedStructure = true;
        }
      });
    }

    const [normalizedRoot] = await bookmarks.getSubTree(primaryRoot.id);
    return { root: normalizedRoot, mutatedStructure };
  }

  function buildStateFromBookmarkRoot(
    root: BookmarkNode,
    currentState: StoredState
  ): {
    nextState: StoredState;
    folderMap: Map<string, string>;
    needsConfigWriteback: boolean;
    duplicateChatBookmarkIds: string[];
  } {
    const rawFolders = (root.children ?? []).filter(isFolder);
    const parsedConfig = parseConfigEntriesFromRoot(root);
    const hasConfigBookmark = parsedConfig.hasConfigBookmark;
    const hasDuplicateConfigs = parsedConfig.hasDuplicateConfigs;
    const hadCorruptConfig = parsedConfig.hadCorruptConfig;

    // Fall back to local cached project styles when config bookmark is missing or corrupted
    const configs =
      parsedConfig.configs.length > 0
        ? parsedConfig.configs
        : !hasConfigBookmark || hadCorruptConfig
          ? currentState.projects.map(projectToDecodedConfig)
          : [];

    const configByName = new Map<string, DecodedProjectConfig>();
    for (const cfg of configs) {
      configByName.set(normalizeProjectNameKey(cfg.name), cfg);
    }

    // Filter out duplicate-name residual folders (kept only for user non-target bookmarks)
    // and unconfigured folders that contain exclusively non-target user items (residual from deleteProject)
    const seenFolderNames = new Set<string>();
    const folderChatNodes: Array<{
      folder: BookmarkNode;
      nameKey: string;
      chatNodes: Array<{ node: BookmarkNode; cid: string; normalizedUrl: string }>;
      cidSet: Set<string>;
    }> = [];

    for (const folder of rawFolders) {
      const folderName = folder.title.trim() || 'Untitled project';
      const nameKey = normalizeProjectNameKey(folderName);
      if (seenFolderNames.has(nameKey)) continue;

      const chatNodes: Array<{ node: BookmarkNode; cid: string; normalizedUrl: string }> = [];
      let nonTargetCount = 0;
      for (const child of folder.children ?? []) {
        if (child.url && !isConfigBookmark(child)) {
          const cid = extractGeminiConversationIdFromUrl(child.url);
          if (cid) {
            const normalizedUrl = normalizeChatUrl(child.url, cid) ?? `https://gemini.google.com/app/${cid}`;
            chatNodes.push({ node: child, cid, normalizedUrl });
            continue;
          }
        }
        if (!isConfigBookmark(child)) {
          nonTargetCount += 1;
        }
      }

      const inConfig = configByName.has(nameKey);
      if (!inConfig && chatNodes.length === 0 && nonTargetCount > 0) {
        continue;
      }

      seenFolderNames.add(nameKey);
      folderChatNodes.push({
        folder,
        nameKey,
        chatNodes,
        cidSet: new Set(chatNodes.map((item) => item.cid))
      });
    }

    const configCidSets = new Map<string, Set<string>>();
    for (const cfg of configs) {
      const set = new Set<string>(cfg.conversationIds);
      for (const chat of Object.values(currentState.chatIndex)) {
        if (chat.projectId === cfg.id) set.add(chat.conversationId);
      }
      configCidSets.set(cfg.id, set);
    }

    const matchedConfigByFolderIndex = new Map<number, DecodedProjectConfig>();
    const usedConfigIds = new Set<string>();
    let needsConfigWriteback =
      (!hasConfigBookmark && folderChatNodes.length > 0) || hasDuplicateConfigs || hadCorruptConfig;

    // Tier 1: Exact normalized name match
    folderChatNodes.forEach((item, index) => {
      const cfg = configByName.get(item.nameKey);
      if (cfg && !usedConfigIds.has(cfg.id)) {
        matchedConfigByFolderIndex.set(index, cfg);
        usedConfigIds.add(cfg.id);
      }
    });

    // Tier 2: Conversation ID overlap matching to detect manual folder renames
    const unmatchedFolderIndices = folderChatNodes
      .map((_, index) => index)
      .filter((index) => !matchedConfigByFolderIndex.has(index));
    const unmatchedConfigs = configs.filter((cfg) => !usedConfigIds.has(cfg.id));

    if (unmatchedFolderIndices.length > 0 && unmatchedConfigs.length > 0) {
      const candidates: Array<{ folderIndex: number; cfg: DecodedProjectConfig; overlap: number }> = [];
      for (const folderIndex of unmatchedFolderIndices) {
        const folderCids = folderChatNodes[folderIndex].cidSet;
        if (folderCids.size === 0) continue;
        for (const cfg of unmatchedConfigs) {
          const cfgCids = configCidSets.get(cfg.id);
          if (!cfgCids || cfgCids.size === 0) continue;
          let overlap = 0;
          for (const cid of folderCids) {
            if (cfgCids.has(cid)) overlap += 1;
          }
          if (overlap > 0) {
            candidates.push({ folderIndex, cfg, overlap });
          }
        }
      }
      candidates.sort((a, b) => b.overlap - a.overlap);
      for (const candidate of candidates) {
        if (matchedConfigByFolderIndex.has(candidate.folderIndex) || usedConfigIds.has(candidate.cfg.id)) {
          continue;
        }
        matchedConfigByFolderIndex.set(candidate.folderIndex, candidate.cfg);
        usedConfigIds.add(candidate.cfg.id);
        needsConfigWriteback = true;
      }
    }

    // If any config entries correspond to deleted folders, prune them from the config bookmark
    if (configs.some((cfg) => !usedConfigIds.has(cfg.id))) {
      needsConfigWriteback = true;
    }

    const usedProjectIds = new Set<string>();
    const folderMap = new Map<string, string>();
    const nextProjects: Project[] = [];
    const bookmarkAssignments = new Map<
      string,
      { bookmarkId: string; projectId: string; title: string; lastUrl: string; dateAdded: number }
    >();
    const duplicateChatBookmarkIds: string[] = [];
    const now = Date.now();

    folderChatNodes.forEach(({ folder, chatNodes }, index) => {
      const folderName = folder.title.trim() || 'Untitled project';
      const matchedConfig = matchedConfigByFolderIndex.get(index);
      let id: string;
      let project: Project;

      if (matchedConfig && !usedProjectIds.has(matchedConfig.id)) {
        id = matchedConfig.id;
        // Exact comparison so case-only renames also update config bookmark
        const renamed = matchedConfig.name.trim() !== folderName;
        if (renamed) needsConfigWriteback = true;
        project = {
          id,
          name: folderName,
          icon: matchedConfig.icon,
          iconStyle: matchedConfig.iconStyle,
          color: matchedConfig.color,
          useIconPalette: matchedConfig.useIconPalette,
          isPinned: matchedConfig.isPinned,
          createdAt: matchedConfig.createdAt ?? matchedConfig.updatedAt,
          updatedAt: renamed ? now : matchedConfig.updatedAt,
          sortIndex: index
        };
      } else {
        id = crypto.randomUUID();
        project = {
          id,
          name: folderName,
          icon: 'default',
          iconStyle: DEFAULT_PROJECT_ICON_STYLE,
          useIconPalette: true,
          isPinned: false,
          createdAt: folder.dateAdded ?? now,
          updatedAt: now,
          sortIndex: index
        };
        needsConfigWriteback = true;
      }

      usedProjectIds.add(id);
      folderMap.set(id, folder.id);
      nextProjects.push(project);

      for (const { node, cid, normalizedUrl } of chatNodes) {
        const candidateDate = node.dateAdded ?? 0;
        const existing = bookmarkAssignments.get(cid);
        const candidate = {
          bookmarkId: node.id,
          projectId: id,
          title: node.title.trim() || currentState.chatIndex[cid]?.title || 'Untitled chat',
          lastUrl: normalizedUrl,
          dateAdded: candidateDate
        };
        if (!existing) {
          bookmarkAssignments.set(cid, candidate);
        } else if (candidateDate >= existing.dateAdded) {
          duplicateChatBookmarkIds.push(existing.bookmarkId);
          bookmarkAssignments.set(cid, candidate);
        } else {
          duplicateChatBookmarkIds.push(candidate.bookmarkId);
        }
      }
    });

    let chatAssignmentsChanged = false;
    const nextChatIndex: Record<string, ChatRef> = {};
    for (const [cid, existing] of Object.entries(currentState.chatIndex)) {
      const fromBookmark = bookmarkAssignments.get(cid);
      if (fromBookmark) {
        if (existing.projectId !== fromBookmark.projectId) chatAssignmentsChanged = true;
        nextChatIndex[cid] = {
          ...existing,
          title: fromBookmark.title || existing.title,
          lastUrl: fromBookmark.lastUrl,
          projectId: fromBookmark.projectId,
          updatedAt: existing.projectId === fromBookmark.projectId ? existing.updatedAt : now
        };
      } else if (existing.projectId !== null) {
        chatAssignmentsChanged = true;
        nextChatIndex[cid] = {
          ...existing,
          projectId: null,
          updatedAt: now
        };
      } else {
        nextChatIndex[cid] = existing;
      }
    }

    for (const [cid, assigned] of bookmarkAssignments.entries()) {
      if (Object.hasOwn(nextChatIndex, cid)) continue;
      chatAssignmentsChanged = true;
      nextChatIndex[cid] = {
        conversationId: cid,
        title: assigned.title,
        isPinned: false,
        projectId: assigned.projectId,
        updatedAt: assigned.dateAdded || now,
        lastUrl: assigned.lastUrl
      };
    }

    if (chatAssignmentsChanged) {
      needsConfigWriteback = true;
    }

    return {
      nextState: {
        ...currentState,
        projects: nextProjects,
        chatIndex: nextChatIndex
      },
      folderMap,
      needsConfigWriteback,
      duplicateChatBookmarkIds
    };
  }

  async function reconcileFromBookmarksInternal(): Promise<void> {
    const currentState = await getState();
    const meta = await loadMeta();
    const { root, mutatedStructure } = await normalizeBookmarkRoots();
    if (!root) {
      refreshTrackedIdsFromRoot(null);
      if (meta.initialized && currentState.projects.length > 0) {
        await pushStateToBookmarks(currentState);
      }
      return;
    }

    const { nextState, folderMap, needsConfigWriteback, duplicateChatBookmarkIds } =
      buildStateFromBookmarkRoot(root, currentState);

    if (duplicateChatBookmarkIds.length > 0) {
      await withInternalWrite(async () => {
        for (const dupId of duplicateChatBookmarkIds) {
          await bookmarks.remove(dupId);
        }
      });
    }

    projectFolderIdMap.clear();
    for (const [projectId, folderId] of folderMap.entries()) {
      projectFolderIdMap.set(projectId, folderId);
    }

    const stateChanged = !areStatesEqual(currentState, nextState);
    if (stateChanged) {
      await commitState(nextState);
    }
    if (!meta.initialized || meta.lastRootBookmarkId !== root.id) {
      await saveMeta({ initialized: true, lastRootBookmarkId: root.id });
    }

    if (needsConfigWriteback || mutatedStructure) {
      await pushConfigOnlyToBookmarks(nextState);
    } else {
      const [refreshed] = await bookmarks.getSubTree(root.id);
      refreshTrackedIdsFromRoot(refreshed);
    }
  }

  function mergeColdStartState(localState: StoredState, bookmarkState: StoredState): StoredState {
    const mergedProjects: Project[] = [];
    const byName = new Map<string, Project>();
    const localIdToMergedId = new Map<string, string>();

    for (const remoteProject of bookmarkState.projects) {
      const nameKey = normalizeProjectNameKey(remoteProject.name);
      byName.set(nameKey, remoteProject);
      mergedProjects.push(remoteProject);
    }

    for (const localProject of sortProjectsBySortIndex(localState.projects)) {
      const nameKey = normalizeProjectNameKey(localProject.name);
      const existing = byName.get(nameKey);
      if (existing) {
        localIdToMergedId.set(localProject.id, existing.id);
        if (localProject.updatedAt > existing.updatedAt) {
          const updated: Project = {
            ...existing,
            name: localProject.name,
            icon: localProject.icon,
            iconStyle: localProject.iconStyle,
            color: localProject.color,
            useIconPalette: localProject.useIconPalette,
            isPinned: localProject.isPinned,
            updatedAt: localProject.updatedAt
          };
          byName.set(nameKey, updated);
          const idx = mergedProjects.findIndex((p) => p.id === existing.id);
          if (idx >= 0) mergedProjects[idx] = updated;
        }
      } else {
        const mergedId = mergedProjects.some((p) => p.id === localProject.id)
          ? crypto.randomUUID()
          : localProject.id;
        localIdToMergedId.set(localProject.id, mergedId);
        const appended: Project = {
          ...localProject,
          id: mergedId,
          sortIndex: mergedProjects.length
        };
        byName.set(nameKey, appended);
        mergedProjects.push(appended);
      }
    }

    const validProjectIds = new Set(mergedProjects.map((p) => p.id));
    const mergedChatIndex: Record<string, ChatRef> = {};

    for (const [cid, localChat] of Object.entries(localState.chatIndex)) {
      const mappedProjectId = localChat.projectId
        ? localIdToMergedId.get(localChat.projectId) ?? localChat.projectId
        : null;
      mergedChatIndex[cid] = {
        ...localChat,
        projectId: mappedProjectId && validProjectIds.has(mappedProjectId) ? mappedProjectId : null
      };
    }

    for (const [cid, remoteChat] of Object.entries(bookmarkState.chatIndex)) {
      if (!remoteChat.projectId || !validProjectIds.has(remoteChat.projectId)) continue;
      const existing = mergedChatIndex[cid];
      mergedChatIndex[cid] = {
        conversationId: cid,
        title: remoteChat.title || existing?.title || 'Untitled chat',
        isPinned: existing?.isPinned ?? remoteChat.isPinned ?? false,
        projectId: remoteChat.projectId,
        updatedAt: Math.max(existing?.updatedAt ?? 0, remoteChat.updatedAt),
        lastUrl: remoteChat.lastUrl ?? existing?.lastUrl
      };
    }

    return {
      ...localState,
      projects: mergedProjects.map((project, index) => ({ ...project, sortIndex: index })),
      chatIndex: mergedChatIndex
    };
  }

  async function initialize(): Promise<void> {
    installBookmarkListeners();
    const meta = await loadMeta();
    const state = await getState();
    const { roots } = await findRootFolders();
    const hasLocalProjects = state.projects.length > 0;
    const hasBookmarkContent = roots.some((root) => (root.children ?? []).length > 0);

    if (!meta.initialized) {
      if (hasLocalProjects && !hasBookmarkContent) {
        await pushStateToBookmarks(state);
      } else if (!hasLocalProjects && hasBookmarkContent) {
        await reconcileFromBookmarksInternal();
      } else if (hasLocalProjects && hasBookmarkContent) {
        const { root } = await normalizeBookmarkRoots();
        if (root) {
          const { nextState: bookmarkState } = buildStateFromBookmarkRoot(root, {
            ...state,
            projects: [],
            chatIndex: {}
          });
          const merged = mergeColdStartState(state, bookmarkState);
          await commitState(merged);
          await pushStateToBookmarks(merged);
        }
      } else {
        refreshTrackedIdsFromRoot(roots[0] ?? null);
        await saveMeta({ initialized: true, lastRootBookmarkId: roots[0]?.id });
      }
      return;
    }

    await reconcileFromBookmarksInternal();
  }

  return {
    initialize,

    async pushState(state: StoredState) {
      if (disposed) return;
      await pushStateToBookmarks(state);
    },

    async pushConfigOnly(state: StoredState) {
      if (disposed) return;
      await pushConfigOnlyToBookmarks(state);
    },

    scheduleChatRefPush() {
      if (disposed) return;
      if (chatPushTimer !== null) timers.clearTimeout(chatPushTimer);
      chatPushTimer = timers.setTimeout(() => {
        chatPushTimer = null;
        return runSerialized(async () => {
          if (disposed) return;
          const state = await getState();
          await pushAssignedChatMetadataToBookmarks(state);
        }).catch((error) => {
          console.warn('[gemini-projects] bookmark chat ref push failed', error);
        });
      }, CHAT_PUSH_DEBOUNCE_MS);
    },

    dispose() {
      disposed = true;
      if (chatPushTimer !== null) {
        timers.clearTimeout(chatPushTimer);
        chatPushTimer = null;
      }
      if (reconcileTimer !== null) {
        timers.clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers.length = 0;
    }
  };
}
