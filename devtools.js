chrome.devtools.panels.create('GIG Components', 'icons/panel.svg', 'panel.html', panel => {
  let panelWindow = null;

  panel.onShown.addListener(window => {
    panelWindow = window;
    panelWindow.postMessage({ type: 'gig-panel-visibility', visible: true }, '*');
  });

  panel.onHidden.addListener(() => {
    panelWindow?.postMessage({ type: 'gig-panel-visibility', visible: false }, '*');
  });
});
