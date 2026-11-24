// Preserve deep links to operations from when Swagger UI occupied the site root.
if (window.location.hash.startsWith('#/')) {
  window.location.replace(`./api/${window.location.hash}`);
}
