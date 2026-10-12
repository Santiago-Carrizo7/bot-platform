/**
 * Admin web — vistas server-rendered.
 * Design read: herramienta interna de operaciones para 3 personas, lenguaje
 * SaaS sobrio oscuro, CSS nativo sin dependencias.
 * Dials: VARIANCE 4 / MOTION 2 / DENSITY 6 (Operate: escaneabilidad primero).
 */
import type { AuditEntry, Business, ManualPayment, MembershipRole } from '../../core/tenant/entities.js';
import { evaluateAccess } from '../../core/tenant/business-status.js';
import type { AdminTemplateOption } from './router.js';

// ---------------------------------------------------------------- estilos ---

const STYLES = `
:root {
  color-scheme: dark light;
  --bg:#0e1116; --panel:#161b24; --panel2:#1c2330; --line:#262d3a; --line2:#323b4d;
  --fg:#e8ebf1; --muted:#9aa5b8; --faint:#6b7689;
  --accent:#5b9dff; --accent-ink:#0b1526;
  --ok:#34d399; --warn:#fbbf24; --danger:#f87171;
  --r-card:10px; --r-ctl:8px; --r-pill:999px;
  --ease:cubic-bezier(0.23,1,0.32,1);
  --shadow:0 1px 0 rgba(255,255,255,.04) inset, 0 8px 24px rgba(0,0,0,.28);
}
@media (prefers-color-scheme: light) {
  :root { --bg:#f1f3f7; --panel:#ffffff; --panel2:#f6f8fb; --line:#dfe4ec; --line2:#cbd3e0;
    --fg:#161b24; --muted:#5b6474; --faint:#8a93a5; --accent:#2456d6; --accent-ink:#fff;
    --shadow:0 1px 2px rgba(16,24,40,.08); }
}
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
a { color:var(--accent); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
.shell { display:grid; grid-template-columns:15rem 1fr; min-height:100dvh; }
aside.side { border-right:1px solid var(--line); background:var(--panel); padding:1rem .8rem;
  display:flex; flex-direction:column; gap:1rem; position:sticky; top:0; height:100dvh; }
.brand { font-weight:750; font-size:.95rem; color:var(--fg); text-decoration:none;
  display:flex; align-items:center; gap:.55rem; padding:.35rem .5rem; }
.brand .dot { width:.6rem; height:.6rem; border-radius:50%; background:var(--accent); flex:none; }
.snav { display:flex; flex-direction:column; gap:.15rem; }
.snav a { display:flex; align-items:center; gap:.6rem; padding:.5rem .65rem; border-radius:var(--r-ctl);
  color:var(--muted); text-decoration:none; font-size:.92rem; border:1px solid transparent; }
.snav a .ic { width:1.25rem; text-align:center; flex:none; }
.snav a:hover { color:var(--fg); background:var(--panel2); }
.snav a[aria-current="page"] { color:var(--fg); background:var(--panel2); border-color:var(--line); }
.side .foot { margin-top:auto; display:flex; flex-direction:column; gap:.6rem; }
.op { font-size:.8rem; color:var(--muted); padding:.4rem .5rem; border:1px dashed var(--line2);
  border-radius:var(--r-ctl); }
.main-col { min-width:0; display:flex; flex-direction:column; }
header.top { display:flex; align-items:center; gap:1rem; padding:.8rem 1.5rem;
  border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:5; }
header.top h1 { font-size:1.05rem; margin:0; font-weight:700; letter-spacing:-.01em; }
header.top .sub { color:var(--muted); font-size:.85rem; }
header.top .sp { flex:1; }
main { max-width:72rem; width:100%; margin:0 auto; padding:1.5rem 1.5rem 4rem; }
h2 { font-size:1rem; margin:0 0 .6rem; letter-spacing:-.01em; }
h3 { font-size:.85rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:1.25rem 0 .5rem; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--r-card);
  padding:1rem 1.1rem; margin-bottom:1rem; box-shadow:var(--shadow); }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr)); gap:.7rem; margin-bottom:1rem; }
.kpi { background:var(--panel); border:1px solid var(--line); border-radius:var(--r-card); padding:.8rem .9rem; }
.kpi .n { font-size:1.5rem; font-weight:750; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
.kpi .l { font-size:.78rem; color:var(--muted); margin-top:.1rem; }
.kpi .d { font-size:.75rem; color:var(--faint); }
table { width:100%; border-collapse:collapse; font-size:.92rem; }
th, td { text-align:left; padding:.55rem .5rem; border-bottom:1px solid var(--line); vertical-align:middle; }
th { color:var(--muted); font-weight:650; font-size:.74rem; text-transform:uppercase; letter-spacing:.05em; }
tr:last-child td { border-bottom:0; }
.num { font-variant-numeric:tabular-nums; text-align:right; }
a.row { color:inherit; text-decoration:none; font-weight:600; }
tbody tr { transition:background 160ms var(--ease); }
@media (hover:hover) and (pointer:fine) { tbody tr:hover td { background:rgba(91,157,255,.07); } }
label { display:block; font-size:.83rem; color:var(--muted); margin:.65rem 0 .28rem; font-weight:600; }
input, select, textarea { width:100%; padding:.52rem .65rem; border:1px solid var(--line2);
  border-radius:var(--r-ctl); background:var(--bg); color:var(--fg); font:inherit; }
textarea { min-height:4.2rem; resize:vertical; }
input::placeholder { color:var(--faint); }
button, .btn { padding:.52rem .95rem; border:1px solid var(--accent); background:var(--accent);
  color:var(--accent-ink); background:var(--accent); color:#fff; border-radius:var(--r-ctl);
  cursor:pointer; font:inherit; font-weight:650; text-decoration:none; display:inline-block;
  transition:transform 160ms var(--ease), filter 160ms var(--ease); }
button:active, .btn:active { transform:scale(.97); }
@media (hover:hover) and (pointer:fine) { button:hover, .btn:hover { filter:brightness(1.07); } }
button.ghost, .btn.ghost { background:transparent; color:var(--fg); border-color:var(--line2); }
button.danger, .btn.danger { background:transparent; border-color:var(--danger); color:var(--danger); }
button.small, .btn.small { padding:.3rem .6rem; font-size:.83rem; }
form.inline { display:inline; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:.7rem; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
@media (max-width:60rem) { .grid2 { grid-template-columns:1fr; } }
.badge { display:inline-flex; align-items:center; gap:.35rem; padding:.12rem .6rem;
  border-radius:var(--r-pill); font-size:.76rem; font-weight:650; border:1px solid var(--line2);
  color:var(--muted); white-space:nowrap; }
.badge::before { content:""; width:.42rem; height:.42rem; border-radius:50%; background:currentColor; flex:none; }
.badge.TRIAL { color:var(--accent); border-color:var(--accent); }
.badge.ACTIVE, .badge.CONFIRMED, .badge.usada { color:var(--ok); border-color:var(--ok); }
.badge.READ_ONLY, .badge.PENDING, .badge.pendiente { color:var(--warn); border-color:var(--warn); }
.badge.SUSPENDED, .badge.VOID, .badge.revocada { color:var(--danger); border-color:var(--danger); }
.badge.expirada { color:var(--muted); border-color:var(--line2); }
.error { border:1px solid var(--danger); color:var(--danger); border-radius:var(--r-ctl);
  padding:.6rem .8rem; margin-bottom:1rem; background:transparent; }
.flash { border:1px solid var(--ok); color:var(--fg); border-radius:var(--r-ctl);
  padding:.6rem .8rem; margin-bottom:1rem; word-break:break-all; background:transparent; }
.flash b { color:var(--ok); }
.warnbox { border:1px solid var(--warn); color:var(--fg); border-radius:var(--r-ctl); padding:.6rem .8rem; margin-bottom:1rem; }
.muted { color:var(--muted); } .faint { color:var(--faint); font-size:.82rem; }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.83rem; word-break:break-all; }
.actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
.empty { color:var(--muted); font-style:italic; padding:.6rem 0; }
.toolbar { display:flex; flex-wrap:wrap; gap:.6rem; align-items:end; margin-bottom:1rem; }
.toolbar .fld { min-width:9rem; flex:1 1 9rem; } .toolbar .fld.small { flex:0 1 7rem; min-width:7rem; }
.tabs { display:flex; gap:.3rem; flex-wrap:wrap; border-bottom:1px solid var(--line); margin-bottom:1rem; }
.tabs a { padding:.5rem .8rem; color:var(--muted); text-decoration:none; font-size:.9rem;
  border-bottom:2px solid transparent; margin-bottom:-1px; }
.tabs a[aria-current="page"] { color:var(--fg); border-bottom-color:var(--accent); font-weight:700; }
.pager { display:flex; gap:.6rem; align-items:center; margin-top:.8rem; font-size:.85rem; color:var(--muted); }
.copyrow { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
.copyrow .mono { flex:1 1 16rem; background:var(--bg); border:1px solid var(--line); border-radius:var(--r-ctl); padding:.5rem .6rem; }
.quick { display:grid; grid-template-columns:repeat(auto-fit,minmax(12rem,1fr)); gap:.7rem; }
.quick a { display:block; padding:.8rem .9rem; border:1px solid var(--line); border-radius:var(--r-card);
  background:var(--panel); text-decoration:none; color:var(--fg); }
.quick a b { display:block; } .quick a span { color:var(--muted); font-size:.82rem; }
.kv { display:grid; grid-template-columns:11rem 1fr; gap:.3rem .8rem; font-size:.92rem; }
.kv dt { color:var(--muted); } .kv dd { margin:0; }
@media (max-width:56rem) {
  .shell { grid-template-columns:1fr; }
  aside.side { position:static; height:auto; flex-direction:column; }
  .snav { flex-direction:row; overflow-x:auto; padding-bottom:.3rem; }
  .snav a { white-space:nowrap; }
  header.top { padding:.7rem 1rem; } main { padding:1rem 1rem 4rem; }
  table.resp, table.resp thead { display:block; } table.resp thead { position:absolute; left:-9999px; }
  table.resp tr { display:block; border:1px solid var(--line); border-radius:var(--r-ctl); margin-bottom:.6rem; padding:.4rem .6rem; }
  table.resp td { display:flex; justify-content:space-between; gap:1rem; border-bottom:1px dashed var(--line); }
  table.resp td:last-child { border-bottom:0; }
  table.resp td::before { content:attr(data-th); color:var(--muted); font-size:.76rem; text-transform:uppercase; letter-spacing:.04em; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration:0ms !important; animation:none !important; }
}
`;

export function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export interface LayoutOptions {
  showNav?: boolean;
  active?: string;
  operator?: string;
  csrf?: string;
  sectionTitle?: string;
  sectionSub?: string;
}

const NAV: Array<{ href: string; label: string; icon: string; id: string }> = [
  { href: '/admin/', label: 'Dashboard', icon: '◔', id: 'dashboard' },
  { href: '/admin/businesses', label: 'Negocios', icon: '▦', id: 'businesses' },
  { href: '/admin/trials', label: 'Trials', icon: '◷', id: 'trials' },
  { href: '/admin/payments', label: 'Pagos', icon: '$', id: 'payments' },
  { href: '/admin/audit', label: 'Auditoría', icon: '☰', id: 'audit' },
  { href: '/admin/config', label: 'Config', icon: '⚙', id: 'config' },
];

export function layout(title: string, body: string, opts: LayoutOptions = {}): string {
  if (!opts.showNav) {
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
<main style="max-width:26rem;">${body}</main>
</body>
</html>`;
  }
  const nav = NAV.map(
    (n) =>
      `<a href="${n.href}"${opts.active === n.id ? ' aria-current="page"' : ''}><span class="ic" aria-hidden="true">${esc(n.icon)}</span>${esc(n.label)}</a>`
  ).join('');
  const op = opts.operator
    ? `<div class="op">Operador: <b>${esc(opts.operator)}</b></div>`
    : `<div class="op">Operador: <b>anónimo</b> <span class="faint">(se registra así en auditoría)</span></div>`;
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
<div class="shell">
<aside class="side" aria-label="Navegación principal">
<a class="brand" href="/admin/"><span class="dot" aria-hidden="true"></span>bot-platform · admin</a>
<nav class="snav">${nav}</nav>
<div class="foot">${op}
<form class="inline" method="post" action="/admin/logout">${opts.csrf ? `<input type="hidden" name="_csrf" value="${esc(opts.csrf)}">` : ''}<button class="ghost small" type="submit" style="width:100%">Salir</button></form>
</div>
</aside>
<div class="main-col">
<header class="top"><div><h1>${esc(opts.sectionTitle ?? title)}</h1>${opts.sectionSub ? `<div class="sub">${esc(opts.sectionSub)}</div>` : ''}</div><div class="sp"></div></header>
<main>${body}</main>
</div>
</div>
</body>
</html>`;
}

export function loginPage(opts: { error?: string } = {}): string {
  const error = opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : '';
  const body = `
<div class="panel" style="margin-top:12dvh;">
  <h2>Entrar al admin</h2>
  ${error}
  <form method="post" action="/admin/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <label for="operator">Operador (opcional, p. ej. tu nombre)</label>
    <input id="operator" name="operator" maxlength="24" placeholder="santi" autocomplete="username">
    <p class="faint">Queda firmado en la sesión y en la auditoría. Sin esto las operaciones figuran como “anónimo”.</p>
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

export function fmtMoney(amount: number, currency = 'ARS'): string {
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Etiqueta legible del estado — definición única vía `evaluateAccess()` del Core. */
export function trialLabel(business: Business, now: Date = new Date()): string {
  const ev = evaluateAccess(business, now);
  if (business.status === 'TRIAL') {
    if (!business.trialStartedAt) return 'trial sin usar';
    if (ev.trialDaysLeft !== null && ev.trialDaysLeft > 0) return `trial ${ev.trialDaysLeft} d`;
    return 'trial vencido';
  }
  if (business.status === 'ACTIVE') return ev.subscriptionReminder ? 'activo · pago pendiente' : 'activo';
  return business.status === 'READ_ONLY' ? 'solo lectura' : 'suspendido';
}

export function trialDaysLeft(business: Business, now: Date = new Date()): number | null {
  return evaluateAccess(business, now).trialDaysLeft;
}

export function trialEndsAt(business: Business): Date | null {
  if (!business.trialStartedAt) return null;
  return new Date(business.trialStartedAt.getTime() + business.trialDays * 86_400_000);
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

function errBox(error?: string): string {
  return error ? `<p class="error" role="alert">${esc(error)}</p>` : '';
}

function flashBox(flash?: string): string {
  return flash ? `<p class="flash" role="status">${esc(flash)}</p>` : '';
}

// ------------------------------------------------------------ dashboard ---

export interface DashboardData {
  totals: { total: number; trial: number; active: number; readOnly: number; suspended: number };
  trialsExpiring: Array<{ business: Business; daysLeft: number | null; endsAt: Date | null }>;
  trialsExpired: Business[];
  lastPayments: Array<{ payment: ManualPayment; businessName: string }>;
  monthConfirmed: number;
  monthPending: number;
  lastBusinesses: Business[];
  recentAudit: Array<{ entry: AuditEntry; businessName: string }>;
  csrf: string;
  operator?: string;
}

export function dashboardPage(d: DashboardData): string {
  const k = d.totals;
  const trialRows =
    d.trialsExpiring.length === 0
      ? '<p class="empty">Sin trials por vencer en 3 días.</p>'
      : `<table class="resp"><thead><tr><th>Negocio</th><th>Vence</th><th>Quedan</th><th></th></tr></thead><tbody>${d.trialsExpiring
          .map(
            (t) => `<tr><td data-th="Negocio"><a class="row" href="/admin/businesses/${esc(t.business.id)}">${esc(t.business.name)}</a></td>
<td data-th="Vence" class="muted">${esc(t.endsAt ? fmtDate(t.endsAt, t.business.timezone) : '—')}</td>
<td data-th="Quedan"><span class="badge TRIAL">${esc(t.daysLeft ?? '—')} d</span></td>
<td data-th=""><a class="btn ghost small" href="/admin/businesses/${esc(t.business.id)}?tab=suscripcion">Ver</a></td></tr>`
          )
          .join('')}</tbody></table>`;
  const payRows =
    d.lastPayments.length === 0
      ? '<p class="empty">Todavía no hay pagos registrados. <a href="/admin/payments">Registrar el primero</a>.</p>'
      : `<table class="resp"><thead><tr><th>Negocio</th><th>Importe</th><th>Fecha</th><th>Estado</th></tr></thead><tbody>${d.lastPayments
          .map(
            (p) => `<tr><td data-th="Negocio">${esc(p.businessName)}</td>
<td data-th="Importe" class="num">${esc(fmtMoney(p.payment.amount, p.payment.currency))}</td>
<td data-th="Fecha" class="muted">${esc(fmtDate(p.payment.paidAt, 'America/Argentina/Buenos_Aires'))}</td>
<td data-th="Estado"><span class="badge ${esc(p.payment.status)}">${esc(p.payment.status)}</span></td></tr>`
          )
          .join('')}</tbody></table>`;
  const bizRows =
    d.lastBusinesses.length === 0
      ? '<p class="empty">Todavía no hay negocios.</p>'
      : `<table class="resp"><thead><tr><th>Negocio</th><th>Template</th><th>Estado</th><th>Alta</th></tr></thead><tbody>${d.lastBusinesses
          .map(
            (b) => `<tr><td data-th="Negocio"><a class="row" href="/admin/businesses/${esc(b.id)}">${esc(b.name)}</a></td>
<td data-th="Template">${esc(b.templateId)}</td>
<td data-th="Estado"><span class="badge ${esc(b.status)}">${esc(trialLabel(b))}</span></td>
<td data-th="Alta" class="muted">${esc(fmtDate(b.createdAt, b.timezone))}</td></tr>`
          )
          .join('')}</tbody></table>`;
  const auditRows =
    d.recentAudit.length === 0
      ? '<p class="empty">Sin actividad administrativa reciente.</p>'
      : `<table class="resp"><thead><tr><th>Cuándo</th><th>Acción</th><th>Negocio</th><th>Operador</th></tr></thead><tbody>${d.recentAudit
          .map((a) => {
            const op = (a.entry.metadata?.operator as string | undefined) ?? 'anónimo';
            return `<tr><td data-th="Cuándo" class="muted">${esc(fmtDate(a.entry.createdAt, 'America/Argentina/Buenos_Aires'))}</td>
<td data-th="Acción" class="mono">${esc(a.entry.action)}</td><td data-th="Negocio">${esc(a.businessName)}</td><td data-th="Operador">${esc(op)}</td></tr>`;
          })
          .join('')}</tbody></table>`;
  const body = `
<div class="kpis" role="list">
  <div class="kpi" role="listitem"><div class="n">${k.total}</div><div class="l">Negocios registrados</div><div class="d">Total en plataforma</div></div>
  <div class="kpi" role="listitem"><div class="n">${k.trial}</div><div class="l">En prueba</div><div class="d">Estado TRIAL</div></div>
  <div class="kpi" role="listitem"><div class="n">${k.active}</div><div class="l">Activos</div><div class="d">Estado ACTIVE</div></div>
  <div class="kpi" role="listitem"><div class="n">${k.readOnly}</div><div class="l">Solo lectura</div><div class="d">READ_ONLY (incluye trial vencido efectivo)</div></div>
  <div class="kpi" role="listitem"><div class="n">${k.suspended}</div><div class="l">Suspendidos</div><div class="d">Bloqueo total</div></div>
  <div class="kpi" role="listitem"><div class="n">${esc(fmtMoney(d.monthConfirmed, 'ARS'))}</div><div class="l">Cobrado este mes</div><div class="d">Pagos CONFIRMED, no suscripciones</div></div>
  <div class="kpi" role="listitem"><div class="n">${esc(fmtMoney(d.monthPending, 'ARS'))}</div><div class="l">Pendiente este mes</div><div class="d">Pagos PENDING, aún no cobrados</div></div>
  <div class="kpi" role="listitem"><div class="n">${d.trialsExpired.length}</div><div class="l">Trials vencidos</div><div class="d">Requieren activación manual</div></div>
</div>
<div class="panel"><h2>Acciones habituales</h2>
<div class="quick">
<a href="/admin/businesses/new"><b>+ Crear negocio</b><span>Alta guiada con seed del template</span></a>
<a href="/admin/businesses"><b>Consultar clientes</b><span>Buscar, filtrar y ordenar</span></a>
<a href="/admin/trials"><b>Ver trials</b><span>Próximos a vencer y vencidos</span></a>
<a href="/admin/payments"><b>Registrar pago</b><span>Cobro manual con historial</span></a>
</div></div>
<div class="grid2">
<div class="panel"><h2>Trials por vencer (≤ 3 días)</h2>${trialRows}<p><a href="/admin/trials">Ver todos los trials →</a></p></div>
<div class="panel"><h2>Últimos pagos</h2>${payRows}<p><a href="/admin/payments">Ver historial →</a></p></div>
</div>
<div class="grid2">
<div class="panel"><h2>Últimos negocios creados</h2>${bizRows}<p><a href="/admin/businesses">Ver todos →</a></p></div>
<div class="panel"><h2>Actividad administrativa reciente</h2>${auditRows}<p><a href="/admin/audit">Ver auditoría →</a></p></div>
</div>`;
  return layout('Dashboard', body, {
    showNav: true,
    active: 'dashboard',
    operator: d.operator,
    csrf: d.csrf,
    sectionTitle: 'Dashboard',
    sectionSub: 'Resumen operativo de la plataforma',
  });
}

// -------------------------------------------------- lista de negocios ---

export interface BusinessListQuery {
  q: string;
  status: string;
  template: string;
  trial: string;
  sort: string;
  order: string;
  page: string;
}

export interface BusinessListPageOptions {
  templates: AdminTemplateOption[];
  error?: string;
  flash?: string;
  query?: BusinessListQuery;
  total?: number;
  page?: number;
  pageSize?: number;
  csrf?: string;
  operator?: string;
}

export function businessListPage(businesses: Business[], opts: BusinessListPageOptions): string {
  const q = opts.query ?? { q: '', status: '', template: '', trial: '', sort: 'createdAt', order: 'desc', page: '1' };
  const total = opts.total ?? businesses.length;
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? (businesses.length || 20);
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const statusOpts = ['', 'TRIAL', 'ACTIVE', 'READ_ONLY', 'SUSPENDED']
    .map((s) => `<option value="${esc(s)}"${q.status === s ? ' selected' : ''}>${s === '' ? 'Todos' : esc(s)}</option>`)
    .join('');
  const tplOpts =
    `<option value="">Todos</option>` +
    opts.templates
      .map((t) => `<option value="${esc(t.id)}"${q.template === t.id ? ' selected' : ''}>${esc(t.label)} (${esc(t.id)})</option>`)
      .join('');
  const trialOpts = [
    ['', 'Todos'],
    ['pending', 'Sin usar'],
    ['active', 'Activos'],
    ['expiring', 'Por vencer ≤3d'],
    ['expired', 'Vencidos'],
  ]
    .map(([v, l]) => `<option value="${esc(v)}"${q.trial === v ? ' selected' : ''}>${esc(l)}</option>`)
    .join('');
  const rows = businesses
    .map(
      (b) => {
        const left = trialDaysLeft(b);
        return `
    <tr>
      <td data-th="Negocio"><a class="row" href="/admin/businesses/${esc(b.id)}">${esc(b.name)}</a><div class="faint mono">${esc(b.id.slice(0, 8))}</div></td>
      <td data-th="Template">${esc(b.templateId)}</td>
      <td data-th="Estado"><span class="badge ${esc(b.status)}">${esc(trialLabel(b))}</span></td>
      <td data-th="Trial" class="muted">${b.trialStartedAt ? `${esc(left ?? '—')} d · vence ${esc(fmtDate(trialEndsAt(b), b.timezone))}` : 'sin usar'}</td>
      <td data-th="Alta" class="muted">${esc(fmtDate(b.createdAt, b.timezone))}</td>
    </tr>`;
      }
    )
    .join('');
  const table = businesses.length
    ? `<table class="resp">
  <thead><tr><th>Negocio</th><th>Template</th><th>Estado</th><th>Trial</th><th>Alta</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="pager"><span>Página ${page} de ${pages} · ${total} negocios</span><span style="flex:1"></span>
${page > 1 ? `<a class="btn ghost small" href="?${esc(queryString({ ...q, page: String(page - 1) }))}">← Anterior</a>` : ''}
${page < pages ? `<a class="btn ghost small" href="?${esc(queryString({ ...q, page: String(page + 1) }))}">Siguiente →</a>` : ''}</div>`
    : '<p class="empty">Todavía no hay negocios.</p>';

  const body = `
<h2 style="margin-top:0">Negocios <span class="muted">(${total})</span></h2>
${errBox(opts.error)}${flashBox(opts.flash)}
<div class="panel">
<form method="get" action="/admin/businesses" class="toolbar" role="search">
  <div class="fld"><label for="q">Buscar</label><input id="q" name="q" value="${esc(q.q)}" placeholder="Nombre o ID…"></div>
  <div class="fld small"><label for="status">Estado</label><select id="status" name="status">${statusOpts}</select></div>
  <div class="fld small"><label for="template">Template</label><select id="template" name="template">${tplOpts}</select></div>
  <div class="fld small"><label for="trial">Trial</label><select id="trial" name="trial">${trialOpts}</select></div>
  <div class="fld small"><label for="sort">Orden</label><select id="sort" name="sort">
    <option value="createdAt"${q.sort === 'createdAt' ? ' selected' : ''}>Alta</option>
    <option value="name"${q.sort === 'name' ? ' selected' : ''}>Nombre</option>
    <option value="trialEnd"${q.sort === 'trialEnd' ? ' selected' : ''}>Vencimiento</option>
  </select></div>
  <div><button class="ghost" type="submit">Filtrar</button> <a class="btn ghost" href="/admin/businesses/new">+ Crear negocio</a></div>
</form>
${table}</div>
<div class="panel">
  <h2>Crear negocio</h2>
  <form method="post" action="/admin/businesses">
    ${opts.csrf ? `<input type="hidden" name="_csrf" value="${esc(opts.csrf)}">` : ''}
    <div class="grid">
      <div>
        <label for="name">Nombre</label>
        <input id="name" name="name" required maxlength="80" placeholder="Kiosco Don Pepe">
      </div>
      <div>
        <label for="templateId">Template</label>
        <select id="templateId" name="templateId">${opts.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} (${esc(t.id)})</option>`).join('')}</select>
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
    <p><button type="submit">Crear</button> <span class="faint">o <a href="/admin/businesses/new">alta guiada →</a></span></p>
  </form>
</div>`;
  return layout('Negocios', body, {
    showNav: true,
    active: 'businesses',
    operator: opts.operator,
    csrf: opts.csrf,
    sectionTitle: 'Negocios',
    sectionSub: `${total} clientes registrados`,
  });
}

function queryString(q: BusinessListQuery): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.status) p.set('status', q.status);
  if (q.template) p.set('template', q.template);
  if (q.trial) p.set('trial', q.trial);
  if (q.sort) p.set('sort', q.sort);
  if (q.order) p.set('order', q.order);
  if (q.page) p.set('page', q.page);
  return p.toString();
}

export interface BusinessNewOptions {
  templates: AdminTemplateOption[];
  error?: string;
  csrf?: string;
  operator?: string;
}

export function businessNewPage(opts: BusinessNewOptions): string {
  const options = opts.templates
    .map((t) => `<option value="${esc(t.id)}">${esc(t.label)} (${esc(t.id)})</option>`)
    .join('');
  const body = `
<p><a href="/admin/businesses">← Volver a negocios</a></p>
${errBox(opts.error)}
<div class="panel" style="max-width:40rem;">
<h2>Paso 1 de 2 — Datos del cliente</h2>
<form method="post" action="/admin/businesses">
${opts.csrf ? `<input type="hidden" name="_csrf" value="${esc(opts.csrf)}">` : ''}
<label for="name">Nombre del negocio *</label>
<input id="name" name="name" required maxlength="80" placeholder="Kiosco Don Pepe">
<label for="templateId">Template / producto contratado *</label>
<select id="templateId" name="templateId">${options}</select>
<p class="faint">Cada bot atiende un solo template. El negocio solo verá las acciones de ese producto.</p>
<div class="grid">
<div><label for="timezone">Zona horaria</label><input id="timezone" name="timezone" value="America/Argentina/Buenos_Aires"></div>
<div><label for="currency">Moneda</label><input id="currency" name="currency" value="ARS" maxlength="3"></div>
</div>
<h3>Después de crear</h3>
<p class="muted">1. Se corre el seed del template · 2. Verás la confirmación con los datos · 3. Acciones recomendadas: generar invitación OWNER, registrar pago, activar.</p>
<p><button type="submit">Crear negocio →</button></p>
</form>
</div>`;
  return layout('Crear negocio', body, {
    showNav: true,
    active: 'businesses',
    operator: opts.operator,
    csrf: opts.csrf,
    sectionTitle: 'Crear negocio',
    sectionSub: 'Alta guiada de un nuevo cliente',
  });
}

export interface BusinessCreatedOptions {
  business: Business;
  csrf?: string;
  operator?: string;
}

export function businessCreatedPage(opts: BusinessCreatedOptions): string {
  const b = opts.business;
  const body = `
<p class="flash" role="status"><b>✓ Negocio creado.</b> ${esc(b.name)} (${esc(b.templateId)}) — ID <span class="mono">${esc(b.id)}</span></p>
<div class="panel"><h2>Datos</h2>
<dl class="kv"><dt>Nombre</dt><dd>${esc(b.name)}</dd><dt>Template</dt><dd>${esc(b.templateId)}</dd>
<dt>Zona / moneda</dt><dd>${esc(b.timezone)} · ${esc(b.currency)}</dd>
<dt>Trial</dt><dd>${b.trialDays} días · ${esc(trialLabel(b))} (inicia con la primera escritura real, no con el alta)</dd></dl>
</div>
<div class="panel"><h2>Siguientes acciones recomendadas</h2>
<div class="quick">
<a href="/admin/businesses/${esc(b.id)}?tab=invitaciones"><b>1. Generar invitación OWNER</b><span>Vincular al dueño por Telegram</span></a>
<a href="/admin/businesses/${esc(b.id)}?tab=pagos"><b>2. Registrar pago</b><span>Si ya cobraste la suscripción</span></a>
<a href="/admin/businesses/${esc(b.id)}"><b>3. Ver detalle</b><span>Miembros, estado y auditoría</span></a>
</div></div>`;
  return layout('Negocio creado', body, {
    showNav: true,
    active: 'businesses',
    operator: opts.operator,
    csrf: opts.csrf,
    sectionTitle: 'Negocio creado',
    sectionSub: b.name,
  });
}

// ------------------------------------------------------- detalle ---

export type DetailTab = 'resumen' | 'suscripcion' | 'miembros' | 'invitaciones' | 'pagos' | 'actividad';

export interface BusinessDetailData {
  business: Business;
  members: MemberView[];
  invitations: InvitationView[];
  payments: ManualPayment[];
  paymentsTotalConfirmed: number;
  lastPayment: ManualPayment | null;
  audit: AuditEntry[];
  tab: DetailTab;
  deepLink?: string;
  paymentFormKey?: string;
  error?: string;
  flash?: string;
  csrf?: string;
  operator?: string;
}

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'suscripcion', label: 'Suscripción' },
  { id: 'miembros', label: 'Miembros' },
  { id: 'invitaciones', label: 'Invitaciones' },
  { id: 'pagos', label: 'Pagos' },
  { id: 'actividad', label: 'Actividad' },
];

export function businessDetailPage(data: BusinessDetailData): string {
  const { business } = data;
  const tab = data.tab ?? 'resumen';
  const tabs = `<nav class="tabs" aria-label="Secciones del negocio">${TABS.map(
    (t) =>
      `<a href="/admin/businesses/${esc(business.id)}?tab=${t.id}"${tab === t.id ? ' aria-current="page"' : ''}>${esc(t.label)}${t.id === 'miembros' ? ` (${data.members.length})` : ''}${t.id === 'invitaciones' ? ` (${data.invitations.length})` : ''}${t.id === 'pagos' ? ` (${data.payments.length})` : ''}</a>`
  ).join('')}</nav>`;
  const deepLink = data.deepLink
    ? `<div class="flash" role="status"><b>Link de invitación</b> (se muestra una sola vez, guardalo ahora):
<div class="copyrow"><span class="mono" id="deeplink">${esc(data.deepLink)}</span>
<button type="button" class="ghost small" onclick="navigator.clipboard.writeText(document.getElementById('deeplink').textContent).then(()=>{this.textContent='¡Copiado!';setTimeout(()=>this.textContent='Copiar enlace',1500);});">Copiar enlace</button></div></div>`
    : '';
  const error = errBox(data.error);
  const flash = flashBox(data.flash);
  const csrf = data.csrf ? `<input type="hidden" name="_csrf" value="${esc(data.csrf)}">` : '';

  const summary = `
<div class="panel"><h2>Datos</h2>
<dl class="kv">
<dt>ID</dt><dd class="mono">${esc(business.id)}</dd>
<dt>Template</dt><dd>${esc(business.templateId)}</dd>
<dt>Estado</dt><dd><span class="badge ${esc(business.status)}">${esc(business.status)}</span> · ${esc(trialLabel(business))}</dd>
<dt>Zona / moneda</dt><dd>${esc(business.timezone)} · ${esc(business.currency)}</dd>
<dt>Alta</dt><dd>${esc(fmtDate(business.createdAt, business.timezone))}</dd>
<dt>Trial</dt><dd>${business.trialDays} días · gracia ${business.graceDays}${business.trialStartedAt ? ` · empezó ${esc(fmtDate(business.trialStartedAt, business.timezone))} · vence ${esc(fmtDate(trialEndsAt(business), business.timezone))}` : ' · sin usar (inicia con la primera escritura real)'}</dd>
<dt>Último pago</dt><dd>${data.lastPayment ? `${esc(fmtMoney(data.lastPayment.amount, data.lastPayment.currency))} · ${esc(fmtDate(data.lastPayment.paidAt, business.timezone))} · <span class="badge ${esc(data.lastPayment.status)}">${esc(data.lastPayment.status)}</span>` : 'sin pagos registrados'}</dd>
<dt>Total cobrado</dt><dd class="num">${esc(fmtMoney(data.paymentsTotalConfirmed, business.currency))} <span class="faint">(CONFIRMED, no borra historial)</span></dd>
</dl></div>`;

  const subscription = `
<div class="panel"><h2>Suscripción y prueba gratuita</h2>
${subscriptionExplain(business)}
<h3>Cambiar estado (manual, auditado)</h3>
<form method="post" action="/admin/businesses/${esc(business.id)}/status" onsubmit="return confirm('Cambiar de ${esc(business.status)} al estado elegido. ¿Confirmás?');">
${csrf}
<div class="grid"><div><label for="status">Estado destino</label><select id="status" name="status">${(['TRIAL', 'ACTIVE', 'READ_ONLY', 'SUSPENDED'] as const)
    .map((s) => `<option value="${s}"${s === business.status ? ' selected' : ''}>${s}</option>`)
    .join('')}</select></div>
<div><label for="reason">Motivo (queda en auditoría)</label><input id="reason" name="reason" maxlength="120" placeholder="p. ej. pagó marzo, a pedido del cliente"></div>
<div style="align-self:end"><button type="submit">Guardar estado</button></div></div>
<p class="faint">Un pago registrado no activa el negocio solo. El operador cambia el estado explícitamente.</p>
</form></div>`;

  const members =
    data.members.length === 0
      ? '<p class="empty">Nadie vinculado todavía. Generá una invitación OWNER.</p>'
      : `<table class="resp"><thead><tr><th>Telegram ID</th><th>Rol</th><th>Vinculado</th></tr></thead><tbody>${data.members
          .map(
            (m) => `<tr><td data-th="Telegram" class="mono">${esc(m.telegramId)}</td><td data-th="Rol">${esc(m.role)}</td><td data-th="Vinculado" class="muted">${esc(fmtDate(m.createdAt, business.timezone))}</td></tr>`
          )
          .join('')}</tbody></table>`;

  const invitations =
    data.invitations.length === 0
      ? '<p class="empty">Sin invitaciones.</p>'
      : `<table class="resp"><thead><tr><th>Rol</th><th>Estado</th><th>Creada</th><th>Expira</th><th></th></tr></thead><tbody>${data.invitations
          .map(
            (i) => `<tr><td data-th="Rol">${esc(i.role)}</td><td data-th="Estado"><span class="badge ${esc(i.status)}">${esc(i.status)}</span></td>
<td data-th="Creada" class="muted">${esc(fmtDate(i.createdAt, business.timezone))}</td>
<td data-th="Expira" class="muted">${esc(fmtDate(i.expiresAt, business.timezone))}</td>
<td data-th="">${i.status === 'pendiente' || i.status === 'expirada'
                ? `<form class="inline" method="post" action="/admin/invitations/${esc(i.id)}/revoke" onsubmit="return confirm('Revocar esta invitación. ¿Confirmás?');">${csrf}<button class="danger small" type="submit">Revocar</button></form>`
                : '<span class="faint">—</span>'}</td></tr>`
          )
          .join('')}</tbody></table>`;

  const payments =
    data.payments.length === 0
      ? '<p class="empty">Sin pagos. Registrá el primer cobro con el formulario de abajo.</p>'
      : `<table class="resp"><thead><tr><th>Fecha cobro</th><th>Importe</th><th>Método</th><th>Concepto</th><th>Estado</th><th></th></tr></thead><tbody>${data.payments
          .map(
            (p) => `<tr><td data-th="Cobro" class="muted">${esc(fmtDate(p.paidAt, business.timezone))}</td>
<td data-th="Importe" class="num">${esc(fmtMoney(p.amount, p.currency))}</td>
<td data-th="Método">${esc(p.method)}</td><td data-th="Concepto">${esc(p.concept)}${p.periodFrom && p.periodTo ? `<div class="faint">${esc(fmtDate(p.periodFrom, business.timezone))} → ${esc(fmtDate(p.periodTo, business.timezone))}</div>` : ''}${p.operator ? `<div class="faint">por ${esc(p.operator)}</div>` : ''}</td>
<td data-th="Estado"><span class="badge ${esc(p.status)}">${esc(p.status)}</span>${p.status === 'VOID' ? `<div class="faint">${esc(p.voidReason ?? '')}</div>` : ''}</td>
<td data-th="">${p.status !== 'VOID'
                ? `<form class="inline" method="post" action="/admin/payments/${esc(p.id)}/void" onsubmit="return confirm('Anular este pago (queda en el historial como VOID). ¿Confirmás?');">${csrf}<input type="hidden" name="businessId" value="${esc(business.id)}"><input type="hidden" name="reason" value="corrección de registro"><button class="danger small" type="submit">Anular</button></form>`
                : '<span class="faint">—</span>'}</td></tr>`
          )
          .join('')}</tbody></table>`;

  const paymentForm = `
<h3>Registrar pago manual</h3>
<form method="post" action="/admin/businesses/${esc(business.id)}/payments">
${csrf}
<input type="hidden" name="idempotencyKey" value="${esc(data.paymentFormKey ?? '')}">
<div class="grid">
<div><label for="amount">Importe *</label><input id="amount" name="amount" inputmode="decimal" required placeholder="15000" pattern="^[0-9]+([.,][0-9]{1,2})?$"></div>
<div><label for="paidAt">Fecha efectiva de cobro *</label><input id="paidAt" name="paidAt" type="date" required></div>
<div><label for="method">Método *</label><select id="method" name="method"><option>EFECTIVO</option><option>TRANSFERENCIA</option><option>MERCADO_PAGO</option><option>OTRO</option></select></div>
<div><label for="pstatus">Estado *</label><select id="pstatus" name="status"><option value="CONFIRMED">CONFIRMED (cobrado)</option><option value="PENDING">PENDING (pendiente)</option></select></div>
<div><label for="concept">Concepto</label><input id="concept" name="concept" maxlength="80" value="Suscripción"></div>
<div><label for="periodFrom">Período desde</label><input id="periodFrom" name="periodFrom" type="date"></div>
<div><label for="periodTo">Período hasta</label><input id="periodTo" name="periodTo" type="date"></div>
<div><label for="notes">Notas internas</label><input id="notes" name="notes" maxlength="200" placeholder="opcional"></div>
</div>
<p><button type="submit">Registrar pago</button> <span class="faint">No activa el negocio ni renueva períodos automáticamente.</span></p>
</form>`;

  const audit =
    data.audit.length === 0
      ? '<p class="empty">Sin actividad registrada para este negocio.</p>'
      : `<table class="resp"><thead><tr><th>Cuándo</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>${data.audit
          .map((a) => {
            const op = (a.metadata?.operator as string | undefined) ?? 'anónimo';
            const extra =
              a.action === 'admin.status_changed'
                ? `${esc(String((a.metadata as Record<string, unknown>).from ?? ''))} → ${esc(String((a.metadata as Record<string, unknown>).to ?? ''))}`
                : esc(a.entityId ?? '');
            return `<tr><td data-th="Cuándo" class="muted">${esc(fmtDate(a.createdAt, business.timezone))}</td>
<td data-th="Acción" class="mono">${esc(a.action)}<div class="faint">por ${esc(op)}</div></td><td data-th="Detalle">${extra}</td></tr>`;
          })
          .join('')}</tbody></table>`;

  let section = '';
  if (tab === 'resumen') section = summary + `<div class="panel"><h2>Acciones</h2><div class="actions">
<a class="btn small" href="/admin/businesses/${esc(business.id)}?tab=invitaciones">Generar invitación</a>
<a class="btn small" href="/admin/businesses/${esc(business.id)}?tab=pagos">Registrar pago</a>
<a class="btn ghost small" href="/admin/businesses/${esc(business.id)}?tab=suscripcion">Cambiar estado</a></div></div>`;
  else if (tab === 'suscripcion') section = subscription;
  else if (tab === 'miembros') section = `<div class="panel"><h2>Miembros (${data.members.length})</h2>${members}</div>`;
  else if (tab === 'invitaciones')
    section = `<div class="panel"><h2>Invitaciones (${data.invitations.length})</h2>${invitations}
<h3>Nueva invitación (OWNER o EMPLOYEE, 1–90 días)</h3>
<form method="post" action="/admin/businesses/${esc(business.id)}/invitations">${csrf}
<div class="grid"><div><label for="role">Rol</label><select id="role" name="role"><option value="OWNER">OWNER</option><option value="EMPLOYEE" selected>EMPLOYEE</option></select></div>
<div><label for="days">Vigencia (días)</label><input id="days" name="days" type="number" min="1" max="90" value="7"></div>
<div style="align-self:end"><button type="submit">Crear link</button></div></div></form>
<p class="faint">El link usa el bot del template y se muestra una sola vez. Si se pierde: revocar y crear otro.</p></div>`;
  else if (tab === 'pagos') section = `<div class="panel"><h2>Pagos e historial financiero (${data.payments.length})</h2>${payments}${paymentForm}</div>`;
  else section = `<div class="panel"><h2>Actividad administrativa (${data.audit.length})</h2>${audit}</div>`;

  const body = `
<h2 style="margin-top:0">${esc(business.name)}</h2>
${error}${deepLink}${flash}
<p><a href="/admin/businesses">← Volver a la lista</a> · <a href="/admin/">Dashboard</a></p>
${tabs}
${section}`;
  return layout(business.name, body, {
    showNav: true,
    active: 'businesses',
    operator: data.operator,
    csrf: data.csrf,
    sectionTitle: business.name,
    sectionSub: `${business.templateId} · ${trialLabel(business)}`,
  });
}

function subscriptionExplain(b: Business): string {
  const ev = evaluateAccess(b);
  if (b.status === 'TRIAL' && !b.trialStartedAt)
    return `<p class="muted"><b style="color:var(--fg)">Trial sin comenzar.</b> Inicia con la primera escritura real de negocio (nunca con el alta, /start ni lecturas). Duración: ${b.trialDays} días.</p>`;
  if (b.status === 'TRIAL' && b.trialStartedAt && ev.effectiveStatus === 'TRIAL')
    return `<p class="muted"><b style="color:var(--fg)">Trial activo.</b> Quedan ${ev.trialDaysLeft} días · vence ${esc(fmtDate(trialEndsAt(b), b.timezone))}. Al vencer pasa a solo lectura efectivo.</p>`;
  if (b.status === 'TRIAL')
    return `<p class="warnbox"><b>Trial vencido.</b> Efectivo: solo lectura. Para reactivar, un operador cambia el estado a ACTIVE manualmente.</p>`;
  if (b.status === 'ACTIVE' && ev.subscriptionReminder)
    return `<p class="warnbox"><b>Período vencido${b.subscriptionExpiresAt ? ` el ${esc(fmtDate(b.subscriptionExpiresAt, b.timezone))}` : ''}.</b> Dentro de gracia (${b.graceDays}d): puede escribir + mostrar recordatorio. Fuera de gracia: solo lectura.</p>`;
  if (b.status === 'ACTIVE')
    return `<p class="muted"><b style="color:var(--fg)">Activo.</b> ${b.subscriptionExpiresAt ? `Vence ${esc(fmtDate(b.subscriptionExpiresAt, b.timezone))}.` : 'Sin vencimiento cargado (la renovación es manual en esta etapa).'}</p>`;
  if (b.status === 'READ_ONLY') return `<p class="muted"><b style="color:var(--fg)">Solo lectura.</b> Puede consultar, no puede modificar. No se borran datos.</p>`;
  return `<p class="error"><b>Suspendido.</b> Bloquea todo con mensaje claro.</p>`;
}

// ------------------------------------------------------------ trials ---

export interface TrialsPageData {
  expiring: Array<{ business: Business; daysLeft: number | null; endsAt: Date | null }>;
  expired: Business[];
  pending: Business[];
  active: Business[];
  csrf?: string;
  operator?: string;
}

export function trialsPage(d: TrialsPageData): string {
  const tbl = (rows: Business[], empty: string, extra?: (b: Business) => string) =>
    rows.length === 0
      ? `<p class="empty">${esc(empty)}</p>`
      : `<table class="resp"><thead><tr><th>Negocio</th><th>Template</th><th>Estado</th><th>Trial</th><th></th></tr></thead><tbody>${rows
          .map(
            (b) => `<tr><td data-th="Negocio"><a class="row" href="/admin/businesses/${esc(b.id)}">${esc(b.name)}</a></td>
<td data-th="Template">${esc(b.templateId)}</td><td data-th="Estado"><span class="badge ${esc(b.status)}">${esc(trialLabel(b))}</span></td>
<td data-th="Trial" class="muted">${extra ? extra(b) : ''}</td>
<td data-th=""><a class="btn ghost small" href="/admin/businesses/${esc(b.id)}?tab=suscripcion">Gestionar</a></td></tr>`
          )
          .join('')}</tbody></table>`;
  const body = `
<div class="panel"><h2>Por vencer (≤ 3 días) — ${d.expiring.length}</h2>
${d.expiring.length === 0 ? '<p class="empty">Sin trials por vencer.</p>' : `<table class="resp"><thead><tr><th>Negocio</th><th>Vence</th><th>Quedan</th><th></th></tr></thead><tbody>${d.expiring.map((t) => `<tr><td data-th="Negocio"><a class="row" href="/admin/businesses/${esc(t.business.id)}">${esc(t.business.name)}</a></td><td data-th="Vence" class="muted">${esc(t.endsAt ? fmtDate(t.endsAt, t.business.timezone) : '—')}</td><td data-th="Quedan"><span class="badge TRIAL">${esc(t.daysLeft ?? '—')} d</span></td><td data-th=""><a class="btn ghost small" href="/admin/businesses/${esc(t.business.id)}?tab=suscripcion">Gestionar</a></td></tr>`).join('')}</tbody></table>`}</div>
<div class="panel"><h2>Vencidos — ${d.expired.length}</h2>${tbl(d.expired, 'Sin trials vencidos.', (b) => `venció ${esc(fmtDate(trialEndsAt(b), b.timezone))}`)}</div>
<div class="panel"><h2>Activos — ${d.active.length}</h2>${tbl(d.active, 'Sin trials activos.', (b) => `${esc(trialDaysLeft(b) ?? '—')} d restantes`)}</div>
<div class="panel"><h2>Sin usar — ${d.pending.length}</h2>${tbl(d.pending, 'Sin trials pendientes de inicio.', () => 'inicia con la primera escritura')}</div>
<p class="faint">Reglas del Core: el trial lo inicia la primera escritura real; al vencer el efectivo es READ_ONLY. El vencimiento del trial no es el vencimiento de un período pago.</p>`;
  return layout('Trials', body, {
    showNav: true,
    active: 'trials',
    operator: d.operator,
    csrf: d.csrf,
    sectionTitle: 'Trials y suscripciones',
    sectionSub: 'Estado comercial de los negocios',
  });
}

// ----------------------------------------------------------- pagos ---

export interface PaymentsPageData {
  payments: Array<{ payment: ManualPayment; businessName: string }>;
  businesses: Business[];
  totals: { confirmed: number; pending: number; count: number };
  filters: { businessId: string; status: string; method: string; from: string; to: string };
  formKey: string;
  error?: string;
  flash?: string;
  csrf?: string;
  operator?: string;
}

export function paymentsPage(d: PaymentsPageData): string {
  const bizOpts =
    `<option value="">Todos los negocios</option>` +
    d.businesses.map((b) => `<option value="${esc(b.id)}"${d.filters.businessId === b.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  const stOpts = ['', 'CONFIRMED', 'PENDING', 'VOID']
    .map((s) => `<option value="${esc(s)}"${d.filters.status === s ? ' selected' : ''}>${s === '' ? 'Todos' : esc(s)}</option>`)
    .join('');
  const mOpts = ['', 'EFECTIVO', 'TRANSFERENCIA', 'MERCADO_PAGO', 'OTRO']
    .map((s) => `<option value="${esc(s)}"${d.filters.method === s ? ' selected' : ''}>${s === '' ? 'Todos' : esc(s)}</option>`)
    .join('');
  const rows =
    d.payments.length === 0
      ? '<p class="empty">Sin pagos para estos filtros.</p>'
      : `<table class="resp"><thead><tr><th>Cobro</th><th>Negocio</th><th>Importe</th><th>Método</th><th>Concepto</th><th>Estado</th><th></th></tr></thead><tbody>${d.payments
          .map(
            ({ payment: p, businessName }) => `<tr><td data-th="Cobro" class="muted">${esc(fmtDate(p.paidAt, 'America/Argentina/Buenos_Aires'))}</td>
<td data-th="Negocio">${esc(businessName)}</td><td data-th="Importe" class="num">${esc(fmtMoney(p.amount, p.currency))}</td>
<td data-th="Método">${esc(p.method)}</td><td data-th="Concepto">${esc(p.concept)}${p.operator ? `<div class="faint">por ${esc(p.operator)}</div>` : ''}</td>
<td data-th="Estado"><span class="badge ${esc(p.status)}">${esc(p.status)}</span></td>
<td data-th="">${p.status !== 'VOID' ? `<form class="inline" method="post" action="/admin/payments/${esc(p.id)}/void" onsubmit="return confirm('Anular (queda como VOID en el historial). ¿Confirmás?');"><input type="hidden" name="_csrf" value="${esc(d.csrf ?? '')}"><input type="hidden" name="businessId" value="${esc(p.businessId)}"><input type="hidden" name="reason" value="corrección de registro"><button class="danger small" type="submit">Anular</button></form>` : `<span class="faint">${esc(p.voidReason ?? '')}</span>`}</td></tr>`
          )
          .join('')}</tbody></table>`;
  const body = `
${errBox(d.error)}${flashBox(d.flash)}
<div class="kpis"><div class="kpi"><div class="n">${esc(fmtMoney(d.totals.confirmed, 'ARS'))}</div><div class="l">Cobrado (CONFIRMED)</div><div class="d">En el filtro actual</div></div>
<div class="kpi"><div class="n">${esc(fmtMoney(d.totals.pending, 'ARS'))}</div><div class="l">Pendiente (PENDING)</div><div class="d">Aún no cobrado</div></div>
<div class="kpi"><div class="n">${d.totals.count}</div><div class="l">Registros</div><div class="d">VOID incluidos en lista, excluidos de totales</div></div></div>
<div class="panel"><h2>Filtros</h2>
<form method="get" action="/admin/payments" class="toolbar">
<div class="fld"><label for="businessId">Negocio</label><select id="businessId" name="businessId">${bizOpts}</select></div>
<div class="fld small"><label for="status">Estado</label><select id="status" name="status">${stOpts}</select></div>
<div class="fld small"><label for="method">Método</label><select id="method" name="method">${mOpts}</select></div>
<div class="fld small"><label for="from">Desde</label><input id="from" name="from" type="date" value="${esc(d.filters.from)}"></div>
<div class="fld small"><label for="to">Hasta</label><input id="to" name="to" type="date" value="${esc(d.filters.to)}"></div>
<div><button class="ghost" type="submit">Filtrar</button></div>
</form>${rows}</div>
<div class="panel" style="max-width:44rem;"><h2>Registrar pago manual</h2>
<form method="post" action="/admin/payments">
<input type="hidden" name="_csrf" value="${esc(d.csrf ?? '')}">
<input type="hidden" name="idempotencyKey" value="${esc(d.formKey)}">
<div class="grid">
<div><label for="nbid">Negocio *</label><select id="nbid" name="businessId">${d.businesses.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></div>
<div><label for="namount">Importe *</label><input id="namount" name="amount" required inputmode="decimal" placeholder="15000" pattern="^[0-9]+([.,][0-9]{1,2})?$"></div>
<div><label for="npaid">Fecha de cobro *</label><input id="npaid" name="paidAt" type="date" required></div>
<div><label for="nmethod">Método *</label><select id="nmethod" name="method"><option>EFECTIVO</option><option>TRANSFERENCIA</option><option>MERCADO_PAGO</option><option>OTRO</option></select></div>
<div><label for="nstatus">Estado *</label><select id="nstatus" name="status"><option value="CONFIRMED">CONFIRMED (cobrado)</option><option value="PENDING">PENDING (pendiente)</option></select></div>
<div><label for="nconcept">Concepto</label><input id="nconcept" name="concept" maxlength="80" value="Suscripción"></div>
</div>
<p><button type="submit">Registrar pago</button></p>
<p class="faint">Anti doble-envío por clave única. Anular nunca borra: marca VOID con motivo.</p>
</form></div>`;
  return layout('Pagos', body, {
    showNav: true,
    active: 'payments',
    operator: d.operator,
    csrf: d.csrf,
    sectionTitle: 'Pagos y control comercial',
    sectionSub: 'Cobros manuales — sin pasarela en esta etapa',
  });
}

// ----------------------------------------------------------- audit ---

export interface AuditPageData {
  entries: Array<{ entry: AuditEntry; businessName: string }>;
  total: number;
  csrf?: string;
  operator?: string;
}

export function auditPage(d: AuditPageData): string {
  const rows =
    d.entries.length === 0
      ? '<p class="empty">Sin actividad registrada.</p>'
      : `<table class="resp"><thead><tr><th>Cuándo</th><th>Acción</th><th>Negocio</th><th>Operador</th><th>Detalle</th></tr></thead><tbody>${d.entries
          .map(({ entry: a, businessName }) => {
            const op = (a.metadata?.operator as string | undefined) ?? 'anónimo';
            return `<tr><td data-th="Cuándo" class="muted">${esc(fmtDate(a.createdAt, 'America/Argentina/Buenos_Aires'))}</td>
<td data-th="Acción" class="mono">${esc(a.action)}</td><td data-th="Negocio">${esc(businessName)}</td>
<td data-th="Operador">${esc(op)}</td><td data-th="Detalle" class="muted mono">${esc(a.entityId ?? '')}</td></tr>`;
          })
          .join('')}</tbody></table>`;
  const body = `<div class="panel"><h2>Actividad administrativa reciente (${d.total})</h2>${rows}
<p class="faint">Se auditan: creación de negocios, cambios de estado, invitaciones, pagos y anulaciones, login/logout (en logs del servidor). Nunca se registran passwords, tokens ni secretos.</p></div>`;
  return layout('Auditoría', body, {
    showNav: true,
    active: 'audit',
    operator: d.operator,
    csrf: d.csrf,
    sectionTitle: 'Auditoría',
    sectionSub: 'Quién hizo qué, cuándo y sobre qué',
  });
}

// ----------------------------------------------------------- config ---

export interface ConfigPageData {
  trialDays: number;
  graceDays: number;
  templates: AdminTemplateOption[];
  polling: string;
  webhook: boolean;
  csrf?: string;
  operator?: string;
}

export function configPage(d: ConfigPageData): string {
  const body = `
<div class="panel"><h2>Parámetros comerciales</h2>
<dl class="kv"><dt>Trial por defecto</dt><dd>${d.trialDays} días (inicia con la primera escritura real)</dd>
<dt>Gracia por defecto</dt><dd>${d.graceDays} días (permisiva, con recordatorio)</dd>
<dt>Templates para altas</dt><dd>${d.templates.map((t) => esc(`${t.label} (${t.id})`)).join(' · ')}</dd>
<dt>Telegram</dt><dd>${esc(d.polling)}${d.webhook ? ' · webhook activo' : ''}</dd></dl>
<p class="faint">Solo lectura: estos valores vienen del backend (env/config). No se exponen secretos ni se editan desde la web en esta etapa.</p></div>
<div class="panel"><h2>Equipo (3 operadores)</h2>
<p class="muted">Acceso con password compartida + etiqueta de operador firmada en la sesión (12 h). Rotar <span class="mono">ADMIN_PASSWORD</span> invalida todas las sesiones. Las operaciones se atribuyen por <span class="mono">metadata.operator</span> en la auditoría.</p>
<p class="faint">Paso siguiente (cambio mayor, no aplicado): cuentas individuales con hash + roles + revocación por usuario. Mientras tanto, usá etiquetas distintas por persona.</p></div>`;
  return layout('Config', body, {
    showNav: true,
    active: 'config',
    operator: d.operator,
    csrf: d.csrf,
    sectionTitle: 'Configuración',
    sectionSub: 'Parámetros que el sistema permite ver',
  });
}
