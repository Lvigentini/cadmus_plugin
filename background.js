'use strict';

// Open popup.html as a centered window instead of the tiny dropdown
chrome.action.onClicked.addListener(async () => {
  const WIDTH = 620;
  const HEIGHT = 760;

  // Get current window to center relative to it
  const current = await chrome.windows.getCurrent();
  const left = Math.round(current.left + (current.width - WIDTH) / 2);
  const top = Math.round(current.top + (current.height - HEIGHT) / 2);

  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: WIDTH,
    height: HEIGHT,
    left,
    top,
  });
});
