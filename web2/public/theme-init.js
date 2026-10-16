// Applies the operator's theme to <html> before first paint. web2 is dark by default (style/tokens.md),
// so only Light and System need a class: `light` pins light, `system` follows the OS (index.css).
// Same storage key as v1 (same origin), a bare string. v1 writes nothing for its System, so a v1 System
// user sees web2's dark default until they pick System here.
(function () {
  try {
    var t = localStorage.getItem("sightr:theme:v1");
    if (t === "light" || t === "system") document.documentElement.classList.add(t);
  } catch (e) {
    // Private mode can throw; dark stays.
  }
})();
