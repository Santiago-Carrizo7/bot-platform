/**
 * HTML server-rendered del admin web. Template literals + CSS inline, sin build
 * step ni dependencias. Todo lo que muestra el admin se genera acá.
 */
import type { Business, MembershipRole } from '../../core/tenant/entities.js';
import type { AdminTemplateOption } from './router.js';

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

export function isTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function fmtDate(date: Date | null, timezone = 'UTC'): string {
  if (!date) return '—';
  try {
    return date.toLocaleString('es-AR', { timeZone: isTimezone(timezone) ? timezone : 'UTC' });
  } catch {
    return date.toISOString();
  }
}

/** Trial restante / estado legible para la lista de negocios. */
export function trialLabel(business: Business): string {
  if (business.status === 'TRIAL') {
    if (!business.trialStartedAt) return 'trial sin usar';
    const end = business.trialStartedAt.getTime() + business.trialDays * 86_400_000;
    const days = Math.ceil((end - Date.now()) / 86_400_000);
    return days > 0 ? `trial ${days} d` : 'trial vencido';
  }
  if (business.status === 'ACTIVE') return 'activo';
  return business.status === 'READ_ONLY' ? 'solo lectura' : 'suspendido';
}

export interface InvitationView {
  id: string;
  role: MembershipRole;
  status: 'pendiente' | 'usada' | 'revocada' | 'expirada';
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export function invitationStatus(invitation: {
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InvitationView['status'] {
  if (invitation.revokedAt) return 'revocada';
  if (invitation.usedAt) return 'usada';
  if (invitation.expiresAt.getTime() <= Date.now()) return 'expirada';
  return 'pendiente';
}

export interface MemberView {
  telegramId: string;
  role: MembershipRole;
  createdAt: Date;
}

export interface BusinessListPageOptions {
  templates: AdminTemplateOption[];
  error?: string;
  flash?: string;
}

export function businessListPage(businesses: Business[], opts: BusinessListPageOptions): string {
  const error = opts.error ? `<p class="error">${esc(opts.error)}</p>` : '';
  const flash = opts.flash ? `<p class="flash">${esc(opts.flash)}</p>` : '';
  const rows = businesses
    .map(
      (b) => `
    <tr>
      <td><a class="row" href="/admin/businesses/${esc(b.id)}">${esc(b.name)}</a></td>
      <td>${esc(b.templateId)}</td>
      <td><span class="badge ${esc(b.status)}">${esc(trialLabel(b))}</span></td>
      <td class="muted">${esc(fmtDate(b.createdAt, b.timezone))}</td>
    </tr>`
    )
    .join('');
  const table = businesses.length
    ? `<table>
  <thead><tr><th>Negocio</th><th>Template</th><th>Estado</th><th>Alta</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
    : '<p class="empty">Todavía no hay negocios.</p>';

  const options = opts.templates
    .map((t) => `<option value="${esc(t.id)}">${esc(t.label)} (${esc(t.id)})</option>`)
    .join('');

  const body = `
<h1>Negocios <span class="muted">(${businesses.length})</span></h1>
${error}${flash}
<div class="panel">${table}</div>
<div class="panel">
  <h2>Crear negocio</h2>
  <form method="post" action="/admin/businesses">
    <div class="grid">
      <div>
        <label for="name">Nombre</label>
        <input id="name" name="name" required maxlength="80" placeholder="Kiosco Don Pepe">
      </div>
      <div>
        <label for="templateId">Template</label>
        <select id="templateId" name="templateId">${options}</select>
      </div>
      <div>
        <label for="timezone">Timezone</label>
        <input id="timezone" name="timezone" value="America/Argentina/Buenos_Aires">
      </div>
      <div>
        <label for="currency">Moneda (ISO 4217)</label>
        <input id="currency" name="currency" value="ARS" maxlength="3">
      </div>
    </div>
    <p><button type="submit">Crear</button></p>
  </form>
</div>`;
  return layout('Negocios', body, { showNav: true });
}

export interface BusinessDetailData {
  business: Business;
  members: MemberView[];
  invitations: InvitationView[];
  /** Deep link recién creado: se muestra UNA sola vez (la DB solo guarda el hash). */
  deepLink?: string;
  error?: string;
}

export function businessDetailPage(data: BusinessDetailData): string {
  const { business } = data;
  const deepLink = data.deepLink
    ? `<p class="flash">Link de invitación (se muestra una sola vez, guardalo ahora):<br><span class="mono">${esc(data.deepLink)}</span></p>`
    : '';
  const error = data.error ? `<p class="error">${esc(data.error)}</p>` : '';

  const memberRows = data.members
    .map(
      (m) => `
    <tr><td class="mono">${esc(m.telegramId)}</td><td>${esc(m.role)}</td><td class="muted">${esc(fmtDate(m.createdAt, business.timezone))}</td></tr>`
    )
    .join('');
  const members = data.members.length
    ? `<table><thead><tr><th>Telegram ID</th><th>Rol</th><th>Vinculado</th></tr></thead><tbody>${memberRows}</tbody></table>`
    : '<p class="empty">Nadie vinculado todavía.</p>';

  const invitationRows = data.invitations
    .map(
      (i) => `
    <tr>
      <td>${esc(i.role)}</td>
      <td><span class="badge">${esc(i.status)}</span></td>
      <td class="muted">${esc(fmtDate(i.createdAt, business.timezone))}</td>
      <td class="muted">${esc(fmtDate(i.expiresAt, business.timezone))}</td>
      <td>${
        i.status === 'pendiente' || i.status === 'expirada'
          ? `<form class="inline" method="post" action="/admin/invitations/${esc(i.id)}/revoke"><button class="danger" type="submit">Revocar</button></form>`
          : ''
      }</td>
    </tr>`
    )
    .join('');
  const invitations = data.invitations.length
    ? `<table><thead><tr><th>Rol</th><th>Estado</th><th>Creada</th><th>Expira</th><th></th></tr></thead><tbody>${invitationRows}</tbody></table>`
    : '<p class="empty">Sin invitaciones.</p>';

  const statusOptions = (['TRIAL', 'ACTIVE', 'READ_ONLY', 'SUSPENDED'] as const)
    .map((s) => `<option value="${s}"${s === business.status ? ' selected' : ''}>${s}</option>`)
    .join('');

  const body = `
<h1>${esc(business.name)}</h1>
${error}${deepLink}
<p><a href="/admin/">← Volver a la lista</a></p>

<div class="panel">
  <h2>Datos</h2>
  <table>
    <tr><th>ID</th><td class="mono">${esc(business.id)}</td></tr>
    <tr><th>Template</th><td>${esc(business.templateId)}</td></tr>
    <tr><th>Estado</th><td><span class="badge ${esc(business.status)}">${esc(business.status)}</span> · ${esc(trialLabel(business))}</td></tr>
    <tr><th>Timezone / moneda</th><td>${esc(business.timezone)} · ${esc(business.currency)}</td></tr>
    <tr><th>Alta</th><td>${esc(fmtDate(business.createdAt, business.timezone))}</td></tr>
    <tr><th>Trial</th><td>${business.trialDays} días · gracia ${business.graceDays}${
      business.trialStartedAt ? ` · empezó ${esc(fmtDate(business.trialStartedAt, business.timezone))}` : ' · sin usar'
    }</td></tr>
  </table>
  <h2>Cambiar estado</h2>
  <form method="post" action="/admin/businesses/${esc(business.id)}/status">
    <div class="grid">
      <div>
        <label for="status">Estado</label>
        <select id="status" name="status">${statusOptions}</select>
      </div>
      <div style="align-self:end"><button type="submit">Guardar estado</button></div>
    </div>
  </form>
</div>

<div class="panel">
  <h2>Miembros (${data.members.length})</h2>
  ${members}
</div>

<div class="panel">
  <h2>Invitaciones (${data.invitations.length})</h2>
  ${invitations}
  <h2>Nueva invitación</h2>
  <form method="post" action="/admin/businesses/${esc(business.id)}/invitations">
    <div class="grid">
      <div>
        <label for="role">Rol</label>
        <select id="role" name="role"><option value="OWNER">OWNER</option><option value="EMPLOYEE" selected>EMPLOYEE</option></select>
      </div>
      <div>
        <label for="days">Vigencia (días)</label>
        <input id="days" name="days" type="number" min="1" max="90" value="7">
      </div>
      <div style="align-self:end"><button type="submit">Crear link</button></div>
    </div>
  </form>
</div>`;
  return layout(business.name, body, { showNav: true });
}
