import { BackgroundRequest, BackgroundResponse } from './shared/types';
import {
  createChromeBookmarksAdapter,
  storageLocalGet,
  storageLocalSet,
  webext
} from './shared/webext';
import { createBackgroundService } from './background/service';

const service = createBackgroundService({
  storage: {
    get: storageLocalGet,
    set: storageLocalSet
  },
  bookmarks: webext?.bookmarks ? createChromeBookmarksAdapter() : undefined
});

void service.initialize();

webext.runtime.onMessage.addListener(
  (
    message: BackgroundRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: BackgroundResponse) => void
  ) => {
    service
      .handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
);
