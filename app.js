/* Portal de reclamos de pedidos para farmacias */
(() => {
  'use strict';

  const MOTIVOS = {
    faltantes: 'Faltantes',
    sobrantes: 'Sobrantes',
    cruces: 'Cruces',
    averias: 'Averías',
    validacion_inventario: 'Validación de inventario',
  };
  const ESTATUS = {
    pendiente: 'Pendiente',
    en_revision: 'En revisión',
    finalizado: 'Finalizado',
  };

  const { SUPABASE_URL, SUPABASE_KEY } = window.APP_CONFIG;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
  const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const motivosDe = (t) => (t.motivos?.length ? t.motivos : t.motivo ? [t.motivo] : []);
  const motivosHtml = (t) => `<div class="motivos">${motivosDe(t).map((m) => `<span class="motivo-tag ${esc(m)}">${esc(MOTIVOS[m] || m)}</span>`).join('')}</div>`;
  const badge = (e) => `<span class="badge st-${esc(e)}">${esc(ESTATUS[e] || e)}</span>`;
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

  function msg(el, text, type = '') {
    el.textContent = text || '';
    el.className = 'msg ' + type;
  }

  const state = { user: null, staff: null, profile: null, staffTickets: [], preview: null };

  function show(viewId) {
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== viewId));
    $('#loading').classList.add('hidden');
  }

  // ---------- Tabs ----------
  $$('.tabs').forEach((nav) => {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      $$('.tab', nav).forEach((b) => b.classList.toggle('active', b === btn));
      const view = nav.parentElement;
      $$('.tabpane', view).forEach((p) => p.classList.toggle('hidden', p.id !== btn.dataset.tab));
      const loader = tabLoaders[btn.dataset.tab];
      if (loader) loader();
    });
  });
  const tabLoaders = {
    tabMisTickets: () => loadMyTickets(),
    tabTickets: () => loadStaffTickets(),
    tabCatalogo: () => loadProducts(),
    tabUsuarios: () => loadStaffUsers(),
    tabSucursales: () => loadSucursales(),
  };

  // ---------- Selects ----------
  for (const [k, v] of Object.entries(MOTIVOS)) {
    $('#tplItem').content.querySelector('.i-motivo').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
    $('#fMotivo').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
  }
  for (const [k, v] of Object.entries(ESTATUS)) {
    $('#fEstatus').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
  }

  // ---------- Login con código ----------
  let pendingEmail = '';
  $('#formEmail').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    pendingEmail = $('#loginEmail').value.trim().toLowerCase();
    msg($('#loginMsg'), 'Enviando…');
    const timeout = new Promise((r) => setTimeout(() => r({ error: { message: 'timeout' } }), 30000));
    const { error } = await Promise.race([
      sb.auth.signInWithOtp({ email: pendingEmail, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } }),
      timeout,
    ]);
    btn.disabled = false;
    if (error) return msg($('#loginMsg'), traducirError(error), 'err');
    $('#sentTo').textContent = pendingEmail;
    $('#formEmail').classList.add('hidden');
    $('#formCode').classList.remove('hidden');
    msg($('#loginMsg'), 'Revisa tu bandeja de entrada (y spam).', 'ok');
    $('#loginCode').focus();
  });
  $('#formCode').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const token = $('#loginCode').value.replace(/\s/g, '');
    const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: 'email' });
    btn.disabled = false;
    if (error) return msg($('#loginMsg'), 'Código inválido o vencido. Intenta de nuevo.', 'err');
    msg($('#loginMsg'), '');
  });
  $('#btnBackEmail').addEventListener('click', () => {
    $('#formCode').classList.add('hidden');
    $('#formEmail').classList.remove('hidden');
    $('#loginCode').value = '';
    msg($('#loginMsg'), '');
  });
  $('#btnLogout').addEventListener('click', () => sb.auth.signOut());

  function traducirError(error) {
    const m = error?.message || String(error);
    if (/no autorizado|database error|unexpected_failure|saving new user|granting user/i.test(m) || error?.status === 500)
      return 'Este correo no está autorizado. Usa tu correo @farmaciasuno.com.sv';
    if (/rate limit|security purposes/i.test(m)) return 'Demasiados intentos. Espera un momento antes de pedir otro código.';
    if (/timeout|504|sending|smtp|confirmation email|magic link email/i.test(m) || error?.status === 504)
      return 'No se pudo enviar el correo con el código. Intenta de nuevo en unos minutos o avisa al administrador.';
    return m;
  }

  // ---------- Sesión ----------
  // La sesión se guarda en el navegador y vence 12 horas después de ingresar el código.
  const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
  const sessionExpired = (session) => {
    const t = Date.parse(session?.user?.last_sign_in_at || '');
    return Number.isFinite(t) && Date.now() - t > SESSION_MAX_MS;
  };
  async function expire() {
    await sb.auth.signOut();
    routedFor = null;
    await route(null);
    msg($('#loginMsg'), 'Tu sesión venció (12 horas). Pide un código nuevo para continuar.', 'err');
  }
  setInterval(async () => {
    if (!state.user) return;
    const { data } = await sb.auth.getSession();
    if (data.session && sessionExpired(data.session)) expire();
  }, 60 * 1000);

  let routedFor; // undefined hasta el primer evento, para que también se muestre el login
  sb.auth.onAuthStateChange((_evt, session) => {
    if (session && sessionExpired(session)) { setTimeout(expire, 0); return; }
    const uid = session?.user?.id || null;
    if (uid === routedFor) return;
    routedFor = uid;
    setTimeout(() => route(session), 0);
  });

  async function route(session) {
    state.user = session?.user || null;
    if (!state.user) {
      $('#userbox').classList.add('hidden');
      $('#formCode').classList.add('hidden');
      $('#formEmail').classList.remove('hidden');
      return show('viewLogin');
    }
    $('#loading').classList.remove('hidden');
    const email = state.user.email.toLowerCase();
    $('#userEmail').textContent = email;
    $('#userbox').classList.remove('hidden');

    const { data: staff } = await sb.from('staff').select('*').eq('email', email).maybeSingle();
    state.staff = staff;
    if (staff) {
      $('#userRole').textContent = staff.es_admin ? 'Admin' : 'Atención';
      $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !staff.es_admin));
      state.preview = null; $('#previewBar').classList.add('hidden');
      show('viewStaff');
      loadZonas();
      return loadStaffTickets();
    }

    $('#userRole').textContent = 'Farmacia';
    const { data: profs, error: perr } = await sb.rpc('vincular_sucursal');
    if (perr) { msg($('#loginMsg'), perr.message, 'err'); return show('viewLogin'); }
    state.profile = profs?.[0] || null;
    if (!state.profile) {
      const { data: sucs } = await sb.from('sucursales').select('cod_suc, sucursal').eq('activo', true).order('sucursal');
      $('#profSuc').innerHTML = '<option value="">Selecciona…</option>' +
        (sucs || []).map((x) => `<option value="${esc(x.cod_suc)}">${esc(x.sucursal)} (${esc(x.cod_suc)})</option>`).join('') +
        '<option value="__otra">Otra / no aparece en la lista</option>';
      return show('viewProfile');
    }
    enterFarmacia();
  }

  $('#formProfile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sel = $('#profSuc');
    const otra = sel.value === '__otra';
    const nombre = otra ? $('#profNombre').value.trim() : sel.selectedOptions[0].textContent.replace(/ \([^)]*\)$/, '');
    if (!nombre) return msg($('#profileMsg'), 'Escribe el nombre.', 'err');
    const row = {
      user_id: state.user.id,
      email: state.user.email.toLowerCase(),
      nombre,
      codigo_sucursal: otra ? null : sel.value,
    };
    const { data, error } = await sb.from('farmacias').insert(row).select().single();
    if (error) return msg($('#profileMsg'), error.message, 'err');
    state.profile = data;
    enterFarmacia();
  });

  $('#profSuc').addEventListener('change', (e) => {
    const otra = e.target.value === '__otra';
    $('#profOtraWrap').classList.toggle('hidden', !otra);
    $('#profNombre').required = otra;
  });

  // ---------- Fotos ----------
  const BUCKET = 'evidencias';
  const MAX_FOTOS_NUEVO = 8, MAX_FOTOS_TICKET = 12;
  // Reduce la foto a máx. 1600 px y JPEG ~75 % (de 3–5 MB a ~200–300 KB)
  async function comprimir(file) {
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      src = await new Promise((ok, fail) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => fail(new Error('Formato de imagen no soportado'));
        img.src = URL.createObjectURL(file);
      });
    }
    const w0 = src.width, h0 = src.height, k = Math.min(1, 1600 / Math.max(w0, h0));
    const cv = document.createElement('canvas');
    cv.width = Math.round(w0 * k); cv.height = Math.round(h0 * k);
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    return new Promise((ok, fail) => cv.toBlob((b) => (b ? ok(b) : fail(new Error('No se pudo procesar la imagen'))), 'image/jpeg', 0.75));
  }
  async function subirFotos(ticketId, blobs) {
    let fallidas = 0;
    for (const b of blobs) {
      const path = `${ticketId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      const { error } = await sb.storage.from(BUCKET).upload(path, b, { contentType: 'image/jpeg', upsert: false });
      if (error) fallidas++;
    }
    return fallidas;
  }
  async function listarFotos(ticketId) {
    const { data, error } = await sb.storage.from(BUCKET).list(String(ticketId), { limit: 50, sortBy: { column: 'name', order: 'asc' } });
    if (error || !data?.length) return [];
    const paths = data.filter((f) => f.name && !f.name.startsWith('.')).map((f) => `${ticketId}/${f.name}`);
    if (!paths.length) return [];
    const { data: urls } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    return (urls || []).filter((u) => u.signedUrl).map((u) => ({ path: u.path, url: u.signedUrl }));
  }

  // Fotos pendientes del formulario de nuevo ticket
  let fotosNuevas = [];
  function renderFotosNuevas() {
    $('#fotosPrev').innerHTML = fotosNuevas.map((f, i) => `
      <div class="thumb"><img src="${f.url}" alt="Foto ${i + 1}"><button type="button" class="x" data-i="${i}" aria-label="Quitar foto">✕</button></div>`).join('');
  }
  async function agregarFotosNuevas(files) {
    const out = $('#fotosMsg');
    msg(out, '');
    const libres = MAX_FOTOS_NUEVO - fotosNuevas.length;
    const lista = [...files].slice(0, Math.max(0, libres));
    if (files.length > lista.length) msg(out, `Máximo ${MAX_FOTOS_NUEVO} fotos por ticket.`, 'err');
    for (const f of lista) {
      try { const blob = await comprimir(f); fotosNuevas.push({ blob, url: URL.createObjectURL(blob) }); }
      catch (e) { msg(out, `${f.name}: ${e.message}`, 'err'); }
    }
    renderFotosNuevas();
  }
  ['#inCam', '#inGal'].forEach((id) => $(id).addEventListener('change', async (e) => {
    await agregarFotosNuevas(e.target.files);
    e.target.value = '';
  }));
  $('#fotosPrev').addEventListener('click', (e) => {
    const x = e.target.closest('.x');
    if (!x) return;
    const [f] = fotosNuevas.splice(Number(x.dataset.i), 1);
    URL.revokeObjectURL(f.url);
    renderFotosNuevas();
  });
  function limpiarFotosNuevas() {
    fotosNuevas.forEach((f) => URL.revokeObjectURL(f.url));
    fotosNuevas = []; renderFotosNuevas(); msg($('#fotosMsg'), '');
  }

  // ---------- Farmacia: nuevo ticket ----------
  function enterFarmacia() {
    $('#farmName').textContent = '· ' + state.profile.nombre + (state.profile.codigo_sucursal ? ` (${state.profile.codigo_sucursal})` : '');
    $('#tFecha').max = today();
    if (!$('#itemsList').children.length) addItem();
    show('viewFarmacia');
  }

  const productCache = new Map();
  async function lookupProduct(code) {
    if (productCache.has(code)) return productCache.get(code);
    const codes = [code];
    if (/^\d{1,7}$/.test(code)) codes.push(code.padStart(8, '0')); // permite escribir sin ceros
    const { data } = await sb.from('productos').select('codigo, descripcion, laboratorio, factor').in('codigo', codes);
    const d = (data || []).sort((a, b) => (a.codigo === code ? -1 : 1))[0] || null;
    productCache.set(code, d);
    return d;
  }

  function addItem() {
    const node = $('#tplItem').content.firstElementChild.cloneNode(true);
    const cod = $('.i-codigo', node), desc = $('.i-desc', node), hint = $('.i-hint', node);
    let timer, seq = 0;
    const run = async () => {
      const code = cod.value.trim();
      const my = ++seq;
      desc.dataset.found = '';
      if (!code) { desc.value = ''; desc.readOnly = true; hint.textContent = ''; return; }
      hint.textContent = 'Buscando…'; hint.className = 'i-hint';
      const d = await lookupProduct(code);
      if (my !== seq) return;
      if (d) {
        if (d.codigo !== code) cod.value = d.codigo;
        desc.value = d.descripcion; desc.readOnly = true; desc.dataset.found = '1';
        hint.textContent = [d.laboratorio, d.factor != null ? `Factor ${d.factor}` : ''].filter(Boolean).join(' · ');
      } else {
        desc.value = ''; desc.readOnly = false; desc.required = true;
        desc.placeholder = 'No está en catálogo: escribe la descripción';
        hint.textContent = 'Código no encontrado'; hint.className = 'i-hint warn';
      }
    };
    cod.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
    cod.addEventListener('blur', () => { clearTimeout(timer); run(); });
    cod.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); $('.i-cant', node).focus(); }
    });
    $('.i-cant', node).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addItem(); }
    });
    // Tipo de reclamo por producto; "Cruces" habilita el campo opcional "Código correcto"
    const mot = $('.i-motivo', node), corrWrap = $('.i-correcto-wrap', node), corr = $('.i-correcto', node), corrHint = $('.i-correcto-hint', node);
    const prev = $('#itemsList .item-row:last-child .i-motivo');
    if (prev?.value) mot.value = prev.value;
    const toggleCorrecto = () => {
      const on = mot.value === 'cruces';
      corrWrap.classList.toggle('hidden', !on);
      if (!on) { corr.value = ''; corrHint.textContent = ''; }
    };
    mot.addEventListener('change', () => { toggleCorrecto(); if (mot.value === 'cruces') corr.focus(); });
    toggleCorrecto();
    let ctimer;
    corr.addEventListener('input', () => {
      clearTimeout(ctimer);
      corrHint.textContent = '';
      const v = corr.value.trim();
      if (!/^[A-Za-z]{0,2}\d{3,8}$/.test(v)) return; // solo busca si parece código
      ctimer = setTimeout(async () => {
        const d = await lookupProduct(v);
        if (corr.value.trim() !== v) return;
        if (d) { if (d.codigo !== v) corr.value = d.codigo; corrHint.textContent = '✓ ' + d.descripcion; }
      }, 400);
    });
    $('.i-del', node).addEventListener('click', () => {
      node.remove();
      if (!$('#itemsList').children.length) addItem();
    });
    $('#itemsList').appendChild(node);
    cod.focus();
  }
  $('#btnAddItem').addEventListener('click', addItem);
  $('fieldset.origen').addEventListener('change', (e) => e.currentTarget.classList.remove('invalid'));

  $('#formTicket').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = $$('#itemsList .item-row').map((r) => ({
      codigo: $('.i-codigo', r).value.trim(),
      descripcion: $('.i-desc', r).value.trim(),
      cantidad: Number($('.i-cant', r).value),
      motivo: $('.i-motivo', r).value,
      codigo_correcto: $('.i-motivo', r).value === 'cruces' ? ($('.i-correcto', r).value.trim() || null) : null,
    })).filter((i) => i.codigo);
    if (!items.length) return msg($('#ticketMsg'), 'Agrega al menos un producto.', 'err');
    if (items.some((i) => !i.descripcion)) return msg($('#ticketMsg'), 'Hay productos sin descripción.', 'err');
    if (items.some((i) => !i.motivo)) return msg($('#ticketMsg'), 'Selecciona el tipo de reclamo de cada producto.', 'err');
    if (items.some((i) => !(i.cantidad > 0))) return msg($('#ticketMsg'), 'Las cantidades deben ser mayores a 0.', 'err');

    const origen = $('input[name=tOrigen]:checked')?.value;
    $('fieldset.origen').classList.toggle('invalid', !origen);
    if (!origen) return msg($('#ticketMsg'), 'Selecciona el origen del pedido: CEDI o AMERICANA.', 'err');
    const btn = $('#btnSubmitTicket'); btn.disabled = true;
    msg($('#ticketMsg'), 'Enviando…');
    const { data, error } = await sb.rpc('crear_ticket', {
      p_origen: origen,
      p_folio: $('#tFolio').value,
      p_fecha: $('#tFecha').value,
      p_observaciones: $('#tObs').value,
      p_items: items,
      p_cod_suc: state.preview?.cod_suc ?? null,
    });
    if (error) { btn.disabled = false; return msg($('#ticketMsg'), error.message, 'err'); }
    let avisoFotos = '';
    if (fotosNuevas.length) {
      msg($('#ticketMsg'), `Ticket #${data} creado. Subiendo ${fotosNuevas.length} foto(s)…`);
      const fallidas = await subirFotos(data, fotosNuevas.map((f) => f.blob));
      if (fallidas) avisoFotos = ` ${fallidas} foto(s) no se pudieron subir; agrégalas desde "Mis tickets".`;
    }
    btn.disabled = false;
    $('#formTicket').reset();
    $('#itemsList').innerHTML = '';
    addItem();
    limpiarFotosNuevas();
    $$('input[name=tOrigen]').forEach((r) => (r.checked = false));
    msg($('#ticketMsg'), `Ticket${state.preview ? ' de prueba' : ''} #${data} enviado. Puedes darle seguimiento en "Mis tickets".${avisoFotos}`, avisoFotos ? 'err' : 'ok');
  });

  // ---------- Farmacia: mis tickets ----------
  async function loadMyTickets() {
    const box = $('#myTickets');
    box.innerHTML = '<p class="muted">Cargando…</p>';
    const { data, error } = await sb.from('tickets')
      .select('id, motivo, motivos, origen, folio, fecha_recepcion, estatus, nota_atencion, created_at, updated_at, ticket_items(count)')
      .eq('user_id', state.user.id).eq('es_prueba', !!state.preview)
      .match(state.preview ? { cod_suc: state.preview.cod_suc } : {})
      .order('created_at', { ascending: false }).limit(300);
    if (error) return (box.innerHTML = `<p class="msg err">${esc(error.message)}</p>`);
    if (!data.length) return (box.innerHTML = '<p class="muted">Aún no has creado tickets.</p>');
    box.innerHTML = `<table><thead><tr>
      <th>#</th><th>Creado</th><th>Motivo</th><th>Origen</th><th>Folio</th><th>Recibido</th><th>Productos</th><th>Estatus</th><th>Respuesta</th>
    </tr></thead><tbody>${data.map((t) => `
      <tr class="clickable" data-id="${t.id}">
        <td>${t.id}</td><td>${fmtDate(t.created_at)}</td><td>${motivosHtml(t)}</td><td>${t.origen ? `<span class="pill-origen">${esc(t.origen)}</span>` : ''}</td>
        <td>${esc(t.folio)}</td><td>${fmtDate(t.fecha_recepcion)}</td>
        <td>${t.ticket_items?.[0]?.count ?? ''}</td><td>${badge(t.estatus)}</td>
        <td class="trunc">${esc(t.nota_atencion || '')}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  $('#btnRefreshMine').addEventListener('click', loadMyTickets);
  $('#myTickets').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openTicket(Number(tr.dataset.id), false);
  });

  // ---------- Atención: tickets ----------
  async function loadStaffTickets() {
    const box = $('#staffTickets');
    box.innerHTML = '<p class="muted">Cargando…</p>';
    let q = sb.from('tickets')
      .select('id, email, farmacia, cod_suc, zona, ruta, motivo, motivos, origen, es_prueba, folio, fecha_recepcion, estatus, atendido_por, created_at, updated_at, ticket_items(count)')
      .order('created_at', { ascending: false }).limit(1000);
    const fe = $('#fEstatus').value, fm = $('#fMotivo').value, fz = $('#fZona').value;
    if (fz) q = q.eq('zona', fz);
    const fp = $('#fPrueba').value;
    if (fp) q = q.eq('es_prueba', fp === 'si');
    // Filtro por fecha (creación o recepción); los límites usan la zona horaria local
    const campo = $('#fFechaCampo').value, desde = $('#fDesde').value, hasta = $('#fHasta').value;
    if (campo === 'created_at') {
      if (desde) q = q.gte('created_at', new Date(desde + 'T00:00:00').toISOString());
      if (hasta) q = q.lt('created_at', new Date(new Date(hasta + 'T00:00:00').getTime() + 864e5).toISOString());
    } else {
      if (desde) q = q.gte('fecha_recepcion', desde);
      if (hasta) q = q.lte('fecha_recepcion', hasta);
    }
    const fo = $('#fOrigen').value;
    if (fo) q = q.eq('origen', fo);
    if (fe) q = q.eq('estatus', fe);
    if (fm) q = q.contains('motivos', [fm]);
    const { data, error } = await q;
    if (error) return (box.innerHTML = `<p class="msg err">${esc(error.message)}</p>`);
    state.staffTickets = data;
    renderStaffTickets();
    loadStats();
  }

  async function loadStats() {
    const counts = await Promise.all(Object.keys(ESTATUS).map((k) =>
      sb.from('tickets').select('id', { count: 'exact', head: true }).eq('estatus', k).then((r) => [k, r.count ?? 0])));
    $('#stats').innerHTML = counts.map(([k, n]) => `
      <button class="stat st-${k}" data-estatus="${k}"><span class="n">${n}</span><span>${ESTATUS[k]}</span></button>`).join('');
  }
  $('#stats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-estatus]');
    if (!b) return;
    $('#fEstatus').value = $('#fEstatus').value === b.dataset.estatus ? '' : b.dataset.estatus;
    loadStaffTickets();
  });

  function filteredStaffTickets() {
    const s = $('#fBuscar').value.trim().toLowerCase();
    if (!s) return state.staffTickets;
    return state.staffTickets.filter((t) =>
      [t.folio, t.farmacia, t.email, t.cod_suc, t.zona, t.ruta, String(t.id)].some((v) => String(v || '').toLowerCase().includes(s)));
  }

  function renderStaffTickets() {
    const box = $('#staffTickets');
    const data = filteredStaffTickets();
    if (!data.length) return (box.innerHTML = '<p class="muted">No hay tickets con esos filtros.</p>');
    box.innerHTML = `<table><thead><tr>
      <th>#</th><th>Creado</th><th>Farmacia</th><th>Motivo</th><th>Origen</th><th>Folio</th><th>Recibido</th><th>Prod.</th><th>Estatus</th><th>Atendió</th>
    </tr></thead><tbody>${data.map((t) => `
      <tr class="clickable" data-id="${t.id}">
        <td>${t.id}${t.es_prueba ? '<br><span class="badge-prueba">PRUEBA</span>' : ''}</td><td>${fmtDate(t.created_at)}</td>
        <td><div>${esc(t.farmacia)} ${t.cod_suc ? `<small class="muted">${esc(t.cod_suc)}</small>` : ''}</div><small class="muted">${esc([t.zona, t.ruta].filter(Boolean).join(' · ') || t.email)}</small></td>
        <td>${motivosHtml(t)}</td><td>${t.origen ? `<span class="pill-origen">${esc(t.origen)}</span>` : ''}</td><td>${esc(t.folio)}</td><td>${fmtDate(t.fecha_recepcion)}</td>
        <td>${t.ticket_items?.[0]?.count ?? ''}</td><td>${badge(t.estatus)}</td>
        <td><small>${esc(t.atendido_por || '')}</small></td>
      </tr>`).join('')}</tbody></table>`;
  }
  $('#fEstatus').addEventListener('change', loadStaffTickets);
  $('#fMotivo').addEventListener('change', loadStaffTickets);
  $('#fZona').addEventListener('change', loadStaffTickets);
  $('#fOrigen').addEventListener('change', loadStaffTickets);
  $('#fPrueba').addEventListener('change', loadStaffTickets);
  ['#fFechaCampo', '#fDesde', '#fHasta'].forEach((id) => $(id).addEventListener('change', () => {
    $$('.filters.fechas .quick .btn').forEach((b) => b.classList.remove('on'));
    loadStaffTickets();
  }));
  $('.filters.fechas .quick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rango]');
    if (!b) return;
    const r = b.dataset.rango, hoy = today();
    let desde = '', hasta = '';
    if (r === 'hoy') { desde = hasta = hoy; }
    else if (r === 'mes') { desde = hoy.slice(0, 8) + '01'; hasta = hoy; }
    else if (r) { const d = new Date(hoy + 'T00:00:00'); d.setDate(d.getDate() - (Number(r) - 1)); desde = d.toLocaleDateString('en-CA'); hasta = hoy; }
    $('#fDesde').value = desde; $('#fHasta').value = hasta;
    $$('.filters.fechas .quick .btn').forEach((x) => x.classList.toggle('on', x === b && !!r));
    loadStaffTickets();
  });
  async function loadZonas() {
    const { data } = await sb.from('sucursales').select('zona');
    const zonas = [...new Set((data || []).map((x) => x.zona).filter(Boolean))].sort();
    const cur = $('#fZona').value;
    $('#fZona').innerHTML = '<option value="">Todas las zonas</option>' + zonas.map((z) => `<option ${z === cur ? 'selected' : ''}>${esc(z)}</option>`).join('');
  }
  $('#fBuscar').addEventListener('input', renderStaffTickets);
  $('#btnRefreshStaff').addEventListener('click', loadStaffTickets);
  $('#staffTickets').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openTicket(Number(tr.dataset.id), true);
  });

  $('#btnExport').addEventListener('click', async () => {
    const ids = filteredStaffTickets().map((t) => t.id);
    if (!ids.length) return;
    const rows = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from('tickets')
        .select('id, created_at, farmacia, cod_suc, zona, ruta, email, motivo, origen, es_prueba, folio, fecha_recepcion, estatus, nota_atencion, atendido_por, ticket_items(codigo, descripcion, laboratorio, factor, cantidad, motivo, codigo_correcto)')
        .in('id', ids.slice(i, i + 200)).order('id');
      if (error) return alert(error.message);
      for (const t of data) for (const it of t.ticket_items) {
        rows.push([t.id, t.es_prueba ? 'Sí' : 'No', t.created_at.slice(0, 10), t.cod_suc || '', t.farmacia, t.zona || '', t.ruta || '', t.email, MOTIVOS[it.motivo || t.motivo] || '', t.origen || '', t.folio, t.fecha_recepcion,
          it.codigo, it.descripcion, it.laboratorio || '', it.factor ?? '', it.cantidad, it.codigo_correcto || '', ESTATUS[t.estatus], t.nota_atencion || '', t.atendido_por || '']);
      }
    }
    const head = ['Ticket', 'Prueba', 'Creado', 'Cód. sucursal', 'Sucursal', 'Zona', 'Ruta', 'Correo', 'Motivo', 'Origen', 'Folio', 'Fecha recepción', 'Código', 'Descripción', 'Laboratorio', 'Factor', 'Cantidad', 'Código correcto', 'Estatus', 'Nota atención', 'Atendió'];
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tickets');
    XLSX.writeFile(wb, `tickets_${today()}.xlsx`);
  });

  // ---------- Detalle de ticket ----------
  async function openTicket(id, isStaff) {
    const dlg = $('#dlg');
    $('#dlgTitle').textContent = `Ticket #${id}`;
    $('#dlgBody').innerHTML = '<p class="muted">Cargando…</p>';
    if (!dlg.open) dlg.showModal();
    const [{ data: t, error }, { data: hist }] = await Promise.all([
      sb.from('tickets').select('*, ticket_items(codigo, descripcion, laboratorio, factor, cantidad, motivo, codigo_correcto)').eq('id', id).single(),
      sb.from('ticket_historial').select('*').eq('ticket_id', id).order('created_at'),
    ]);
    if (error) return ($('#dlgBody').innerHTML = `<p class="msg err">${esc(error.message)}</p>`);

    $('#dlgBody').innerHTML = `
      <div class="detail-grid">
        <div><small class="muted">Sucursal</small><div>${esc(t.farmacia)}${t.cod_suc ? ` (${esc(t.cod_suc)})` : ''}</div><small class="muted">${esc(t.email)}</small></div>
        ${t.zona || t.ruta ? `<div><small class="muted">Zona / Ruta</small><div>${esc([t.zona, t.ruta].filter(Boolean).join(' · '))}</div></div>` : ''}
        <div><small class="muted">Tipo de reclamo</small>${motivosHtml(t)}</div>
        <div><small class="muted">Origen</small><div>${esc(t.origen || '—')}</div></div>
        <div><small class="muted">Folio</small><div>${esc(t.folio)}</div></div>
        <div><small class="muted">Fecha de recepción</small><div>${fmtDate(t.fecha_recepcion)}</div></div>
        <div><small class="muted">Creado</small><div>${fmtDateTime(t.created_at)}</div></div>
        <div><small class="muted">Estatus</small><div>${badge(t.estatus)}</div></div>
      </div>
      ${t.observaciones ? `<p><small class="muted">Observaciones</small><br>${esc(t.observaciones)}</p>` : ''}
      <table class="compact"><thead><tr><th>Código</th><th>Descripción</th><th>Tipo</th><th>Laboratorio</th><th class="num">Factor</th><th class="num">Cantidad</th></tr></thead>
      <tbody>${t.ticket_items.map((i) => `<tr><td>${esc(i.codigo)}</td><td>${esc(i.descripcion)}${i.codigo_correcto ? `<br><small class="muted">Código correcto: <b>${esc(i.codigo_correcto)}</b></small>` : ''}</td>
        <td><span class="motivo-tag ${esc(i.motivo || t.motivo || '')}">${esc(MOTIVOS[i.motivo || t.motivo] || '')}</span></td><td>${esc(i.laboratorio || '')}</td><td class="num">${esc(i.factor ?? '')}</td><td class="num">${esc(i.cantidad)}</td></tr>`).join('')}</tbody></table>
      ${isStaff ? `
        <form id="formStatus" class="status-form">
          <h3>Actualizar</h3>
          <div class="seg">${Object.entries(ESTATUS).map(([k, v]) => `
            <label><input type="radio" name="est" value="${k}" ${t.estatus === k ? 'checked' : ''}><span class="st-${k}">${v}</span></label>`).join('')}</div>
          <label>Nota para la farmacia
            <textarea id="stNota" rows="3" placeholder="Ej.: Se generó nota de crédito…">${esc(t.nota_atencion || '')}</textarea>
          </label>
          <button class="btn primary" type="submit">Guardar cambios</button>
          <p id="statusMsg" class="msg"></p>
        </form>` : (t.nota_atencion ? `<div class="note"><small class="muted">Respuesta de atención</small><br>${esc(t.nota_atencion)}</div>` : '')}
      <h3>Fotos</h3>
      <div id="dlgFotos" class="thumbs"><small class="muted">Cargando fotos…</small></div>
      <div class="foto-btns" id="dlgFotoBtns" style="margin-top:.5rem">
        <label class="btn ghost sm file-btn">📷 Tomar foto<input type="file" id="dlgCam" accept="image/*" capture="environment" hidden></label>
        <label class="btn ghost sm file-btn">🖼️ Agregar imágenes<input type="file" id="dlgGal" accept="image/*" multiple hidden></label>
      </div>
      <small id="dlgFotosMsg" class="msg"></small>
      ${isStaff && t.es_prueba && state.staff?.es_admin ? `<p><button class="btn ghost sm danger" id="btnDelPrueba">Borrar este ticket de prueba</button></p>` : ''}
      <h3>Historial</h3>
      <ul class="timeline">${(hist || []).map((h) => `
        <li><span class="when">${fmtDateTime(h.created_at)}</span>
          ${h.estatus_anterior && h.estatus_anterior !== h.estatus_nuevo ? `${badge(h.estatus_anterior)} → ` : ''}${badge(h.estatus_nuevo)}
          ${h.nota ? `<div>${esc(h.nota)}</div>` : ''}
          <small class="muted">${esc(h.usuario || '')}</small></li>`).join('')}</ul>`;

    if (t.es_prueba) $('#dlgTitle').innerHTML = `Ticket #${id} <span class="badge-prueba">PRUEBA</span>`;
    const puedeBorrarFoto = !!state.staff?.es_admin;
    const pintarFotos = async () => {
      const fotos = await listarFotos(id);
      if (!$('#dlgFotos')) return;
      $('#dlgFotos').innerHTML = fotos.length ? fotos.map((f) => `
        <div class="thumb"><a href="${esc(f.url)}" target="_blank" rel="noopener"><img src="${esc(f.url)}" alt="Foto del ticket" loading="lazy"></a>
        ${puedeBorrarFoto ? `<button type="button" class="x" data-path="${esc(f.path)}" aria-label="Borrar foto">✕</button>` : ''}</div>`).join('')
        : '<small class="muted">Sin fotos.</small>';
      $('#dlgFotoBtns').classList.toggle('hidden', fotos.length >= MAX_FOTOS_TICKET);
      return fotos;
    };
    pintarFotos();
    const subirDesdeDetalle = async (e) => {
      const files = [...e.target.files]; e.target.value = '';
      if (!files.length) return;
      const out = $('#dlgFotosMsg');
      const actuales = $$('#dlgFotos .thumb').length;
      const lista = files.slice(0, Math.max(0, MAX_FOTOS_TICKET - actuales));
      if (lista.length < files.length) msg(out, `Máximo ${MAX_FOTOS_TICKET} fotos por ticket.`, 'err');
      msg(out, `Subiendo ${lista.length} foto(s)…`);
      const blobs = [];
      for (const f of lista) { try { blobs.push(await comprimir(f)); } catch (err) { msg(out, `${f.name}: ${err.message}`, 'err'); } }
      const fallidas = await subirFotos(id, blobs);
      msg(out, fallidas ? `${fallidas} foto(s) no se pudieron subir.` : 'Fotos agregadas.', fallidas ? 'err' : 'ok');
      pintarFotos();
    };
    $('#dlgCam').addEventListener('change', subirDesdeDetalle);
    $('#dlgGal').addEventListener('change', subirDesdeDetalle);
    $('#dlgFotos').addEventListener('click', async (e) => {
      const x = e.target.closest('.x');
      if (!x || !confirm('¿Borrar esta foto?')) return;
      const { error } = await sb.storage.from(BUCKET).remove([x.dataset.path]);
      if (error) return msg($('#dlgFotosMsg'), error.message, 'err');
      pintarFotos();
    });
    $('#btnDelPrueba')?.addEventListener('click', async () => {
      if (!confirm(`¿Borrar el ticket de prueba #${id}?`)) return;
      const fotos = await listarFotos(id);
      if (fotos.length) await sb.storage.from(BUCKET).remove(fotos.map((f) => f.path));
      const { error } = await sb.from('tickets').delete().eq('id', id).eq('es_prueba', true);
      if (error) return alert(error.message);
      $('#dlg').close();
      loadStaffTickets();
    });
    if (isStaff) {
      $('#formStatus').addEventListener('submit', async (e) => {
        e.preventDefault();
        const estatus = $('input[name=est]:checked', e.target).value;
        const nota = $('#stNota').value.trim() || null;
        const { error } = await sb.from('tickets').update({ estatus, nota_atencion: nota }).eq('id', id);
        if (error) return msg($('#statusMsg'), error.message, 'err');
        await openTicket(id, true);
        loadStaffTickets();
      });
    }
  }
  $('#dlgClose').addEventListener('click', () => $('#dlg').close());
  $('#dlg').addEventListener('click', (e) => { if (e.target.id === 'dlg') e.target.close(); });

  // ---------- Atención: catálogo ----------
  let prodTimer;
  async function loadProducts() {
    const s = $('#prodSearch').value.trim();
    let q = sb.from('productos').select('codigo, descripcion, laboratorio, factor', { count: 'exact' }).order('codigo').limit(200);
    if (s) { const t = s.replace(/[%,()]/g, ''); q = q.or(`codigo.ilike.%${t}%,descripcion.ilike.%${t}%,laboratorio.ilike.%${t}%`); }
    const { data, count, error } = await q;
    const box = $('#prodList');
    if (error) return (box.innerHTML = `<p class="msg err">${esc(error.message)}</p>`);
    $('#prodCount').textContent = `(${count ?? 0}${count > 200 ? ', mostrando 200' : ''})`;
    box.innerHTML = data.length ? `<table class="compact"><thead><tr><th>Código</th><th>Descripción</th><th>Laboratorio</th><th class="num">Factor</th><th></th></tr></thead><tbody>
      ${data.map((p) => `<tr><td>${esc(p.codigo)}</td><td>${esc(p.descripcion)}</td><td>${esc(p.laboratorio || '')}</td><td class="num">${esc(p.factor ?? '')}</td>
        <td class="num"><button class="btn ghost sm" data-edit="${esc(p.codigo)}" data-desc="${esc(p.descripcion)}" data-lab="${esc(p.laboratorio || '')}" data-factor="${esc(p.factor ?? '')}">Editar</button>
        <button class="btn ghost sm danger" data-del="${esc(p.codigo)}">Borrar</button></td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Sin productos.</p>';
  }
  $('#prodSearch').addEventListener('input', () => { clearTimeout(prodTimer); prodTimer = setTimeout(loadProducts, 300); });
  $('#prodList').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { $('#pCodigo').value = ed.dataset.edit; $('#pDesc').value = ed.dataset.desc; $('#pLab').value = ed.dataset.lab; $('#pFactor').value = ed.dataset.factor; $('#pDesc').focus(); return; }
    const del = e.target.closest('[data-del]');
    if (del && confirm(`¿Borrar el producto ${del.dataset.del}?`)) {
      const { error } = await sb.from('productos').delete().eq('codigo', del.dataset.del);
      if (error) return alert(error.message);
      loadProducts();
    }
  });
  $('#formProd').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = { codigo: $('#pCodigo').value.trim(), descripcion: $('#pDesc').value.trim(),
      laboratorio: $('#pLab').value.trim() || null, factor: $('#pFactor').value === '' ? null : Number($('#pFactor').value), updated_at: new Date().toISOString() };
    const { error } = await sb.from('productos').upsert(row);
    if (error) return msg($('#prodMsg'), error.message, 'err');
    msg($('#prodMsg'), `Producto ${row.codigo} guardado.`, 'ok');
    e.target.reset();
    loadProducts();
  });

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  $('#btnImport').addEventListener('click', async () => {
    const file = $('#fileCatalog').files[0];
    const out = $('#importMsg');
    if (!file) return msg(out, 'Selecciona un archivo.', 'err');
    msg(out, 'Leyendo archivo…');
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
      if (!rows.length) return msg(out, 'El archivo está vacío.', 'err');
      const head = rows[0].map(norm);
      let ci = head.findIndex((h) => ['codigo', 'cod', 'code', 'sku', 'itemcode'].includes(h));
      let di = head.findIndex((h) => ['descripcion', 'desc', 'description', 'nombre', 'itemname', 'producto', 'articulo'].includes(h));
      const li = head.findIndex((h) => ['laboratorio', 'lab', 'proveedor', 'fabricante'].includes(h));
      const fi = head.findIndex((h) => ['factor', 'fact', 'unidades', 'empaque'].includes(h));
      let start = 1;
      if (ci < 0 || di < 0) { ci = 0; di = 1; start = 0; }
      const map = new Map();
      for (const r of rows.slice(start)) {
        const c = String(r[ci] ?? '').trim(), d = String(r[di] ?? '').trim();
        if (!c || !d) continue;
        const row = { codigo: c, descripcion: d, updated_at: new Date().toISOString() };
        if (li >= 0) row.laboratorio = String(r[li] ?? '').trim() || null;
        if (fi >= 0) { const f = Number(String(r[fi] ?? '').replace(',', '.')); row.factor = String(r[fi] ?? '').trim() !== '' && Number.isFinite(f) ? f : null; }
        map.set(c, row);
      }
      const list = [...map.values()];
      if (!list.length) return msg(out, 'No se encontraron filas con código y descripción.', 'err');
      for (let i = 0; i < list.length; i += 1000) {
        msg(out, `Importando ${Math.min(i + 1000, list.length)} de ${list.length}…`);
        const { error } = await sb.from('productos').upsert(list.slice(i, i + 1000));
        if (error) return msg(out, error.message, 'err');
      }
      productCache.clear();
      msg(out, `Listo: ${list.length} productos importados/actualizados.`, 'ok');
      loadProducts();
    } catch (err) {
      msg(out, 'No se pudo leer el archivo: ' + err.message, 'err');
    }
  });

  // ---------- Admin: probar como farmacia ----------
  $('#btnPreview').addEventListener('click', async () => {
    const { data: sucs } = await sb.from('sucursales').select('cod_suc, sucursal').eq('activo', true).order('sucursal');
    $('#dlgTitle').textContent = 'Probar como farmacia';
    $('#dlgBody').innerHTML = `
      <p class="muted">Verás la app igual que una sucursal. Los tickets que crees quedan marcados como <span class="badge-prueba">PRUEBA</span>, aparecen en el panel y los puedes borrar.</p>
      <form id="formPreview">
        <label>Sucursal
          <select id="pvSuc" required><option value="">Selecciona…</option>
            ${(sucs || []).map((x) => `<option value="${esc(x.cod_suc)}">${esc(x.sucursal)} (${esc(x.cod_suc)})</option>`).join('')}
          </select>
        </label>
        <button class="btn primary" type="submit">Entrar como esta sucursal</button>
      </form>`;
    if (!$('#dlg').open) $('#dlg').showModal();
    $('#formPreview').addEventListener('submit', (e) => {
      e.preventDefault();
      const opt = $('#pvSuc').selectedOptions[0];
      state.preview = { cod_suc: opt.value, nombre: opt.textContent.replace(/ \([^)]*\)$/, '') };
      state.profile = { nombre: state.preview.nombre, codigo_sucursal: state.preview.cod_suc };
      $('#dlg').close();
      $('#previewName').textContent = `${state.preview.nombre} (${state.preview.cod_suc})`;
      $('#previewBar').classList.remove('hidden');
      $('#formTicket').reset(); $('#itemsList').innerHTML = ''; msg($('#ticketMsg'), ''); limpiarFotosNuevas();
      $('#viewFarmacia .tab[data-tab=tabNuevo]').click();
      enterFarmacia();
    });
  });
  $('#btnExitPreview').addEventListener('click', () => {
    state.preview = null; state.profile = null;
    $('#previewBar').classList.add('hidden');
    show('viewStaff');
    loadStaffTickets();
  });

  // ---------- Sucursales (maestro) ----------
  let sucData = [];
  async function loadSucursales() {
    const { data, error } = await sb.from('sucursales').select('*').order('cod_suc');
    const box = $('#sucList');
    if (error) return (box.innerHTML = `<p class="msg err">${esc(error.message)}</p>`);
    sucData = data;
    const fill = (id, key) => ($(id).innerHTML = [...new Set(data.map((x) => x[key]).filter(Boolean))].sort().map((v) => `<option value="${esc(v)}">`).join(''));
    fill('#dlZonas', 'zona'); fill('#dlRutas', 'ruta'); fill('#dlTrans', 'transporte');
    renderSucursales();
  }
  function renderSucursales() {
    const q = $('#sucSearch').value.trim().toLowerCase();
    const isAdmin = !!state.staff?.es_admin;
    const list = sucData.filter((x) => !q || [x.cod_suc, x.sucursal, x.zona, x.ruta, x.correo, x.transporte].some((v) => String(v || '').toLowerCase().includes(q)));
    $('#sucCount').textContent = `(${list.length})`;
    $('#sucList').innerHTML = list.length ? `<table class="compact"><thead><tr>
      <th>Código</th><th>Sucursal</th><th>Zona</th><th>Ruta</th><th>Teléfono</th><th>Correo</th><th>Transporte</th><th class="num">Corr.</th>${isAdmin ? '<th></th>' : ''}
      </tr></thead><tbody>${list.map((x) => `<tr class="${x.activo ? '' : 'inactiva'}">
        <td>${esc(x.cod_suc)}</td><td>${esc(x.sucursal)}${x.activo ? '' : ' <small class="muted">(inactiva)</small>'}</td>
        <td>${esc(x.zona || '')}</td><td>${esc(x.ruta || '')}</td><td>${esc(x.telefono || '')}</td>
        <td><small>${esc(x.correo || '')}</small></td><td>${esc(x.transporte || '')}</td><td class="num">${esc(x.correlativo_despacho ?? '')}</td>
        ${isAdmin ? `<td class="num" style="white-space:nowrap"><button class="btn ghost sm" data-edit="${esc(x.cod_suc)}">Editar</button>
          <button class="btn ghost sm danger" data-del="${esc(x.cod_suc)}">Borrar</button></td>` : ''}
      </tr>`).join('')}</tbody></table>` : '<p class="muted">Sin sucursales.</p>';
  }
  $('#sucSearch').addEventListener('input', renderSucursales);
  const sucFields = { cod_suc: '#suCod', sucursal: '#suNombre', correo: '#suCorreo', telefono: '#suTel', zona: '#suZona', ruta: '#suRuta', transporte: '#suTrans', correlativo_despacho: '#suCorr', direccion: '#suDir' };
  $('#sucList').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const x = sucData.find((r) => r.cod_suc === ed.dataset.edit);
      for (const [k, sel] of Object.entries(sucFields)) $(sel).value = x[k] ?? '';
      $('#suActivo').checked = x.activo;
      $('#formSuc').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del && confirm(`¿Borrar la sucursal ${del.dataset.del}? Los tickets ya creados no se borran. Si solo dejó de operar, mejor desmarca "Activa".`)) {
      const { error } = await sb.from('sucursales').delete().eq('cod_suc', del.dataset.del);
      if (error) return alert(error.message);
      loadSucursales();
    }
  });
  $('#btnSucClear').addEventListener('click', () => { $('#formSuc').reset(); msg($('#sucMsg'), ''); });
  function cleanSuc(row) {
    for (const k of Object.keys(row)) if (typeof row[k] === 'string') row[k] = row[k].trim() || null;
    if (row.correo) row.correo = row.correo.toLowerCase();
    if (row.telefono === '0') row.telefono = null;
    if (row.correlativo_despacho != null) { const n = parseInt(row.correlativo_despacho, 10); row.correlativo_despacho = Number.isFinite(n) ? n : null; }
    row.updated_at = new Date().toISOString();
    return row;
  }
  $('#formSuc').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {};
    for (const [k, sel] of Object.entries(sucFields)) row[k] = $(sel).value;
    row.activo = $('#suActivo').checked;
    const { error } = await sb.from('sucursales').upsert(cleanSuc(row));
    if (error) return msg($('#sucMsg'), /duplicate key.*correo/i.test(error.message) ? 'Ese correo ya está asignado a otra sucursal.' : error.message, 'err');
    msg($('#sucMsg'), `Sucursal ${row.cod_suc} guardada.`, 'ok');
    e.target.reset();
    loadSucursales(); loadZonas();
  });
  $('#btnImportSuc').addEventListener('click', async () => {
    const file = $('#fileSuc').files[0];
    const out = $('#importSucMsg');
    if (!file) return msg(out, 'Selecciona un archivo.', 'err');
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
      const head = (rows[0] || []).map(norm);
      const idx = (...names) => head.findIndex((h) => names.includes(h));
      const rutas = head.map((h, i) => (h === 'ruta' ? i : -1)).filter((i) => i >= 0);
      const zi = idx('zona') >= 0 ? idx('zona') : rutas[0];
      const ri = idx('zona') >= 0 ? rutas[0] : rutas[1];
      const col = { cod_suc: idx('codsuc', 'codsucursal', 'codigo', 'cod'), sucursal: idx('sucursal', 'nombre'), telefono: idx('telefono', 'tel'),
        correo: idx('correo', 'email'), direccion: idx('direccion'), transporte: idx('transdespacho', 'transporte'),
        correlativo_despacho: idx('corrdespacho', 'correlativo', 'correlativodespacho'), zona: zi ?? -1, ruta: ri ?? -1 };
      if (col.cod_suc < 0 || col.sucursal < 0) return msg(out, 'No encontré las columnas Cod_Suc y Sucursal.', 'err');
      const map = new Map();
      for (const r of rows.slice(1)) {
        const row = {};
        for (const [k, i] of Object.entries(col)) if (i >= 0) row[k] = String(r[i] ?? '');
        if (!row.cod_suc?.trim() || !row.sucursal?.trim()) continue;
        map.set(row.cod_suc.trim(), cleanSuc(row));
      }
      const list = [...map.values()];
      const { error } = await sb.from('sucursales').upsert(list);
      if (error) return msg(out, /duplicate key.*correo/i.test(error.message) ? 'Hay un correo repetido entre sucursales.' : error.message, 'err');
      msg(out, `Listo: ${list.length} sucursales importadas/actualizadas.`, 'ok');
      loadSucursales(); loadZonas();
    } catch (err) {
      msg(out, 'No se pudo leer el archivo: ' + err.message, 'err');
    }
  });

  // ---------- Admin: usuarios de atención ----------
  async function loadStaffUsers() {
    const { data, error } = await sb.from('staff').select('*').order('email');
    const box = $('#staffList');
    if (error) return (box.innerHTML = `<p class="msg err">${esc(error.message)}</p>`);
    box.innerHTML = `<table class="compact"><thead><tr><th>Correo</th><th>Nombre</th><th>Rol</th><th></th></tr></thead><tbody>
      ${data.map((s) => `<tr><td>${esc(s.email)}</td><td>${esc(s.nombre || '')}</td><td>${s.es_admin ? 'Admin' : 'Atención'}</td>
        <td class="num">${s.email === state.user.email.toLowerCase() ? '' : `<button class="btn ghost sm danger" data-del="${esc(s.email)}">Quitar</button>`}</td></tr>`).join('')}
      </tbody></table>`;
  }
  $('#formStaff').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = { email: $('#sEmail').value.trim().toLowerCase(), nombre: $('#sNombre').value.trim() || null, es_admin: $('#sAdmin').checked };
    const { error } = await sb.from('staff').upsert(row);
    if (error) return msg($('#staffMsg'), error.message, 'err');
    msg($('#staffMsg'), `${row.email} agregado.`, 'ok');
    e.target.reset();
    loadStaffUsers();
  });
  $('#staffList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || !confirm(`¿Quitar a ${b.dataset.del} de atención?`)) return;
    const { error } = await sb.from('staff').delete().eq('email', b.dataset.del);
    if (error) return alert(error.message);
    loadStaffUsers();
  });
})();
