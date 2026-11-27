type AnyFn = (...args: any[]) => any;

const globalApi = globalThis as typeof globalThis & {
  browser?: any;
  chrome?: any;
};

export const webext = globalApi.chrome ?? globalApi.browser;

function requireWebext() {
  const api = globalApi.chrome ?? globalApi.browser;
  if (!api) {
    throw new Error('WebExtension API is not available in this environment.');
  }
  return api;
}

function invokeCompat<T>(fn: AnyFn, args: unknown[]): Promise<T> {
  try {
    const maybePromise = fn(...args);
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise as Promise<T>;
    }
  } catch {
    // Fall through to callback mode for Chrome APIs.
  }

  return new Promise<T>((resolve, reject) => {
    fn(...args, (value: T) => {
      const runtimeError = globalApi.chrome?.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'WebExtension API call failed.'));
        return;
      }
      resolve(value);
    });
  });
}

export function storageLocalGet<T = Record<string, unknown>>(
  keys?: string | string[] | Record<string, unknown>
): Promise<T> {
  const api = requireWebext();
  return invokeCompat<T>(api.storage.local.get.bind(api.storage.local), [keys]);
}

export function storageLocalSet(items: Record<string, unknown>): Promise<void> {
  const api = requireWebext();
  return invokeCompat<void>(api.storage.local.set.bind(api.storage.local), [items]);
}

export function runtimeSendMessage<TResponse = unknown>(message: unknown): Promise<TResponse> {
  const api = requireWebext();
  return invokeCompat<TResponse>(api.runtime.sendMessage.bind(api.runtime), [message]);
}

export function runtimeLastErrorMessage(): string | null {
  const api = globalApi.chrome ?? globalApi.browser;
  const error = globalApi.chrome?.runtime?.lastError ?? api?.runtime?.lastError;
  return error?.message || null;
}

export interface ChromeBookmarkNodeLike {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  dateAdded?: number;
  folderType?: string;
  children?: ChromeBookmarkNodeLike[];
}

export function createChromeBookmarksAdapter() {
  const getBookmarks = () => {
    const api = requireWebext();
    if (!api.bookmarks) {
      throw new Error('Bookmarks API is not available in this environment.');
    }
    return api.bookmarks;
  };

  function subscribeEvent<TArgs extends unknown[]>(
    eventName: string,
    listener: (...args: TArgs) => void
  ): () => void {
    const event = getBookmarks()[eventName];
    if (!event?.addListener) return () => undefined;
    event.addListener(listener);
    return () => {
      event.removeListener?.(listener);
    };
  }

  return {
    getTree(): Promise<ChromeBookmarkNodeLike[]> {
      const bm = getBookmarks();
      return invokeCompat<ChromeBookmarkNodeLike[]>(bm.getTree.bind(bm), []);
    },
    getSubTree(id: string): Promise<ChromeBookmarkNodeLike[]> {
      const bm = getBookmarks();
      return invokeCompat<ChromeBookmarkNodeLike[]>(bm.getSubTree.bind(bm), [id]);
    },
    create(details: {
      parentId: string;
      title: string;
      url?: string;
      index?: number;
    }): Promise<ChromeBookmarkNodeLike> {
      const bm = getBookmarks();
      return invokeCompat<ChromeBookmarkNodeLike>(bm.create.bind(bm), [details]);
    },
    update(id: string, changes: { title?: string; url?: string }): Promise<ChromeBookmarkNodeLike> {
      const bm = getBookmarks();
      return invokeCompat<ChromeBookmarkNodeLike>(bm.update.bind(bm), [id, changes]);
    },
    move(
      id: string,
      destination: { parentId?: string; index?: number }
    ): Promise<ChromeBookmarkNodeLike> {
      const bm = getBookmarks();
      return invokeCompat<ChromeBookmarkNodeLike>(bm.move.bind(bm), [id, destination]);
    },
    remove(id: string): Promise<void> {
      const bm = getBookmarks();
      return invokeCompat<void>(bm.remove.bind(bm), [id]);
    },
    onCreated(listener: (id: string, bookmark: ChromeBookmarkNodeLike) => void) {
      return subscribeEvent('onCreated', listener);
    },
    onChanged(listener: (id: string, changeInfo: { title: string; url?: string }) => void) {
      return subscribeEvent('onChanged', listener);
    },
    onMoved(
      listener: (
        id: string,
        moveInfo: { parentId: string; index: number; oldParentId: string; oldIndex: number }
      ) => void
    ) {
      return subscribeEvent('onMoved', listener);
    },
    onRemoved(
      listener: (
        id: string,
        removeInfo: { parentId: string; index: number; node: ChromeBookmarkNodeLike }
      ) => void
    ) {
      return subscribeEvent('onRemoved', listener);
    },
    onImportBegan(listener: () => void) {
      return subscribeEvent('onImportBegan', listener);
    },
    onImportEnded(listener: () => void) {
      return subscribeEvent('onImportEnded', listener);
    }
  };
}
