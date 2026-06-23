// dubia_app.js — Main Application Controller

const App = {
  state: {
    section: 'dashboard',
    colonyId: null,
    charts: {},
    gutInterval: null,
    gutSession: null,
    allAlerts: [],
    _confirmCb: null,
  },

  // ── INIT ──────────────────────────────────────────────────────────────
  init() {
    this._nav();
    this._modals();
    this._fab();
    this._alerts();
    this.go('dashboard');
    this._gutCheck();
  },

  // ── NAVIGATION ────────────────────────────────────────────────────────
  _nav() {
    document.querySelectorAll('[data-section]').forEach(el => {
      el.addEventListener('click', () => this.go(el.dataset.section));
    });
  },

  go(sec) {
    document.querySelectorAll('[data-section]').forEach(el =>
      el.classList.toggle('active', el.dataset.section === sec));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    const el = document.getElementById('sec-' + sec);
    if (el) el.classList.add('active');
    this.state.section = sec;
    const map = {
      dashboard:  () => this.renderDashboard(),
      colonies:   () => this.renderColonies(),
      clima:      () => window.ClimaApp && window.ClimaApp.render(),
      harvest:    () => this._harvestSetup(),
      gut:        () => this._gutSetup(),
      finances:   () => this._finSetup(),
      clients:    () => this._clientsSetup(),
      settings:   () => this._settingsSetup(),
    };
    (map[sec] || (() => {}))();
  },

  // ── DASHBOARD ─────────────────────────────────────────────────────────
  renderDashboard() {
    const encs = DB.getEnclosures();
    let totalW = 0, alerts = 0, allAlerts = [];

    encs.forEach(e => {
      const m = DB.getMeasurements(e.id);
      if (m.length) totalW += m[0].weight;
    });

    // KPIs
    this.$('stat-weight').textContent = this.fmtW(totalW);
    this.$('stat-weight').style.color = 'var(--green)';
    this.$('stat-count').textContent = encs.length;
    this.$('stat-eco').textContent = '€ ' + (totalW * 0.09).toFixed(0);
    this.$('hdr-weight').textContent = this.fmtW(totalW);
    this.$('hdr-count').textContent = encs.length;
    this.$('hdr-eco').textContent = '€ ' + (totalW * 0.09).toFixed(0);
    const avgW = encs.length ? totalW / encs.length : 0;
    const avgEl = this.$('stat-avg-weight');
    if (avgEl) avgEl.textContent = this.fmtW(avgW);

    // Grid
    const grid = this.$('colonyGrid');
    const empty = this.$('emptyState');
    if (!encs.length) { grid.innerHTML = ''; grid.appendChild(empty); empty.style.display='flex'; return; }
    empty.style.display = 'none';
    grid.innerHTML = '';

    encs.forEach(enc => {
      const ms = DB.getMeasurements(enc.id);
      const cohorts = DB.getCohorts(enc.id);
      const status = BIO.enclosureStatus(enc, cohorts, ms);
      status.alerts.forEach(a => {
        allAlerts.push({...a, encName: enc.name, encId: enc.id});
        if (a.severity !== 'info') alerts++;
      });
      grid.appendChild(this._card(enc, ms, cohorts, status));
    });

    this.state.allAlerts = allAlerts;
    this._badgeCount(alerts);

    // Summary row
    const aEl = this.$('stat-alerts');
    if (aEl) {
      aEl.textContent = alerts > 0 ? `${alerts} alert attivi` : '✓ Tutto OK';
      aEl.style.color = alerts > 0 ? 'var(--orange)' : 'var(--green)';
    }
  },

  // ── COLONY CARD ───────────────────────────────────────────────────────
  _card(enc, ms, cohorts, statusInfo) {
    const card = document.createElement('div');
    const s = statusInfo.status;
    card.className = `colony-card s-${s}`;
    card.dataset.id = enc.id;

    const w = ms.length ? ms[0].weight : 0;
    const wp = ms.length > 1 ? ms[1].weight : null;
    const chgPct = wp ? ((w-wp)/wp*100) : null;
    const trendHtml = chgPct !== null
      ? `<span class="trend-tag ${chgPct>=0?'trend-up':'trend-down'}">${chgPct>=0?'↑':'↓'} ${Math.abs(chgPct).toFixed(1)}%</span>`
      : '';

    const calInfo = BIO.calibrate(enc, ms);
    const capInfo = BIO.capacity(enc, w/1000);
    const health  = BIO.healthIndex(ms, enc);

    const adultCohort = cohorts.find(c=>c.status==='adult_breeders');
    const nymphCohort = cohorts.find(c=>c.status==='nymph'&&c.instarStage<7);
    const moultDays   = nymphCohort ? BIO.daysToNextMoult(nymphCohort.instarStage, nymphCohort.accumulatedDD||0, enc.avgTemperature||30) : null;

    const daysSince = ms.length ? Math.round((Date.now()-new Date(ms[0].date))/86400000) : null;
    const batchAge  = Math.round((Date.now()-new Date(enc.batchId||enc.createdAt))/86400000);

    // Semaphore icon
    const semIcon = s==='red' ? '🔴' : s==='orange' ? '🟡' : s==='yellow' ? '🟡' : '🟢';

    // Alert chips (max 2)
    const chipColors = {critical:'r', warning:'o', info:'b'};
    const chips = statusInfo.alerts.slice(0,2).map(a => {
      const msg = a.message.length > 32 ? a.message.slice(0,30)+'…' : a.message;
      return `<span class="chip ${chipColors[a.severity]||'b'}">${msg}</span>`;
    }).join('');

    // Predicted weight (30 days)
    const pred30 = BIO.project(w, 30, enc.avgTemperature||30, calInfo.factor);

    card.innerHTML = `
      <div class="card-top">
        <div>
          <div class="card-name">${semIcon} ${this.esc(enc.name)}</div>
          <div class="card-batch">Batch ${enc.batchId||'–'} · ${batchAge}gg</div>
        </div>
        <div class="card-btns">
          <button class="icon-btn accent" data-act="weigh" title="Aggiungi pesata">⊕</button>
          <button class="icon-btn"        data-act="detail" title="Dettaglio">···</button>
        </div>
      </div>

      <div class="weight-line">
        <span class="weight-val">${w>=1000?(w/1000).toFixed(2):Math.round(w)}</span>
        <span class="weight-unit">${w>=1000?'kg':'g'}</span>
        ${trendHtml}
      </div>

      <div class="cap-bar-wrap">
        <div class="cap-bar-label"><span>Capacità box</span><span>${capInfo.pct.toFixed(0)}%</span></div>
        <div class="cap-bar"><div class="cap-fill ${capInfo.status==='critical'?'cr':capInfo.status==='warning'?'w':capInfo.status==='caution'?'c':''}" style="width:${Math.min(100,capInfo.pct)}%"></div></div>
      </div>

      <div class="card-meta">
        ${adultCohort ? `<div class="meta-item"><span class="meta-v">${adultCohort.maleCount}♂ ${adultCohort.femaleCount}♀</span><span class="meta-l">Adulti</span></div>` : ''}
        ${moultDays!==null ? `<div class="meta-item"><span class="meta-v text-b" style="font-size:.78rem;">${moultDays===0?'⚡ Muta!':moultDays+'gg'}</span><span class="meta-l">Muta L${nymphCohort.instarStage}→${nymphCohort.instarStage+1}</span></div>` : ''}
        ${health ? `<div class="meta-item"><span class="meta-v text-${health.status==='critical'?'r':health.status==='warning'?'o':'g'}">H:${health.value}%</span><span class="meta-l">Salute</span></div>` : ''}
        ${daysSince!==null ? `<div class="meta-item"><span class="meta-v ${daysSince>15?'text-o':'text-muted'}">${daysSince}gg</span><span class="meta-l">Ultima pesata</span></div>` : ''}
        <div class="meta-item"><span class="meta-v text-b">${this.fmtW(pred30)}</span><span class="meta-l">Previsto 30gg</span></div>
      </div>

      ${chips ? `<div class="chip-row">${chips}</div>` : ''}
      <div style="margin-top:6px;">
        <span class="learn-badge ${calInfo.phase==='adaptive'?'ada':'cal'}">${calInfo.phase==='adaptive'?'🧠 Adattivo':'📡 Calibrazione'} ${calInfo.confidence.toFixed(0)}%</span>
      </div>

      <!-- Mini sparkline -->
      <div style="margin-top:10px;height:48px;position:relative;">
        <canvas class="mini-chart" data-id="${enc.id}" style="width:100%;height:48px;"></canvas>
      </div>
    `;

    // Events
    card.querySelector('[data-act="weigh"]').addEventListener('click', e => { e.stopPropagation(); this._openWeigh(enc.id); });
    card.querySelector('[data-act="detail"]').addEventListener('click', e => { e.stopPropagation(); this._openDetail(enc.id); });
    card.addEventListener('click', () => this._openDetail(enc.id));

    // Draw sparkline after append
    setTimeout(() => this._sparkline(card.querySelector('.mini-chart'), ms, enc, capInfo.status), 30);

    return card;
  },

  _sparkline(canvas, ms, enc, capStatus) {
    if (!canvas || ms.length < 2) return;
    const data = ms.slice(0,12).reverse();
    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();

    const labels = data.map(m => new Date(m.date).toLocaleDateString('it-IT',{day:'2-digit',month:'short'}));
    const actual  = data.map(m => m.weight);
    const first   = actual[0], firstDate = new Date(data[0].date);
    const theory  = data.map(m => BIO.project(first, (new Date(m.date)-firstDate)/86400000, enc.avgTemperature||30, 1.0));
    const adaptive= data.map(m => BIO.project(first, (new Date(m.date)-firstDate)/86400000, enc.avgTemperature||30, enc.calibrationFactor||1.0));

    const lineColor = capStatus==='critical'?'#ff453a':capStatus==='warning'?'#ff9f0a':capStatus==='caution'?'#ffd60a':'#30d158';

    new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label:'Reale', data:actual, borderColor:lineColor, borderWidth:2, pointRadius:2.5, pointBackgroundColor:lineColor, fill:false, tension:.35 },
          { label:'Adattivo', data:adaptive, borderColor:'rgba(10,132,255,.55)', borderDash:[4,2], borderWidth:1.2, pointRadius:0, fill:false, tension:.35 },
          { label:'Teorico', data:theory, borderColor:'rgba(255,255,255,.18)', borderDash:[2,3], borderWidth:1, pointRadius:0, fill:false, tension:.35 },
        ]
      },
      options: {
        responsive:true, maintainAspectRatio:false, animation:false,
        plugins:{ legend:{display:false}, tooltip:{enabled:false} },
        scales:{ x:{display:false}, y:{display:false} }
      }
    });
  },

  // ── DETAIL PANEL ─────────────────────────────────────────────────────
  _openDetail(encId) {
    const enc = DB.getEnclosure(encId);
    if (!enc) return;
    this.state.colonyId = encId;

    const ms       = DB.getMeasurements(encId);
    const cohorts  = DB.getCohorts(encId);
    const status   = BIO.enclosureStatus(enc, cohorts, ms);
    const calInfo  = BIO.calibrate(enc, ms);
    const fcr      = BIO.fcr(ms);
    const health   = BIO.healthIndex(ms, enc);

    if (calInfo.sampleSize > 0) {
      DB.updateEnclosure(encId, { calibrationFactor:calInfo.factor, calibrationPhase:calInfo.phase });
      enc.calibrationFactor = calInfo.factor;
    }

    const curW  = ms.length ? ms[0].weight : 0;
    const pred7  = BIO.project(curW, 7,  enc.avgTemperature||30, calInfo.factor);
    const pred30 = BIO.project(curW, 30, enc.avgTemperature||30, calInfo.factor);
    const adults = cohorts.find(c=>c.status==='adult_breeders');
    const sr     = adults ? BIO.sexRatio(adults.maleCount, adults.femaleCount) : null;
    const popM   = adults && adults.femaleCount ? BIO.populationMetrics(adults.femaleCount) : null;
    const cap    = BIO.capacity(enc, curW/1000);

    this.$('panelTitle').textContent = enc.name;
    this.$('panelSub').textContent   = `Batch ${enc.batchId||'–'} · ${Math.round((Date.now()-new Date(enc.batchId||enc.createdAt))/86400000)} giorni`;

    this.$('panelBody').innerHTML = `
      <!-- Quick Actions -->
      <div style="display:flex;gap:var(--gap-sm);margin-bottom:var(--gap-md);flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" id="pWeigh">⊕ Pesata</button>
        <button class="btn btn-secondary btn-sm" id="pCohort">+ Lotto</button>
        <button class="btn btn-orange btn-sm" id="pEdit">Modifica</button>
        <button class="btn btn-red btn-sm" id="pDelete">Elimina</button>
      </div>

      <!-- Semaphore Status -->
      <div class="panel-sec">
        <div class="panel-sec-title">Stato Semaforo</div>
        <div style="display:flex;align-items:center;gap:var(--gap-md);padding:var(--gap-md);background:var(--bg);border-radius:var(--r-md);border:1px solid var(--${status.status==='red'?'red':status.status==='orange'?'orange':status.status==='yellow'?'yellow':'green'}-border);">
          <div style="font-size:2rem;">${status.status==='red'?'🔴':status.status==='orange'?'🟡':status.status==='yellow'?'🟡':'🟢'}</div>
          <div>
            <div style="font-weight:700;color:var(--${status.status==='red'?'red':status.status==='orange'?'orange':status.status==='yellow'?'yellow':'green'});">${status.status==='red'?'ALLARME CRITICO':status.status==='orange'?'Azione Richiesta':status.status==='yellow'?'Attenzione':'Tutto OK'}</div>
            <div style="font-size:.8rem;color:var(--text-2);margin-top:2px;">${status.alerts.length > 0 ? status.alerts[0].message : 'Nessun problema rilevato'}</div>
          </div>
        </div>
        ${status.alerts.length > 1 ? status.alerts.slice(1).map(a => `
          <div style="margin-top:6px;padding:10px var(--gap-md);border-radius:var(--r-sm);background:var(--${a.severity==='critical'?'red':a.severity==='warning'?'orange':'yellow'}-bg);border:1px solid var(--${a.severity==='critical'?'red':a.severity==='warning'?'orange':'yellow'}-border);font-size:.8rem;">
            <span style="font-weight:600;color:var(--${a.severity==='critical'?'red':a.severity==='warning'?'orange':'yellow'});">${a.message}</span>
            ${a.action?`<div style="color:var(--text-2);margin-top:2px;">${a.action}</div>`:''}
          </div>`).join('') : ''}
      </div>

      <!-- Weight Cards -->
      <div class="panel-sec">
        <div class="panel-sec-title">Peso & Previsioni</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:var(--gap-sm);">
          <div class="card" style="padding:var(--gap-sm);text-align:center;margin:0;">
            <div style="font-size:1.3rem;font-weight:900;font-family:var(--font-mono);">${this.fmtW(curW)}</div>
            <div class="fs-xs text-muted mt-sm">Attuale</div>
          </div>
          <div class="card" style="padding:var(--gap-sm);text-align:center;margin:0;">
            <div style="font-size:1.3rem;font-weight:900;font-family:var(--font-mono);color:var(--blue);">${this.fmtW(pred7)}</div>
            <div class="fs-xs text-muted mt-sm">+7 giorni</div>
          </div>
          <div class="card" style="padding:var(--gap-sm);text-align:center;margin:0;">
            <div style="font-size:1.3rem;font-weight:900;font-family:var(--font-mono);color:var(--teal);">${this.fmtW(pred30)}</div>
            <div class="fs-xs text-muted mt-sm">+30 giorni</div>
          </div>
        </div>
      </div>

      <!-- Main Chart -->
      ${ms.length >= 2 ? `
      <div class="panel-sec">
        <div class="panel-sec-title">Andamento Peso — Reale vs Curva Teorica</div>
        <div style="position:relative;height:200px;">
          <canvas id="pMainChart"></canvas>
        </div>
        <div style="display:flex;gap:var(--gap-md);margin-top:var(--gap-sm);flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:4px;font-size:.72rem;color:var(--text-2);">
            <div style="width:16px;height:2px;background:var(--green);border-radius:1px;"></div> Pesate reali
          </div>
          <div style="display:flex;align-items:center;gap:4px;font-size:.72rem;color:var(--text-2);">
            <div style="width:16px;height:2px;background:rgba(10,132,255,.7);border-radius:1px;border-top:2px dashed rgba(10,132,255,.7);"></div> Curva adattiva
          </div>
          <div style="display:flex;align-items:center;gap:4px;font-size:.72rem;color:var(--text-2);">
            <div style="width:16px;height:2px;background:rgba(255,255,255,.2);border-radius:1px;border-top:2px dashed rgba(255,255,255,.2);"></div> Curva Auburn (teorica)
          </div>
        </div>
      </div>` : ''}

      <!-- Adaptive Learning -->
      <div class="panel-sec">
        <div class="panel-sec-title">Apprendimento Adattivo</div>
        <div class="learn-panel">
          <div class="learn-row"><span>Fase:</span><span class="learn-badge ${calInfo.phase==='adaptive'?'ada':'cal'}">${calInfo.phase==='adaptive'?'🧠 Adattivo':'📡 Calibrazione'}</span></div>
          <div class="learn-row"><span>Fattore correttivo:</span><span class="text-mono fw-7">${calInfo.factor.toFixed(3)}×</span></div>
          <div class="learn-row"><span>Confidenza:</span><span class="text-g fw-7">${calInfo.confidence.toFixed(0)}%</span></div>
          <div class="conf-bar"><div class="conf-fill" style="width:${calInfo.confidence}%"></div></div>
          <div style="font-size:.72rem;color:var(--text-3);margin-top:var(--gap-sm);">
            ${calInfo.phase==='calibration'
              ? `Servono ${Math.max(0,8-ms.length)} pesate per entrare in fase Adattiva`
              : `Le tue Dubia crescono ${calInfo.factor>1?((calInfo.factor-1)*100).toFixed(0)+'% più veloce':((1-calInfo.factor)*100).toFixed(0)+'% più lento'} dello standard Auburn`}
          </div>
        </div>
      </div>

      <!-- Sex Ratio -->
      ${sr ? `
      <div class="panel-sec">
        <div class="panel-sec-title">Rapporto Sessuale</div>
        <div style="display:flex;align-items:center;gap:var(--gap-md);margin-bottom:var(--gap-sm);">
          <span style="font-size:.82rem;color:var(--blue);font-weight:700;">♂ ${adults.maleCount}</span>
          <div style="flex:1;">
            <div class="sex-bar-container">
              <div class="sex-bar-m" style="width:${(adults.maleCount/(adults.maleCount+adults.femaleCount)*100).toFixed(0)}%"></div>
              <div class="sex-bar-f" style="width:${(adults.femaleCount/(adults.maleCount+adults.femaleCount)*100).toFixed(0)}%"></div>
            </div>
          </div>
          <span style="font-size:.82rem;color:var(--purple);font-weight:700;">♀ ${adults.femaleCount}</span>
        </div>
        <div style="padding:10px;background:var(--${sr.severity}-bg);border:1px solid var(--${sr.severity}-border);border-radius:var(--r-sm);font-size:.82rem;">
          <span style="color:var(--${sr.severity});font-weight:600;">${sr.action}</span>
          ${sr.excessMales > 0 ? `<button class="btn btn-sm btn-secondary mt-sm w-full" id="pHarvestMales">Preleva ${sr.excessMales} maschi → pasto (1:4)</button>` : ''}
        </div>
      </div>` : ''}

      ${popM ? `
      <div class="panel-sec">
        <div class="panel-sec-title">Dinamiche di Popolazione</div>
        <div class="g2">
          <div class="card" style="margin:0;padding:var(--gap-sm);text-align:center;">
            <div class="fw-9 text-mono text-g">${popM.doublingDays}gg</div>
            <div class="fs-xs text-muted mt-sm">Tempo raddoppio</div>
          </div>
          <div class="card" style="margin:0;padding:var(--gap-sm);text-align:center;">
            <div class="fw-9 text-mono">${popM.R0.toFixed(1)}</div>
            <div class="fs-xs text-muted mt-sm">Tasso netto R₀</div>
          </div>
        </div>
      </div>` : ''}

      <!-- Carrying Capacity -->
      <div class="panel-sec">
        <div class="panel-sec-title">Capacità di Carico</div>
        <div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:6px;">
          <span>Utilizzo</span>
          <span class="text-${cap.status==='critical'?'r':cap.status==='warning'?'o':cap.status==='caution'?'y':'g'} fw-7">${cap.pct.toFixed(0)}%</span>
        </div>
        <div class="cap-bar" style="height:8px;">
          <div class="cap-fill ${cap.status==='critical'?'cr':cap.status==='warning'?'w':cap.status==='caution'?'c':''}" style="width:${Math.min(100,cap.pct)}%;height:100%;"></div>
        </div>
        <div style="font-size:.72rem;color:var(--text-3);margin-top:6px;">Superficie utile: ${(cap.surface*10000).toFixed(0)} cm² · Max: ${(cap.maxLoad*1000).toFixed(0)} g</div>
      </div>

      <!-- Cohorts -->
      <div class="panel-sec">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--gap-sm);">
          <div class="panel-sec-title" style="margin:0;">Lotti (Cohorts)</div>
          <button class="btn btn-sm btn-secondary" id="pAddCohort">+ Lotto</button>
        </div>
        ${cohorts.length === 0 ? '<div class="fs-sm text-muted">Nessun lotto. Aggiungi adulti o ninfe.</div>' : ''}
        ${cohorts.map(c => this._cohortRow(c, enc)).join('')}
      </div>

      <!-- FCR & Metrics -->
      ${fcr ? `
      <div class="panel-sec">
        <div class="panel-sec-title">Metriche di Efficienza</div>
        <div class="g2">
          <div class="card" style="margin:0;padding:var(--gap-sm);text-align:center;">
            <div class="fw-9 text-mono text-${fcr<2?'g':fcr<2.7?'y':'r'}">${fcr.toFixed(2)}</div>
            <div class="fs-xs text-muted mt-sm">FCR (g cibo/g crescita)</div>
          </div>
          <div class="card" style="margin:0;padding:var(--gap-sm);text-align:center;">
            <div class="fw-9 text-mono">${enc.avgTemperature||30}°C</div>
            <div class="fs-xs text-muted mt-sm">Temperatura</div>
          </div>
        </div>
      </div>` : ''}

      <!-- Food Checklist -->
      <div class="panel-sec">
        <div class="panel-sec-title">Checklist Alimentazione</div>
        <div id="cl-${enc.id}">${this._checklist(enc.id)}</div>
      </div>

      <!-- History Table -->
      ${ms.length ? `
      <div class="panel-sec">
        <div class="panel-sec-title">Ultime Pesate</div>
        <div class="table-scroll">
          <table class="dt">
            <thead><tr><th>Data</th><th>Peso</th><th>Cibo</th><th>Note</th><th></th></tr></thead>
            <tbody>
              ${ms.slice(0,12).map(m=>`
                <tr>
                  <td>${new Date(m.date).toLocaleDateString('it-IT',{day:'2-digit',month:'short',year:'2-digit'})}</td>
                  <td class="text-mono fw-6">${this.fmtW(m.weight)}</td>
                  <td class="text-muted">${m.foodAdded?m.foodAdded+'g':'–'}</td>
                  <td class="text-muted fs-xs">${m.notes||''}</td>
                  <td><button class="btn btn-sm btn-red" style="padding:2px 6px;" onclick="App._delMeasure('${m.id}','${enc.id}')">✕</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
    `;

    // Open
    this.$('detailPanel').classList.add('open');
    this.$('panelOverlay').style.display = 'block';

    // Wire buttons
    this.$('pWeigh').onclick   = () => this._openWeigh(enc.id);
    this.$('pDelete').onclick  = () => this._confirmDelete(enc.id);
    this.$('pCohort').onclick  = () => this._openCohortModal(enc.id);
    this.$('pAddCohort') && (this.$('pAddCohort').onclick = () => this._openCohortModal(enc.id));
    this.$('pEdit').onclick    = () => this._openEditModal(enc);
    const phm = this.$('pHarvestMales');
    if (phm) phm.onclick = () => this._harvestMales(enc.id, adults, sr.excessMales);

    // Main chart
    if (ms.length >= 2) setTimeout(() => this._mainChart(ms, enc), 60);
  },

  _mainChart(ms, enc) {
    const canvas = this.$('pMainChart');
    if (!canvas) return;
    const ex = Chart.getChart(canvas);
    if (ex) ex.destroy();

    const data = ms.slice(0,20).reverse();
    const labels = data.map(m => new Date(m.date).toLocaleDateString('it-IT',{day:'2-digit',month:'short'}));
    const actual  = data.map(m => m.weight);
    const first   = actual[0], t0 = new Date(data[0].date);
    const theory  = data.map(m => BIO.project(first, (new Date(m.date)-t0)/86400000, enc.avgTemperature||30, 1.0));
    const adaptive= data.map(m => BIO.project(first, (new Date(m.date)-t0)/86400000, enc.avgTemperature||30, enc.calibrationFactor||1.0));

    new Chart(canvas, {
      type:'line',
      data:{
        labels,
        datasets:[
          { label:'Reale', data:actual, borderColor:'#30d158', backgroundColor:'rgba(48,209,88,.08)', fill:true, tension:.3, pointRadius:4, pointHoverRadius:6, borderWidth:2.5 },
          { label:'Adattivo', data:adaptive, borderColor:'rgba(10,132,255,.7)', borderDash:[5,3], fill:false, tension:.3, pointRadius:0, borderWidth:1.5 },
          { label:'Auburn (teorico)', data:theory, borderColor:'rgba(255,255,255,.2)', borderDash:[3,4], fill:false, tension:.3, pointRadius:0, borderWidth:1 },
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{
          legend:{display:false},
          tooltip:{
            backgroundColor:'rgba(24,24,28,.95)', borderColor:'rgba(255,255,255,.1)', borderWidth:1,
            titleFont:{family:'Inter',size:11}, bodyFont:{family:'JetBrains Mono',size:12},
            callbacks:{ label: ctx => ` ${ctx.dataset.label}: ${this.fmtW(ctx.raw)}` }
          }
        },
        scales:{
          x:{ ticks:{color:'rgba(242,242,242,.4)',font:{family:'Inter',size:10}}, grid:{color:'rgba(255,255,255,.04)'} },
          y:{ ticks:{color:'rgba(242,242,242,.4)',font:{family:'JetBrains Mono',size:10},callback:v=>v>=1000?(v/1000).toFixed(2)+'kg':v+'g'}, grid:{color:'rgba(255,255,255,.04)'} }
        }
      }
    });
  },

  _cohortRow(c, enc) {
    const labels = ['L1','L2','L3','L4','L5','L6','L7'];
    const statusLbl = {nymph:'Ninfe',adult_breeders:'Riproduttori',gut_loading:'Gut-Loading',clean_up_crew:'CUC'};
    let extra = '';
    if (c.status==='nymph' && c.instarStage<7) {
      const d = BIO.daysToNextMoult(c.instarStage, c.accumulatedDD||0, enc.avgTemperature||30);
      const steps = labels.map((_,i)=>`<div class="instar-step ${i<c.instarStage-1?'done':i===c.instarStage-1?'curr':''}"></div>`).join('');
      extra = `<div class="instar-track">${steps}</div><div class="instar-labels">${labels.map(l=>`<span>${l}</span>`).join('')}</div>
        <div style="font-size:.72rem;color:var(--blue);margin-top:3px;">${d===null?'Adulto':d===0?'⚡ Muta imminente!':d===Infinity?'Temp. troppo bassa':`Muta tra ${d}gg`}</div>`;
    }
    return `
      <div class="card" style="padding:10px;margin-bottom:6px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div class="fw-6 fs-sm">${statusLbl[c.status]||c.status} ${c.status==='nymph'?`· ${labels[c.instarStage-1]||'?'}`:''}</div>
            <div class="fs-xs text-muted">${c.quantity} individui${c.status==='adult_breeders'?` · ${c.maleCount}♂ ${c.femaleCount}♀`:''}</div>
          </div>
          <button class="btn btn-sm btn-red" style="padding:2px 6px;font-size:.7rem;" onclick="App._delCohort('${c.id}','${enc.id}')">✕</button>
        </div>
        ${extra}
      </div>`;
  },

  _checklist(encId) {
    const key = 'cl_'+encId;
    let items;
    try { items = JSON.parse(localStorage.getItem(key)||'null'); } catch{items=null;}
    if (!items) {
      items = [
        {id:'dry',  name:'Mangime secco',             max:3, done:null},
        {id:'wet',  name:'Verdure / frutta umida',    max:2, done:null},
        {id:'water',name:'Idratazione (gel/spugna)',  max:2, done:null},
        {id:'ca',   name:'Supplemento calcio',        max:7, done:null},
        {id:'clean',name:'Controllo pulizia teca',    max:7, done:null},
      ];
      localStorage.setItem(key, JSON.stringify(items));
    }
    const today = new Date().toISOString().split('T')[0];
    return items.map(it => {
      const isDone = it.done === today;
      const ds = it.done ? Math.round((Date.now()-new Date(it.done))/86400000) : null;
      const ov = ds !== null && ds > it.max;
      
      let statusText = '-';
      if (isDone) {
        statusText = '✓ Fatto oggi';
      } else if (ds !== null) {
        statusText = `${ds}gg fa${ov ? ' ⚠️' : ''}`;
      }

      return `
        <div class="cl-item ${isDone ? 'done' : ''}" onclick="App._toggleCl('${encId}','${it.id}')">
          <div class="cl-check ${isDone ? 'on' : ''}">${isDone ? '✓' : ''}</div>
          <div style="flex:1;">
            <div class="cl-text fs-sm">${it.name}</div>
            <div class="fs-xs ${ov ? 'cl-overdue' : 'text-muted'}">${statusText}</div>
          </div>
          <span class="fs-xs text-muted">ogni ${it.max}gg</span>
        </div>`;
    }).join('');
  },

  _toggleCl(encId, itemId) {
    const key = 'cl_'+encId;
    const items = JSON.parse(localStorage.getItem(key)||'[]');
    const it = items.find(i=>i.id===itemId);
    if (!it) return;
    const today = new Date().toISOString().split('T')[0];
    it.done = it.done===today ? null : today;
    localStorage.setItem(key, JSON.stringify(items));
    const el = document.getElementById('cl-'+encId);
    if (el) el.innerHTML = this._checklist(encId);
  },

  closePanel() {
    this.$('detailPanel').classList.remove('open');
    this.$('panelOverlay').style.display = 'none';
    this.state.colonyId = null;
  },

  // ── WEIGH MODAL ──────────────────────────────────────────────────────
  _openWeigh(encId=null) {
    const encs = DB.getEnclosures();
    const sel  = this.$('wColony');
    sel.innerHTML = encs.map(e=>`<option value="${e.id}"${e.id===encId?' selected':''}>${this.esc(e.name)}</option>`).join('');
    this.$('wWeight').value = '';
    this.$('wFood').value   = '';
    this.$('wNotes').value  = '';
    this.$('wDate').value   = new Date().toISOString().split('T')[0];
    this.$('wCalAlert').style.display = 'none';

    this.$('wWeight').oninput = () => this._weighDiscrepancy(sel.value);
    sel.onchange = () => this._weighDiscrepancy(sel.value);

    this.$('modalWeigh').classList.add('open');
    setTimeout(()=>this.$('wWeight').focus(), 200);
  },

  _weighDiscrepancy(encId) {
    const raw = parseFloat(this.$('wWeight').value);
    const unit = this.$('wUnit').value;
    if (!raw||!encId) { this.$('wCalAlert').style.display='none'; return; }
    const g   = unit==='kg' ? raw*1000 : raw;
    const enc = DB.getEnclosure(encId);
    if (!enc) return;
    const ms  = DB.getMeasurements(encId);
    if (!ms.length) return;
    const days = (Date.now()-new Date(ms[0].date))/86400000;
    const pred = BIO.project(ms[0].weight, days, enc.avgTemperature||30, enc.calibrationFactor||1.0);
    const pct  = (g-pred)/pred*100;
    if (Math.abs(pct) > 12) {
      const dir = g>pred ? 'superiore' : 'inferiore';
      this.$('wCalText').textContent = `Peso inserito (${this.fmtW(g)}) è ${Math.abs(pct).toFixed(0)}% ${dir} alla previsione adattiva (${this.fmtW(pred)}). Vuoi ricalibrare il fattore di crescita?`;
      this.$('wCalAlert').style.display = 'block';
    } else {
      this.$('wCalAlert').style.display = 'none';
    }
  },

  _saveWeigh() {
    const encId = this.$('wColony').value;
    const raw   = parseFloat(this.$('wWeight').value);
    const unit  = this.$('wUnit').value;
    const food  = parseFloat(this.$('wFood').value)||0;
    const notes = this.$('wNotes').value;
    const date  = this.$('wDate').value;
    const recal = this.$('wRecal').checked;

    if (!encId||isNaN(raw)||raw<=0) { this.toast('Inserisci un peso valido','red'); return; }
    const g = unit==='kg' ? raw*1000 : raw;

    DB.createMeasurement({ enclosureId:encId, weight:g, foodAdded:food, notes, date:new Date(date).toISOString() })
    .then(m => {
      if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('measurements', m);

      if (recal && this.$('wCalAlert').style.display!=='none') {
        const enc = DB.getEnclosure(encId);
        const ms  = DB.getMeasurements(encId);
        const ci  = BIO.calibrate(enc, ms);
        if (ci.sampleSize>0) DB.updateEnclosure(encId, {calibrationFactor:ci.factor, calibrationPhase:ci.phase})
          .then(e => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('enclosures', e); });
      }

      this.$('modalWeigh').classList.remove('open');
      this.renderDashboard();
      if (this.state.colonyId===encId) this._openDetail(encId);
      this.toast(`Pesata ${this.fmtW(g)} salvata ✓`, 'green');

      // SOS check
      const enc2 = DB.getEnclosure(encId);
      const ms2  = DB.getMeasurements(encId);
      BIO.analyzeTrend(ms2).alerts.forEach(a => {
        if (a.severity==='critical') this.toast(`🚨 SOS ${enc2.name}: ${a.message}`, 'red', 8000);
      });
    });
  },

  // ── NEW COLONY MODAL ─────────────────────────────────────────────────
  _openNewColony() {
    const n = DB.getEnclosures().length;
    this.$('ncName').value    = `Box ${String.fromCharCode(65+Math.floor(n/9))}-0${(n%9)+1}`;
    this.$('ncBatch').value   = new Date().toISOString().split('T')[0];
    this.$('ncVol').value     = '';
    this.$('ncFlats').value   = '8';
    this.$('ncTemp').value    = DB.getSettings().defaultTemp||'30';
    this.$('ncWeight').value  = '';
    this.$('ncNotes').value   = '';
    this.$('modalNewColony').classList.add('open');
    setTimeout(()=>this.$('ncName').focus(), 200);
  },

  _saveNewColony() {
    const name  = this.$('ncName').value.trim();
    const batch = this.$('ncBatch').value;
    const vol   = parseFloat(this.$('ncVol').value)||50;
    const flats = parseInt(this.$('ncFlats').value)||8;
    const temp  = parseFloat(this.$('ncTemp').value)||30;
    const initW = parseFloat(this.$('ncWeight').value)||0;
    const notes = this.$('ncNotes').value;

    if (!name) { this.toast('Inserisci il nome del box','red'); return; }
    DB.createEnclosure({name, batchId:batch, volumeLiters:vol, eggFlatsCount:flats, avgTemperature:temp, notes})
      .then(enc => {
        if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('enclosures', enc);
        if (initW>0) DB.createMeasurement({enclosureId:enc.id, weight:initW, date:new Date().toISOString(), notes:'Peso iniziale'})
          .then(m => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('measurements', m); });
        this.$('modalNewColony').classList.remove('open');
        this.renderDashboard();
        this.toast(`"${name}" creata! 🪲`, 'green');
      });
  },

  // ── EDIT COLONY MODAL ────────────────────────────────────────────────
  _openEditModal(enc) {
    this.$('ecName').value  = enc.name;
    this.$('ecBatch').value = enc.batchId||'';
    this.$('ecVol').value   = enc.volumeLiters||50;
    this.$('ecFlats').value = enc.eggFlatsCount||8;
    this.$('ecTemp').value  = enc.avgTemperature||30;
    this.$('ecNotes').value = enc.notes||'';
    this.$('ecId').value    = enc.id;
    this.$('modalEdit').classList.add('open');
  },

  _saveEdit() {
    const id = this.$('ecId').value;
    DB.updateEnclosure(id, {
      name:          this.$('ecName').value.trim(),
      batchId:       this.$('ecBatch').value,
      volumeLiters:  parseFloat(this.$('ecVol').value)||50,
      eggFlatsCount: parseInt(this.$('ecFlats').value)||8,
      avgTemperature:parseFloat(this.$('ecTemp').value)||30,
      notes:         this.$('ecNotes').value,
    }).then(e => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('enclosures', e); });
    this.$('modalEdit').classList.remove('open');
    this.renderDashboard();
    if (this.state.colonyId===id) this._openDetail(id);
    this.toast('Colonia aggiornata ✓', 'green');
  },

  // ── COHORT MODAL ─────────────────────────────────────────────────────
  _openCohortModal(encId) {
    this.$('cEncId').value = encId;
    this.$('cType').value  = 'nymph';
    this.$('cStage').value = '1';
    this.$('cQty').value   = '';
    this.$('cMales').value = '';
    this.$('cFemales').value='';
    this._cohortTypeToggle();
    this.$('modalCohort').classList.add('open');
  },

  _cohortTypeToggle() {
    const isAdult = this.$('cType').value === 'adult_breeders';
    this.$('cStageRow').style.display  = isAdult ? 'none' : 'block';
    this.$('cSexRow').style.display    = isAdult ? 'block' : 'none';
  },

  _saveCohort() {
    const encId = this.$('cEncId').value;
    const type  = this.$('cType').value;
    const qty   = parseInt(this.$('cQty').value)||0;
    if (!qty) { this.toast('Inserisci una quantità','red'); return; }

    const data = type==='adult_breeders' ? 
      { enclosureId:encId, status:'adult_breeders', quantity:qty, maleCount:parseInt(this.$('cMales').value)||0, femaleCount:parseInt(this.$('cFemales').value)||0 } :
      { enclosureId:encId, status:type, instarStage:parseInt(this.$('cStage').value)||1, quantity:qty, birthDate:new Date().toISOString().split('T')[0] };

    DB.createCohort(data).then(c => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('cohorts', c); });
    this.$('modalCohort').classList.remove('open');
    if (this.state.colonyId===encId) this._openDetail(encId);
    this.toast('Lotto aggiunto ✓', 'green');
  },

  // ── DELETE ───────────────────────────────────────────────────────────
  _confirmDelete(encId) {
    const enc = DB.getEnclosure(encId);
    if (!enc) return;
    const ms      = DB.getMeasurements(encId);
    const cohorts = DB.getCohorts(encId);
    SafetyGate.confirm({
      title:    '🗑️ Elimina Colonia',
      message:  `Stai rimuovendo "${enc.name}" e tutti i suoi dati. Questa azione è irreversibile.`,
      impact:   `${ms.length} pesate · ${cohorts.length} lotti`,
      word:     enc.name.split(' ')[0],
      onConfirm: () => {
        DB.deleteEnclosure(encId).then(() => {
          if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('enclosures', {...enc, deleted:true});
          this.closePanel(); this.renderDashboard();
          this.toast('Colonia eliminata', 'orange');
        });
      },
    });
  },

  _delMeasure(mid, encId) {
    DB.deleteMeasurement(mid).then(() => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('measurements', {id:mid, deleted:true}); });
    this._openDetail(encId); this.renderDashboard();
    this.toast('Pesata eliminata','orange');
  },

  _delCohort(cid, encId) {
    DB.updateCohort(cid,{deleted:true}).then(c => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('cohorts', c); });
    this._openDetail(encId);
  },

  _harvestMales(encId, adults, excess) {
    DB.createEvent({enclosureId:encId, type:'sorting', notes:`Prelievo ${excess} maschi eccedenti`});
    DB.updateCohort(adults.id,{maleCount:adults.maleCount-excess}).then(c => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('cohorts', c); });
    this._openDetail(encId);
    this.toast(`${excess} maschi rimossi → sex ratio bilanciata ✓`, 'green');
  },

  // ── MODALS SETUP ─────────────────────────────────────────────────────
  _modals() {
    // New colony (colonies section)
    const nc2 = this.$('btnNewColColonies');
    if (nc2) nc2.onclick = () => this._openNewColony();

    // Weigh
    this.$('btnWeighCancel').onclick = ()=>this.$('modalWeigh').classList.remove('open');
    this.$('btnWeighSave').onclick   = ()=>this._saveWeigh();

    // New colony
    ['btnNewCol','btnNewColEmpty'].forEach(id => { const el=this.$(id); if(el) el.onclick=()=>this._openNewColony(); });
    this.$('btnNewColCancel').onclick = ()=>this.$('modalNewColony').classList.remove('open');
    this.$('btnNewColSave').onclick   = ()=>this._saveNewColony();

    // Edit
    this.$('btnEditCancel').onclick = ()=>this.$('modalEdit').classList.remove('open');
    this.$('btnEditSave').onclick   = ()=>this._saveEdit();

    // Cohort
    this.$('cType').onchange = ()=>this._cohortTypeToggle();
    this.$('btnCohortCancel').onclick = ()=>this.$('modalCohort').classList.remove('open');
    this.$('btnCohortSave').onclick   = ()=>this._saveCohort();

    // Confirm
    this.$('btnCfNo').onclick  = ()=>{ this.$('modalConfirm').classList.remove('open'); this.state._confirmCb=null; };
    this.$('btnCfYes').onclick = ()=>{ this.$('modalConfirm').classList.remove('open'); if(this.state._confirmCb) this.state._confirmCb(); this.state._confirmCb=null; };

    // Close on overlay click
    document.querySelectorAll('.modal-overlay').forEach(o => {
      o.addEventListener('click', e=>{ if(e.target===o) o.classList.remove('open'); });
    });

    // Panel overlay
    this.$('panelOverlay').onclick = ()=>this.closePanel();
    this.$('panelClose').onclick   = ()=>this.closePanel();
  },

  // ── FAB ───────────────────────────────────────────────────────────────
  _fab() {
    this.$('fab').onclick = ()=>this._openWeigh(this.state.colonyId||null);
  },

  // ── ALERTS ────────────────────────────────────────────────────────────
  _alerts() {
    this.$('alertsBtn').onclick = ()=>this._toggleAlerts();
    document.addEventListener('click', e=>{
      if (!this.$('alertsWrap').contains(e.target)) this.$('alertsPanel').style.display='none';
    });
  },

  _toggleAlerts() {
    const p = this.$('alertsPanel');
    if (p.style.display==='block') { p.style.display='none'; return; }
    this._renderAlerts(); p.style.display='block';
  },

  _renderAlerts() {
    const c = this.$('alertsPanelContent');
    const al = this.state.allAlerts;
    if (!al.length) { c.innerHTML='<div class="alert-item"><span class="text-g">✓ Nessun alert attivo</span></div>'; return; }
    c.innerHTML = al.slice(0,12).map(a => {
      const col = a.severity==='critical'?'red':a.severity==='warning'?'orange':'yellow';
      return `<div class="alert-item" onclick="App._openDetail('${a.encId}');App._toggleAlerts();">
        <div class="alert-dot" style="background:var(--${col})"></div>
        <div><div class="fw-6 fs-sm">${a.encName}</div><div class="text-2" style="font-size:.76rem;">${a.message}</div></div>
      </div>`;
    }).join('');
  },

  _badgeCount(n) {
    const b = this.$('alertBadge');
    if (n>0) { b.textContent=n; b.style.display='flex'; } else b.style.display='none';
    const nb = this.$('navBadge');
    if (nb) { nb.textContent=n; nb.style.display=n>0?'inline':'none'; }
  },

  // ── COLONIES SECTION ─────────────────────────────────────────────────
  renderColonies() {
    const grid = this.$('coloniesGrid');
    const encs = DB.getEnclosures();
    if (!encs.length) { grid.innerHTML='<div class="empty" style="grid-column:1/-1"><div class="empty-icon">📦</div><div class="empty-text">Nessuna colonia. Aggiungi la prima.</div></div>'; return; }
    grid.innerHTML='';
    encs.forEach(e=>{
      const ms=DB.getMeasurements(e.id), co=DB.getCohorts(e.id), st=BIO.enclosureStatus(e,co,ms);
      grid.appendChild(this._card(e,ms,co,st));
    });
  },

  // ── HARVEST ───────────────────────────────────────────────────────────
  _harvestSetup() {
    this.$('btnCalcHarvest').onclick = ()=>this._calcHarvest();
  },

  _calcHarvest() {
    const targetG = parseFloat(this.$('hTargetG').value)||500;
    const stage   = this.$('hStage').value;
    const days    = parseInt(this.$('hDays').value)||21;

    const encs    = DB.getEnclosures();
    const cohorts = DB.getCohorts();
    const plan    = BIO.optimizeHarvest(encs, id=>DB.getMeasurements(id), cohorts, targetG, stage, days);

    const resEl = this.$('hResults');
    const recEl = this.$('hRecs');

    if (!plan.length) {
      recEl.innerHTML=`<div class="card"><div style="text-align:center;padding:var(--gap-md);color:var(--text-3);">
        <div style="font-size:2rem;margin-bottom:var(--gap-sm);">🔍</div>
        <div>Nessuna colonia disponibile per questo raccolto.</div>
        <div class="fs-xs mt-sm">Aumenta il tempo o scegli uno stadio diverso.</div>
      </div></div>`;
    } else {
      let rem = targetG;
      recEl.innerHTML = plan.map(p => {
        const take = Math.min(rem, p.harvestable); rem -= take;
        const pct = (take/targetG*100).toFixed(0);
        return `<div class="harvest-rec ${p.ok?'':'warn'}">
          <div style="font-size:1.4rem;">${p.ok?'✅':'⚠️'}</div>
          <div style="flex:1;">
            <div class="fw-7">${this.esc(p.enc.name)}</div>
            <div class="fs-sm text-2">Disponibili <strong>${this.fmtW(p.harvestable)}</strong> · Preleva <strong class="text-g">${this.fmtW(take)}</strong> (${pct}% del target)</div>
            <div class="fs-xs text-muted mt-sm">Dopo prelievo: ${this.fmtW(p.proj - take)}</div>
          </div>
        </div>`;
      }).join('');
      if (rem > 10) recEl.innerHTML += `<div class="card" style="border-color:var(--yellow-border);background:var(--yellow-bg);margin-top:var(--gap-sm);">
        <span style="color:var(--yellow);font-size:.85rem;font-weight:600;">⚠️ Mancano ancora ${this.fmtW(rem)} al target. Aspetta qualche giorno in più.</span></div>`;
    }

    resEl.style.display='block';
  },

  // ── GUT-LOADING ───────────────────────────────────────────────────────
  _gutSetup() {
    const sel = this.$('gutColony');
    sel.innerHTML = '<option value="">Seleziona colonia...</option>' +
      DB.getEnclosures().map(e=>`<option value="${e.id}">${this.esc(e.name)}</option>`).join('');
    this.$('btnGutStart').onclick = ()=>this._gutStart();
    this.$('btnGutStop').onclick  = ()=>this._gutStop();
    this._gutCheck();
    this._gutHistory();
  },

  _gutCheck() {
    const active = DB.getGutSessions().find(s=>s.phase!=='complete');
    this.state.gutSession = active||null;
    const aEl = this.$('gutActive'), nEl = this.$('gutNone');
    if (!aEl||!nEl) return;
    if (active) {
      aEl.style.display='block'; nEl.style.display='none';
      this._gutTick();
      if (this.state.gutInterval) clearInterval(this.state.gutInterval);
      this.state.gutInterval = setInterval(()=>this._gutTick(), 60000);
    } else {
      aEl.style.display='none'; nEl.style.display='block';
    }
  },

  _gutTick() {
    const s = this.state.gutSession;
    if (!s) return;
    const p = BIO.gutPhase(s.startTime);
    const enc = DB.getEnclosure(s.enclosureId);
    const h = Math.floor(p.remaining), m = Math.floor((p.remaining-h)*60);

    this.$('gutTime').textContent  = p.phase==='complete'?'✓':`${h}h ${m}m`;
    this.$('gutLabel').textContent = p.label;
    this.$('gutSessLabel').textContent = `${enc?enc.name:'Colonia'} · ${p.label}`;

    const C = 276.46;
    const offset = C*(1-Math.min(1,p.progress));
    const prog = this.$('gutRingProg');
    if (prog) {
      prog.style.strokeDashoffset = offset;
      prog.style.stroke = p.phase==='complete'?'var(--green)':p.phase==='loading'?'var(--blue)':'var(--yellow)';
    }

    const caEl = this.$('gutCaRatio');
    const caBar= this.$('gutCaBar');
    if (caEl) caEl.textContent = `${(p.caRatio||.26).toFixed(2)} : 1`;
    if (caBar) caBar.style.width = `${p.caProgress||0}%`;

    // Phase badges
    const b1=this.$('gutBadge1'), b2=this.$('gutBadge2');
    if (b1&&b2) {
      b1.style.opacity = p.phase==='fasting'?'1':'.4';
      b2.style.opacity = p.phase==='loading'||p.phase==='complete'?'1':'.4';
    }

    if (p.phase!==s.phase) { DB.updateGutSession(s.id,{phase:p.phase}); s.phase=p.phase; }
    this._gutRadar(p.caRatio||.26);
  },

  _gutRadar(caRatio) {
    const canvas = this.$('gutRadar');
    if (!canvas) return;
    const ex = Chart.getChart(canvas);
    if (ex) ex.destroy();
    const caPct = Math.min(100,(caRatio/2.0)*100);
    new Chart(canvas, {
      type:'radar',
      data:{
        labels:['Proteine','Lipidi','Calcio','Chitina ↓','Digeribilità'],
        datasets:[
          { label:'Pre', data:[58,35,13,60,65], borderColor:'rgba(255,159,10,.7)', backgroundColor:'rgba(255,159,10,.08)', pointBackgroundColor:'var(--orange)', borderWidth:1.5 },
          { label:'Post', data:[72,30,caPct,45,85], borderColor:'rgba(10,132,255,.7)', backgroundColor:'rgba(10,132,255,.08)', pointBackgroundColor:'var(--blue)', borderWidth:1.5 },
        ]
      },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{labels:{color:'rgba(242,242,242,.6)',font:{family:'Inter',size:11}}} },
        scales:{ r:{ min:0,max:100, ticks:{color:'rgba(242,242,242,.35)',backdropColor:'transparent',font:{size:9}}, grid:{color:'rgba(255,255,255,.07)'}, pointLabels:{color:'rgba(242,242,242,.7)',font:{family:'Inter',size:11}} } }
      }
    });
  },

  _gutStart() {
    const encId = this.$('gutColony').value;
    const tw    = parseFloat(this.$('gutWeight').value)||0;
    if (!encId) { this.toast('Seleziona una colonia','red'); return; }
    DB.createGutSession({enclosureId:encId, targetWeight:tw}).then(s => {
      if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('gut_sessions', s);
      this.state.gutSession = s;
      this._gutCheck();
      this.toast('Gut-Loading avviato! ⏳ Fase 1: Digiuno 24h','blue');
    });
  },

  _gutStop() {
    if (!this.state.gutSession) return;
    const upd = {phase:'complete', completedAt:new Date().toISOString()};
    DB.updateGutSession(this.state.gutSession.id, upd).then(s => {
      if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('gut_sessions', s);
    });
    clearInterval(this.state.gutInterval);
    this.state.gutSession = null;
    this._gutCheck();
    this._gutHistory();
    this.toast('Sessione Gut-Loading completata ✓','green');
  },

  _gutHistory() {
    const el = this.$('gutHist');
    if (!el) return;
    const done = DB.getGutSessions().filter(s=>s.phase==='complete').slice(0,5);
    if (!done.length) { el.innerHTML='<div class="fs-sm text-muted">Nessuna sessione completata.</div>'; return; }
    el.innerHTML = done.map(s=>{
      const enc=DB.getEnclosure(s.enclosureId);
      const h = Math.round((new Date(s.completedAt||s.startTime)-new Date(s.startTime))/3600000);
      return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:.82rem;">
        <div><div class="fw-6">${enc?this.esc(enc.name):'–'}</div><div class="text-muted">${new Date(s.startTime).toLocaleDateString('it-IT')} · ${h}h</div></div>
        <span class="chip g">Completato</span>
      </div>`;
    }).join('');
  },

  // ── FINANCES ─────────────────────────────────────────────────────────
  _finSetup() {
    this.$('btnCalcROI').onclick = ()=>this._calcROI();
    this._renderROIChart();
  },

  _calcROI() {
    const cBox  = parseFloat(this.$('fCostBox').value)||5;
    const cHeat = parseFloat(this.$('fCostHeat').value)||15;
    const cFeed = parseFloat(this.$('fCostFeed').value)||20;
    const pA    = parseFloat(this.$('fPriceA').value)||0.08;
    const pN    = parseFloat(this.$('fPriceN').value)||0.12;
    const costs = cBox+cHeat+cFeed;
    const encs  = DB.getEnclosures();
    let totalW=0;
    encs.forEach(e=>{ const m=DB.getMeasurements(e.id); if(m.length) totalW+=m[0].weight; });
    const rev   = (totalW*0.12)*pA; // MSY 12% monthly harvest at adult price
    const profit= rev-costs;

    this.$('fRevenue').textContent = `€ ${rev.toFixed(2)}`;
    this.$('fCosts').textContent   = `€ ${costs.toFixed(2)}`;
    this.$('fProfit').textContent  = `€ ${Math.abs(profit).toFixed(2)}`;
    this.$('fProfit').style.color  = profit>=0?'var(--green)':'var(--red)';
    this.$('fROIval').textContent  = (profit>=0?'+':'–')+`€ ${Math.abs(profit).toFixed(2)}`;
    this.$('fROIval').style.color  = profit>=0?'var(--green)':'var(--red)';
    this.$('fBreak').textContent   = profit>0?`Ammortamento: ~${Math.ceil(costs/profit)} mesi`:'Operazione in perdita';
    this.$('fResults').style.display='block';
    this._renderROIChart();
  },

  _renderROIChart() {
    const canvas = this.$('roiChart');
    if (!canvas) return;
    const ex = Chart.getChart(canvas);
    if (ex) ex.destroy();

    const encs = DB.getEnclosures();
    // Collect monthly totals (last 6 months)
    const months = Array.from({length:6},(_,i)=>{
      const d = new Date(); d.setMonth(d.getMonth()-5+i);
      return d.toLocaleDateString('it-IT',{month:'short',year:'2-digit'});
    });

    // Simulate weight progression
    let totalW=0;
    encs.forEach(e=>{ const m=DB.getMeasurements(e.id); if(m.length) totalW+=m[0].weight; });
    const cost = 40; // fixed monthly

    const weights = months.map((_,i) => {
      const base = totalW * Math.pow(0.94, 5-i);
      return Math.round(base);
    });
    const revenues = weights.map(w => parseFloat(((w*0.12)*0.08).toFixed(2)));
    const costs    = months.map(()=>cost);

    new Chart(canvas, {
      type:'bar',
      data:{
        labels:months,
        datasets:[
          { label:'Ricavi stimati (€)', data:revenues, backgroundColor:'rgba(48,209,88,.7)', borderColor:'rgba(48,209,88,1)', borderWidth:1, borderRadius:6 },
          { label:'Costi fissi (€)', data:costs, backgroundColor:'rgba(255,69,58,.5)', borderColor:'rgba(255,69,58,.8)', borderWidth:1, borderRadius:6 },
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{labels:{color:'rgba(242,242,242,.6)',font:{family:'Inter',size:11}}} },
        scales:{
          x:{ ticks:{color:'rgba(242,242,242,.4)',font:{family:'Inter',size:10}}, grid:{display:false} },
          y:{ ticks:{color:'rgba(242,242,242,.4)',font:{family:'JetBrains Mono',size:10},callback:v=>'€'+v}, grid:{color:'rgba(255,255,255,.05)'} }
        }
      }
    });
  },

  // ── CLIENTS ───────────────────────────────────────────────────────────
  _clientsSetup() {
    this.$('btnNewClient').onclick = ()=>this._openNewClient();
    this._renderClients();
    this._renderTransactions();
  },

  _openNewClient() {
    ['clName','clEmail','clPhone','clCity','clAnimal','clNotes'].forEach(id=>{ const el=this.$(id); if(el) el.value=''; });
    this.$('modalClient').classList.add('open');
  },

  _saveClient() {
    const name = this.$('clName').value.trim();
    if (!name) { this.toast('Inserisci nome cliente','red'); return; }
    DB.createClient({ name, email:this.$('clEmail').value, phone:this.$('clPhone').value, city:this.$('clCity').value, animal:this.$('clAnimal').value, notes:this.$('clNotes').value })
      .then(c => {
        if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('clients', c);
        this.$('modalClient').classList.remove('open');
        this._renderClients();
        this._renderTransactions();
        this.toast(`Cliente "${name}" aggiunto ✓`, 'green');
      });
  },

  _renderClients() {
    const el = this.$('clientsList');
    if (!el) return;
    const clients = DB.getClients();
    if (!clients.length) { el.innerHTML='<div class="fs-sm text-muted">Nessun cliente. Aggiungine uno.</div>'; return; }
    el.innerHTML = clients.map(c=>`
      <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--gap-sm) 0;border-bottom:1px solid var(--border);">
        <div>
          <div class="fw-6 fs-sm">${this.esc(c.name)}</div>
          <div class="fs-xs text-muted">${c.city||''}${c.animal?` · ${c.animal}`:''}</div>
        </div>
        <div style="display:flex;gap:var(--gap-xs);">
          <button class="btn btn-sm btn-secondary" onclick="App._openSale('${c.id}')">+ Cessione</button>
          <button class="btn btn-sm btn-red" onclick="App._deleteClient('${c.id}')">✕</button>
        </div>
      </div>`).join('');
  },

  _openSale(clientId) {
    const c = DB.getClients().find(cl=>cl.id===clientId);
    if (!c) return;
    this.$('saleClientId').value = clientId;
    this.$('saleClientName').textContent = c.name;
    this.$('saleQty').value=''; this.$('salePrice').value=''; this.$('saleType').value='adulti'; this.$('saleNotes').value='';
    this.$('modalSale').classList.add('open');
  },

  _saveSale() {
    const cid   = this.$('saleClientId').value;
    const qty   = parseFloat(this.$('saleQty').value)||0;
    const price = parseFloat(this.$('salePrice').value)||0;
    const type  = this.$('saleType').value;
    const notes = this.$('saleNotes').value;
    if (!qty||!price) { this.toast('Inserisci quantità e prezzo','red'); return; }
    DB.createTransaction({clientId:cid, qty, price, total:qty*price, type, notes, date:new Date().toISOString()})
      .then(t => {
        if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('transactions', t);
        this.$('modalSale').classList.remove('open');
        this._renderTransactions();
        this.toast(`Cessione €${(qty*price).toFixed(2)} registrata ✓`,'green');
      });
  },

  _deleteClient(id) {
    DB.deleteClient(id).then(() => {
      if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('clients', {id, deleted:true});
      this._renderClients();
      this._renderTransactions();
      this.toast('Cliente rimosso','orange');
    });
  },

  _renderTransactions() {
    const el = this.$('salesList');
    if (!el) return;
    const txs = DB.getTransactions().slice(0,20);
    const clients = DB.getClients();
    if (!txs.length) { el.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:var(--gap-md);">Nessuna cessione registrata.</td></tr>'; return; }
    el.innerHTML = txs.map(t=>{
      const c = clients.find(cl=>cl.id===t.clientId);
      return `<tr>
        <td>${new Date(t.date).toLocaleDateString('it-IT',{day:'2-digit',month:'short'})}</td>
        <td class="fw-6">${c?this.esc(c.name):'–'}</td>
        <td>${t.type||'–'}</td>
        <td class="text-mono">${t.qty}g</td>
        <td class="text-g fw-7">€ ${(t.total||0).toFixed(2)}</td>
      </tr>`;
    }).join('');

    // Totals
    const total = txs.reduce((s,t)=>s+(t.total||0),0);
    const totalG = txs.reduce((s,t)=>s+(t.qty||0),0);
    const el2=this.$('salesTotals');
    if (el2) el2.innerHTML=`<td colspan="3"></td><td class="fw-7 text-mono">${totalG}g</td><td class="text-g fw-9">€ ${total.toFixed(2)}</td>`;
  },

  // ── SETTINGS ─────────────────────────────────────────────────────────
  _settingsSetup() {
    const s = DB.getSettings();
    this.$('sTemp').value = s.defaultTemp||30;
    this.$('sCurrency').value = s.currency||'EUR';

    this.$('btnSaveSettings').onclick = ()=>{
      DB.updateSettings({ defaultTemp:parseFloat(this.$('sTemp').value)||30, currency:this.$('sCurrency').value })
        .then(upd => { if (typeof CloudAnchor !== 'undefined') CloudAnchor.push('settings', upd); });
      this.toast('Impostazioni salvate ✓','green');
    };

    this.$('btnExport').onclick = ()=>{
      DB.exportJSON().then(json => {
        const blob = new Blob([json],{type:'application/json'});
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href=url; a.download=`biotwin_backup_${new Date().toISOString().split('T')[0]}.json`;
        a.click(); URL.revokeObjectURL(url);
        this.toast('Backup esportato ✓','green');
      });
    };

    this.$('btnImport').onchange = e=>{
      const f=e.target.files[0]; if(!f) return;
      SafetyGate.confirm({
        title:   '⬆️ Importa Backup',
        message: `Importando "${f.name}" i dati attuali verranno sovrascritti.`,
        impact:  'Tutti i dati esistenti saranno sostituiti',
        onConfirm: () => {
          const r=new FileReader();
          r.onload=ev=>{
            DB.importJSON(ev.target.result)
              .then(() => { this.toast('Backup importato ✓','green'); this.renderDashboard(); })
              .catch(() => this.toast('File JSON non valido','red'));
          };
          r.readAsText(f);
        }
      });
    };

    this.$('btnReset').onclick = ()=>{
      SafetyGate.confirm({
        title:   '🗑️ Azzera Tutti i Dati',
        message: 'Questa azione eliminerà PERMANENTEMENTE tutte le colonie, pesate, lotti e clienti.',
        impact:  `${DB.getEnclosures().length} colonie · ${DB.getMeasurements().length} pesate`,
        word:    'ELIMINA',
        onConfirm: () => {
          DB.resetAll().then(() => { this.toast('Database azzerato','orange'); location.reload(); });
        }
      });
    };
  },

  // ── TOAST ─────────────────────────────────────────────────────────────
  toast(msg, type='green', dur=3800) {
    const c = this.$('toasts');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<div class="toast-msg">${msg}</div>`;
    c.appendChild(t);
    setTimeout(()=>{ t.style.animation='toast-in .3s ease reverse'; setTimeout(()=>t.remove(),300); }, dur);
  },

  // ── UTILS ─────────────────────────────────────────────────────────────
  $(id) { return document.getElementById(id); },
  esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },
  fmtW(g) {
    if (g===null||g===undefined) return '-- g';
    return g>=1000 ? `${(g/1000).toFixed(2)} kg` : `${Math.round(g)} g`;
  },
};

document.addEventListener('DOMContentLoaded', ()=>App.init());
