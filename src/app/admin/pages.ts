/**
 * HTML server-rendered del admin web. Template literals + CSS inline, sin build
 * step ni dependencias. Todo lo que muestra el admin se genera acá.
 */

const STYLES = `
:root { color-scheme: light dark; --bg:#0f1115; --panel:#171a21; --line:#272c36; --fg:#e6e8ec; --muted:#9aa3b2; --accent:#4c8dff; --danger:#ff6b6b; --ok:#3ddc97; }
@media (prefers-color-scheme: light) { :root { --bg:#f5f6f8; --panel:#fff; --line:#dfe3ea; --fg:#1b1f27; --muted:#5b6472; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
header.top { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.75rem 1.25rem; border-bottom:1px solid var(--line); background:var(--panel); }
.brand { font-weight:700; color:var(--fg); text-decoration:none; }
nav { display:flex; align-items:center; gap:.75rem; }
nav a { color:var(--muted); text-decoration:none; }
nav a:hover { color:var(--fg); }
main { max-width:64rem; margin:0 auto; padding:1.5rem 1.25rem 4rem; }
h1 { font-size:1.35rem; margin:.25rem 0 1rem; }
h2 { font-size:1.05rem; margin:1.75rem 0 .5rem; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:1rem; margin-bottom:1rem; }
table { width:100%; border-collapse:collapse; font-size:.95rem; }
th, td { text-align:left; padding:.55rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
tr:last-child td { border-bottom:0; }
a.row { color:inherit; text-decoration:none; }
a.row:hover td { background:rgba(76,141,255,.08); }
label { display:block; font-size:.85rem; color:var(--muted); margin:.6rem 0 .25rem; }
input, select, button { font:inherit; }
input, select { width:100%; padding:.5rem .6rem; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); }
button { padding:.5rem .9rem; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:8px; cursor:pointer; }
button.ghost { background:transparent; color:var(--fg); border-color:var(--line); }
button.danger { background:transparent; border-color:var(--danger); color:var(--danger); }
button:hover { filter:brightness(1.08); }
form.inline { display:inline; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(12rem,1fr)); gap:.75rem; }
.badge { display:inline-block; padding:.1rem .5rem; border-radius:999px; font-size:.78rem; border:1px solid var(--line); color:var(--muted); }
.badge.TRIAL { color:var(--accent); border-color:var(--accent); }
.badge.ACTIVE { color:var(--ok); border-color:var(--ok); }
.badge.READ_ONLY, .badge.SUSPENDED { color:var(--danger); border-color:var(--danger); }
.error { border:1px solid var(--danger); color:var(--danger); border-radius:8px; padding:.6rem .8rem; margin-bottom:1rem; }
.flash { border:1px solid var(--ok); color:var(--ok); border-radius:8px; padding:.6rem .8rem; margin-bottom:1rem; word-break:break-all; }
.muted { color:var(--muted); }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85rem; word-break:break-all; }
.actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
.empty { color:var(--muted); font-style:italic; padding:.5rem 0; }
`;

export function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export interface LayoutOptions {
  /** Barra superior con navegación y cierre de sesión (solo con sesión). */
  showNav?: boolean;
}

export function layout(title: string, body: string, opts: LayoutOptions = {}): string {
  const nav = opts.showNav
    ? `<nav><a href="/admin/">Negocios</a><form class="inline" method="post" action="/admin/logout"><button class="ghost" type="submit">Salir</button></form></nav>`
    : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · bot-platform admin</title>
<style>${STYLES}</style>
</head>
<body>
<header class="top"><a class="brand" href="/admin/">bot-platform · admin</a>${nav}</header>
<main>${body}</main>
</body>
</html>`;
}

export function loginPage(opts: { error?: string } = {}): string {
  const error = opts.error ? `<p class="error">${esc(opts.error)}</p>` : '';
  const body = `
<div class="panel" style="max-width:22rem;margin:3rem auto;">
  <h1>Entrar al admin</h1>
  ${error}
  <form method="post" action="/admin/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <p><button type="submit">Entrar</button></p>
  </form>
  <p class="muted">Herramienta interna de operaciones. Los intentos quedan registrados.</p>
</div>`;
  return layout('Entrar', body);
}
