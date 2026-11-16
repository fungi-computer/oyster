import { raw } from "hono/html";

/**
 * The recovery pages load no asset, so their styling travels inline. They stay
 * readable in light and dark when the selected App or Shell cannot load.
 */
export const recoveryStyle = raw(`<style>
:root{color-scheme:light dark;--bg:#faf8f4;--card:#fff;--ink:#2a2622;--muted:#6f675e;--line:#e4ded4;--accent:#1f6f54;--accent-ink:#fff;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#171512;--card:#211e1a;--ink:#f0ebe3;--muted:#a39a8e;--line:#3a352e;--accent:#58c29b;--accent-ink:#0f1a15;--warn:#e0b04a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:44rem;margin:0 auto;padding:2rem 1rem 3rem}
h1{font-size:1.5rem;margin:0 0 .5rem}
h2{font-size:1.1rem;margin:0 0 .5rem;overflow-wrap:anywhere}
p{margin:.35rem 0}
.lede,.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.25rem;margin:1rem 0}
.row{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;margin-top:.75rem}
dl{margin:.5rem 0;display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
button{font:inherit;font-weight:600;cursor:pointer;border-radius:8px;padding:.5rem 1rem;border:1px solid var(--line);background:transparent;color:var(--ink)}
button.primary,a.button{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent)}
a.button{display:inline-block;font-weight:600;border-radius:8px;padding:.5rem 1rem;border:1px solid var(--line);text-decoration:none}
a.button.primary{color:var(--accent-ink)}
small{font-size:.8rem;margin-left:.4rem}
.status{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 .6rem;font-size:.9rem}
.warn{color:var(--warn)}
form{margin:0}
header.bar{padding:.75rem 1rem;border-bottom:1px solid var(--line);background:var(--card)}
header.bar p{margin:.25rem 0}
</style>`);
