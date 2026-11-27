const viewer = document.querySelector('dialog.viewer');
const screenshot = viewer.querySelector('img');
const caption = viewer.querySelector('#viewer-caption');
const shareUrl = viewer.querySelector('#screenshot-url');
const copyStatus = viewer.querySelector('[role="status"]');
const cards = [...document.querySelectorAll('.feature-image[data-gallery]')];
let current = 0;

function showScreenshot(index) {
  current = (index + cards.length) % cards.length;
  const card = cards[current];
  const source = card.querySelector('img');
  screenshot.alt = source.alt;
  screenshot.src = card.href;
  const title = card.closest('article').querySelector('h3').textContent;
  caption.textContent = `${current + 1} of ${cards.length} · ${title}`;
  const url = new URL(document.querySelector('link[rel="canonical"]').href);
  url.hash = card.id;
  shareUrl.value = url.href;
  shareUrl.hidden = true;
  copyStatus.textContent = '';
}

if (typeof viewer.showModal === 'function') {
  const previous = viewer.querySelector('#viewer-previous');
  const next = viewer.querySelector('#viewer-next');
  previous.addEventListener('click', () => showScreenshot(current - 1));
  next.addEventListener('click', () => showScreenshot(current + 1));
  viewer.querySelector('#viewer-close').addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', (event) => {
    if (event.target === viewer) viewer.close();
  });
  viewer.addEventListener('keydown', (event) => {
    if (event.target === shareUrl || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      showScreenshot(current + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });

  for (const link of document.querySelectorAll('[data-gallery]')) {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      showScreenshot(cards.findIndex((card) => card.id === link.dataset.gallery));
      if (!viewer.open) viewer.showModal();
    });
  }

  function openLinkedScreenshot() {
    const target = window.location.hash.slice(1);
    const index = cards.findIndex((card) => card.id === target);
    if (index < 0) return;
    showScreenshot(index);
    if (!viewer.open) viewer.showModal();
  }

  window.addEventListener('hashchange', openLinkedScreenshot);
  openLinkedScreenshot();
}
