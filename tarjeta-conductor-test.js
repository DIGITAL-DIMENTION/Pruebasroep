// tarjeta-conductor-test.js
// Tarjeta "Mi horario de hoy" dentro del propio panel del conductor.
// Reemplaza el link/URL aparte del prototipo: cada conductor ve sus
// corridas del día (capturadas por el checador en su pestaña "Horarios")
// directo en su panel, y se actualiza sola en tiempo real.

import { supabase } from './supabase-config-test.js';

let tarjetaChannel = null;

function formatHora(m) {
  if (m === null || m === undefined) return '--:--';
  let mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60), mi = mm % 60;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
function ramalNombre(r) { return r === 'capilla' ? 'Por Capilla' : 'Por Secundaria'; }
function ramalColorVar(r) { return r === 'capilla' ? 'var(--cempasuchil)' : 'var(--agave)'; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function ensureTarjetaMount() {
  let el = document.getElementById('miTarjetaHoy');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'miTarjetaHoy';
  el.className = 'hidden';
  el.innerHTML = `
    <style>
      #miTarjetaHoy{margin:0 0 14px;}
      #miTarjetaHoy .mt-card{background:var(--surface);border:1px solid var(--border-soft);border-radius:1rem;padding:14px 16px;}
      #miTarjetaHoy .mt-title{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:8px;}
      #miTarjetaHoy .mt-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-soft);}
      #miTarjetaHoy .mt-row:last-child{border-bottom:none;}
      #miTarjetaHoy .mt-time{font-weight:700;font-size:17px;color:var(--ink);}
      #miTarjetaHoy .mt-time.pasada{color:var(--ink-faint);text-decoration:line-through;}
      #miTarjetaHoy .mt-meta{font-size:12px;color:var(--ink-soft);text-align:right;}
      #miTarjetaHoy .mt-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;}
      #miTarjetaHoy .mt-empty{font-size:13px;color:var(--ink-faint);text-align:center;padding:8px 0;}
      #miTarjetaHoy .mt-next-tag{font-size:10px;font-weight:700;color:var(--agave);}
    </style>
    <div class="mt-card">
      <div class="mt-title">Mi horario de hoy</div>
      <div id="miTarjetaHoyBody"></div>
    </div>
  `;
  const anchor = document.getElementById('mainScreen');
  if (anchor) anchor.insertBefore(el, anchor.firstChild);
  return el;
}

function renderTarjeta(driverId, corridas) {
  const wrap = ensureTarjetaMount();
  const body = document.getElementById('miTarjetaHoyBody');
  if (!corridas.length) {
    wrap.classList.remove('hidden');
    body.innerHTML = '<div class="mt-empty">Todavía no tienes salidas asignadas hoy.</div>';
    return;
  }
  wrap.classList.remove('hidden');
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  body.innerHTML = corridas.map((c) => {
    const pasada = c.estado === 'salio' || c.estado === 'regresada';
    const esSiguiente = c.estado === 'siguiente';
    return `
      <div class="mt-row">
        <div>
          <div class="mt-time ${pasada ? 'pasada' : ''}">${formatHora(c.hora_salida)}</div>
        </div>
        <div class="mt-meta">
          <span class="mt-dot" style="background:${ramalColorVar(c.ramal)}"></span>${ramalNombre(c.ramal)}
          ${esSiguiente ? '<div class="mt-next-tag">SIGUIENTE</div>' : ''}
          ${c.hora_regreso != null ? `<div>regresa ${formatHora(c.hora_regreso)}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function loadYRender(driverId) {
  const { data, error } = await supabase
    .from('corridas')
    .select('*')
    .eq('driver_id', driverId)
    .eq('fecha', todayStr())
    .order('hora_salida', { ascending: true });
  if (error) { console.error('Error cargando mi horario:', error); return; }
  renderTarjeta(driverId, data || []);
}

export function initTarjetaConductor(driverId) {
  if (!driverId) return;
  loadYRender(driverId);
  if (tarjetaChannel) supabase.removeChannel(tarjetaChannel);
  tarjetaChannel = supabase
    .channel('tarjeta-conductor-' + driverId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'corridas', filter: `driver_id=eq.${driverId}` }, () => {
      loadYRender(driverId);
    })
    .subscribe();
}
