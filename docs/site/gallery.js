const viewer = document.querySelector('dialog.viewer');
const screenshot = viewer.querySelector('img');

for (const link of document.querySelectorAll('[data-gallery]')) {
  link.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (typeof viewer.showModal !== 'function') return;

    event.preventDefault();
    screenshot.alt = link.querySelector('img').alt;
    screenshot.src = link.href;
    viewer.showModal();
  });
}

viewer.querySelector('button').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', (event) => {
  if (event.target === viewer) viewer.close();
});
