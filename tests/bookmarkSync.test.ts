import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_BOOKMARK_TITLE, ROOT_FOLDER_TITLE } from '../src/background/bookmarkSync';
import { createBackgroundService } from '../src/background/service';
import { STORAGE_KEY } from '../src/shared/storage';
import type { Project, StoredState } from '../src/shared/types';
import { createFakeBookmarks, createFakeStorage, createFakeTimers, type FakeBookmarks } from './fakes/chromeFakes';

async function getProjectsRoot(bookmarks: FakeBookmarks) {
  const [other] = await bookmarks.getSubTree(bookmarks.otherBookmarksId);
  return (other.children ?? []).find((node) => !node.url && node.title === ROOT_FOLDER_TITLE) ?? null;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = 1_700_000_000_000;
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Work Research',
    icon: overrides.icon ?? 'research',
    iconStyle: overrides.iconStyle ?? 'duotone',
    color: overrides.color,
    useIconPalette: overrides.useIconPalette ?? true,
    isPinned: overrides.isPinned ?? false,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    sortIndex: overrides.sortIndex ?? 0
  };
}

test('Slice 1: upsertProject rejects duplicate project names ignoring whitespace and case, but allows editing self', async () => {
  const storage = createFakeStorage();
  const bookmarks = createFakeBookmarks();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  const first = await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'proj-1', name: 'Work Research' })
  });
  assert.equal(first.ok, true);

  const duplicateCreate = await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'proj-2', name: '  work research  ' })
  });
  assert.equal(duplicateCreate.ok, false);
  if (!duplicateCreate.ok) {
    assert.match(duplicateCreate.error, /already exists/i);
  }

  const selfEdit = await service.handleMessage({
    type: 'upsertProject',
    editing: true,
    project: makeProject({ id: 'proj-1', name: 'work research', icon: 'coding' })
  });
  assert.equal(selfEdit.ok, true);

  const second = await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'proj-2', name: 'Writing' })
  });
  assert.equal(second.ok, true);

  const duplicateRename = await service.handleMessage({
    type: 'upsertProject',
    editing: true,
    project: makeProject({ id: 'proj-2', name: 'WORK RESEARCH' })
  });
  assert.equal(duplicateRename.ok, false);

  service.dispose();
});

test('Slice 2a: cold-start on existing local device pushes projects and assigned chats only to Other Bookmarks / Gemini Projects', async () => {
  const initialState: StoredState = {
    schemaVersion: 1,
    projects: [
      makeProject({ id: 'p-b', name: 'Beta', sortIndex: 20, icon: 'coding', iconStyle: 'solid', color: '#3b82f6', useIconPalette: undefined, isPinned: true }),
      makeProject({ id: 'p-a', name: 'Alpha', sortIndex: 10, icon: 'writing', iconStyle: 'outline' })
    ],
    chatIndex: {
      chat_assigned_1: {
        conversationId: 'chat_assigned_1',
        title: 'Architecture Review',
        projectId: 'p-a',
        updatedAt: 1000,
        lastUrl: 'https://gemini.google.com/u/1/app/chat_assigned_1'
      },
      chat_assigned_2: {
        conversationId: 'chat_assigned_2',
        title: 'Fallback URL Chat',
        projectId: 'p-b',
        updatedAt: 2000
      },
      chat_unassigned: {
        conversationId: 'chat_unassigned',
        title: 'Random Unassigned',
        projectId: null,
        updatedAt: 3000,
        lastUrl: 'https://gemini.google.com/app/chat_unassigned'
      }
    },
    uiPrefs: { projectsCollapsed: false }
  };

  const storage = createFakeStorage({ [STORAGE_KEY]: initialState });
  const bookmarks = createFakeBookmarks();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.initialize();

  const root = await getProjectsRoot(bookmarks);
  assert.ok(root, 'Gemini Projects root folder should be created under Other Bookmarks');

  const children = root.children ?? [];
  assert.equal(children.length, 3);
  // Folders ordered by sortIndex (Alpha=10 before Beta=20, even though Beta is pinned), config bookmark last
  assert.equal(children[0].title, 'Alpha');
  assert.equal(children[1].title, 'Beta');
  assert.equal(children[2].title, CONFIG_BOOKMARK_TITLE);
  assert.ok(children[2].url?.startsWith('https://gemini.google.com/#gp-sync-v1='));

  assert.deepEqual(
    (children[0].children ?? []).map((item) => ({ title: item.title, url: item.url })),
    [{ title: 'Architecture Review', url: 'https://gemini.google.com/u/1/app/chat_assigned_1' }]
  );
  assert.deepEqual(
    (children[1].children ?? []).map((item) => ({ title: item.title, url: item.url })),
    [{ title: 'Fallback URL Chat', url: 'https://gemini.google.com/app/chat_assigned_2' }]
  );

  service.dispose();
});

test('Slice 2b: project CRUD, pin/unpin, and moveChat update bookmarks while keeping folder sortIndex stable on pin', async () => {
  const storage = createFakeStorage();
  const bookmarks = createFakeBookmarks();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p1', name: 'First', sortIndex: 1 })
  });
  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p2', name: 'Second', sortIndex: 2 })
  });
  await service.handleMessage({
    type: 'moveChat',
    conversationId: 'conv_1',
    projectId: 'p1',
    metadata: {
      conversationId: 'conv_1',
      title: 'My Chat',
      lastUrl: 'https://gemini.google.com/app/conv_1'
    }
  });

  // Pinning Second must not reorder bookmark folders (First remains index 0, Second index 1)
  await service.handleMessage({ type: 'setProjectPinned', projectId: 'p2', isPinned: true });

  let root = await getProjectsRoot(bookmarks);
  assert.ok(root);
  assert.deepEqual(
    (root.children ?? []).map((c) => c.title),
    ['First', 'Second', CONFIG_BOOKMARK_TITLE]
  );
  assert.equal(root.children![0].children?.length, 1);
  assert.equal(root.children![0].children![0].url, 'https://gemini.google.com/app/conv_1');

  // Move chat to Second, rename First, then delete First
  await service.handleMessage({ type: 'moveChat', conversationId: 'conv_1', projectId: 'p2' });
  await service.handleMessage({
    type: 'upsertProject',
    editing: true,
    project: makeProject({ id: 'p1', name: 'First Renamed', sortIndex: 1 })
  });
  root = await getProjectsRoot(bookmarks);
  assert.equal(root!.children![0].title, 'First Renamed');
  assert.equal(root!.children![0].children?.length, 0);
  assert.equal(root!.children![1].children?.length, 1);

  // Unassign chat and delete project
  await service.handleMessage({ type: 'moveChat', conversationId: 'conv_1', projectId: null });
  await service.handleMessage({ type: 'deleteProject', projectId: 'p1' });

  root = await getProjectsRoot(bookmarks);
  assert.deepEqual(
    (root!.children ?? []).map((c) => c.title),
    ['Second', CONFIG_BOOKMARK_TITLE]
  );
  assert.equal(root!.children![0].children?.length, 0);

  service.dispose();
});

test('Slice 3a: fresh device cold-start pulls projects, metadata, pin, sortIndex, and chats from synced bookmarks', async () => {
  // Simulate Device A pushing its state to bookmarks
  const bookmarks = createFakeBookmarks();
  const deviceAStorage = createFakeStorage({
    [STORAGE_KEY]: {
      schemaVersion: 1,
      projects: [
        makeProject({ id: 'p-1', name: 'Research', sortIndex: 0, icon: 'beaker', iconStyle: 'solid', color: '#10b981', useIconPalette: undefined, isPinned: true }),
        makeProject({ id: 'p-2', name: 'Travel', sortIndex: 1, icon: 'airplane', iconStyle: 'outline', isPinned: false })
      ],
      chatIndex: {
        conv_res_1: {
          conversationId: 'conv_res_1',
          title: 'Paper Notes',
          projectId: 'p-1',
          updatedAt: 5000,
          lastUrl: 'https://gemini.google.com/u/2/app/conv_res_1'
        }
      },
      uiPrefs: { projectsCollapsed: false }
    } satisfies StoredState
  });
  const deviceA = createBackgroundService({ storage: deviceAStorage, bookmarks, timers: createFakeTimers() });
  await deviceA.initialize();
  deviceA.dispose();

  // Device B starts with empty local storage and the synced bookmarks tree
  const deviceBStorage = createFakeStorage();
  const deviceB = createBackgroundService({ storage: deviceBStorage, bookmarks, timers: createFakeTimers() });
  const res = await deviceB.handleMessage({ type: 'getState' });
  assert.equal(res.ok, true);
  if (res.ok && res.state) {
    assert.equal(res.state.projects.length, 2);
    const research = res.state.projects.find((p) => p.name === 'Research');
    const travel = res.state.projects.find((p) => p.name === 'Travel');
    assert.ok(research && travel);
    assert.equal(research.id, 'p-1');
    assert.equal(research.icon, 'beaker');
    assert.equal(research.iconStyle, 'solid');
    assert.equal(research.color, '#10b981');
    assert.equal(research.isPinned, true);
    assert.equal(research.sortIndex, 0);
    assert.equal(travel.id, 'p-2');
    assert.equal(travel.icon, 'airplane');
    assert.equal(travel.isPinned, false);
    assert.equal(travel.sortIndex, 1);

    assert.equal(res.state.chatIndex.conv_res_1?.projectId, 'p-1');
    assert.equal(res.state.chatIndex.conv_res_1?.lastUrl, 'https://gemini.google.com/u/2/app/conv_res_1');
  }
  deviceB.dispose();
});

test('Slice 3b: external bookmark edits (add folder, reorder, move chat, delete chat/folder, import batch) sync back after debounce', async () => {
  const bookmarks = createFakeBookmarks();
  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p1', name: 'Alpha', sortIndex: 0 })
  });
  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p2', name: 'Beta', sortIndex: 1 })
  });
  await service.handleMessage({
    type: 'moveChat',
    conversationId: 'c1',
    projectId: 'p1',
    metadata: { conversationId: 'c1', title: 'Chat One', lastUrl: 'https://gemini.google.com/app/c1' }
  });
  await service.handleMessage({
    type: 'moveChat',
    conversationId: 'c2',
    projectId: 'p1',
    metadata: { conversationId: 'c2', title: 'Chat Two', lastUrl: 'https://gemini.google.com/app/c2' }
  });

  // External user actions in Chrome Bookmark Manager inside an import batch
  const root = (await getProjectsRoot(bookmarks))!;
  const alphaFolder = root.children!.find((c) => c.title === 'Alpha')!;
  const betaFolder = root.children!.find((c) => c.title === 'Beta')!;
  const chat1Node = alphaFolder.children!.find((c) => c.url?.includes('c1'))!;
  const chat2Node = alphaFolder.children!.find((c) => c.url?.includes('c2'))!;

  bookmarks.emitImportBegan();
  // Move Beta before Alpha
  await bookmarks.move(betaFolder.id, { parentId: root.id, index: 0 });
  // Move c1 from Alpha to Beta
  await bookmarks.move(chat1Node.id, { parentId: betaFolder.id });
  // Delete c2 bookmark
  await bookmarks.remove(chat2Node.id);
  // Create a brand new folder Gamma in Bookmark Manager
  await bookmarks.create({ parentId: root.id, title: 'Gamma', index: 2 });
  // While import is in progress, debounce should not have fired reconciliation yet
  await timers.advanceBy(2000);
  let stateBeforeEnd = await service.handleMessage({ type: 'getState' });
  assert.equal(stateBeforeEnd.ok && stateBeforeEnd.state?.projects.length, 2);

  bookmarks.emitImportEnded();
  await timers.advanceBy(1500);

  let afterBatch = await service.handleMessage({ type: 'getState' });
  assert.equal(afterBatch.ok, true);
  if (afterBatch.ok && afterBatch.state) {
    const byName = new Map(afterBatch.state.projects.map((p) => [p.name, p]));
    assert.equal(byName.size, 3);
    assert.ok(byName.get('Beta')!.sortIndex < byName.get('Alpha')!.sortIndex);
    assert.ok(byName.has('Gamma'));
    assert.equal(afterBatch.state.chatIndex.c1?.projectId, 'p2');
    // Deleted chat bookmark unassigns projectId (keeps chatIndex entry so native sidebar restores it)
    assert.equal(afterBatch.state.chatIndex.c2?.projectId, null);
  }

  // Delete Alpha folder externally
  await bookmarks.removeTree(alphaFolder.id);
  await timers.advanceBy(1500);
  const afterDelete = await service.handleMessage({ type: 'getState' });
  assert.equal(afterDelete.ok, true);
  if (afterDelete.ok && afterDelete.state) {
    assert.equal(afterDelete.state.projects.some((p) => p.name === 'Alpha'), false);
    assert.equal(afterDelete.state.projects.length, 2);
  }

  service.dispose();
});

test('Slice 4: cold-start union merges when both local storage and bookmarks already have data', async () => {
  const bookmarks = createFakeBookmarks();

  // Device A already synced Shared + OnlyA to bookmarks
  const deviceAStorage = createFakeStorage({
    [STORAGE_KEY]: {
      schemaVersion: 1,
      projects: [
        makeProject({ id: 'pa-shared', name: 'Shared', icon: 'beaker', updatedAt: 2000, sortIndex: 0 }),
        makeProject({ id: 'pa-only', name: 'OnlyA', icon: 'coding', updatedAt: 2000, sortIndex: 1 })
      ],
      chatIndex: {
        c_shared: {
          conversationId: 'c_shared',
          title: 'Shared Chat',
          projectId: 'pa-shared',
          updatedAt: 2000,
          lastUrl: 'https://gemini.google.com/app/c_shared'
        },
        c_only_a: {
          conversationId: 'c_only_a',
          title: 'Chat A',
          projectId: 'pa-only',
          updatedAt: 2000,
          lastUrl: 'https://gemini.google.com/app/c_only_a'
        }
      },
      uiPrefs: { projectsCollapsed: false }
    } satisfies StoredState
  });
  const deviceA = createBackgroundService({ storage: deviceAStorage, bookmarks, timers: createFakeTimers() });
  await deviceA.initialize();
  deviceA.dispose();

  // Device B upgrades with its own pre-existing local projects (no sync meta yet)
  const deviceBStorage = createFakeStorage({
    [STORAGE_KEY]: {
      schemaVersion: 1,
      projects: [
        makeProject({ id: 'pb-shared', name: 'shared', icon: 'writing', updatedAt: 1000, sortIndex: 0 }),
        makeProject({ id: 'pb-only', name: 'OnlyB', icon: 'travel', updatedAt: 1500, sortIndex: 1 })
      ],
      chatIndex: {
        c_shared: {
          conversationId: 'c_shared',
          title: 'Shared Chat Local',
          projectId: 'pb-only',
          updatedAt: 1500,
          lastUrl: 'https://gemini.google.com/app/c_shared'
        },
        c_only_b: {
          conversationId: 'c_only_b',
          title: 'Chat B',
          projectId: 'pb-only',
          updatedAt: 1500,
          lastUrl: 'https://gemini.google.com/app/c_only_b'
        }
      },
      uiPrefs: { projectsCollapsed: false }
    } satisfies StoredState
  });

  const deviceBTimers = createFakeTimers();
  const deviceB = createBackgroundService({ storage: deviceBStorage, bookmarks, timers: deviceBTimers });
  const res = await deviceB.handleMessage({ type: 'getState' });
  assert.equal(res.ok, true);
  if (res.ok && res.state) {
    const names = res.state.projects.map((p) => p.name).sort();
    assert.deepEqual(names, ['OnlyA', 'OnlyB', 'Shared']);

    const shared = res.state.projects.find((p) => p.name === 'Shared')!;
    const onlyA = res.state.projects.find((p) => p.name === 'OnlyA')!;
    const onlyB = res.state.projects.find((p) => p.name === 'OnlyB')!;
    assert.equal(shared.icon, 'beaker'); // newer updatedAt from bookmarks wins
    assert.equal(res.state.chatIndex.c_only_a?.projectId, onlyA.id);
    assert.equal(res.state.chatIndex.c_only_b?.projectId, onlyB.id);
    // Conflicting assignment for c_shared resolves to bookmark side
    assert.equal(res.state.chatIndex.c_shared?.projectId, shared.id);
  }

  // Bookmarks should also now contain OnlyB and c_only_b
  const root = (await getProjectsRoot(bookmarks))!;
  const onlyBFolder = root.children!.find((c) => c.title === 'OnlyB');
  assert.ok(onlyBFolder, 'OnlyB should be pushed to bookmarks after union merge');
  assert.equal(onlyBFolder.children?.length, 1);
  assert.equal(onlyBFolder.children![0].url, 'https://gemini.google.com/app/c_only_b');

  // After initialization, deleting OnlyB externally works normally
  await bookmarks.removeTree(onlyBFolder.id);
  await deviceBTimers.advanceBy(1500);
  const afterDelete = await deviceB.handleMessage({ type: 'getState' });
  assert.equal(afterDelete.ok && afterDelete.state?.projects.some((p) => p.name === 'OnlyB'), false);

  deviceB.dispose();
});

test('Slice 5a: manual folder rename in Bookmark Manager preserves project id and styling via conversationId overlap', async () => {
  const bookmarks = createFakeBookmarks();
  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({
      id: 'proj-styled',
      name: 'Old Name',
      icon: 'lotus',
      iconStyle: 'solid',
      color: '#ec4899',
      useIconPalette: undefined,
      isPinned: true,
      sortIndex: 0
    })
  });
  await service.handleMessage({
    type: 'moveChat',
    conversationId: 'c_overlap_1',
    projectId: 'proj-styled',
    metadata: { conversationId: 'c_overlap_1', title: 'Topic 1', lastUrl: 'https://gemini.google.com/app/c_overlap_1' }
  });

  // Externally rename the bookmark folder without touching the config bookmark
  const root = (await getProjectsRoot(bookmarks))!;
  const folder = root.children!.find((c) => c.title === 'Old Name')!;
  await bookmarks.update(folder.id, { title: 'Renamed Manually' });
  await timers.advanceBy(1500);

  const res = await service.handleMessage({ type: 'getState' });
  assert.equal(res.ok, true);
  if (res.ok && res.state) {
    assert.equal(res.state.projects.length, 1);
    const project = res.state.projects[0];
    assert.equal(project.id, 'proj-styled');
    assert.equal(project.name, 'Renamed Manually');
    assert.equal(project.icon, 'lotus');
    assert.equal(project.iconStyle, 'solid');
    assert.equal(project.color, '#ec4899');
    assert.equal(project.isPinned, true);
  }

  service.dispose();
});

test('Slice 5b: deduplicates multiple roots, multiple configs (LWW), duplicate project folders, and duplicate chat bookmarks (newest dateAdded wins)', async () => {
  const bookmarks = createFakeBookmarks();

  // Create root 1 (older) with Work (older config) + duplicate chat c_dup (older dateAdded)
  bookmarks.setClock(1_700_000_001_000);
  const root1 = bookmarks.createSilent({ parentId: bookmarks.otherBookmarksId, title: ROOT_FOLDER_TITLE, dateAdded: 1000 });
  const work1 = bookmarks.createSilent({ parentId: root1.id, title: 'Work', dateAdded: 1100 });
  bookmarks.createSilent({ parentId: work1.id, title: 'Chat One', url: 'https://gemini.google.com/app/c_1', dateAdded: 1200 });
  bookmarks.createSilent({ parentId: work1.id, title: 'Dup Chat Old', url: 'https://gemini.google.com/app/c_dup', dateAdded: 1300 });
  const olderConfigPayload = Buffer.from(
    JSON.stringify({
      v: 1,
      p: [{ id: 'p-work', n: 'Work', i: 'briefcase', s: 'outline', at: 1000 }]
    })
  ).toString('base64url');
  bookmarks.createSilent({
    parentId: root1.id,
    title: CONFIG_BOOKMARK_TITLE,
    url: `https://gemini.google.com/#gp-sync-v1=${olderConfigPayload}`,
    dateAdded: 1400
  });

  // Create root 2 (newer) with duplicate folder 'work', new folder 'Play', newer config for Work, and newer c_dup in Play
  const root2 = bookmarks.createSilent({ parentId: bookmarks.otherBookmarksId, title: ROOT_FOLDER_TITLE, dateAdded: 2000 });
  const work2 = bookmarks.createSilent({ parentId: root2.id, title: 'work', dateAdded: 2100 });
  bookmarks.createSilent({ parentId: work2.id, title: 'Chat Two', url: 'https://gemini.google.com/app/c_2', dateAdded: 2200 });
  const playFolder = bookmarks.createSilent({ parentId: root2.id, title: 'Play', dateAdded: 2300 });
  bookmarks.createSilent({ parentId: playFolder.id, title: 'Dup Chat New', url: 'https://gemini.google.com/app/c_dup', dateAdded: 5000 });
  const newerConfigPayload = Buffer.from(
    JSON.stringify({
      v: 1,
      p: [
        { id: 'p-work', n: 'Work', i: 'coding', s: 'solid', pin: 1, at: 5000 },
        { id: 'p-play', n: 'Play', i: 'music', s: 'duotone', at: 4000 }
      ]
    })
  ).toString('base64url');
  bookmarks.createSilent({
    parentId: root2.id,
    title: CONFIG_BOOKMARK_TITLE,
    url: `https://gemini.google.com/#gp-sync-v1=${newerConfigPayload}`,
    dateAdded: 2400
  });

  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  const res = await service.handleMessage({ type: 'getState' });
  assert.equal(res.ok, true);
  if (res.ok && res.state) {
    assert.equal(res.state.projects.length, 2);
    const work = res.state.projects.find((p) => p.name.toLowerCase() === 'work')!;
    const play = res.state.projects.find((p) => p.name === 'Play')!;
    assert.ok(work && play);
    // Newer config won LWW for Work
    assert.equal(work.id, 'p-work');
    assert.equal(work.icon, 'coding');
    assert.equal(work.iconStyle, 'solid');
    assert.equal(work.isPinned, true);
    // Both chats from Work and work merged into Work
    assert.equal(res.state.chatIndex.c_1?.projectId, work.id);
    assert.equal(res.state.chatIndex.c_2?.projectId, work.id);
    // Newer duplicate chat in Play won over older duplicate in Work
    assert.equal(res.state.chatIndex.c_dup?.projectId, play.id);
  }

  // Bookmarks tree should now have a single root, single config, 2 folders, and no duplicate c_dup in Work
  const [other] = await bookmarks.getSubTree(bookmarks.otherBookmarksId);
  const rootsAfter = (other.children ?? []).filter((n) => !n.url && n.title === ROOT_FOLDER_TITLE);
  assert.equal(rootsAfter.length, 1);
  assert.equal(rootsAfter[0].id, root1.id);

  const rootChildren = rootsAfter[0].children ?? [];
  const configNodes = rootChildren.filter((n) => n.title === CONFIG_BOOKMARK_TITLE);
  assert.equal(configNodes.length, 1);

  const workFolderAfter = rootChildren.find((n) => !n.url && n.title.toLowerCase() === 'work')!;
  const playFolderAfter = rootChildren.find((n) => !n.url && n.title === 'Play')!;
  assert.equal(
    (workFolderAfter.children ?? []).some((n) => n.url?.includes('c_dup')),
    false,
    'Older duplicate chat bookmark should be removed from Work'
  );
  assert.equal(
    (playFolderAfter.children ?? []).some((n) => n.url?.includes('c_dup')),
    true,
    'Newer chat bookmark should remain in Play'
  );

  service.dispose();
});

test('Slice 6a: accidental deletion of Gemini Projects root folder preserves local projects and recreates root', async () => {
  const bookmarks = createFakeBookmarks();
  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p-keep', name: 'Important', icon: 'heart', isPinned: true })
  });
  await service.handleMessage({
    type: 'moveChat',
    conversationId: 'c_keep',
    projectId: 'p-keep',
    metadata: { conversationId: 'c_keep', title: 'Keep Me', lastUrl: 'https://gemini.google.com/app/c_keep' }
  });

  const rootBefore = (await getProjectsRoot(bookmarks))!;
  await bookmarks.removeTree(rootBefore.id);
  await timers.advanceBy(1500);

  const res = await service.handleMessage({ type: 'getState' });
  assert.equal(res.ok, true);
  if (res.ok && res.state) {
    assert.equal(res.state.projects.length, 1);
    assert.equal(res.state.projects[0].id, 'p-keep');
    assert.equal(res.state.chatIndex.c_keep?.projectId, 'p-keep');
  }

  const rootAfter = await getProjectsRoot(bookmarks);
  assert.ok(rootAfter, 'Root folder should be recreated automatically');
  const importantFolder = (rootAfter.children ?? []).find((c) => c.title === 'Important');
  assert.ok(importantFolder);
  assert.equal(importantFolder.children?.length, 1);

  service.dispose();
});

test('Slice 6b: accidental deletion of config bookmark preserves local styling and rebuilds config bookmark', async () => {
  const bookmarks = createFakeBookmarks();
  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({
      id: 'p-style',
      name: 'Design',
      icon: 'palette',
      iconStyle: 'outline',
      color: '#f59e0b',
      useIconPalette: undefined,
      isPinned: true
    })
  });

  const rootBefore = (await getProjectsRoot(bookmarks))!;
  const configBefore = (rootBefore.children ?? []).find((c) => c.title === CONFIG_BOOKMARK_TITLE)!;
  await bookmarks.remove(configBefore.id);
  await timers.advanceBy(1500);

  const res = await service.handleMessage({ type: 'getState' });
  assert.equal(res.ok, true);
  if (res.ok && res.state) {
    const design = res.state.projects[0];
    assert.equal(design.id, 'p-style');
    assert.equal(design.icon, 'palette');
    assert.equal(design.iconStyle, 'outline');
    assert.equal(design.color, '#f59e0b');
    assert.equal(design.isPinned, true);
  }

  const rootAfter = (await getProjectsRoot(bookmarks))!;
  const configAfter = (rootAfter.children ?? []).find((c) => c.title === CONFIG_BOOKMARK_TITLE);
  assert.ok(configAfter, 'Config bookmark should be rebuilt automatically');

  service.dispose();
});

test('Slice 6c: non-Gemini bookmarks and nested subfolders are ignored and never deleted during sync or deleteProject', async () => {
  const bookmarks = createFakeBookmarks();
  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p-ref', name: 'Refs' })
  });
  await service.handleMessage({
    type: 'moveChat',
    conversationId: 'c_ref',
    projectId: 'p-ref',
    metadata: { conversationId: 'c_ref', title: 'Gemini Ref', lastUrl: 'https://gemini.google.com/app/c_ref' }
  });

  const root = (await getProjectsRoot(bookmarks))!;
  const refsFolder = (root.children ?? []).find((c) => c.title === 'Refs')!;
  const userLink = await bookmarks.create({
    parentId: refsFolder.id,
    title: 'External Docs',
    url: 'https://example.com/docs'
  });
  const nestedSubfolder = await bookmarks.create({
    parentId: refsFolder.id,
    title: 'Nested Notes'
  });
  await bookmarks.create({
    parentId: nestedSubfolder.id,
    title: 'Deep Link',
    url: 'https://example.com/deep'
  });

  await timers.advanceBy(1500);

  // Sync must not create projects or chatIndex entries for non-Gemini bookmarks / nested folders
  let res = await service.handleMessage({ type: 'getState' });
  assert.equal(res.ok && res.state?.projects.length, 1);
  assert.deepEqual(Object.keys(res.ok && res.state ? res.state.chatIndex : {}), ['c_ref']);

  // Deleting project removes Gemini chat bookmark but preserves user link and nested subfolder
  await service.handleMessage({ type: 'deleteProject', projectId: 'p-ref' });
  const [refsAfter] = await bookmarks.getSubTree(refsFolder.id);
  const childIds = (refsAfter.children ?? []).map((c) => c.id);
  assert.ok(childIds.includes(userLink.id), 'User non-Gemini bookmark must be preserved');
  assert.ok(childIds.includes(nestedSubfolder.id), 'User nested subfolder must be preserved');
  assert.equal(
    (refsAfter.children ?? []).some((c) => c.url?.includes('c_ref')),
    false,
    'Managed Gemini chat bookmark should be removed'
  );

  service.dispose();
});

test('Slice 6d: assigned chat title updates debounce to bookmarks, unassigned chats do not push, and restoreBackup overwrites bookmarks', async () => {
  const bookmarks = createFakeBookmarks();
  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p1', name: 'Active' })
  });
  await service.handleMessage({
    type: 'moveChat',
    conversationId: 'c1',
    projectId: 'p1',
    metadata: { conversationId: 'c1', title: 'Initial Title', lastUrl: 'https://gemini.google.com/app/c1' }
  });

  // Unassigned chat update should NOT schedule a bookmark push
  await service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'c_other', title: 'Unassigned Chat', lastUrl: 'https://gemini.google.com/app/c_other' }]
  });
  assert.equal(timers.pendingCount(), 0);

  // Assigned chat title rename in Gemini native sidebar debounces 1500ms before updating bookmark
  await service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'c1', title: 'Renamed in Gemini', lastUrl: 'https://gemini.google.com/app/c1' }]
  });
  assert.equal(timers.pendingCount(), 1);

  let root = (await getProjectsRoot(bookmarks))!;
  assert.equal(root.children![0].children![0].title, 'Initial Title');

  await timers.advanceBy(1500);
  root = (await getProjectsRoot(bookmarks))!;
  assert.equal(root.children![0].children![0].title, 'Renamed in Gemini');

  // Restore backup overwrites both local storage and bookmarks
  const backupRes = await service.handleMessage({
    type: 'restoreBackup',
    data: {
      version: 1,
      exportedAt: '2026-11-27T00:00:00.000Z',
      projects: {
        schemaVersion: 1,
        projects: [
          makeProject({ id: 'p-restored', name: 'Restored Project', icon: 'globe', sortIndex: 0 })
        ],
        chatIndex: {
          c_restored: {
            conversationId: 'c_restored',
            title: 'Restored Chat',
            projectId: 'p-restored',
            updatedAt: 9999,
            lastUrl: 'https://gemini.google.com/app/c_restored'
          }
        },
        uiPrefs: { projectsCollapsed: false }
      },
      prompts: null
    }
  });
  assert.equal(backupRes.ok, true);

  root = (await getProjectsRoot(bookmarks))!;
  assert.deepEqual(
    (root.children ?? []).map((c) => c.title),
    ['Restored Project', CONFIG_BOOKMARK_TITLE]
  );
  assert.equal(root.children![0].children![0].title, 'Restored Chat');

  service.dispose();
});

test('Review regressions: unrelated bookmark events are filtered, residual user-only deleted folder does not resurrect, corrupted config self-heals, case-only rename updates config, and no-op reconcile skips storage write', async () => {
  const bookmarks = createFakeBookmarks();
  const storage = createFakeStorage();
  const timers = createFakeTimers();
  const service = createBackgroundService({ storage, bookmarks, timers });

  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p-work', name: 'Work', icon: 'coding', iconStyle: 'solid', color: '#2563eb', useIconPalette: undefined, isPinned: true })
  });
  await service.handleMessage({
    type: 'upsertProject',
    editing: false,
    project: makeProject({ id: 'p-refs', name: 'Refs', icon: 'notebook', sortIndex: 1 })
  });

  // 1. Unrelated bookmark created in Bookmarks Bar should NOT schedule reconcile
  await bookmarks.create({ parentId: bookmarks.bookmarksBarId, title: 'News', url: 'https://news.ycombinator.com' });
  assert.equal(timers.pendingCount(), 0);

  // 2. Delete project containing a user non-Gemini bookmark -> folder stays for user link, but next reconcile must NOT resurrect Refs
  let root = (await getProjectsRoot(bookmarks))!;
  const refsFolder = root.children!.find((c) => c.title === 'Refs')!;
  await bookmarks.create({ parentId: refsFolder.id, title: 'My Doc', url: 'https://example.com/my-doc' });
  await timers.advanceBy(1500);
  await service.handleMessage({ type: 'deleteProject', projectId: 'p-refs' });

  // Trigger a reconcile via an external touch inside root; Refs must remain deleted
  const workFolder = (await getProjectsRoot(bookmarks))!.children!.find((c) => c.title === 'Work')!;
  await bookmarks.update(workFolder.id, { title: 'WORK' }); // case-only rename
  await timers.advanceBy(1500);

  let stateRes = await service.handleMessage({ type: 'getState' });
  assert.equal(stateRes.ok, true);
  if (stateRes.ok && stateRes.state) {
    assert.equal(stateRes.state.projects.length, 1);
    assert.equal(stateRes.state.projects[0].id, 'p-work');
    assert.equal(stateRes.state.projects[0].name, 'WORK');
  }

  // Case-only rename should have updated config bookmark so a fresh device sees 'WORK' with styling preserved
  const freshStorage = createFakeStorage();
  const freshDevice = createBackgroundService({ storage: freshStorage, bookmarks, timers: createFakeTimers() });
  const freshRes = await freshDevice.handleMessage({ type: 'getState' });
  assert.equal(freshRes.ok, true);
  if (freshRes.ok && freshRes.state) {
    assert.equal(freshRes.state.projects.length, 1);
    assert.equal(freshRes.state.projects[0].name, 'WORK');
    assert.equal(freshRes.state.projects[0].icon, 'coding');
    assert.equal(freshRes.state.projects[0].isPinned, true);
  }
  freshDevice.dispose();

  // 3. Corrupted config bookmark URL self-heals using cached local project styles
  root = (await getProjectsRoot(bookmarks))!;
  const configNode = root.children!.find((c) => c.title === CONFIG_BOOKMARK_TITLE)!;
  await bookmarks.update(configNode.id, { url: 'https://gemini.google.com/#gp-sync-v1=!!!corrupted!!!' });
  await timers.advanceBy(1500);

  stateRes = await service.handleMessage({ type: 'getState' });
  if (stateRes.ok && stateRes.state) {
    assert.equal(stateRes.state.projects[0].id, 'p-work');
    assert.equal(stateRes.state.projects[0].icon, 'coding');
    assert.equal(stateRes.state.projects[0].color, '#2563eb');
  }

  // 4. Pinning while a new remote folder is pending debounce must not wipe out the remote folder
  const remoteFolder = await bookmarks.create({ parentId: root.id, title: 'RemoteNew' });
  await service.handleMessage({ type: 'setProjectPinned', projectId: 'p-work', isPinned: false });
  root = (await getProjectsRoot(bookmarks))!;
  assert.ok(
    root.children!.some((c) => c.id === remoteFolder.id),
    'setProjectPinned should only update config bookmark without wiping pending remote folders'
  );
  await timers.advanceBy(1500);
  stateRes = await service.handleMessage({ type: 'getState' });
  assert.equal(stateRes.ok && stateRes.state?.projects.some((p) => p.name === 'RemoteNew'), true);

  // 5. Re-initializing when bookmarks match local state skips unnecessary storage.local writes
  const writesBeforeRestart = storage.getWriteCount();
  const restarted = createBackgroundService({ storage, bookmarks, timers: createFakeTimers() });
  await restarted.initialize();
  assert.equal(storage.getWriteCount(), writesBeforeRestart);
  restarted.dispose();

  service.dispose();
});
