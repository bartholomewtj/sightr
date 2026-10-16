// Applies a pinned light theme to <html> before first paint. web2 is dark by default (style/tokens.md),
// so only an explicit Light pin needs a class. Same storage key as v1 (same origin), bare string.
(function () {
  try {
    if (localStorage.getItem("sightr:theme:v1") === "light") document.documentElement.classList.add("light");
  } catch (e) {
    // Private mode can throw; dark stays.
  }
})();
