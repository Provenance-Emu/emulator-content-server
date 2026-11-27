const pageUrl = document.querySelector('link[rel="canonical"]').href;
document.querySelector('#share-url').value = pageUrl;

for (const button of document.querySelectorAll('[data-copy]')) {
  const source = document.getElementById(button.dataset.copy);
  const status = button
    .closest('.quick-install, .share-panel, .viewer')
    .querySelector('[role="status"]');
  button.hidden = false;
  button.addEventListener('click', async () => {
    const value = source.value ?? source.textContent;
    const label = button.getAttribute('aria-label') ?? button.textContent.trim();
    status.textContent = '';
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = `${label.replace(/^Copy /, 'Copied ')}.`;
    } catch {
      source.hidden = false;
      if (typeof source.select === 'function') {
        source.focus();
        source.select();
      } else {
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      status.textContent = 'Text selected. Use your device’s copy command.';
    }
  });
}

const shareButton = document.querySelector('#native-share');
if (typeof navigator.share === 'function') {
  shareButton.hidden = false;
  shareButton.addEventListener('click', async () => {
    const status = shareButton.closest('.share-panel').querySelector('[role="status"]');
    status.textContent = '';
    try {
      await navigator.share({ title: 'Emulation Server', url: pageUrl });
    } catch (error) {
      if (error.name !== 'AbortError')
        status.textContent = 'Sharing is unavailable. Use Copy link.';
    }
  });
}
