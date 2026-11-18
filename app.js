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
  const badge = (e) => `<span class="badge st-${esc(e)}">${esc(ESTATUS[e] || e)}</span>`;
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

  function msg(el, text, type = '') {
    el.textContent = text || '';
    el.className = 'msg ' + type;
  }

  const state = { user: null, staff: null, profile: null, staffTickets: [] };

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
  };

  // ---------- Selects ----------
  for (const [k, v] of Object.entries(MOTIVOS)) {
    $('#tMotivo').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
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
    if (/rate limit|security purposes/i.test(m)) return 'Demasiados intentos. Espera un momento antes de pedir otro código.';
    if (/timeout|504|sending|smtp|confirmation email|magic link email/i.test(m) || error?.status === 504)
      return 'No se pudo enviar el correo con el código. Intenta de nuevo en unos minutos o avisa al administrador.';
    return m;
  }

  // ---------- Sesión ----------
  let routedFor; // undefined hasta el primer evento, para que también se muestre el login
  sb.auth.onAuthStateChange((_evt, session) => {
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
      show('viewStaff');
      return loadStaffTickets();
    }

    $('#userRole').textContent = 'Farmacia';
    const { data: prof } = await sb.from('farmacias').select('*').eq('user_id', state.user.id).maybeSingle();
    state.profile = prof;
    if (!prof) return show('viewProfile');
    enterFarmacia();
  }

  $('#formProfile').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      user_id: state.user.id,
      email: state.user.email.toLowerCase(),
      nombre: $('#profNombre').value.trim(),
      codigo_sucursal: $('#profSucursal').value.trim() || null,
    };
    const { data, error } = await sb.from('farmacias').insert(row).select().single();
    if (error) return msg($('#profileMsg'), error.message, 'err');
    state.profile = data;
    enterFarmacia();
  });

  // ---------- Farmacia: nuevo ticket ----------
  function enterFarmacia() {
    $('#farmName').textContent = '· ' + state.profile.nombre;
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
    $('.i-del', node).addEventListener('click', () => {
      node.remove();
      if (!$('#itemsList').children.length) addItem();
    });
    $('#itemsList').appendChild(node);
    cod.focus();
  }
  $('#btnAddItem').addEventListener('click', addItem);

  $('#formTicket').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = $$('#itemsList .item-row').map((r) => ({
      codigo: $('.i-codigo', r).value.trim(),
      descripcion: $('.i-desc', r).value.trim(),
      cantidad: Number($('.i-cant', r).value),
    })).filter((i) => i.codigo);
    if (!items.length) return msg($('#ticketMsg'), 'Agrega al menos un producto.', 'err');
    if (items.some((i) => !i.descripcion)) return msg($('#ticketMsg'), 'Hay productos sin descripción.', 'err');
    if (items.some((i) => !(i.cantidad > 0))) return msg($('#ticketMsg'), 'Las cantidades deben ser mayores a 0.', 'err');

    const btn = $('#btnSubmitTicket'); btn.disabled = true;
    msg($('#ticketMsg'), 'Enviando…');
    const { data, error } = await sb.rpc('crear_ticket', {
      p_motivo: $('#tMotivo').value,
      p_folio: $('#tFolio').value,
      p_fecha: $('#tFecha').value,
      p_observaciones: $('#tObs').value,
      p_items: items,
    });
    btn.disabled = false;
    if (error) return msg($('#ticketMsg'), error.message, 'err');
    $('#formTicket').reset();
    $('#itemsList').innerHTML = '';
    addItem();
    msg($('#ticketMsg'), `Ticket #${data} enviado. Puedes darle seguimiento en "Mis tickets".`, 'ok');
  });

  // ---------- Farmacia: mis tickets ----------
  async function loadMyTickets() {
    const box = $('#myTickets');
    box.innerHTML = '<p class="muted">Cargando…</p>';
    const { data, error } = await sb.from('tickets')
      .select('id, motivo, folio, fecha_recepcion, estatus, nota_atencion, created_at, updated_at, ticket_items(count)')
      .eq('user_id', state.user.id).order('created_at', { ascending: false }).limit(300);
    if (error) return (box.innerHTML = `<p class="msg err">${esc(error.message)}</p>`);
    if (!data.length) return (box.innerHTML = '<p class="muted">Aún no has creado tickets.</p>');
    box.innerHTML = `<table><thead><tr>
      <th>#</th><th>Creado</th><th>Motivo</th><th>Folio</th><th>Recibido</th><th>Productos</th><th>Estatus</th><th>Respuesta</th>
    </tr></thead><tbody>${data.map((t) => `
      <tr class="clickable" data-id="${t.id}">
        <td>${t.id}</td><td>${fmtDate(t.created_at)}</td><td>${esc(MOTIVOS[t.motivo])}</td>
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
      .select('id, email, farmacia, motivo, folio, fecha_recepcion, estatus, atendido_por, created_at, updated_at, ticket_items(count)')
      .order('created_at', { ascending: false }).limit(1000);
    const fe = $('#fEstatus').value, fm = $('#fMotivo').value;
    if (fe) q = q.eq('estatus', fe);
    if (fm) q = q.eq('motivo', fm);
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
      [t.folio, t.farmacia, t.email, String(t.id)].some((v) => String(v || '').toLowerCase().includes(s)));
  }

  function renderStaffTickets() {
    const box = $('#staffTickets');
    const data = filteredStaffTickets();
    if (!data.length) return (box.innerHTML = '<p class="muted">No hay tickets con esos filtros.</p>');
    box.innerHTML = `<table><thead><tr>
      <th>#</th><th>Creado</th><th>Farmacia</th><th>Motivo</th><th>Folio</th><th>Recibido</th><th>Prod.</th><th>Estatus</th><th>Atendió</th>
    </tr></thead><tbody>${data.map((t) => `
      <tr class="clickable" data-id="${t.id}">
        <td>${t.id}</td><td>${fmtDate(t.created_at)}</td>
        <td><div>${esc(t.farmacia)}</div><small class="muted">${esc(t.email)}</small></td>
        <td>${esc(MOTIVOS[t.motivo])}</td><td>${esc(t.folio)}</td><td>${fmtDate(t.fecha_recepcion)}</td>
        <td>${t.ticket_items?.[0]?.count ?? ''}</td><td>${badge(t.estatus)}</td>
        <td><small>${esc(t.atendido_por || '')}</small></td>
      </tr>`).join('')}</tbody></table>`;
  }
  $('#fEstatus').addEventListener('change', loadStaffTickets);
  $('#fMotivo').addEventListener('change', loadStaffTickets);
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
        .select('id, created_at, farmacia, email, motivo, folio, fecha_recepcion, estatus, nota_atencion, atendido_por, ticket_items(codigo, descripcion, laboratorio, factor, cantidad)')
        .in('id', ids.slice(i, i + 200)).order('id');
      if (error) return alert(error.message);
      for (const t of data) for (const it of t.ticket_items) {
        rows.push([t.id, t.created_at.slice(0, 10), t.farmacia, t.email, MOTIVOS[t.motivo], t.folio, t.fecha_recepcion,
          it.codigo, it.descripcion, it.laboratorio || '', it.factor ?? '', it.cantidad, ESTATUS[t.estatus], t.nota_atencion || '', t.atendido_por || '']);
      }
    }
    const head = ['Ticket', 'Creado', 'Farmacia', 'Correo', 'Motivo', 'Folio', 'Fecha recepción', 'Código', 'Descripción', 'Laboratorio', 'Factor', 'Cantidad', 'Estatus', 'Nota atención', 'Atendió'];
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
      sb.from('tickets').select('*, ticket_items(codigo, descripcion, laboratorio, factor, cantidad)').eq('id', id).single(),
      sb.from('ticket_historial').select('*').eq('ticket_id', id).order('created_at'),
    ]);
    if (error) return ($('#dlgBody').innerHTML = `<p class="msg err">${esc(error.message)}</p>`);

    $('#dlgBody').innerHTML = `
      <div class="detail-grid">
        <div><small class="muted">Farmacia</small><div>${esc(t.farmacia)}</div><small class="muted">${esc(t.email)}</small></div>
        <div><small class="muted">Motivo</small><div>${esc(MOTIVOS[t.motivo])}</div></div>
        <div><small class="muted">Folio</small><div>${esc(t.folio)}</div></div>
        <div><small class="muted">Fecha de recepción</small><div>${fmtDate(t.fecha_recepcion)}</div></div>
        <div><small class="muted">Creado</small><div>${fmtDateTime(t.created_at)}</div></div>
        <div><small class="muted">Estatus</small><div>${badge(t.estatus)}</div></div>
      </div>
      ${t.observaciones ? `<p><small class="muted">Observaciones</small><br>${esc(t.observaciones)}</p>` : ''}
      <table class="compact"><thead><tr><th>Código</th><th>Descripción</th><th>Laboratorio</th><th class="num">Factor</th><th class="num">Cantidad</th></tr></thead>
      <tbody>${t.ticket_items.map((i) => `<tr><td>${esc(i.codigo)}</td><td>${esc(i.descripcion)}</td><td>${esc(i.laboratorio || '')}</td><td class="num">${esc(i.factor ?? '')}</td><td class="num">${esc(i.cantidad)}</td></tr>`).join('')}</tbody></table>
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
      <h3>Historial</h3>
      <ul class="timeline">${(hist || []).map((h) => `
        <li><span class="when">${fmtDateTime(h.created_at)}</span>
          ${h.estatus_anterior && h.estatus_anterior !== h.estatus_nuevo ? `${badge(h.estatus_anterior)} → ` : ''}${badge(h.estatus_nuevo)}
          ${h.nota ? `<div>${esc(h.nota)}</div>` : ''}
          <small class="muted">${esc(h.usuario || '')}</small></li>`).join('')}</ul>`;

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
