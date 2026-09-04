// horarios-test-logic.js
// Pestaña "Horarios" del panel del checador: cola de salidas por ramal
// (Capilla / Secundaria), vista pizarrón, y alimenta la tarjeta que cada
// conductor ve en su propio panel. Todo vive en Supabase (tablas
// ramales_config y corridas) — ya no en localStorage, para que se comparta
// entre el checador, el dueño y los conductores en tiempo real.

import { supabase } from './supabase-config-test.js';

const RAMALES = ['capilla', 'secundaria'];
let ramalesConfig = {}; // { capilla: {nombre, intervalo, margen}, secundaria: {...} }
let corridasPorRamal = { capilla: [], secundaria: [] };
let unidadesH = []; // [{id, numero}]
let conductoresH = []; // [{id, nombre, route}]
let corridasChannel = null;
let saveQueue = new Map(); // corridaId -> timeout, para no saturar Supabase con cada tecla

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function formatHora(m) {
  if (m === null || m === undefined) return '--:--';
  let mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60), mi = mm % 60;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ======================= CARGA INICIAL ======================= */
async function loadRamalesConfig() {
  const { data, error } = await supabase.from('ramales_config').select('*');
  if (error) { console.error('Error cargando ramales_config:', error); return; }
  ramalesConfig = {};
  (data || []).forEach((r) => { ramalesConfig[r.ramal] = r; });
}

async function loadRosterH() {
  const [{ data: units }, { data: drivers }] = await Promise.all([
    supabase.from('units').select('id, unit_number, active').eq('active', true).order('unit_number'),
    supabase.from('drivers').select('id, name, route'),
  ]);
  unidadesH = (units || []).map((u) => ({ id: u.id, numero: u.unit_number }));
  conductoresH = (drivers || []).map((d) => ({ id: d.id, nombre: d.name || 'Conductor', route: d.route }));
}

async function loadCorridasHoy() {
  const { data, error } = await supabase.from('corridas').select('*').eq('fecha', todayStr());
  if (error) { console.error('Error cargando corridas:', error); return; }
  corridasPorRamal = { capilla: [], secundaria: [] };
  (data || []).forEach((c) => { if (corridasPorRamal[c.ramal]) corridasPorRamal[c.ramal].push(c); });
  RAMALES.forEach((k) => corridasPorRamal[k].sort((a, b) => (a.hora_salida ?? 9999) - (b.hora_salida ?? 9999)));
}

function initCorridasRealtime(onChange) {
  if (corridasChannel) supabase.removeChannel(corridasChannel);
  corridasChannel = supabase
    .channel('corridas-horarios-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'corridas' }, async () => {
      await loadCorridasHoy();
      onChange();
    })
    .subscribe();
}

/* ======================= MOTOR (mismo cálculo del prototipo) ======================= */
// El margen "fantasma" aplica a la salida Y a la vuelta, solo si el ramal
// tiene margen configurado (Capilla). horaSalidaRaw encadena el intervalo
// real; horaSalida es lo que se muestra/entrega (raw + margen). Una hora
// editada a mano se respeta tal cual y se vuelve el nuevo punto de partida.
function recalcRamal(key) {
  const cfg = ramalesConfig[key];
  const margen = cfg?.margen || 0;
  const intervalo = cfg?.intervalo || 7;
  let anchorRaw = null;
  let siguienteAsignada = false;
  const now = nowMinutes();
  const lista = corridasPorRamal[key];

  lista.forEach((c) => {
    if (c.estado === 'salio' || c.estado === 'regresada') {
      anchorRaw = c.hora_salida_raw != null ? c.hora_salida_raw : c.hora_salida;
      return;
    }
    if (c.manual) {
      anchorRaw = c.hora_salida;
      c.hora_salida_raw = c.hora_salida;
    } else {
      anchorRaw = anchorRaw === null ? now : anchorRaw + intervalo;
      c.hora_salida_raw = anchorRaw;
      c.hora_salida = anchorRaw + margen;
    }
    c.estado = siguienteAsignada ? 'programada' : 'siguiente';
    siguienteAsignada = true;
  });

  lista.forEach((c) => {
    if (c.tiempo_vuelta != null && c.hora_salida_raw != null) {
      c.hora_regreso = c.hora_salida_raw + c.tiempo_vuelta + margen;
    }
  });
}
function recalcTodos() { RAMALES.forEach(recalcRamal); }

function unidadNombre(id) { return unidadesH.find((u) => u.id === id)?.numero || '—'; }
function conductorNombre(id) { return conductoresH.find((c) => c.id === id)?.nombre || '—'; }

/* ======================= PERSISTENCIA ======================= */
// Debounce por fila: cada corrida se guarda sola 400ms después de su último
// cambio, para no mandar un UPDATE por cada tecla.
function queueSave(corrida) {
  clearTimeout(saveQueue.get(corrida.id));
  saveQueue.set(corrida.id, setTimeout(async () => {
    const { error } = await supabase.from('corridas').update({
      unit_id: corrida.unit_id,
      driver_id: corrida.driver_id,
      hora_salida: corrida.hora_salida,
      hora_salida_raw: corrida.hora_salida_raw,
      hora_regreso: corrida.hora_regreso,
      estado: corrida.estado,
      manual: corrida.manual,
      tiempo_vuelta: corrida.tiempo_vuelta,
      updated_at: new Date().toISOString(),
    }).eq('id', corrida.id);
    if (error) console.error('Error guardando corrida:', error);
  }, 400));
}

async function saveAllRamal(key) {
  corridasPorRamal[key].forEach(queueSave);
}

/* ======================= RENDER: PESTAÑA HORARIOS ======================= */
function renderHorarios() {
  const grid = document.getElementById('horariosGrid');
  if (!grid) return;
  grid.innerHTML = '';
  RAMALES.forEach((key) => grid.appendChild(renderRamalCol(key)));
  if (window.lucide) lucide.createIcons();
}

function unidadOptions(selectedId) {
  return unidadesH.map((u) => `<option value="${u.id}" ${u.id === selectedId ? 'selected' : ''}>${u.numero}</option>`).join('');
}
function conductorOptions(selectedId) {
  return conductoresH.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.nombre}</option>`).join('');
}

function renderRamalCol(key) {
  const cfg = ramalesConfig[key] || { nombre: key, intervalo: 7, margen: 0 };
  const lista = corridasPorRamal[key];
  const pendientes = lista.filter((c) => c.estado === 'programada' || c.estado === 'siguiente');
  const siguiente = pendientes.find((c) => c.estado === 'siguiente');
  const enRutaLista = lista.filter((c) => c.estado === 'salio');
  const presets = [6, 7, 8, 9];

  const col = document.createElement('div');
  col.className = 'hz-ramal-col hz-' + key;
  col.innerHTML = `
    <div class="hz-ramal-head">
      <div class="flex items-center justify-between">
        <div class="hz-ramal-name">${cfg.nombre}</div>
        <div class="hz-margen-tag">${cfg.margen ? '+' + cfg.margen + ' min fantasma' : 'sin margen'}</div>
      </div>
      <div class="hz-interval-row">
        <label class="text-xs" style="color:var(--ink-soft)">Sale cada</label>
        <input type="number" min="1" class="hz-intervalo-input" data-ramal="${key}" value="${cfg.intervalo}">
        <label class="text-xs" style="color:var(--ink-soft)">min</label>
        ${presets.map((p) => `<button type="button" class="hz-preset-btn ${p === cfg.intervalo ? 'active' : ''}" data-ramal="${key}" data-preset="${p}">${p}</button>`).join('')}
      </div>
    </div>

    <div class="hz-hero-next">
      ${siguiente ? `
        <div>
          <div class="hz-hero-label">SIGUIENTE SALIDA</div>
          <div class="hz-hero-time">${formatHora(siguiente.hora_salida)}</div>
          <div class="hz-hero-meta">${unidadNombre(siguiente.unit_id)} · ${conductorNombre(siguiente.driver_id)}</div>
        </div>
        <button type="button" class="hz-icon-btn hz-go" title="Marcar como salió" data-action="salio" data-ramal="${key}" data-id="${siguiente.id}"><i data-lucide="check" class="w-4 h-4"></i></button>
      ` : `<div class="hz-hero-empty">No hay salidas programadas.</div>`}
    </div>

    <div class="hz-subhead">Cola de salidas</div>
    <div class="hz-corridas-list" data-list="${key}"></div>

    <div class="hz-add-row">
      <button type="button" class="hz-btn-add" data-action="agregar" data-ramal="${key}">+ Agregar salida a la cola</button>
    </div>

    ${enRutaLista.length ? `
      <div class="hz-subhead">En ruta · regresando a base</div>
      <div class="hz-corridas-list" data-enruta="${key}"></div>
    ` : ''}
  `;

  const list = col.querySelector(`[data-list="${key}"]`);
  pendientes.forEach((c) => list.appendChild(renderCorridaRow(key, c)));
  if (pendientes.length === 0) {
    const p = document.createElement('div');
    p.className = 'hz-empty-note';
    p.textContent = 'Cola vacía.';
    list.appendChild(p);
  }
  const enRutaBox = col.querySelector(`[data-enruta="${key}"]`);
  if (enRutaBox) enRutaLista.forEach((c) => enRutaBox.appendChild(renderEnRutaRow(key, c)));

  return col;
}

function renderCorridaRow(key, c) {
  const row = document.createElement('div');
  row.className = 'hz-corrida-row';
  row.innerHTML = `
    <div class="hz-corrida-time ${c.manual ? 'manual' : ''}">${formatHora(c.hora_salida)}</div>
    <select class="hz-sel" data-field="unit_id" data-ramal="${key}" data-id="${c.id}">${unidadOptions(c.unit_id)}</select>
    <select class="hz-sel" data-field="driver_id" data-ramal="${key}" data-id="${c.id}">${conductorOptions(c.driver_id)}</select>
    <div class="hz-row-actions">
      <button type="button" class="hz-icon-btn" title="Editar hora manualmente" data-action="editar-hora" data-ramal="${key}" data-id="${c.id}"><i data-lucide="pencil" class="w-3.5 h-3.5"></i></button>
      <button type="button" class="hz-icon-btn hz-go" title="Marcar como salió" data-action="salio" data-ramal="${key}" data-id="${c.id}"><i data-lucide="check" class="w-3.5 h-3.5"></i></button>
      <button type="button" class="hz-icon-btn" title="Quitar de la cola" data-action="quitar" data-ramal="${key}" data-id="${c.id}"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
    </div>
  `;
  return row;
}

function renderEnRutaRow(key, c) {
  const row = document.createElement('div');
  row.className = 'hz-corrida-row';
  const now = nowMinutes();
  const disponible = c.hora_regreso != null && c.hora_regreso <= now;
  row.innerHTML = `
    <div class="hz-corrida-time salio">${formatHora(c.hora_salida)}</div>
    <div class="text-xs self-center" style="color:var(--ink-soft);grid-column:span 2;">${unidadNombre(c.unit_id)} · ${conductorNombre(c.driver_id)}</div>
    <div class="hz-row-actions">
      ${disponible
        ? `<span class="hz-badge ok">de vuelta</span><button type="button" class="hz-icon-btn hz-go" title="Confirmar regreso" data-action="confirmar-regreso" data-ramal="${key}" data-id="${c.id}"><i data-lucide="check" class="w-3.5 h-3.5"></i></button>`
        : (c.hora_regreso != null ? `<span class="hz-badge enruta">regresa ${formatHora(c.hora_regreso)}</span>` : `<span class="hz-badge enruta">en ruta</span>`)}
      <input type="number" min="1" class="hz-vuelta-input" placeholder="min vuelta" data-ramal="${key}" data-id="${c.id}" value="${c.tiempo_vuelta ?? ''}">
    </div>
  `;
  return row;
}

/* ======================= EVENTOS ======================= */
function findCorrida(key, id) { return corridasPorRamal[key].find((c) => c.id === id); }

async function handleHorariosClick(e) {
  const t = e.target.closest('[data-action], .hz-preset-btn');
  if (!t || !document.getElementById('horarios')?.contains(t)) return;

  if (t.matches('.hz-preset-btn')) {
    const key = t.dataset.ramal;
    const val = parseInt(t.dataset.preset, 10);
    await supabase.from('ramales_config').update({ intervalo: val }).eq('ramal', key);
    ramalesConfig[key].intervalo = val;
    recalcRamal(key); renderHorarios(); await saveAllRamal(key);
    return;
  }

  if (t.dataset.action === 'agregar') {
    const key = t.dataset.ramal;
    const enRuta = new Set(corridasPorRamal[key].filter((c) => c.estado === 'salio').map((c) => c.unit_id));
    const enRutaC = new Set(corridasPorRamal[key].filter((c) => c.estado === 'salio').map((c) => c.driver_id));
    const usados = new Set(corridasPorRamal[key].map((c) => c.unit_id));
    const usadosC = new Set(corridasPorRamal[key].map((c) => c.driver_id));
    const unidad = unidadesH.find((u) => !enRuta.has(u.id) && !usados.has(u.id)) || unidadesH.find((u) => !enRuta.has(u.id)) || unidadesH[0];
    const conductor = conductoresH.find((c) => !enRutaC.has(c.id) && !usadosC.has(c.id)) || conductoresH.find((c) => !enRutaC.has(c.id)) || conductoresH[0];
    const { data, error } = await supabase.from('corridas').insert({
      ramal: key, unit_id: unidad?.id || null, driver_id: conductor?.id || null,
      estado: 'programada', fecha: todayStr(),
    }).select().single();
    if (error) { console.error('Error agregando corrida:', error); return; }
    corridasPorRamal[key].push(data);
    recalcRamal(key); renderHorarios(); await saveAllRamal(key);
    return;
  }

  if (t.dataset.action === 'quitar') {
    const key = t.dataset.ramal;
    await supabase.from('corridas').delete().eq('id', t.dataset.id);
    corridasPorRamal[key] = corridasPorRamal[key].filter((c) => c.id !== t.dataset.id);
    recalcRamal(key); renderHorarios(); await saveAllRamal(key);
    return;
  }

  if (t.dataset.action === 'salio') {
    const key = t.dataset.ramal;
    const c = findCorrida(key, t.dataset.id);
    if (c) {
      const now = nowMinutes();
      c.hora_salida = now; c.hora_salida_raw = now; c.estado = 'salio';
      recalcRamal(key); renderHorarios(); queueSave(c);
    }
    return;
  }

  if (t.dataset.action === 'confirmar-regreso') {
    const key = t.dataset.ramal;
    const c = findCorrida(key, t.dataset.id);
    if (c) { c.estado = 'regresada'; renderHorarios(); queueSave(c); }
    return;
  }

  if (t.dataset.action === 'editar-hora') {
    const key = t.dataset.ramal;
    const c = findCorrida(key, t.dataset.id);
    if (!c) return;
    const nueva = prompt('Nueva hora de salida (HH:MM, 24 horas):', formatHora(c.hora_salida));
    if (nueva && /^\d{1,2}:\d{2}$/.test(nueva.trim())) {
      const [h, m] = nueva.trim().split(':').map(Number);
      if (h >= 0 && h < 24 && m >= 0 && m < 60) {
        c.hora_salida = h * 60 + m; c.hora_salida_raw = c.hora_salida; c.manual = true;
        recalcRamal(key); renderHorarios(); queueSave(c);
      }
    }
    return;
  }
}

function handleHorariosChange(e) {
  const t = e.target;
  if (!document.getElementById('horarios')?.contains(t)) return;

  if (t.matches('.hz-intervalo-input')) {
    const key = t.dataset.ramal;
    const val = parseInt(t.value, 10);
    if (val && val > 0) {
      supabase.from('ramales_config').update({ intervalo: val }).eq('ramal', key);
      ramalesConfig[key].intervalo = val;
      recalcRamal(key); renderHorarios(); saveAllRamal(key);
    }
    return;
  }
  if (t.matches('.hz-sel')) {
    const key = t.dataset.ramal;
    const c = findCorrida(key, t.dataset.id);
    if (c) { c[t.dataset.field] = t.value; queueSave(c); }
    return;
  }
  if (t.matches('.hz-vuelta-input')) {
    const key = t.dataset.ramal;
    const c = findCorrida(key, t.dataset.id);
    if (c) {
      c.tiempo_vuelta = t.value ? parseInt(t.value, 10) : null;
      recalcRamal(key); renderHorarios(); queueSave(c);
    }
    return;
  }
}

/* ======================= RELOJ ======================= */
function tickHorarios() {
  recalcTodos();
  if (!document.getElementById('horarios')?.classList.contains('hidden')) renderHorarios();
}

/* ======================= INIT ======================= */
export async function initHorarios() {
  await Promise.all([loadRamalesConfig(), loadRosterH()]);
  await loadCorridasHoy();
  recalcTodos();
  renderHorarios();
  document.addEventListener('click', handleHorariosClick);
  document.addEventListener('change', handleHorariosChange);
  initCorridasRealtime(() => { recalcTodos(); renderHorarios(); });
  setInterval(tickHorarios, 20000);
}
