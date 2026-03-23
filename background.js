'use strict';

// Open popup.html as a centered window instead of the tiny dropdown
chrome.action.onClicked.addListener(async () => {
  const WIDTH = 860;
  const HEIGHT = 900;

  // Get current window — centre horizontally, 20% from top
  const current = await chrome.windows.getCurrent();
  const left = Math.round(current.left + (current.width - WIDTH) / 2);
  const top = Math.round(current.top + current.height * 0.2);

  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: WIDTH,
    height: HEIGHT,
    left,
    top,
  });
});
