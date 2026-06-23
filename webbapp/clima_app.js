// clima_app.js — Modulo di gestione per la sezione Clima (Sensori ESP8266)
// ─────────────────────────────────────────────────────────────────────────────
// Interagisce con il backend Vercel (simulato o reale) per mostrare i dati
// ambientali.

const ClimaApp = {
  state: {
    sensors: [], // Registry data dal backend
    readings: [], // Raw data dal backend
    filterGroup: 'all',
    chartInstance: null,
    // Per ora, simuliamo l'URL del backend:
    // backendUrl: 'https://TUO-PROGETTO.vercel.app/api'
    backendUrl: null, 
  },

  // Per il test UI, generiamo dati mock se non abbiamo un backend configurato.
  async fetchMockData() {
    this.state.sensors = [
      {
        device_id: 'ESP-MOCK-01',
        display_name: 'Sonda Zona Calda',
        terrario_id: '1',
        terrario_name: 'Terrario Adulti',
        temp_min: 28.0, temp_max: 32.0,
        hum_min: 50.0, hum_max: 70.0,
        active: true,
        group_tag: 'zona-calda',
        last_seen: new Date().toISOString()
      },
      {
        device_id: 'ESP-MOCK-02',
        display_name: 'Sonda Zona Fredda',
        terrario_id: '2',
        terrario_name: 'Terrario Neanidi',
        temp_min: 26.0, temp_max: 30.0,
        hum_min: 60.0, hum_max: 80.0,
        active: true,
        group_tag: 'zona-fredda',
        last_seen: new Date(Date.now() - 3600000).toISOString() // 1h fa
      }
    ];

    // Genera 100 letture mock per sensore (ultime 24 ore)
    this.state.readings = [];
    const now = Date.now();
    for (let s of this.state.sensors) {
      for (let i = 0; i < 100; i++) {
        // Un punto ogni 15 minuti circa
        const timestamp = new Date(now - (100 - i) * 15 * 60000);
        // Temp base ~ 29, variazione sinusoidale + rumore
        const temp_c = 29 + Math.sin(i / 10) * 2 + (Math.random() - 0.5);
        // Hum base ~ 60, variazione
        const humidity_pct = 60 + Math.cos(i / 10) * 10 + (Math.random() - 0.5) * 2;
        
        this.state.readings.push({
          device_id: s.device_id,
          timestamp_received: timestamp.toISOString(),
          temp_c: temp_c,
          humidity_pct: humidity_pct
        });
      }
    }
  },

  async loadData() {
    if (this.state.backendUrl) {
      try {
        const [regRes, readRes] = await Promise.all([
          fetch(`${this.state.backendUrl}/registry`),
          fetch(`${this.state.backendUrl}/readings?limit=2000`)
        ]);
        if (regRes.ok) this.state.sensors = await regRes.json();
        if (readRes.ok) this.state.readings = await readRes.json();
      } catch (err) {
        console.error("Errore fetch dati reali, uso mock", err);
        await this.fetchMockData();
      }
    } else {
      // Uso mock per sviluppo UI
      await this.fetchMockData();
    }
  },

  async render() {
    const grid = document.getElementById('climaGrid');
    grid.innerHTML = '<div style="color:var(--text-3);padding:20px;">Caricamento...</div>';
    
    await this.loadData();
    
    this.renderFilters();
    this.renderCards();
    this.renderChartSetup();
    this.setupListeners();
  },

  renderFilters() {
    const container = document.getElementById('climaGroupsFilter');
    if (!container) return;
    
    const groups = new Set();
    this.state.sensors.forEach(s => {
      if (s.group_tag) groups.add(s.group_tag);
    });

    let html = '';
    groups.forEach(g => {
      html += `<button class="btn btn-secondary ${this.state.filterGroup === g ? 'active' : ''}" data-filter="${g}">${g}</button>`;
    });
    container.innerHTML = html;
  },

  getLatestReading(deviceId) {
    const sensorReadings = this.state.readings.filter(r => r.device_id === deviceId);
    if (!sensorReadings.length) return null;
    // Assume ordinate, prendi l'ultima
    return sensorReadings[sensorReadings.length - 1];
  },

  renderCards() {
    const grid = document.getElementById('climaGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const sensorsToRender = this.state.sensors.filter(s => 
      this.state.filterGroup === 'all' || s.group_tag === this.state.filterGroup
    );

    if (!sensorsToRender.length) {
      grid.innerHTML = '<div style="color:var(--text-3); grid-column: 1/-1;">Nessun sensore in questo gruppo.</div>';
      return;
    }

    sensorsToRender.forEach(sensor => {
      const reading = this.getLatestReading(sensor.device_id);
      
      let tempDisplay = '--';
      let humDisplay = '--';
      let isAlarm = false;
      let timeDiffMinutes = 999;
      
      if (reading) {
        tempDisplay = reading.temp_c.toFixed(1) + '°C';
        humDisplay = reading.humidity_pct.toFixed(1) + '%';
        
        // Verifica Allarmi
        if (sensor.temp_min && reading.temp_c < sensor.temp_min) isAlarm = true;
        if (sensor.temp_max && reading.temp_c > sensor.temp_max) isAlarm = true;
        if (sensor.hum_min && reading.humidity_pct < sensor.hum_min) isAlarm = true;
        if (sensor.hum_max && reading.humidity_pct > sensor.hum_max) isAlarm = true;
        
        // Check Last seen
        const lastSeen = new Date(reading.timestamp_received);
        timeDiffMinutes = (Date.now() - lastSeen.getTime()) / 60000;
      }
      
      // Se offline da > 90 min = Allarme
      const isOffline = timeDiffMinutes > 90;
      const statusClass = (isAlarm || isOffline) ? 'status-critical' : 'status-good';
      
      const card = document.createElement('div');
      card.className = `card ${isAlarm ? 'card-pulse' : ''}`;
      if (isAlarm) card.style.border = '1px solid var(--orange)';
      if (isOffline) card.style.border = '1px solid var(--text-3)'; // Grigio se offline

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
          <div>
            <div style="font-weight:600; font-size:1.1rem;">${sensor.display_name}</div>
            <div style="font-size:0.8rem; color:var(--text-3);">${sensor.terrario_name || 'Nessun terrario'}</div>
          </div>
          <div class="status-indicator ${statusClass}"></div>
        </div>
        
        <div style="display:flex; gap:16px; margin-bottom:12px;">
          <div style="flex:1; background:rgba(0,0,0,0.2); padding:12px; border-radius:8px;">
            <div style="font-size:0.75rem; color:var(--text-3); margin-bottom:4px;">TEMPERATURA</div>
            <div style="font-size:1.5rem; font-weight:700; color:${(sensor.temp_min && reading && reading.temp_c < sensor.temp_min) || (sensor.temp_max && reading && reading.temp_c > sensor.temp_max) ? 'var(--orange)' : 'var(--text-1)'}">${tempDisplay}</div>
            <div style="font-size:0.7rem; color:var(--text-4); margin-top:4px;">
              ${sensor.temp_min ? sensor.temp_min+'°' : '-'} / ${sensor.temp_max ? sensor.temp_max+'°' : '-'}
            </div>
          </div>
          <div style="flex:1; background:rgba(0,0,0,0.2); padding:12px; border-radius:8px;">
            <div style="font-size:0.75rem; color:var(--text-3); margin-bottom:4px;">UMIDITÀ</div>
            <div style="font-size:1.5rem; font-weight:700; color:${(sensor.hum_min && reading && reading.humidity_pct < sensor.hum_min) || (sensor.hum_max && reading && reading.humidity_pct > sensor.hum_max) ? 'var(--orange)' : 'var(--text-1)'}">${humDisplay}</div>
            <div style="font-size:0.7rem; color:var(--text-4); margin-top:4px;">
              ${sensor.hum_min ? sensor.hum_min+'%' : '-'} / ${sensor.hum_max ? sensor.hum_max+'%' : '-'}
            </div>
          </div>
        </div>
        <div style="font-size:0.75rem; color:var(--text-4); text-align:right;">
          ${isOffline ? 'Offline. Ultimo dato: ' + (reading ? new Date(reading.timestamp_received).toLocaleString() : 'Mai') : 'Aggiornato di recente'}
        </div>
      `;
      grid.appendChild(card);
    });
  },

  renderChartSetup() {
    const select = document.getElementById('climaChartSensor');
    if (!select) return;

    // Popola select
    let options = '<option value="">Seleziona Sensore...</option>';
    this.state.sensors.forEach(s => {
      options += `<option value="${s.device_id}">${s.display_name}</option>`;
    });
    select.innerHTML = options;

    if (this.state.sensors.length > 0) {
      select.value = this.state.sensors[0].device_id;
      this.updateChart(this.state.sensors[0].device_id);
    }
  },

  updateChart(deviceId) {
    if (!deviceId) return;
    
    const sensorReadings = this.state.readings.filter(r => r.device_id === deviceId);
    if (!sensorReadings.length) return;

    // Ordina cronologicamente
    sensorReadings.sort((a,b) => new Date(a.timestamp_received) - new Date(b.timestamp_received));

    const ctx = document.getElementById('climaChart');
    if (!ctx) return;

    if (this.state.chartInstance) {
      this.state.chartInstance.destroy();
    }

    // Usiamo il date adapter di chart.js (se incluso) altrimenti usiamo etichette testo
    const labels = sensorReadings.map(r => new Date(r.timestamp_received).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));
    const dataTemp = sensorReadings.map(r => r.temp_c);
    const dataHum = sensorReadings.map(r => r.humidity_pct);

    this.state.chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Temperatura (°C)',
            data: dataTemp,
            borderColor: '#ff9500', // Arancione
            backgroundColor: 'rgba(255, 149, 0, 0.1)',
            borderWidth: 2,
            tension: 0.4,
            yAxisID: 'yTemp'
          },
          {
            label: 'Umidità (%)',
            data: dataHum,
            borderColor: '#30d158', // Verde
            backgroundColor: 'rgba(48, 209, 88, 0.1)',
            borderWidth: 2,
            tension: 0.4,
            yAxisID: 'yHum'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#f2f2f2' } }
        },
        scales: {
          x: { 
            ticks: { color: '#888', maxTicksLimit: 10 },
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          yTemp: {
            type: 'linear',
            display: true,
            position: 'left',
            title: { display: true, text: '°C', color: '#ff9500' },
            ticks: { color: '#ff9500' },
            grid: { color: 'rgba(255,255,255,0.05)' }
          },
          yHum: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: '%', color: '#30d158' },
            ticks: { color: '#30d158' },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  },

  setupListeners() {
    // Filtri
    const filtersBar = document.querySelector('.filters-bar');
    if (filtersBar) {
      filtersBar.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
          document.querySelectorAll('.filters-bar button').forEach(b => b.classList.remove('active'));
          e.target.classList.add('active');
          this.state.filterGroup = e.target.dataset.filter || 'all';
          this.renderCards();
        }
      });
    }

    // Chart select
    const select = document.getElementById('climaChartSensor');
    if (select) {
      select.addEventListener('change', (e) => {
        this.updateChart(e.target.value);
      });
    }

    // Modal settings
    const btnSettings = document.getElementById('btnClimaSettings');
    if (btnSettings) {
      btnSettings.addEventListener('click', () => {
        alert('Funzionalità "Gestisci Sensori" in sviluppo. Permetterà di rinominare e riassegnare le sonde dal database Google Sheets.');
      });
    }
  }
};

window.ClimaApp = ClimaApp;
