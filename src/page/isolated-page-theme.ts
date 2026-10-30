/** Called once by an isolated page entry for its document's lifetime. */
export function bootstrapIsolatedPageTheme() {
  const appearance = matchMedia("(prefers-color-scheme: dark)");
  const setTheme = () => {
    document.documentElement.dataset.theme = appearance.matches
      ? "mocha"
      : "latte";
  };
  setTheme();
  appearance.addEventListener("change", setTheme);
}
