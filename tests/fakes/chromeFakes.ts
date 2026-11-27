import type {
  BookmarkNode,
  BookmarksAdapter,
  LocalStorageAdapter,
  TimerAdapter
} from '../../src/background/bookmarkSync';

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function createFakeStorage(initial: Record<string, unknown> = {}): LocalStorageAdapter & {
  dump: () => Record<string, unknown>;
  getWriteCount: () => number;
} {
  const store = new Map<string, unknown>(
    Object.entries(initial).map(([key, value]) => [key, cloneValue(value)])
  );
  let writeCount = 0;

  return {
    async get<T = Record<string, unknown>>(keys?: string | string[] | Record<string, unknown>): Promise<T> {
      const result: Record<string, unknown> = {};
      if (keys === undefined) {
        for (const [key, value] of store.entries()) {
          result[key] = cloneValue(value);
        }
        return result as T;
      }
      if (typeof keys === 'string') {
        if (store.has(keys)) result[keys] = cloneValue(store.get(keys));
        return result as T;
      }
      if (Array.isArray(keys)) {
        for (const key of keys) {
          if (store.has(key)) result[key] = cloneValue(store.get(key));
        }
        return result as T;
      }
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = store.has(key) ? cloneValue(store.get(key)) : cloneValue(fallback);
      }
      return result as T;
    },

    async set(items: Record<string, unknown>): Promise<void> {
      writeCount += 1;
      for (const [key, value] of Object.entries(items)) {
        store.set(key, cloneValue(value));
      }
    },

    dump() {
      const out: Record<string, unknown> = {};
      for (const [key, value] of store.entries()) {
        out[key] = cloneValue(value);
      }
      return out;
    },

    getWriteCount() {
      return writeCount;
    }
  };
}

interface InternalBookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  dateAdded: number;
  folderType?: string;
  children?: InternalBookmarkNode[];
}

export interface FakeBookmarks extends BookmarksAdapter {
  otherBookmarksId: string;
  bookmarksBarId: string;
  removeTree: (id: string) => Promise<void>;
  setClock: (timestamp: number) => void;
  advanceClock: (ms: number) => number;
  emitImportBegan: () => void;
  emitImportEnded: () => void;
  createSilent: (details: {
    parentId: string;
    title: string;
    url?: string;
    index?: number;
    dateAdded?: number;
  }) => BookmarkNode;
}

export function createFakeBookmarks(options: { includeFolderType?: boolean } = {}): FakeBookmarks {
  const includeFolderType = options.includeFolderType !== false;
  let nextId = 10;
  let clock = 1_700_000_000_000;

  const root: InternalBookmarkNode = {
    id: '0',
    title: '',
    dateAdded: clock,
    children: [
      {
        id: '1',
        parentId: '0',
        index: 0,
        title: 'Bookmarks bar',
        dateAdded: clock,
        ...(includeFolderType ? { folderType: 'bookmarks-bar' } : {}),
        children: []
      },
      {
        id: '2',
        parentId: '0',
        index: 1,
        title: 'Other bookmarks',
        dateAdded: clock,
        ...(includeFolderType ? { folderType: 'other' } : {}),
        children: []
      }
    ]
  };

  const nodesById = new Map<string, InternalBookmarkNode>();
  nodesById.set(root.id, root);
  for (const child of root.children!) {
    nodesById.set(child.id, child);
  }

  const createdListeners = new Set<(id: string, bookmark: BookmarkNode) => void>();
  const changedListeners = new Set<(id: string, changeInfo: { title: string; url?: string }) => void>();
  const movedListeners = new Set<
    (id: string, moveInfo: { parentId: string; index: number; oldParentId: string; oldIndex: number }) => void
  >();
  const removedListeners = new Set<
    (id: string, removeInfo: { parentId: string; index: number; node: BookmarkNode }) => void
  >();
  const importBeganListeners = new Set<() => void>();
  const importEndedListeners = new Set<() => void>();

  function reindex(parent: InternalBookmarkNode) {
    if (!parent.children) return;
    parent.children.forEach((child, idx) => {
      child.index = idx;
      child.parentId = parent.id;
    });
  }

  function snapshot(node: InternalBookmarkNode): BookmarkNode {
    return {
      id: node.id,
      parentId: node.parentId,
      index: node.index,
      title: node.title,
      url: node.url,
      dateAdded: node.dateAdded,
      folderType: node.folderType,
      children: node.children ? node.children.map(snapshot) : undefined
    };
  }

  function deleteSubtreeFromIndex(node: InternalBookmarkNode) {
    nodesById.delete(node.id);
    for (const child of node.children ?? []) {
      deleteSubtreeFromIndex(child);
    }
  }

  function insertNode(
    details: { parentId: string; title: string; url?: string; index?: number; dateAdded?: number },
    emit: boolean
  ): BookmarkNode {
    const parent = nodesById.get(details.parentId);
    if (!parent || !parent.children) {
      throw new Error(`Bookmark folder not found: ${details.parentId}`);
    }
    clock += 10;
    const id = String(nextId++);
    const node: InternalBookmarkNode = {
      id,
      parentId: parent.id,
      title: details.title,
      ...(details.url !== undefined ? { url: details.url } : { children: [] }),
      dateAdded: details.dateAdded ?? clock
    };
    const index =
      details.index !== undefined
        ? Math.max(0, Math.min(details.index, parent.children.length))
        : parent.children.length;
    parent.children.splice(index, 0, node);
    reindex(parent);
    nodesById.set(id, node);
    const snap = snapshot(node);
    if (emit) {
      createdListeners.forEach((listener) => listener(id, snap));
    }
    return snap;
  }

  function removeNode(id: string, recursive: boolean): void {
    const node = nodesById.get(id);
    if (!node || !node.parentId) throw new Error(`Can't find bookmark for id: ${id}`);
    if (!recursive && node.children && node.children.length > 0) {
      throw new Error('Cannot remove a non-empty folder.');
    }
    const parent = nodesById.get(node.parentId)!;
    const index = parent.children!.indexOf(node);
    const snap = snapshot(node);
    parent.children!.splice(index, 1);
    reindex(parent);
    deleteSubtreeFromIndex(node);
    removedListeners.forEach((listener) =>
      listener(id, { parentId: parent.id, index, node: snap })
    );
  }

  return {
    otherBookmarksId: '2',
    bookmarksBarId: '1',

    setClock(timestamp: number) {
      clock = timestamp;
    },

    advanceClock(ms: number) {
      clock += ms;
      return clock;
    },

    emitImportBegan() {
      importBeganListeners.forEach((listener) => listener());
    },

    emitImportEnded() {
      importEndedListeners.forEach((listener) => listener());
    },

    createSilent(details) {
      return insertNode(details, false);
    },

    async getTree() {
      return [snapshot(root)];
    },

    async getSubTree(id: string) {
      const node = nodesById.get(id);
      if (!node) throw new Error(`Can't find bookmark for id: ${id}`);
      return [snapshot(node)];
    },

    async create(details) {
      return insertNode(details, true);
    },

    async update(id, changes) {
      const node = nodesById.get(id);
      if (!node) throw new Error(`Can't find bookmark for id: ${id}`);
      if (changes.title !== undefined) node.title = changes.title;
      if (changes.url !== undefined) {
        if (node.children) throw new Error('Cannot set url on folder');
        node.url = changes.url;
      }
      const snap = snapshot(node);
      changedListeners.forEach((listener) =>
        listener(id, { title: node.title, ...(node.url !== undefined ? { url: node.url } : {}) })
      );
      return snap;
    },

    async move(id, destination) {
      const node = nodesById.get(id);
      if (!node || !node.parentId) throw new Error(`Can't find bookmark for id: ${id}`);
      const oldParent = nodesById.get(node.parentId)!;
      const oldIndex = oldParent.children!.indexOf(node);
      const targetParent = nodesById.get(destination.parentId ?? node.parentId);
      if (!targetParent || !targetParent.children) {
        throw new Error(`Destination folder not found: ${destination.parentId}`);
      }

      oldParent.children!.splice(oldIndex, 1);
      reindex(oldParent);

      let targetIndex =
        destination.index !== undefined
          ? Math.max(0, Math.min(destination.index, targetParent.children.length))
          : targetParent.children.length;
      if (oldParent === targetParent && destination.index !== undefined && destination.index > oldIndex) {
        targetIndex = Math.max(0, Math.min(destination.index - 1, targetParent.children.length));
      }
      targetParent.children.splice(targetIndex, 0, node);
      reindex(targetParent);

      const snap = snapshot(node);
      movedListeners.forEach((listener) =>
        listener(id, {
          parentId: targetParent.id,
          index: node.index!,
          oldParentId: oldParent.id,
          oldIndex
        })
      );
      return snap;
    },

    async remove(id) {
      removeNode(id, false);
    },

    async removeTree(id) {
      removeNode(id, true);
    },

    onCreated(listener) {
      createdListeners.add(listener);
      return () => createdListeners.delete(listener);
    },

    onChanged(listener) {
      changedListeners.add(listener);
      return () => changedListeners.delete(listener);
    },

    onMoved(listener) {
      movedListeners.add(listener);
      return () => movedListeners.delete(listener);
    },

    onRemoved(listener) {
      removedListeners.add(listener);
      return () => removedListeners.delete(listener);
    },

    onImportBegan(listener) {
      importBeganListeners.add(listener);
      return () => importBeganListeners.delete(listener);
    },

    onImportEnded(listener) {
      importEndedListeners.add(listener);
      return () => importEndedListeners.delete(listener);
    }
  };
}

export interface FakeTimers extends TimerAdapter {
  now: number;
  advanceBy: (ms: number) => Promise<void>;
  flushAll: () => Promise<void>;
  pendingCount: () => number;
}

export function createFakeTimers(startNow = 1_700_000_000_000): FakeTimers {
  let nextHandle = 1;
  let currentNow = startNow;
  const tasks = new Map<number, { dueAt: number; callback: () => void | Promise<void> }>();

  async function drainDue() {
    while (true) {
      let earliestId: number | null = null;
      let earliestDue = Number.POSITIVE_INFINITY;
      for (const [id, task] of tasks.entries()) {
        if (task.dueAt <= currentNow && task.dueAt < earliestDue) {
          earliestDue = task.dueAt;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const task = tasks.get(earliestId)!;
      tasks.delete(earliestId);
      await task.callback();
    }
  }

  return {
    get now() {
      return currentNow;
    },

    setTimeout(callback, delayMs) {
      const handle = nextHandle++;
      tasks.set(handle, { dueAt: currentNow + delayMs, callback });
      return handle;
    },

    clearTimeout(handle) {
      tasks.delete(handle);
    },

    async advanceBy(ms) {
      currentNow += ms;
      await drainDue();
    },

    async flushAll() {
      while (tasks.size > 0) {
        const maxDue = Math.max(...Array.from(tasks.values(), (task) => task.dueAt));
        currentNow = Math.max(currentNow, maxDue);
        await drainDue();
      }
    },

    pendingCount() {
      return tasks.size;
    }
  };
}
