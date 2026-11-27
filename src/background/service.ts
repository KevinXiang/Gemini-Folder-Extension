import {
  BackgroundRequest,
  BackgroundResponse,
  ChatRef,
  DEFAULT_PROJECT_ICON_STYLE,
  NativeChatMetadata,
  Project,
  StoredState
} from '../shared/types';
import {
  createEmptyState,
  DUPLICATE_PROJECT_NAME_ERROR,
  hasDuplicateProjectName,
  isProjectIconStyle,
  isSafeId,
  normalizeChatUrl,
  normalizeProjectsState,
  STORAGE_KEY
} from '../shared/storage';
import { createSeedData, normalizePromptsData, PROMPTS_KEY, PromptsData } from '../shared/prompts';
import { validateBackup } from '../shared/backup';
import {
  BookmarksAdapter,
  BookmarkSyncController,
  createBookmarkSync,
  LocalStorageAdapter,
  TimerAdapter
} from './bookmarkSync';

export interface BackgroundServiceOptions {
  storage: LocalStorageAdapter;
  bookmarks?: BookmarksAdapter;
  timers?: TimerAdapter;
}

export interface BackgroundService {
  initialize(): Promise<void>;
  handleMessage(message: BackgroundRequest): Promise<BackgroundResponse>;
  dispose(): void;
}

export function createBackgroundService(options: BackgroundServiceOptions): BackgroundService {
  const { storage, bookmarks, timers } = options;

  let cachedState: StoredState | null = null;
  let cachedPrompts: PromptsData | null = null;
  let mutationTail: Promise<void> = Promise.resolve();
  let initPromise: Promise<void> | null = null;

  async function loadStoredState(): Promise<StoredState> {
    const result = await storage.get<Record<string, unknown>>(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (raw === undefined) return createEmptyState();
    const state = normalizeProjectsState(raw);
    if (!state) throw new Error('Could not read projects data.');
    return state;
  }

  async function getState(): Promise<StoredState> {
    cachedState ??= await loadStoredState();
    return cachedState;
  }

  async function getPrompts(): Promise<PromptsData> {
    if (cachedPrompts) return cachedPrompts;
    const raw = (await storage.get<Record<string, unknown>>(PROMPTS_KEY))[PROMPTS_KEY];
    if (raw === undefined) {
      const seeded = createSeedData();
      await storage.set({ [PROMPTS_KEY]: seeded });
      cachedPrompts = seeded;
    } else {
      cachedPrompts = normalizePromptsData(raw);
      if (!cachedPrompts) throw new Error('Could not read prompts. Please try again.');
    }
    return cachedPrompts;
  }

  // 串行化写入，避免多标签页或高频同步消息并发覆盖状态。
  function runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const next = mutationTail.then(task, task);
    mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async function commitState(nextState: StoredState): Promise<StoredState> {
    await storage.set({ [STORAGE_KEY]: nextState });
    cachedState = nextState;
    return nextState;
  }

  const bookmarkSync: BookmarkSyncController | null = bookmarks
    ? createBookmarkSync({
        bookmarks,
        storage,
        timers,
        runSerialized,
        getState,
        commitState
      })
    : null;

  function ensureInitialized(): Promise<void> {
    if (!bookmarkSync) return Promise.resolve();
    initPromise ??= runSerialized(async () => {
      try {
        await bookmarkSync.initialize();
      } catch (error) {
        console.warn('[gemini-projects] bookmark sync init failed', error);
      }
    });
    return initPromise;
  }

  function buildUpsertProjectState(state: StoredState, project: Project): StoredState {
    const exists = state.projects.some((item) => item.id === project.id);
    const projects = exists
      ? state.projects.map((item) =>
          item.id === project.id
            ? {
                ...item,
                name: project.name,
                icon: project.icon,
                iconStyle: project.iconStyle ?? item.iconStyle,
                color: project.color,
                useIconPalette: project.useIconPalette,
                updatedAt: Date.now()
              }
            : item
        )
      : [...state.projects, { ...project, iconStyle: project.iconStyle ?? DEFAULT_PROJECT_ICON_STYLE }];
    return { ...state, projects };
  }

  function buildDeleteProjectState(state: StoredState, projectId: string): StoredState {
    const projects = state.projects.filter((item) => item.id !== projectId);
    const chatIndex: Record<string, ChatRef> = {};
    for (const [key, chat] of Object.entries(state.chatIndex)) {
      chatIndex[key] = chat.projectId === projectId ? { ...chat, projectId: null } : chat;
    }
    return { ...state, projects, chatIndex };
  }

  function mergeNativeMetadata(existing: ChatRef | undefined, chat: NativeChatMetadata): ChatRef {
    // 原生历史扫描只拥有标题和 URL，项目归属及其更新时间由后台维护。
    return {
      conversationId: chat.conversationId,
      title: chat.title || existing?.title || '',
      isPinned: existing?.isPinned ?? false,
      projectId: existing?.projectId ?? null,
      updatedAt: existing?.updatedAt ?? Date.now(),
      lastUrl: normalizeChatUrl(chat.lastUrl, chat.conversationId) ?? existing?.lastUrl
    };
  }

  function buildUpsertChatRefsState(
    state: StoredState,
    chats: NativeChatMetadata[]
  ): { state: StoredState; changedAssigned: boolean } {
    const chatIndex: Record<string, ChatRef> = { ...state.chatIndex };
    let changed = false;
    let changedAssigned = false;
    for (const chat of chats) {
      if (!isSafeId(chat.conversationId)) continue;
      const existing = chatIndex[chat.conversationId];
      const next = mergeNativeMetadata(existing, chat);
      if (existing?.title === next.title && existing.lastUrl === next.lastUrl) continue;
      chatIndex[chat.conversationId] = next;
      changed = true;
      if (next.projectId) changedAssigned = true;
    }
    return { state: changed ? { ...state, chatIndex } : state, changedAssigned };
  }

  function buildUpdateUiPrefsState(state: StoredState, prefs: Partial<StoredState['uiPrefs']>): StoredState {
    return {
      ...state,
      uiPrefs: { projectsCollapsed: prefs.projectsCollapsed ?? state.uiPrefs.projectsCollapsed }
    };
  }

  async function safePushState(state: StoredState, configOnly = false): Promise<void> {
    if (!bookmarkSync) return;
    try {
      if (configOnly) {
        await bookmarkSync.pushConfigOnly(state);
      } else {
        await bookmarkSync.pushState(state);
      }
    } catch (error) {
      console.warn('[gemini-projects] bookmark sync push failed', error);
    }
  }

  async function handleMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
    if (
      message.type !== 'getPrompts' &&
      message.type !== 'savePrompt' &&
      message.type !== 'deletePrompt' &&
      message.type !== 'trackPromptUsage'
    ) {
      await ensureInitialized();
    }

    return runSerialized<BackgroundResponse>(async () => {
      switch (message.type) {
        case 'restoreBackup': {
          const { projects, prompts } = validateBackup(message.data);
          await storage.set({
            ...(projects && { [STORAGE_KEY]: projects }),
            ...(prompts && { [PROMPTS_KEY]: prompts })
          });
          if (projects) {
            cachedState = projects;
            await safePushState(projects);
          }
          if (prompts) cachedPrompts = prompts;
          return { ok: true };
        }
        case 'getPrompts':
          return { ok: true, prompts: await getPrompts() };
        case 'savePrompt':
        case 'deletePrompt':
        case 'trackPromptUsage': {
          const current = await getPrompts();
          const prompts = { ...current.prompts };
          const id =
            message.type === 'savePrompt' ? message.prompt.id ?? crypto.randomUUID() : message.id;
          if (!isSafeId(id)) return { ok: false, error: 'Invalid prompt ID.' };
          const existing = prompts[id];
          const now = Date.now();
          if (message.type === 'savePrompt') {
            const { title, content } = message.prompt;
            if (!title.trim() || !content.trim()) return { ok: false, error: 'Name and content are required.' };
            if (message.prompt.id && !existing) return { ok: false, error: 'This prompt was removed in another tab.' };
            prompts[id] = {
              id,
              title,
              content,
              updatedAt: now,
              createdAt: existing?.createdAt ?? now,
              usageCount: existing?.usageCount ?? 0,
              lastUsedAt: existing?.lastUsedAt ?? 0
            };
          } else {
            if (!existing) return { ok: true };
            if (message.type === 'deletePrompt') delete prompts[id];
            else prompts[id] = { ...existing, usageCount: existing.usageCount + 1, lastUsedAt: now };
          }
          const next = { ...current, prompts };
          await storage.set({ [PROMPTS_KEY]: next });
          cachedPrompts = next;
          return { ok: true };
        }
      }

      const state = await getState();
      switch (message.type) {
        case 'getState':
          return { ok: true, state };
        case 'upsertProject': {
          const trimmedName = message.project.name.trim();
          if (!trimmedName) {
            return { ok: false, error: 'Project name is required.' };
          }
          if (message.project.iconStyle !== undefined && !isProjectIconStyle(message.project.iconStyle)) {
            return { ok: false, error: 'Invalid project icon style.' };
          }
          if (message.editing && !state.projects.some((item) => item.id === message.project.id)) {
            return { ok: false, error: 'Project not found' };
          }
          if (hasDuplicateProjectName(state.projects, trimmedName, message.editing ? message.project.id : null)) {
            return { ok: false, error: DUPLICATE_PROJECT_NAME_ERROR };
          }
          const nextState = await commitState(
            buildUpsertProjectState(state, { ...message.project, name: trimmedName })
          );
          await safePushState(nextState);
          return { ok: true, state: nextState };
        }
        case 'setProjectPinned': {
          const project = state.projects.find((item) => item.id === message.projectId);
          if (!project) return { ok: false, error: 'Project not found' };
          const nextState = await commitState({
            ...state,
            projects: state.projects.map((item) =>
              item.id === project.id
                ? { ...item, isPinned: message.isPinned, updatedAt: Date.now() }
                : item
            )
          });
          await safePushState(nextState, true);
          return { ok: true, state: nextState };
        }
        case 'deleteProject': {
          const nextState = await commitState(buildDeleteProjectState(state, message.projectId));
          await safePushState(nextState);
          return { ok: true, state: nextState };
        }
        case 'moveChat': {
          const { conversationId, projectId, metadata } = message;
          if (
            !isSafeId(conversationId) ||
            (projectId !== null && !state.projects.some((item) => item.id === projectId))
          ) {
            return { ok: false, error: 'Chat or destination project is unavailable.' };
          }
          const existing = state.chatIndex[conversationId];
          const chat = mergeNativeMetadata(
            existing,
            metadata
              ? { ...metadata, conversationId }
              : {
                  conversationId,
                  title: ''
                }
          );
          if (!existing && !chat.lastUrl) return { ok: false, error: 'Chat is unavailable.' };
          const nextState = await commitState({
            ...state,
            chatIndex: {
              ...state.chatIndex,
              [conversationId]: { ...chat, projectId, updatedAt: Date.now() }
            }
          });
          await safePushState(nextState);
          return { ok: true, state: nextState };
        }
        case 'upsertChatRefs': {
          const { state: next, changedAssigned } = buildUpsertChatRefsState(state, message.chats);
          if (next === state) return { ok: true, state };
          const committed = await commitState(next);
          if (changedAssigned) {
            bookmarkSync?.scheduleChatRefPush();
          }
          return { ok: true, state: committed };
        }
        case 'updateUiPrefs': {
          const nextState = await commitState(buildUpdateUiPrefsState(state, message.prefs));
          return { ok: true, state: nextState };
        }
        default:
          return { ok: false, error: 'Unknown message type' };
      }
    });
  }

  return {
    initialize: ensureInitialized,
    handleMessage,
    dispose() {
      bookmarkSync?.dispose();
    }
  };
}
