/* global Chart, QRCode, Html5Qrcode, DUBIA */
/**
 * D.U.B.I.A. Engine - Dynamic Updating Biomass Inference Algorithm
 * 
 * NOTA: Le formule matematiche core (Feed-Forward, Back-Propagation,
 * Indice H, Diagnostica, Censimento) sono definite nel modulo separato
 * dubia_module.js e accessibili tramite window.DUBIA.
 * Questo file gestisce lo stato applicativo, il DB e la UI.
 */

// Constants & Configurations
const GAS_URL = "https://script.google.com/macros/s/AKfycbytzG9NLE51X939kgbNQbaRTC5vmd5V58nfYKAtfuZixhv30mizaPsB2ko7jmjD0gygsg/exec";

// ══════════════════════════════════════════════════════════════
// CLOUD LAYER V2
// ══════════════════════════════════════════════════════════════

const generateUUID = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });

const cloudPost = async (payload, { retries = 4 } = {}) => {
    if (!payload.event_id) payload.event_id = generateUUID();
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(GAS_URL, {
                method: 'POST', redirect: 'follow',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            if (json.status === 'error') throw new Error(json.message);
            return { ok: true, data: json };
        } catch (e) {
            if (attempt === retries) {
                console.warn('[D.U.B.I.A.] cloudPost fallito dopo ' + (retries + 1) + ' tentativi:', e.message);
                return { ok: false, error: e.message };
            }
            // Exponential Backoff: 2s, 4s, 8s, 16s + jitter casuale (0-500ms)
            // Sicuro grazie all'idempotenza L1+L2: il backend ignora UUID duplicati
            const delay = 2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
            console.info(`[D.U.B.I.A.] Retry ${attempt + 1}/${retries} tra ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
};

const cloudGet = async (sheet, timeoutMs = 8000) => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${GAS_URL}?sheet=${encodeURIComponent(sheet)}`, {
            redirect: 'follow', signal: controller.signal
        });
        clearTimeout(tid);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.status === 'error') throw new Error(json.message);
        return json.data || [];
    } catch (e) {
        clearTimeout(tid);
        console.warn(`[D.U.B.I.A.] cloudGet(${sheet}) fallito:`, e.message);
        return [];
    }
};

const OFFLINE_QUEUE_KEY = 'dubia_offline_queue_v2';

const queuePush = (payload) => {
    try {
        const q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
        q.push({ payload, ts: Date.now() });
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
        console.info(`[D.U.B.I.A.] Offline queue: ${q.length} item.`);
    } catch (e) { console.warn('[D.U.B.I.A.] queuePush:', e.message); }
};

const flushOfflineQueue = async () => {
    let q;
    try { q = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); } catch (e) { return; }
    if (q.length === 0) return;
    console.info(`[D.U.B.I.A.] Flush offline queue: ${q.length} item...`);
    if (typeof showNotification === 'function')
        showNotification('Sincronizzazione Offline', `Invio di ${q.length} operazione/i in sospeso...`, 'success');
    const remaining = [];
    for (const item of q) {
        const result = await cloudPost(item.payload, { retries: 1 });
        if (!result.ok) { remaining.push(item); break; }
    }
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    if (remaining.length === 0 && q.length > 0 && typeof showNotification === 'function')
        showNotification('Sincronizzazione Completata', `${q.length} operazione/i offline inviate.`, 'success');
};

const cloudPostWithQueue = async (payload, opts = {}) => {
    if (!payload.event_id) payload.event_id = generateUUID();
    if (!navigator.onLine) { queuePush(payload); return { ok: true, queued: true }; }
    return cloudPost(payload, opts);
};

window.addEventListener('online', () => { console.info('[D.U.B.I.A.] Online: flush queue...'); flushOfflineQueue(); });

let _backgroundSyncTimer = null;

const mapTimelineData = (data) => {
    const seen = new Set();
    return data.map(m => ({
        ...m,
        date:             m.date || null,
        total_weight:     parseFloat(m.total_weight)     || 0,
        food_amount:      parseFloat(m.food_amount)      || 0,
        harvest_amount:   parseFloat(m.harvest_amount)   || 0,
        adult_ratio:      (m.adult_ratio !== null && m.adult_ratio !== undefined) ? (parseFloat(m.adult_ratio) || 0) : 0,
        predicted_weight: parseFloat(m.predicted_weight) || 0,
        health_index:     (m.health_index !== null && m.health_index !== undefined) ? (parseFloat(m.health_index) || 0) : 100,
        is_new_blood:     m.is_new_blood === 'true' || m.is_new_blood === true
    }))
    .filter(m => !!m.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    // De-duplica: per i record senza event_id (storici del vecchio sheet),
    // tieni solo il primo per ogni coppia (data-ISO, total_weight).
    // I record con event_id sono sempre tenuti anche se con stessa data.
    .filter(m => {
        if (m.event_id) return true; // record V2: sempre includi
        const key = `${String(m.date).substring(0,10)}_${m.total_weight}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const startBackgroundSync = () => {
    if (_backgroundSyncTimer) return;
    _backgroundSyncTimer = setInterval(async () => {
        if (document.hidden || !navigator.onLine) return;
        try {
            const data = await cloudGet('Timeline', 6000);
            if (data.length > 0 && data.length !== appState.measurements.length) {
                const mapped = mapTimelineData(data);
                if (mapped.length !== appState.measurements.length) {
                    appState.measurements = mapped;
                    if (typeof updateUI === 'function') updateUI();
                    console.info(`[D.U.B.I.A.] Background sync: ${mapped.length} record.`);
                }
            }
        } catch (e) { /* silenzioso */ }
    }, 45000);
};

document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(_backgroundSyncTimer); _backgroundSyncTimer = null; }
    else startBackgroundSync();
});


// Tasso di apprendimento α per la discesa del gradiente
const ALPHA = 1e-6;

// Parametri di default (coincidono con le costanti del Teorema D.U.B.I.A.)
const DEFAULT_PARAMS = {
    theta1: 0.30,          // θ₁ iniziale: Resa Alimentazione
    theta2: 1.05,          // θ₂ iniziale: Crescita Naturale Neanidi
    mortalityRate: 1.5     // Mortalità Mensile (%)
};

// Soglie per l'Indice di Salute H = (θ₁ / θ₁*) × 100
const HEALTH_THRESHOLD_WARNING = 90;  // H >= 90% → Ottimale
const HEALTH_THRESHOLD_ALERT   = 75;  // H >= 75% e < 90% → Warning; H < 75% → Critico

// Proxy al modulo matematico (window.DUBIA da dubia_module.js)
// Fornisce un fallback sicuro se il modulo non è ancora caricato.
const D = () => (typeof DUBIA !== 'undefined' ? DUBIA : null);

// Demographic Mass Constants (in grams)
const MASS = {
    FEMALE: 2.5,
    MALE: 1.5,
    SUBADULT: 1.6,
    MEDIUM: 0.8,
    SMALL: 0.3,
    BABY: 0.1
};

// Prezzi di default per tipologia (modificabili dall'utente)
const DEFAULT_PRICES = {
    FEMALE: 0.50,
    MALE: 0.40,
    SUBADULT: 0.30,
    MEDIUM: 0.20,
    SMALL: 0.10,
    BABY: 0.05
};

// Listino Prezzi Ufficiale per Vendita e Preventivi D.U.B.I.A.
const COMMERCIAL_CATALOG = {
    ADULT: {
        id: 'ADULT',
        label: 'Blatte Adulte (M/F)',
        size: '2.0 – 2.5 cm',
        pricePerKg: 40.00,
        pricePer100: 8.00,
        massPerUnit: 2.0, // ~2.0g per adulto medio
        defaultUnit: 'kg',
        color: '#e74c3c',
        desc: 'Adulti riproduttori o feeder taglia grande'
    },
    MIXED: {
        id: 'MIXED',
        label: 'Colonia Mista Avviata',
        size: 'Mix Tutte le Misure',
        pricePerKg: 60.00,
        pricePer100: null,
        massPerUnit: null,
        defaultUnit: 'kg',
        color: '#9b59b6',
        desc: 'Colonia avviata completa (baby, medie, grandi)'
    },
    MEDIUM: {
        id: 'MEDIUM',
        label: 'Neanidi Medie',
        size: '1.0 – 1.5 cm',
        pricePerKg: 140.00,
        pricePer100: 14.00,
        massPerUnit: 1.0, // ~1.0g per individuo (1000 pz/kg)
        defaultUnit: '100pz',
        color: '#2ecc71',
        desc: 'Dimensione ideale per gechi e sauri sub-adulti'
    },
    SMALL: {
        id: 'SMALL',
        label: 'Neanidi Small (Baby)',
        size: '1 mm – 8 mm',
        pricePerKg: 1250.00,
        pricePer100: 12.50,
        massPerUnit: 0.1, // ~0.1g per baby (10.000 pz/kg)
        defaultUnit: '100pz',
        color: '#f39c12',
        desc: 'Appena nate, guscio morbidissimo e digeribile'
    }
};

// Catalogo Commerciale Completo Multilivello (Blatte, Hardware IoT & Accessori)
const PRICE_CATALOG_FULL = {
    edition: '2026',
    brand: 'D.U.B.I.A. Cervello Digitale',
    categories: [
        {
            id: 'BLATTE',
            title: 'Blatte da Pasto & Colonie Riproduttive (Blaptica Dubia)',
            icon: '🪳',
            tag: 'blatte',
            tagLabel: 'Insetti Vivi',
            items: [
                {
                    id: 'ADULT',
                    title: 'Blatte Adulte (M/F)',
                    size: '2.0 – 2.5 cm',
                    icon: '🔴',
                    desc: 'Adulti riproduttori o feeder per sauri di taglia media e grande (pogone, varani, tegu). Elevato apporto proteico e guscio consistente.',
                    category: 'BLATTE',
                    unit: '100pz',
                    tiers: {
                        DIRECT: [
                            { qty: '100 pz', price: 10.00, note: '0,10 €/pz' },
                            { qty: '500 pz', price: 42.00, note: '0,084 €/pz' },
                            { qty: '1 Kg (~500 pz)', price: 48.00, note: 'Scorta convenienza' }
                        ],
                        MICHAEL: [
                            { qty: '100 pz', price: 8.00, note: '0,08 €/pz' },
                            { qty: '500 pz', price: 35.00, note: '0,07 €/pz' },
                            { qty: '1 Kg (~500 pz)', price: 40.00, note: 'Prezzo ingrosso' }
                        ]
                    }
                },
                {
                    id: 'MIXED',
                    title: 'Colonia Mista Avviata',
                    size: 'Tutte le misure (Baby + Medie + Adulti)',
                    icon: '🟣',
                    desc: 'Mix demografico perfettamente bilanciato per avviare o potenziare il proprio allevamento autonomo di blatte dubia.',
                    category: 'BLATTE',
                    unit: 'kg',
                    tiers: {
                        DIRECT: [
                            { qty: '500 g', price: 38.00, note: 'Mix avviato' },
                            { qty: '1 Kg', price: 70.00, note: 'Colonia completa' },
                            { qty: 'Starter Kit 2 Kg', price: 130.00, note: 'Super pack riproduzione' }
                        ],
                        MICHAEL: [
                            { qty: '500 g', price: 35.00, note: 'Mix bilanciato' },
                            { qty: '1 Kg', price: 60.00, note: 'Prezzo concordato' },
                            { qty: 'Kit Fornitura 2 Kg', price: 110.00, note: 'Fornitura all\'ingrosso' }
                        ]
                    }
                },
                {
                    id: 'MEDIUM',
                    title: 'Neanidi Medie',
                    size: '1.0 – 1.5 cm',
                    icon: '🟢',
                    desc: 'La taglia più richiesta e versatile. Ideale per gechi leopardini, pogone sub-adulte, camaleonti e sauri giovani.',
                    category: 'BLATTE',
                    unit: '100pz',
                    tiers: {
                        DIRECT: [
                            { qty: '100 pz', price: 16.00, note: '0,16 €/pz' },
                            { qty: '500 pz', price: 72.00, note: '0,144 €/pz' },
                            { qty: '1 Kg (~1.000 pz)', price: 150.00, note: '150,00 €/kg' }
                        ],
                        MICHAEL: [
                            { qty: '100 pz', price: 14.00, note: '0,14 €/pz' },
                            { qty: '500 pz', price: 65.00, note: '0,13 €/pz' },
                            { qty: '1 Kg (~1.000 pz)', price: 140.00, note: '140,00 €/kg' }
                        ]
                    }
                },
                {
                    id: 'SMALL',
                    title: 'Neanidi Small (Baby)',
                    size: '1 mm – 8 mm',
                    icon: '🟡',
                    desc: 'Neanidi piccolissime con esoscheletro tenero e digeribile. Perfette per baby gechi, rane, dendrobates, aracnidi e sauri nani.',
                    category: 'BLATTE',
                    unit: '100pz',
                    tiers: {
                        DIRECT: [
                            { qty: '100 pz', price: 14.00, note: '0,14 €/pz' },
                            { qty: '500 pz', price: 60.00, note: '0,12 €/pz' },
                            { qty: '1 Kg (~10.000 pz)', price: 1350.00, note: 'Maxi allevamento' }
                        ],
                        MICHAEL: [
                            { qty: '100 pz', price: 12.50, note: '0,125 €/pz' },
                            { qty: '500 pz', price: 55.00, note: '0,11 €/pz' },
                            { qty: '1 Kg (~10.000 pz)', price: 1250.00, note: '1.250,00 €/kg' }
                        ]
                    }
                },
                {
                    id: 'FEMALES_BREEDING',
                    title: 'Femmine Riproduttrici Selezionate',
                    size: '2.3 – 2.6 cm (Femmine Gravide)',
                    icon: '👑',
                    desc: 'Femmine adulte fecondate pronte alla deposizione delle ooteche. Selezionate per taglia e vitalità.',
                    category: 'BLATTE',
                    unit: '50pz',
                    tiers: {
                        DIRECT: [
                            { qty: '50 pz', price: 28.00, note: '0,56 €/cad' },
                            { qty: '100 pz', price: 50.00, note: '0,50 €/cad' }
                        ],
                        MICHAEL: [
                            { qty: '50 pz', price: 25.00, note: '0,50 €/cad' },
                            { qty: '100 pz', price: 45.00, note: '0,45 €/cad' }
                        ]
                    }
                },
                {
                    id: 'MALES_SELECTED',
                    title: 'Maschi Adulti Fecondatori',
                    size: '2.0 – 2.3 cm (Maschi Alati)',
                    icon: '🛡️',
                    desc: 'Maschi adulti sani ed energici per garantire il corretto rapporto sessuale (1 maschio ogni 3-4 femmine).',
                    category: 'BLATTE',
                    unit: '50pz',
                    tiers: {
                        DIRECT: [
                            { qty: '50 pz', price: 20.00, note: '0,40 €/cad' },
                            { qty: '100 pz', price: 35.00, note: '0,35 €/cad' }
                        ],
                        MICHAEL: [
                            { qty: '50 pz', price: 18.00, note: '0,36 €/cad' },
                            { qty: '100 pz', price: 32.00, note: '0,32 €/cad' }
                        ]
                    }
                }
            ]
        },
        {
            id: 'IOT',
            title: 'Hardware IoT & Monitoraggio Terrari (Termoigrometri Wi-Fi)',
            icon: '📡',
            tag: 'iot',
            tagLabel: 'Hardware IoT',
            items: [
                {
                    id: 'TERMOIGROMETRO_V2',
                    title: 'Termoigrometro Wi-Fi ESP8266 + SHT40 v2.0',
                    size: 'Dispositivo Smart Completo',
                    icon: '📟',
                    desc: 'Termoigrometro Wi-Fi programmato con firmware v2.0. Sensore di precisione Sensirion SHT40 (±1.5% RH, ±0.2°C), sincronizzazione cloud e dashboard live.',
                    category: 'IOT',
                    unit: 'pz',
                    tiers: {
                        DIRECT: [
                            { qty: '1 Dispositivo', price: 34.90, note: 'Assemblato & Testato' },
                            { qty: 'Kit 3 Dispositivi', price: 89.70, note: '29,90 € / cad (-14%)' }
                        ],
                        MICHAEL: [
                            { qty: '1 Dispositivo', price: 29.90, note: 'Prezzo concordato' },
                            { qty: 'Kit 3+ Dispositivi', price: 74.70, note: '24,90 € / cad' }
                        ]
                    }
                },
                {
                    id: 'SONDA_SHT40',
                    title: 'Sonda SHT40 con Cavo Schermato 1m',
                    size: 'Sensore Esterno Terrario',
                    icon: '🔬',
                    desc: 'Sonda Sensirion SHT40 ad altissima affidabilità e risposta ultra rapida, protetta da guaina termorestringente e cavo flessibile schermato da 1 metro.',
                    category: 'IOT',
                    unit: 'pz',
                    tiers: {
                        DIRECT: [
                            { qty: '1 Sonda', price: 16.90, note: 'Calibrata di fabbrica' },
                            { qty: '3 Sonde', price: 44.70, note: '14,90 € / cad' }
                        ],
                        MICHAEL: [
                            { qty: '1 Sonda', price: 14.90, note: 'Ricambio originale' },
                            { qty: '3 Sonde', price: 38.70, note: '12,90 € / cad' }
                        ]
                    }
                },
                {
                    id: 'DISPLAY_OLED',
                    title: 'Modulo Display OLED I2C 0.96"',
                    size: 'Schermo Digitale Locale',
                    icon: '🖥️',
                    desc: 'Display OLED retroilluminato ad alto contrasto per visualizzare temperatura, umidità, punto di rugiada e stato Wi-Fi direttamente sulla scatola.',
                    category: 'IOT',
                    unit: 'pz',
                    tiers: {
                        DIRECT: [
                            { qty: '1 Modulo Display', price: 8.90, note: 'I2C Plug & Play' }
                        ],
                        MICHAEL: [
                            { qty: '1 Modulo Display', price: 7.50, note: 'Prezzo riserva' }
                        ]
                    }
                },
                {
                    id: 'POWER_KIT',
                    title: 'Kit Alimentazione 5V 2A + Cavo 2m',
                    size: 'Alimentazione Continua',
                    icon: '🔌',
                    desc: 'Alimentatore switching compatto stabilizzato 5V 2A con cavo Micro-USB rinforzato in nylon da 2 metri per installazione fissa in terrariofilia.',
                    category: 'IOT',
                    unit: 'pz',
                    tiers: {
                        DIRECT: [
                            { qty: '1 Kit Alimentazione', price: 9.90, note: '5V 2A + Cavo 2m' }
                        ],
                        MICHAEL: [
                            { qty: '1 Kit Alimentazione', price: 8.90, note: 'Fornitura continua' }
                        ]
                    }
                }
            ]
        },
        {
            id: 'ACCESSORI',
            title: 'Nutrizione, Substrato & Accessori Allevamento',
            icon: '🌾',
            tag: 'accessori',
            tagLabel: 'Allevamento',
            items: [
                {
                    id: 'FEED_PROTEIN',
                    title: 'Mangime "Dubia Protein+" Formula Allevamento',
                    size: 'Formula Secca Bilanciata',
                    icon: '🥣',
                    desc: 'Miscela secca bilanciata a base di cereali nobili, spirulina, proteine vegetali e carbonato di calcio. Massimizza tasso di crescita e fertilità.',
                    category: 'ACCESSORI',
                    unit: 'kg',
                    tiers: {
                        DIRECT: [
                            { qty: '500 g', price: 7.50, note: '15,00 €/kg' },
                            { qty: '1 Kg', price: 12.50, note: 'Confezione salva-freschezza' }
                        ],
                        MICHAEL: [
                            { qty: '500 g', price: 6.50, note: '13,00 €/kg' },
                            { qty: '1 Kg', price: 11.00, note: 'Formato scorta' }
                        ]
                    }
                },
                {
                    id: 'WATER_GEL',
                    title: 'Cristalli Idrogel Ultra-Puri (Idratazione)',
                    size: 'Polimero Idrofilo Neutro',
                    icon: '💧',
                    desc: 'Cristalli idrogel a rilascio graduale. Prevengono l\'annegamento delle neanidi ed evitano ristagni d\'acqua e formazione di muffe nei contenitori.',
                    category: 'ACCESSORI',
                    unit: 'conf',
                    tiers: {
                        DIRECT: [
                            { qty: '250 g secco (Resa 50L)', price: 8.90, note: 'Idratazione pulita' },
                            { qty: '500 g secco (Resa 100L)', price: 15.00, note: 'Maxi convenienza' }
                        ],
                        MICHAEL: [
                            { qty: '250 g secco (Resa 50L)', price: 7.90, note: 'Prezzo riservato' },
                            { qty: '500 g secco (Resa 100L)', price: 13.50, note: 'Fornitura stock' }
                        ]
                    }
                },
                {
                    id: 'EGG_CRATES',
                    title: 'Cartoni Portauova Verticali Vergini',
                    size: 'Pacco Rifugi Igienici',
                    icon: '📦',
                    desc: 'Portauova in cartone di cellulosa vergine non riciclata, esenti da trattamenti chimici e inchiostri. Ottimizzano la superficie calpestabile.',
                    category: 'ACCESSORI',
                    unit: 'pack',
                    tiers: {
                        DIRECT: [
                            { qty: 'Pacco 15 pz', price: 8.00, note: 'Cartone naturale' },
                            { qty: 'Pacco 30 pz', price: 14.00, note: '0,46 €/pz' }
                        ],
                        MICHAEL: [
                            { qty: 'Pacco 15 pz', price: 7.00, note: 'Fornitura starter' },
                            { qty: 'Pacco 30 pz', price: 12.00, note: '0,40 €/pz' }
                        ]
                    }
                },
                {
                    id: 'SHIPPING_BOX',
                    title: 'Box Termico Isotropico + Heat Pack 40h',
                    size: 'Kit Spedizione Sicura',
                    icon: '❄️',
                    desc: 'Contenitore in polistirolo ad alta densità con scaldino chimico auto-attivante 40 ore. Garantisce temperatura ideale durante il tragitto.',
                    category: 'ACCESSORI',
                    unit: 'pz',
                    tiers: {
                        DIRECT: [
                            { qty: '1 Kit Box + Scaldino', price: 6.90, note: 'Protezione freddo/caldo' }
                        ],
                        MICHAEL: [
                            { qty: '1 Kit Box + Scaldino', price: 6.00, note: 'Costo vivo imballo' }
                        ]
                    }
                }
            ]
        }
    ]
};

// State
let appState = {
    measurements: [],
    params: { ...DEFAULT_PARAMS },
    charts: {},
    clients: [],
    cessioni: [],
    quotes: [],
    customPrices: { ...DEFAULT_PRICES },
    colonies: [],
    isSyncing: false,
    // Auto-Tuning: storico delle misurazioni di massa per categoria (media mobile 3x)
    calibrationHistory: {},
    // Auto-Tuning: costanti biologiche personalizzate (override di MASS)
    customMass: {}
};

// --- DATABASE (IndexedDB) ---
const dbName = "DubiaDB";
// Versione 5: aggiunto store quotes (preventivi)
const dbVersion = 5;
let db;

const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);

        request.onupgradeneeded = (event) => {
            db = event.target.result;
            const oldVersion = event.oldVersion;

            // Crea store misure se non esiste (v1+)
            if (!db.objectStoreNames.contains("measurements")) {
                db.createObjectStore("measurements", { keyPath: "id", autoIncrement: true });
            }
            // Crea store parametri se non esiste (v1+)
            if (!db.objectStoreNames.contains("parameters")) {
                db.createObjectStore("parameters", { keyPath: "id" });
            }
            // Crea store clienti se non esiste (v3+)
            if (!db.objectStoreNames.contains("clients")) {
                db.createObjectStore("clients", { keyPath: "id", autoIncrement: true });
            }
            // Crea store cessioni se non esiste (v3+)
            if (!db.objectStoreNames.contains("cessioni")) {
                db.createObjectStore("cessioni", { keyPath: "id", autoIncrement: true });
            }
            // Crea store colonie se non esiste (v4+)
            if (!db.objectStoreNames.contains("colonies")) {
                db.createObjectStore("colonies", { keyPath: "id", autoIncrement: true });
            }
            // Crea store preventivi se non esiste (v5+)
            if (!db.objectStoreNames.contains("quotes")) {
                db.createObjectStore("quotes", { keyPath: "id", autoIncrement: true });
            }
            // Migration v1→v2: invalida i parametri salvati in modo che vengano
            // rivalidati al prossimo caricamento (reset a DEFAULT_PARAMS se fuori range)
            if (oldVersion === 1) {
                console.info('[D.U.B.I.A.] Migration v1→v2: params will be revalidated on next load.');
            }
            if (oldVersion < 3) {
                console.info('[D.U.B.I.A.] Migration v3: aggiunto store clients e cessioni.');
            }
            if (oldVersion < 4) {
                console.info('[D.U.B.I.A.] Migration v4: aggiunto store colonies.');
            }
            if (oldVersion < 5) {
                console.info('[D.U.B.I.A.] Migration v5: aggiunto store quotes.');
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            loadInitialData().then(resolve);
        };

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.error);
            reject(event.target.error);
        };
    });
};

/**
 * validateAndMigrateParams — Valida i parametri caricati da IndexedDB.
 *
 * Garantisce che theta1 e theta2 siano nei range fisici del Teorema D.U.B.I.A.
 * Se i valori sono fuori range (es. vecchi default 0.05 / 0.01), li resetta.
 *
 * @param {object} stored - Oggetto params caricato da IndexedDB
 * @returns {object} Params validati e pronti all'uso
 */
const validateAndMigrateParams = (stored) => {
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_PARAMS };

    const THETA1_MIN = 0.05;  const THETA1_MAX = 2.0;
    const THETA2_MIN = 0.20;  const THETA2_MAX = 3.0;

    const theta1 = parseFloat(stored.theta1);
    const theta2 = parseFloat(stored.theta2);

    const theta1Valid = isFinite(theta1) && theta1 >= THETA1_MIN && theta1 <= THETA1_MAX;
    const theta2Valid = isFinite(theta2) && theta2 >= THETA2_MIN && theta2 <= THETA2_MAX;

    if (!theta1Valid || !theta2Valid) {
        console.warn(
            `[D.U.B.I.A.] Params fuori range biologico: θ₁=${theta1}, θ₂=${theta2}. ` +
            `Reset a DEFAULT_PARAMS (θ₁=${DEFAULT_PARAMS.theta1}, θ₂=${DEFAULT_PARAMS.theta2}).`
        );
        return { ...DEFAULT_PARAMS };
    }

    return {
        ...DEFAULT_PARAMS,  // base con campi non-theta
        ...stored,          // sovrascrive con tutto il resto
        theta1,             // usa i valori validati
        theta2
    };
};

/**
 * rebuildParamsFromMeasurements — Ricostruisce theta1/theta2 riapplicando
 * tutte le backpropagation in sequenza sulle misure cloud.
 *
 * Questo garantisce che mobile e desktop abbiano SEMPRE lo stesso stato appreso,
 * indipendentemente da cosa c'è nel loro IndexedDB locale.
 *
 * @param {Array} measurements - Lista ordinata per data
 * @returns {{ theta1: number, theta2: number }}
 */
const rebuildParamsFromMeasurements = (measurements) => {
    const dubiaModule = D();
    let theta1 = DEFAULT_PARAMS.theta1;
    let theta2 = DEFAULT_PARAMS.theta2;

    for (let i = 1; i < measurements.length; i++) {
        const prev = measurements[i - 1];
        const curr = measurements[i];

        const d1 = new Date(prev.date);
        const d2 = new Date(curr.date);
        const delta_g = Math.max(1, (d2 - d1) / (1000 * 60 * 60 * 24));

        const adultRatio = (curr.adult_ratio !== undefined && curr.adult_ratio !== null) ? Number(curr.adult_ratio) : 0.35;
        const foodAmount = curr.food_amount || 0;

        const W_pred = dubiaModule
            ? dubiaModule.feedForward(prev.total_weight, foodAmount, adultRatio, delta_g, theta1, theta2)
            : prev.total_weight + (theta1 * foodAmount) + (theta2 * prev.total_weight * (1 - adultRatio) * (delta_g / 30));

        const bp = dubiaModule
            ? dubiaModule.backpropagate(theta1, theta2, W_pred, curr.total_weight, prev.total_weight, foodAmount, adultRatio, delta_g, ALPHA)
            : { theta1: theta1 - ALPHA * (W_pred - curr.total_weight) * foodAmount,
                theta2: theta2 - ALPHA * (W_pred - curr.total_weight) * prev.total_weight * (1 - adultRatio) * (delta_g / 30) };

        // Clamp per stabilità biologica e numerica
        theta1 = Math.max(0.05, Math.min(2.0, bp.theta1));
        theta2 = Math.max(0.20, Math.min(3.0, bp.theta2));
    }

    return { theta1, theta2 };
};

const syncWithCloud = async () => {
    if (!navigator.onLine) {
        startBackgroundSync();
        return;
    }

    appState.isSyncing = true;
    if (typeof showNotification === 'function') {
        showNotification("Sincronizzazione", "Download dati dal cloud...", "success");
    }

    // Aggiorna la UI per mostrare eventuale stato di caricamento
    if (typeof updateColoniesUI === 'function') updateColoniesUI();
    if (typeof updateClientiUI === 'function') updateClientiUI();

    try {
        const [timelineResult, clientiResult, cessioniResult, colonieResult] = await Promise.allSettled([
            cloudGet("Timeline", 10000),
            cloudGet("Clienti",  8000),
            cloudGet("Cessioni", 8000),
            cloudGet("Colonie",  8000)
        ]);

        // Timeline → misure principali
        const timelineData = timelineResult.status === "fulfilled" ? timelineResult.value : [];
        if (timelineData.length > 0) {
            appState.measurements = mapTimelineData(timelineData);
            console.info(`[D.U.B.I.A.] Timeline: ${appState.measurements.length} record.`);

            // Salva su DB locale
            const tx = db.transaction("measurements", "readwrite");
            const store = tx.objectStore("measurements");
            store.clear();
            appState.measurements.forEach(m => store.put(m));

            // Ricostruisce theta1/theta2 deterministicamente
            if (appState.measurements.length > 1) {
                const rebuilt = rebuildParamsFromMeasurements(appState.measurements);
                appState.params.theta1 = rebuilt.theta1;
                appState.params.theta2 = rebuilt.theta2;
                saveParams(appState.params);
                console.info(`[D.U.B.I.A.] Params ricostruiti: th1=${rebuilt.theta1.toFixed(6)}, th2=${rebuilt.theta2.toFixed(6)}`);
            }
        } else {
            console.info("[D.U.B.I.A.] Timeline cloud vuota o non raggiungibile.");
        }

        // Clienti cloud → merge con locale
        const clientiData = clientiResult.status === "fulfilled" ? clientiResult.value : [];
        if (clientiData.length > 0) {
            const tx = db.transaction("clients", "readwrite");
            const store = tx.objectStore("clients");
            clientiData.forEach(c => { if (c.id) store.put({ ...c, id: Number(c.id) }); });
            appState.clients = clientiData.map(c => ({ ...c, id: Number(c.id) }));
            console.info(`[D.U.B.I.A.] Clienti cloud: ${clientiData.length}.`);
        }

        // Cessioni cloud → merge con locale
        const cessioniData = cessioniResult.status === "fulfilled" ? cessioniResult.value : [];
        if (cessioniData.length > 0) {
            const tx = db.transaction("cessioni", "readwrite");
            const store = tx.objectStore("cessioni");
            cessioniData.forEach(c => { if (c.id) store.put({ ...c, id: Number(c.id) }); });
            appState.cessioni = cessioniData
                .map(c => ({ ...c, id: Number(c.id), cliente_id: Number(c.cliente_id) }))
                .sort((a, b) => new Date(b.data) - new Date(a.data));
            console.info(`[D.U.B.I.A.] Cessioni cloud: ${cessioniData.length}.`);
        }

        // Colonie cloud → merge con locale
        const colonieData = colonieResult.status === "fulfilled" ? colonieResult.value : [];
        if (colonieData.length > 0) {
            const coloniesMap = new Map();
            colonieData.forEach(c => { if (c.id) coloniesMap.set(Number(c.id), c); });
            const tx = db.transaction("colonies", "readwrite");
            const store = tx.objectStore("colonies");
            coloniesMap.forEach((c, id) => {
                const isDeleted = c.is_deleted === true || c.is_deleted === 'true' || c.is_deleted === 1;
                const mapped = {
                    id, name: c.name || `Colonia ${id}`, type: c.type || "Pasto",
                    creation_date: c.date || c.creation_date || new Date().toISOString().split("T")[0],
                    current_weight: parseFloat(c.current_weight) || 0,
                    males_count: parseInt(c.males_count) || 0, females_count: parseInt(c.females_count) || 0,
                    subadults_count: parseInt(c.subadults_count) || 0, medium_count: parseInt(c.medium_count) || 0,
                    small_count: parseInt(c.small_count) || 0, baby_count: parseInt(c.baby_count) || 0,
                    notes: c.notes || "",
                    is_deleted: isDeleted
                };
                store.put(mapped);
                const idx = appState.colonies.findIndex(x => x.id === id);
                if (idx >= 0) appState.colonies[idx] = mapped;
                else appState.colonies.push(mapped);
            });
            console.info(`[D.U.B.I.A.] Colonie cloud: ${coloniesMap.size}.`);
        }

        if (typeof showNotification === 'function') {
            showNotification("Sincronizzazione", "Dati cloud caricati con successo.", "success");
        }
        flushOfflineQueue();
        startBackgroundSync();

    } catch (e) {
        console.warn("[D.U.B.I.A.] syncWithCloud error:", e.message);
        if (typeof showNotification === 'function') {
            showNotification("Errore di Sincronizzazione", "Impossibile sincronizzare con il cloud. Caricamento dati locali.", "warning");
        }
    } finally {
        appState.isSyncing = false;
        if (typeof updateUI === 'function') updateUI();
        if (typeof updateColoniesUI === 'function') updateColoniesUI();
        if (typeof updateClientiUI === 'function') updateClientiUI();
        
        // Avvia il precaricamento del clima in background
        if (typeof ClimateModule !== 'undefined' && typeof ClimateModule.preload === 'function') {
            ClimateModule.preload();
        }
    }
};

const loadInitialData = async () => {
    // ── STEP 1: Parametri da IndexedDB ──────────────────────────────────
    const storedParams = await new Promise((resolve) => {
        const tx = db.transaction("parameters", "readonly");
        const req = tx.objectStore("parameters").get(1);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror  = () => resolve(null);
    });
    appState.params = validateAndMigrateParams(storedParams);
    if (!storedParams) saveParams(appState.params);
    console.info(`[D.U.B.I.A.] Params: th1=${appState.params.theta1.toFixed(4)}, th2=${appState.params.theta2.toFixed(4)}`);

    // ── Prezzi personalizzati ────────────────────────────────────────────
    const storedPrices = await new Promise((resolve) => {
        const tx = db.transaction("parameters", "readonly");
        const req = tx.objectStore("parameters").get(2);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror  = () => resolve(null);
    });
    if (storedPrices && storedPrices.prices) {
        appState.customPrices = { ...DEFAULT_PRICES, ...storedPrices.prices };
    }

    // ── Carica dati locali (IndexedDB) ───────────────────────────────────
    await loadClientsAndCessioni();
    await loadColonies();
    await loadQuotes();

    // Carica misure locali (IndexedDB)
    await new Promise((resolve) => {
        const tx = db.transaction("measurements", "readonly");
        const req = tx.objectStore("measurements").getAll();
        req.onsuccess = () => {
            appState.measurements = (req.result || []).sort((a, b) => new Date(a.date) - new Date(b.date));
            resolve();
        };
        req.onerror = () => resolve();
    });

    // Forza render iniziale immediato con i dati locali
    if (typeof updateUI === 'function') updateUI();
    if (typeof updateColoniesUI === 'function') updateColoniesUI();
    if (typeof updateClientiUI === 'function') updateClientiUI();

    // Avvia sync cloud in background in modo asincrono
    syncWithCloud();

    return; // Ritorna immediatamente risolvendo la promise per sbloccare l'avvio dell'app!
};

const saveParams = (params) => {
    if (typeof db !== 'undefined' && db && typeof db.transaction === 'function') {
        const tx = db.transaction("parameters", "readwrite");
        const store = tx.objectStore("parameters");
        store.put({ id: 1, ...params });
    }
};

// ═══════════════════════════════════════════════════
// CLIENTI & CESSIONI — CRUD
// ═══════════════════════════════════════════════════

/**
 * Carica tutti i clienti e le cessioni da IndexedDB.
 */
const loadClientsAndCessioni = () => {
    return new Promise((resolve) => {
        const tx = db.transaction(["clients", "cessioni"], "readonly");
        const clientsStore = tx.objectStore("clients");
        const cessioniStore = tx.objectStore("cessioni");

        const clientsReq = clientsStore.getAll();
        const cessioniReq = cessioniStore.getAll();

        let clientsDone = false;
        let cessioniDone = false;

        clientsReq.onsuccess = () => {
            appState.clients = clientsReq.result || [];
            clientsDone = true;
            if (clientsDone && cessioniDone) resolve();
        };
        cessioniReq.onsuccess = () => {
            appState.cessioni = (cessioniReq.result || []).sort((a, b) => new Date(b.data) - new Date(a.data));
            cessioniDone = true;
            if (clientsDone && cessioniDone) resolve();
        };
        clientsReq.onerror = () => { clientsDone = true; if (clientsDone && cessioniDone) resolve(); };
        cessioniReq.onerror = () => { cessioniDone = true; if (clientsDone && cessioniDone) resolve(); };
    });
};

/**
 * Salva un nuovo cliente o aggiorna uno esistente in IndexedDB.
 * Se client.id è undefined, viene creato (autoIncrement).
 */
const saveClient = async (client) => {
    return new Promise((resolve) => {
        const tx = db.transaction("clients", "readwrite");
        const store = tx.objectStore("clients");
        const req = store.put(client);
        req.onsuccess = (e) => {
            if (!client.id) client.id = e.target.result;
            const idx = appState.clients.findIndex(c => c.id === client.id);
            if (idx >= 0) appState.clients[idx] = client;
            else appState.clients.push(client);
            // Sync cloud V2
            cloudPostWithQueue({ event_type: "cliente_sync", ...client });
            resolve(client);
        };
        req.onerror = () => resolve(null);
    });
};

/**
 * Elimina un cliente e tutte le sue cessioni.
 */
const deleteClient = (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction(["clients", "cessioni"], "readwrite");
        const clientsStore = tx.objectStore("clients");
        const cessioniStore = tx.objectStore("cessioni");
        clientsStore.delete(Number(id));
        appState.clients = appState.clients.filter(c => c.id !== Number(id));
        const cessioniReq = cessioniStore.getAll();
        cessioniReq.onsuccess = () => {
            const toDelete = (cessioniReq.result || []).filter(c => c.cliente_id === Number(id));
            toDelete.forEach(c => cessioniStore.delete(c.id));
            appState.cessioni = appState.cessioni.filter(c => c.cliente_id !== Number(id));
            // Sync cloud V2
            cloudPostWithQueue({ event_type: "cliente_delete", id: Number(id) });
            resolve();
        };
    });
};

/**
 * Salva una nuova cessione in IndexedDB.
 */
const saveCessione = async (cessione) => {
    return new Promise((resolve) => {
        const tx = db.transaction("cessioni", "readwrite");
        const store = tx.objectStore("cessioni");
        const req = store.add(cessione);
        req.onsuccess = (e) => {
            cessione.id = e.target.result;
            appState.cessioni.unshift(cessione);
            // Sync cloud V2
            cloudPostWithQueue({ event_type: "cessione_sync", ...cessione });
            resolve(cessione);
        };
        req.onerror = () => resolve(null);
    });
};

/**
 * Elimina una cessione per id.
 */
const deleteCessione = (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction("cessioni", "readwrite");
        const store = tx.objectStore("cessioni");
        store.delete(Number(id));
        appState.cessioni = appState.cessioni.filter(c => c.id !== Number(id));
        // Sync cloud V2
        cloudPostWithQueue({ event_type: "cessione_delete", id: Number(id) });
        resolve();
    });
};

/**
 * Salva i prezzi personalizzati in IndexedDB (store parameters, id=2).
 */
const savePrices = (prices) => {
    appState.customPrices = { ...prices };
    const tx = db.transaction("parameters", "readwrite");
    const store = tx.objectStore("parameters");
    store.put({ id: 2, prices });
};

// ═══════════════════════════════════════════════════
// PREVENTIVI / QUOTES — CRUD
// ═══════════════════════════════════════════════════

/**
 * Carica tutti i preventivi salvati da IndexedDB.
 */
const loadQuotes = () => {
    return new Promise((resolve) => {
        if (!db || !db.objectStoreNames.contains("quotes")) {
            appState.quotes = [];
            return resolve();
        }
        try {
            const tx = db.transaction("quotes", "readonly");
            const store = tx.objectStore("quotes");
            const req = store.getAll();
            req.onsuccess = () => {
                appState.quotes = (req.result || []).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
                resolve();
            };
            req.onerror = () => {
                appState.quotes = [];
                resolve();
            };
        } catch (e) {
            console.warn('[D.U.B.I.A.] loadQuotes fallback:', e);
            appState.quotes = [];
            resolve();
        }
    });
};

/**
 * Salva o aggiorna un preventivo in IndexedDB.
 */
const saveQuote = async (quote) => {
    return new Promise((resolve) => {
        if (!db || !db.objectStoreNames.contains("quotes")) {
            if (!quote.id) quote.id = Date.now();
            const idx = appState.quotes.findIndex(q => q.id === quote.id);
            if (idx >= 0) appState.quotes[idx] = quote;
            else appState.quotes.unshift(quote);
            return resolve(quote);
        }
        const tx = db.transaction("quotes", "readwrite");
        const store = tx.objectStore("quotes");
        const req = store.put(quote);
        req.onsuccess = (e) => {
            if (!quote.id) quote.id = e.target.result;
            const idx = appState.quotes.findIndex(q => q.id === quote.id);
            if (idx >= 0) appState.quotes[idx] = quote;
            else appState.quotes.unshift(quote);
            // Sync cloud
            cloudPostWithQueue({ event_type: "preventivo_sync", ...quote });
            resolve(quote);
        };
        req.onerror = () => resolve(null);
    });
};

/**
 * Elimina un preventivo per id.
 */
const deleteQuote = (id) => {
    return new Promise((resolve) => {
        if (!db || !db.objectStoreNames.contains("quotes")) {
            appState.quotes = appState.quotes.filter(q => q.id !== Number(id));
            return resolve();
        }
        const tx = db.transaction("quotes", "readwrite");
        const store = tx.objectStore("quotes");
        store.delete(Number(id));
        appState.quotes = appState.quotes.filter(q => q.id !== Number(id));
        cloudPostWithQueue({ event_type: "preventivo_delete", id: Number(id) });
        resolve();
    });
};

/**
 * Converte un preventivo accettato in una o più cessioni registrate nel database.
 */
const convertQuoteToCessione = async (quoteId) => {
    const quote = appState.quotes.find(q => q.id === Number(quoteId));
    if (!quote) return;

    // Trova o crea il cliente
    let clientId = quote.clientId;
    if (!clientId && quote.client && quote.client.nome) {
        // Cerca se esiste già un cliente con lo stesso nome
        const existing = appState.clients.find(c =>
            (c.nome + ' ' + (c.cognome || '')).toLowerCase().trim() ===
            (quote.client.nome + ' ' + (quote.client.cognome || '')).toLowerCase().trim()
        );
        if (existing) {
            clientId = existing.id;
        } else {
            const newClient = await saveClient({
                nome: quote.client.nome,
                cognome: quote.client.cognome || '',
                citta: quote.client.citta || '',
                telefono: quote.client.telefono || '',
                email: quote.client.email || '',
                animale: 'rettile',
                note: `Creato automaticamente da Preventivo ${quote.number || ''}`,
                data_aggiunta: new Date().toISOString().split('T')[0]
            });
            clientId = newClient?.id;
        }
    }

    if (!clientId && appState.clients.length > 0) {
        clientId = appState.clients[0].id;
    }

    // Registra una cessione per ogni articolo
    const items = quote.items || [];
    for (const item of items) {
        let tipoBlatta = 'SUBADULT';
        if (item.category === 'ADULT') tipoBlatta = 'FEMALE';
        else if (item.category === 'MEDIUM') tipoBlatta = 'MEDIUM';
        else if (item.category === 'SMALL') tipoBlatta = 'SMALL';
        else if (item.category === 'MIXED') tipoBlatta = 'SUBADULT';

        let quantitaG = 0;
        if (item.unit === 'kg') quantitaG = item.quantity * 1000;
        else if (item.unit === 'g') quantitaG = item.quantity;
        else if (item.unit === '100pz') {
            const massMap = { ADULT: 200, MEDIUM: 100, SMALL: 10, MIXED: 80, CUSTOM: 80 };
            quantitaG = item.quantity * (massMap[item.category] || 80);
        } else if (item.unit === 'pz') {
            const massMap = { ADULT: 2.0, MEDIUM: 1.0, SMALL: 0.1, MIXED: 0.8, CUSTOM: 0.8 };
            quantitaG = item.quantity * (massMap[item.category] || 0.8);
        }

        const cessione = {
            cliente_id: clientId || null,
            data: new Date().toISOString().split('T')[0],
            tipo_blatta: tipoBlatta,
            quantita_g: quantitaG,
            prezzo_unit: parseFloat(item.unitPrice || 0),
            totale_euro: parseFloat(item.total || 0),
            note: `Da preventivo ${quote.number || ''} (${item.categoryLabel || item.category}: ${item.quantity} ${item.unit})`
        };
        await saveCessione(cessione);
    }

    // Aggiorna stato preventivo a CONVERTED
    quote.status = 'CONVERTED';
    await saveQuote(quote);
    updateClientiUI();
    if (typeof showNotification === 'function') {
        showNotification("Preventivo Convertito", `Il preventivo ${quote.number} è stato registrato nello Storico Cessioni!`, "success");
    }
};

// ═══════════════════════════════════════════════════
// UI CLIENTI
// ═══════════════════════════════════════════════════

/**
 * Etichette e colori per tipo animale allevato.
 */
const ANIMAL_BADGES = {
    rettile:   { label: '🦎 Rettile',   color: '#27AE60' },
    anfibio:   { label: '🐸 Anfibio',   color: '#3498db' },
    uccello:   { label: '🦜 Uccello',   color: '#F2C94C' },
    mammifero: { label: '🐾 Mammifero', color: '#e67e22' },
    pesce:     { label: '🐟 Pesce',     color: '#1abc9c' },
    altro:     { label: '🐾 Altro',     color: '#95a5a6' }
};

/**
 * Etichette per tipo blatta nel form cessioni.
 */
const BLATTA_TYPES = [
    { value: 'FEMALE',   label: '🔴 Femmine Adulte (2.5g)',    mass: 2.5 },
    { value: 'MALE',     label: '🔵 Maschi Adulti (1.5g)',     mass: 1.5 },
    { value: 'SUBADULT', label: '🟡 Sub-Adulte (1.6g)',        mass: 1.6 },
    { value: 'MEDIUM',   label: '🟢 Neanidi Medie (0.8g)',     mass: 0.8 },
    { value: 'SMALL',    label: '⚪ Neanidi Piccole (0.3g)',   mass: 0.3 },
    { value: 'BABY',     label: '🟡 Micro-Neanidi (0.1g)',     mass: 0.1 }
];

/**
 * Aggiorna tutta la UI della sezione Clienti.
 * Chiamata dopo ogni modifica a clients/cessioni.
 */
const updateClientiUI = (filterClientId = null) => {
    const clients = appState.clients;
    const cessioni = appState.cessioni;

    // ── Stat Cards ───────────────────────────────────────────────────────────
    const totalGrammi = cessioni.reduce((sum, c) => sum + (parseFloat(c.quantita_g) || 0), 0);
    const totalEuro = cessioni.reduce((sum, c) => sum + (parseFloat(c.totale_euro) || 0), 0);

    const elClientiTot = document.getElementById('clientiTotali');
    const elCessioniTot = document.getElementById('cessioniTotali');
    const elGrammiTot = document.getElementById('grammiCeduti');
    const elEuroTot = document.getElementById('euroTotale');

    if (elClientiTot) elClientiTot.textContent = clients.length;
    if (elCessioniTot) elCessioniTot.textContent = cessioni.length;
    if (elGrammiTot) elGrammiTot.textContent = totalGrammi.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' g';
    if (elEuroTot) elEuroTot.textContent = '€ ' + totalEuro.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // ── Lista Clienti ────────────────────────────────────────────────────────
    const listEl = document.getElementById('clientiList');
    if (!listEl) return;

    const searchVal = (document.getElementById('clientiSearch')?.value || '').toLowerCase();
    const filtered = clients.filter(c =>
        !searchVal ||
        (c.nome + ' ' + c.cognome).toLowerCase().includes(searchVal) ||
        (c.citta || '').toLowerCase().includes(searchVal) ||
        (c.animale || '').toLowerCase().includes(searchVal)
    );

    if (filtered.length === 0) {
        if (appState.isSyncing) {
            listEl.innerHTML = `
                <div class="clienti-empty">
                    <span class="clienti-empty-icon loading-spin">⏳</span>
                    <p>Sincronizzazione clienti in corso...</p>
                    <p class="subtitle-text">Attendere prego, caricamento dei dati dal cloud.</p>
                </div>`;
        } else {
            listEl.innerHTML = `
                <div class="clienti-empty">
                    <span class="clienti-empty-icon">👥</span>
                    <p>Nessun cliente trovato.</p>
                    <p class="subtitle-text">Clicca su <strong>+ Nuovo Cliente</strong> per aggiungerne uno.</p>
                </div>`;
        }
    } else {
        listEl.innerHTML = filtered.map(c => {
            const badge = ANIMAL_BADGES[c.animale] || ANIMAL_BADGES.altro;
            const cessioniCliente = cessioni.filter(ce => ce.cliente_id === c.id);
            const grammiCliente = cessioniCliente.reduce((s, ce) => s + (parseFloat(ce.quantita_g) || 0), 0);
            const ultimaCessione = cessioniCliente[0];
            return `
            <div class="client-card" data-id="${c.id}">
                <div class="client-card-header">
                    <div class="client-avatar">${(c.nome || '?')[0]}${(c.cognome || '')[0] || ''}</div>
                    <div class="client-info">
                        <div class="client-name">${c.nome} ${c.cognome}</div>
                        ${c.citta ? `<div class="client-location">📍 ${c.citta}</div>` : ''}
                    </div>
                    <span class="animal-badge" style="background: ${badge.color}22; color: ${badge.color}; border-color: ${badge.color}44;">${badge.label}</span>
                </div>
                <div class="client-contacts">
                    ${c.telefono ? `<a href="tel:${c.telefono}" class="client-contact-chip">📞 ${c.telefono}</a>` : ''}
                    ${c.email ? `<a href="mailto:${c.email}" class="client-contact-chip">✉️ ${c.email}</a>` : ''}
                </div>
                ${c.note ? `<div class="client-note">"${c.note}"</div>` : ''}
                <div class="client-card-footer">
                    <div class="client-stats">
                        <span class="client-stat"><strong>${cessioniCliente.length}</strong> cessioni · <strong>${grammiCliente.toFixed(0)} g</strong> ceduti</span>
                        ${ultimaCessione ? `<span class="client-stat-date">Ultima: ${ultimaCessione.data}</span>` : ''}
                    </div>
                    <div class="client-actions">
                        <button class="btn-standard btn-client-cessione" data-id="${c.id}" title="Registra cessione">📦 Cessione</button>
                        <button class="btn-standard btn-client-edit" data-id="${c.id}" title="Modifica cliente">✏️</button>
                        <button class="btn-standard btn-client-delete" data-id="${c.id}" title="Elimina cliente">🗑️</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    // ── Tabella Storico Cessioni ──────────────────────────────────────────────
    const tbody = document.querySelector('#cessioniTable tbody');
    if (!tbody) return;

    const cessioniToShow = filterClientId
        ? cessioni.filter(c => c.cliente_id === Number(filterClientId))
        : cessioni;

    // Aggiorna filtro dropdown
    const filterSelect = document.getElementById('cessioniFilterCliente');
    if (filterSelect) {
        const currentVal = filterSelect.value;
        filterSelect.innerHTML = '<option value="">Tutti i clienti</option>' +
            clients.map(c => `<option value="${c.id}" ${c.id == currentVal ? 'selected' : ''}>${c.nome} ${c.cognome}</option>`).join('');
    }

    if (cessioniToShow.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Nessuna cessione registrata.</td></tr>`;
    } else {
        tbody.innerHTML = cessioniToShow.map(c => {
            const cliente = clients.find(cl => cl.id === c.cliente_id);
            const nomeCliente = cliente ? `${cliente.nome} ${cliente.cognome}` : '—';
            const blattaType = BLATTA_TYPES.find(b => b.value === c.tipo_blatta);
            const blattaLabel = blattaType ? blattaType.label : c.tipo_blatta || '—';
            const nIndividui = blattaType && c.quantita_g ? Math.round(c.quantita_g / blattaType.mass) : '—';
            return `
            <tr>
                <td>${c.data}</td>
                <td><strong>${nomeCliente}</strong></td>
                <td>${blattaLabel}</td>
                <td>${parseFloat(c.quantita_g || 0).toFixed(1)} g
                    ${nIndividui !== '—' ? `<br><small style="color:var(--text-muted)">≈ ${nIndividui} ind.</small>` : ''}
                </td>
                <td style="color: var(--accent-green);">€ ${parseFloat(c.totale_euro || 0).toFixed(2)}</td>
                <td style="max-width:150px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${c.note || ''}">${c.note || '—'}</td>
                <td>
                    <button class="btn-standard btn-danger btn-delete-cessione" data-id="${c.id}" style="padding:0.2rem 0.5rem;font-size:0.8rem;">🗑️</button>
                </td>
            </tr>`;
        }).join('');
    }

    // ── Aggiorna Preventivi e Grafico Prezzi ───────────────────────────────────
    updatePreventiviUI();
    renderPrezziChart();
};

/**
 * Renderizza o aggiorna il Grafico dei Prezzi Ufficiali (Chart.js)
 */
let _currentPriceChartMode = 'kg'; // 'kg', '100pz', 'log'

const renderPrezziChart = (mode = _currentPriceChartMode) => {
    _currentPriceChartMode = mode;
    const canvas = document.getElementById('prezziChart');
    if (!canvas) return;

    if (appState.charts.prezziChart) {
        appState.charts.prezziChart.destroy();
    }

    const categories = [
        COMMERCIAL_CATALOG.ADULT.label,
        COMMERCIAL_CATALOG.MIXED.label,
        COMMERCIAL_CATALOG.MEDIUM.label,
        COMMERCIAL_CATALOG.SMALL.label
    ];

    let datasetData = [];
    let yAxisLabel = 'Prezzo (€ / kg)';
    let isLog = false;

    if (mode === 'kg') {
        datasetData = [
            COMMERCIAL_CATALOG.ADULT.pricePerKg,
            COMMERCIAL_CATALOG.MIXED.pricePerKg,
            COMMERCIAL_CATALOG.MEDIUM.pricePerKg,
            COMMERCIAL_CATALOG.SMALL.pricePerKg
        ];
        yAxisLabel = 'Prezzo al Kg (€ / kg)';
    } else if (mode === '100pz') {
        datasetData = [
            COMMERCIAL_CATALOG.ADULT.pricePer100, // 8.00
            null,
            COMMERCIAL_CATALOG.MEDIUM.pricePer100, // 14.00
            COMMERCIAL_CATALOG.SMALL.pricePer100  // 12.50
        ];
        yAxisLabel = 'Prezzo per 100 Pezzi (€ / 100 pz)';
    } else if (mode === 'log') {
        datasetData = [
            COMMERCIAL_CATALOG.ADULT.pricePerKg,
            COMMERCIAL_CATALOG.MIXED.pricePerKg,
            COMMERCIAL_CATALOG.MEDIUM.pricePerKg,
            COMMERCIAL_CATALOG.SMALL.pricePerKg
        ];
        yAxisLabel = 'Prezzo al Kg (€ / kg) - Scala Logaritmica';
        isLog = true;
    }

    const bgColors = [
        'rgba(231, 76, 60, 0.85)',
        'rgba(155, 89, 182, 0.85)',
        'rgba(46, 204, 113, 0.85)',
        'rgba(243, 156, 18, 0.85)'
    ];

    const borderColors = ['#e74c3c', '#9b59b6', '#2ecc71', '#f39c12'];

    const ctx = canvas.getContext('2d');
    appState.charts.prezziChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: categories,
            datasets: [{
                label: yAxisLabel,
                data: datasetData,
                backgroundColor: bgColors,
                borderColor: borderColors,
                borderWidth: 2,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const val = context.raw;
                            if (val === null || val === undefined) return ' Solo vendita al kg';
                            if (mode === '100pz') return ` € ${val.toFixed(2)} / 100 pezzi`;
                            return ` € ${val.toFixed(2)} / kg`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    type: isLog ? 'logarithmic' : 'linear',
                    beginAtZero: !isLog,
                    grid: { color: 'rgba(255, 255, 255, 0.08)' },
                    ticks: {
                        color: '#95a5a6',
                        callback: (v) => '€ ' + v
                    },
                    title: {
                        display: true,
                        text: yAxisLabel,
                        color: '#bdc3c7',
                        font: { size: 12, weight: 'bold' }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#ecf0f1', font: { weight: '600' } }
                }
            }
        }
    });
};

/**
 * Aggiorna la tabella dei Preventivi nella sezione Clienti.
 */
const updatePreventiviUI = () => {
    const tbody = document.getElementById('preventiviTableBody');
    if (!tbody) return;

    const quotes = appState.quotes || [];
    if (quotes.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="table-empty">Nessun preventivo registrato. Clicca su <strong>+ Nuovo Preventivo</strong> per crearne uno.</td></tr>`;
        return;
    }

    const STATUS_LABELS = {
        DRAFT: { label: 'Bozza', class: 'quote-status-DRAFT' },
        SENT: { label: 'Inviato', class: 'quote-status-SENT' },
        ACCEPTED: { label: 'Accettato', class: 'quote-status-ACCEPTED' },
        CONVERTED: { label: 'Convertito in Cessione', class: 'quote-status-CONVERTED' },
        REJECTED: { label: 'Non Confermato', class: 'quote-status-REJECTED' }
    };

    tbody.innerHTML = quotes.map(q => {
        const statusInfo = STATUS_LABELS[q.status] || STATUS_LABELS.SENT;
        const clientName = q.client ? (q.client.nome ? `${q.client.nome} ${q.client.cognome || ''}` : (q.client.name || 'Cliente')) : '—';
        const isMichael = (q.channel === 'MICHAEL') || (!q.channel && (!q.shipping || parseFloat(q.shipping) === 0));
        const channelBadge = isMichael
            ? `<span class="badge" style="background:rgba(39, 174, 96, 0.2); color:#2ecc71; border:1px solid rgba(39, 174, 96, 0.4); font-size:0.72rem; padding:0.15rem 0.5rem; border-radius:999px;">🤝 Michael</span>`
            : `<span class="badge" style="background:rgba(52, 152, 219, 0.2); color:#3498db; border:1px solid rgba(52, 152, 219, 0.4); font-size:0.72rem; padding:0.15rem 0.5rem; border-radius:999px;">🛍️ Diretto</span>`;

        const itemsSummary = (q.items || []).map(it => `${it.quantity} ${it.unit} ${it.categoryLabel || it.category}`).join(', ') || 'Nessun articolo';
        const total = parseFloat(q.grandTotal || 0).toFixed(2);

        return `
        <tr>
            <td><strong>${q.number || 'PREV'}</strong></td>
            <td>${q.date || '—'}</td>
            <td>
                <strong>${clientName}</strong>
                <div style="margin-top:0.25rem;">${channelBadge}</div>
            </td>
            <td style="max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${itemsSummary}">${itemsSummary}</td>
            <td style="color: var(--accent-green); font-weight: 700;">€ ${total}</td>
            <td><span class="quote-status-badge ${statusInfo.class}">${statusInfo.label}</span></td>
            <td>
                <div style="display:flex; gap:0.35rem; align-items:center;">
                    <button class="btn-standard btn-quote-pdf" data-id="${q.id}" title="Scarica PDF" style="padding:0.25rem 0.5rem; font-size:0.8rem; background:linear-gradient(135deg,#e67e22,#d35400);">📥 PDF</button>
                    <button class="btn-standard btn-quote-edit" data-id="${q.id}" title="Modifica preventivo" style="padding:0.25rem 0.5rem; font-size:0.8rem;">✏️</button>
                    ${q.status !== 'CONVERTED' ? `<button class="btn-standard btn-quote-convert" data-id="${q.id}" title="Converti in Cessione" style="padding:0.25rem 0.5rem; font-size:0.8rem; background:rgba(142,68,173,0.3); border-color:var(--accent-purple);">📦</button>` : ''}
                    <button class="btn-standard btn-danger btn-quote-delete" data-id="${q.id}" title="Elimina" style="padding:0.25rem 0.5rem; font-size:0.8rem;">🗑️</button>
                </div>
            </td>
        </tr>`;
    }).join('');
};

/**
 * Aggiunge o renderizza una riga articolo nel form del preventivo.
 */
const renderQuoteItemRow = (item = null) => {
    const container = document.getElementById('quoteItemsContainer');
    if (!container) return;

    const rowId = 'quote_row_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const rowEl = document.createElement('div');
    rowEl.className = 'quote-item-row';
    rowEl.id = rowId;

    const catValue = item?.category || 'ADULT';
    const unitValue = item?.unit || (catValue === 'MEDIUM' || catValue === 'SMALL' ? '100pz' : 'kg');
    const qtyValue = item?.quantity !== undefined ? item.quantity : 1;

    let defaultPrice = 40.00;
    if (COMMERCIAL_CATALOG[catValue]) {
        defaultPrice = (unitValue === '100pz' && COMMERCIAL_CATALOG[catValue].pricePer100 !== null)
            ? COMMERCIAL_CATALOG[catValue].pricePer100
            : (unitValue === 'g' ? COMMERCIAL_CATALOG[catValue].pricePerKg / 1000 : COMMERCIAL_CATALOG[catValue].pricePerKg);
    }
    const priceValue = item?.unitPrice !== undefined ? item.unitPrice : defaultPrice;

    rowEl.innerHTML = `
        <div class="form-group" style="margin:0;">
            <select class="input-standard quote-item-cat" style="width:100%;">
                <option value="ADULT" ${catValue === 'ADULT' ? 'selected' : ''}>🔴 Blatte Adulte (2-2.5cm)</option>
                <option value="MIXED" ${catValue === 'MIXED' ? 'selected' : ''}>🟣 Colonia Mista Avviata</option>
                <option value="MEDIUM" ${catValue === 'MEDIUM' ? 'selected' : ''}>🟢 Neanidi Medie (1-1.5cm)</option>
                <option value="SMALL" ${catValue === 'SMALL' ? 'selected' : ''}>🟡 Neanidi Small (1-8mm)</option>
                <option value="CUSTOM" ${catValue === 'CUSTOM' ? 'selected' : ''}>⚪ Articolo Personalizzato</option>
            </select>
        </div>
        <div class="form-group" style="margin:0;">
            <select class="input-standard quote-item-unit" style="width:100%;">
                <option value="kg" ${unitValue === 'kg' ? 'selected' : ''}>Kg</option>
                <option value="g" ${unitValue === 'g' ? 'selected' : ''}>Grammi (g)</option>
                <option value="100pz" ${unitValue === '100pz' ? 'selected' : ''}>100 Pezzi</option>
                <option value="pz" ${unitValue === 'pz' ? 'selected' : ''}>Pezzi singoli</option>
            </select>
        </div>
        <div class="form-group" style="margin:0;">
            <input type="number" class="input-standard quote-item-qty" value="${qtyValue}" step="0.1" min="0.1" placeholder="Qtà" style="width:100%;">
        </div>
        <div class="form-group" style="margin:0;">
            <input type="number" class="input-standard quote-item-price" value="${priceValue.toFixed(2)}" step="0.50" min="0" placeholder="€ Unit." style="width:100%;">
        </div>
        <div style="font-weight:700; color:var(--accent-green); text-align:right; font-size:0.9rem;" class="quote-item-subtotal">
            € 0,00
        </div>
        <div>
            <button type="button" class="btn-standard btn-danger btn-remove-quote-item" style="padding:0.35rem 0.6rem; font-size:0.8rem;" title="Rimuovi voce">✕</button>
        </div>
    `;

    container.appendChild(rowEl);

    // Gestione cambio categoria e unità
    const catSelect = rowEl.querySelector('.quote-item-cat');
    const unitSelect = rowEl.querySelector('.quote-item-unit');
    const priceInput = rowEl.querySelector('.quote-item-price');
    const qtyInput = rowEl.querySelector('.quote-item-qty');

    const updateRowDefaultPrice = () => {
        const cat = catSelect.value;
        const u = unitSelect.value;
        const catalogEntry = COMMERCIAL_CATALOG[cat];
        if (catalogEntry) {
            if (u === 'kg') priceInput.value = catalogEntry.pricePerKg.toFixed(2);
            else if (u === 'g') priceInput.value = (catalogEntry.pricePerKg / 1000).toFixed(3);
            else if (u === '100pz') priceInput.value = (catalogEntry.pricePer100 !== null ? catalogEntry.pricePer100 : (catalogEntry.pricePerKg * 0.2)).toFixed(2);
            else if (u === 'pz') priceInput.value = (catalogEntry.pricePer100 !== null ? catalogEntry.pricePer100 / 100 : (catalogEntry.pricePerKg * 0.002)).toFixed(3);
        }
        recalculateQuoteTotals();
    };

    catSelect.addEventListener('change', () => {
        const cat = catSelect.value;
        if (cat === 'MEDIUM' || cat === 'SMALL') {
            unitSelect.value = '100pz';
        } else if (cat === 'ADULT' || cat === 'MIXED') {
            unitSelect.value = 'kg';
        }
        updateRowDefaultPrice();
    });

    unitSelect.addEventListener('change', updateRowDefaultPrice);
    priceInput.addEventListener('input', recalculateQuoteTotals);
    qtyInput.addEventListener('input', recalculateQuoteTotals);

    rowEl.querySelector('.btn-remove-quote-item').addEventListener('click', () => {
        rowEl.remove();
        recalculateQuoteTotals();
    });

    recalculateQuoteTotals();
};

/**
 * Calcola i totali live del preventivo attualmente aperto nel modale.
 */
const recalculateQuoteTotals = () => {
    const channel = document.getElementById('quoteChannel')?.value || 'MICHAEL';
    const isMichael = channel === 'MICHAEL';

    const shippingGroup = document.getElementById('quoteShippingGroup');
    if (shippingGroup) {
        shippingGroup.style.display = isMichael ? 'none' : 'block';
    }

    const rows = document.querySelectorAll('#quoteItemsContainer .quote-item-row');
    let subtotal = 0;
    let totalBiomassG = 0;
    let totalInsectCount = 0;

    rows.forEach(row => {
        const cat = row.querySelector('.quote-item-cat')?.value || 'ADULT';
        const unit = row.querySelector('.quote-item-unit')?.value || 'kg';
        const qty = parseFloat(row.querySelector('.quote-item-qty')?.value) || 0;
        const price = parseFloat(row.querySelector('.quote-item-price')?.value) || 0;

        const rowTotal = qty * price;
        subtotal += rowTotal;

        const subtotalEl = row.querySelector('.quote-item-subtotal');
        if (subtotalEl) {
            subtotalEl.textContent = `€ ${rowTotal.toFixed(2)}`;
        }

        // Stima biomassa e conteggio
        let massG = 0;
        let count = 0;
        if (unit === 'kg') {
            massG = qty * 1000;
            count = cat === 'ADULT' ? massG / 2.0 : (cat === 'MEDIUM' ? massG / 1.0 : (cat === 'SMALL' ? massG / 0.1 : massG / 0.8));
        } else if (unit === 'g') {
            massG = qty;
            count = cat === 'ADULT' ? massG / 2.0 : (cat === 'MEDIUM' ? massG / 1.0 : (cat === 'SMALL' ? massG / 0.1 : massG / 0.8));
        } else if (unit === '100pz') {
            count = qty * 100;
            massG = cat === 'ADULT' ? count * 2.0 : (cat === 'MEDIUM' ? count * 1.0 : (cat === 'SMALL' ? count * 0.1 : count * 0.8));
        } else if (unit === 'pz') {
            count = qty;
            massG = cat === 'ADULT' ? count * 2.0 : (cat === 'MEDIUM' ? count * 1.0 : (cat === 'SMALL' ? count * 0.1 : count * 0.8));
        }

        totalBiomassG += massG;
        totalInsectCount += count;
    });

    const shipping = isMichael ? 0 : (parseFloat(document.getElementById('quoteShipping')?.value) || 0);
    const discount = parseFloat(document.getElementById('quoteDiscount')?.value) || 0;
    const grandTotal = Math.max(0, subtotal + shipping - discount);

    const elSubtotal = document.getElementById('quoteSubtotalText');
    const elShipping = document.getElementById('quoteShippingText');
    const elDiscount = document.getElementById('quoteDiscountText');
    const elGrandTotal = document.getElementById('quoteGrandTotalText');
    const elBiomass = document.getElementById('quoteBiomassSummary');

    if (elSubtotal) elSubtotal.textContent = `€ ${subtotal.toFixed(2)}`;
    if (elShipping) {
        if (isMichael) {
            elShipping.parentElement.style.display = 'inline';
            elShipping.textContent = '€ 0,00 (Non applicata)';
        } else {
            elShipping.parentElement.style.display = 'inline';
            elShipping.textContent = `€ ${shipping.toFixed(2)}`;
        }
    }
    if (elDiscount) elDiscount.textContent = `€ ${discount.toFixed(2)}`;
    if (elGrandTotal) elGrandTotal.textContent = `€ ${grandTotal.toFixed(2)}`;
    if (elBiomass) {
        elBiomass.textContent = `Biomassa totale: ~${totalBiomassG.toFixed(0)} g · Individui stimati: ~${Math.round(totalInsectCount)}`;
    }

    return { subtotal, shipping, discount, grandTotal, totalBiomassG, totalInsectCount, channel };
};

/**
 * Apre il modale per la creazione o modifica di un preventivo.
 */
const openQuoteModal = (quote = null) => {
    const modal = document.getElementById('quoteModal');
    if (!modal) return;
    const form = document.getElementById('quoteForm');
    form.reset();

    const itemsContainer = document.getElementById('quoteItemsContainer');
    if (itemsContainer) itemsContainer.innerHTML = '';

    // Popola select clienti
    const clientSelect = document.getElementById('quoteClientSelect');
    if (clientSelect) {
        clientSelect.innerHTML = '<option value="">— Seleziona da Anagrafica Clienti —</option>' +
            appState.clients.map(c => `<option value="${c.id}">${c.nome} ${c.cognome} (${c.citta || 'N/D'})</option>`).join('');
    }

    const titleEl = document.getElementById('quoteModalTitle');
    const btnConvert = document.getElementById('btnConvertQuoteToCessione');
    const quoteChannelSelect = document.getElementById('quoteChannel');

    if (quote) {
        if (titleEl) titleEl.innerHTML = `<span>📄</span> Modifica Preventivo <strong>${quote.number || ''}</strong>`;
        document.getElementById('quoteId').value = quote.id || '';
        if (quoteChannelSelect) quoteChannelSelect.value = quote.channel || 'MICHAEL';
        document.getElementById('quoteNumber').value = quote.number || '';
        document.getElementById('quoteDate').value = quote.date || new Date().toISOString().split('T')[0];
        document.getElementById('quoteValidity').value = quote.validityDays || 15;
        document.getElementById('quoteStatus').value = quote.status || 'SENT';
        document.getElementById('quoteShipping').value = parseFloat(quote.shipping || 0).toFixed(2);
        document.getElementById('quoteDiscount').value = parseFloat(quote.discount || 0).toFixed(2);
        document.getElementById('quotePaymentTerms').value = quote.paymentTerms || 'Saldo a consegna / Bonifico';
        document.getElementById('quoteNotes').value = quote.notes || '';

        // Dati cliente
        if (quote.clientId) {
            document.getElementById('radioClientExisting').checked = true;
            document.getElementById('quoteClientExistingBlock').style.display = 'block';
            document.getElementById('quoteClientManualBlock').style.display = 'none';
            if (clientSelect) clientSelect.value = quote.clientId;
        } else if (quote.client) {
            document.getElementById('radioClientManual').checked = true;
            document.getElementById('quoteClientExistingBlock').style.display = 'none';
            document.getElementById('quoteClientManualBlock').style.display = 'grid';
            document.getElementById('quoteClientNome').value = quote.client.nome || quote.client.name || '';
            document.getElementById('quoteClientCitta').value = quote.client.citta || '';
            document.getElementById('quoteClientTelefono').value = quote.client.telefono || '';
            document.getElementById('quoteClientEmail').value = quote.client.email || '';
        }

        // Righe articoli
        if (quote.items && quote.items.length > 0) {
            quote.items.forEach(it => renderQuoteItemRow(it));
        } else {
            renderQuoteItemRow(null);
        }

        if (btnConvert) {
            btnConvert.style.display = quote.status !== 'CONVERTED' ? 'inline-block' : 'none';
            btnConvert.onclick = () => convertQuoteToCessione(quote.id);
        }
    } else {
        if (titleEl) titleEl.innerHTML = `<span>📄</span> Nuovo Preventivo di Vendita`;
        document.getElementById('quoteId').value = '';
        if (quoteChannelSelect) quoteChannelSelect.value = 'MICHAEL';
        const currentYear = new Date().getFullYear();
        const nextNum = (appState.quotes.length + 1).toString().padStart(3, '0');
        document.getElementById('quoteNumber').value = `PREV-${currentYear}-${nextNum}`;
        document.getElementById('quoteDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('quoteValidity').value = 15;
        document.getElementById('quoteStatus').value = 'SENT';
        document.getElementById('quoteShipping').value = '0.00';
        document.getElementById('quoteDiscount').value = '0.00';
        document.getElementById('quotePaymentTerms').value = 'Saldo a consegna / Bonifico';
        document.getElementById('quoteNotes').value = 'Accordi di fornitura riservata intermediario Michael. Consegna diretta senza spese di spedizione.';

        document.getElementById('radioClientManual').checked = true;
        document.getElementById('quoteClientExistingBlock').style.display = 'none';
        document.getElementById('quoteClientManualBlock').style.display = 'grid';
        document.getElementById('quoteClientNome').value = 'Michael (Intermediario)';
        document.getElementById('quoteClientCitta').value = '';

        // Riga di default (1 kg Adulte)
        renderQuoteItemRow({
            category: 'ADULT',
            unit: 'kg',
            quantity: 1,
            unitPrice: 40.00
        });

        if (btnConvert) btnConvert.style.display = 'none';
    }

    recalculateQuoteTotals();
    modal.classList.add('active');
};

/**
 * Helper sicuro per recuperare la classe costruttore di jsPDF.
 */
const getJsPDFClass = () => {
    if (typeof window !== 'undefined') {
        if (window.jspdf && typeof window.jspdf.jsPDF === 'function') return window.jspdf.jsPDF;
        if (typeof window.jsPDF === 'function') return window.jsPDF;
    }
    return null;
};

/**
 * Esegue autoTable in modo sicuro su qualsiasi versione/ambiente jsPDF con fallback testuale.
 */
const safeAutoTable = (doc, options) => {
    let finalY = options.startY || 60;
    try {
        if (typeof doc.autoTable === 'function') {
            doc.autoTable(options);
            return (doc.lastAutoTable && doc.lastAutoTable.finalY) ? doc.lastAutoTable.finalY : finalY + 40;
        } else if (window.jspdfAutoTable && typeof window.jspdfAutoTable.default === 'function') {
            window.jspdfAutoTable.default(doc, options);
            return (doc.lastAutoTable && doc.lastAutoTable.finalY) ? doc.lastAutoTable.finalY : finalY + 40;
        } else if (window.jspdfAutoTable && typeof window.jspdfAutoTable === 'function') {
            window.jspdfAutoTable(doc, options);
            return (doc.lastAutoTable && doc.lastAutoTable.finalY) ? doc.lastAutoTable.finalY : finalY + 40;
        } else if (typeof window.autoTable === 'function') {
            window.autoTable(doc, options);
            return (doc.lastAutoTable && doc.lastAutoTable.finalY) ? doc.lastAutoTable.finalY : finalY + 40;
        }
    } catch (err) {
        console.warn("safeAutoTable warning (utilizzo fallback grafico/testuale):", err);
    }

    // Fallback tabellare manuale nel caso il plugin autoTable non sia caricato
    let y = finalY;
    if (options.head && options.head[0]) {
        doc.setFillColor(24, 43, 73);
        doc.rect(15, y, 180, 7, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.text(options.head[0].join('  |  '), 18, y + 4.8);
        y += 9;
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.setTextColor(44, 62, 80);
    if (options.body && Array.isArray(options.body)) {
        options.body.forEach(row => {
            const line = Array.isArray(row) ? row.slice(0, 3).join('  -  ') : String(row);
            doc.text(line.substring(0, 95), 18, y);
            y += 5.5;
        });
    }
    return y + 4;
};

/**
 * Salva e scarica il documento PDF in modo compatibile su tutti i browser e dispositivi.
 */
const savePdfDocument = (doc, fileName) => {
    try {
        doc.save(fileName);
        return true;
    } catch (saveErr) {
        console.warn("doc.save() standard non riuscito, avvio download alternativo tramite Blob URL:", saveErr);
        try {
            const blob = doc.output('blob');
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
            }, 2500);
            return true;
        } catch (blobErr) {
            console.error("Download Blob fallito, apertura dataURI:", blobErr);
            try {
                const dataUri = doc.output('datauristring');
                const win = window.open();
                if (win) {
                    win.document.write(`<iframe src="${dataUri}" frameborder="0" style="border:0; top:0; left:0; bottom:0; right:0; width:100%; height:100%;" allowfullscreen></iframe>`);
                } else {
                    window.location.href = dataUri;
                }
                return true;
            } catch (finalErr) {
                console.error("Impossibile scaricare il PDF:", finalErr);
                return false;
            }
        }
    }
};

/**
 * Esporta il preventivo in PDF ad alta qualità con jsPDF e autoTable.
 */
const exportQuotePDF = (quote) => {
    const JsPDFClass = getJsPDFClass();
    if (!JsPDFClass) {
        alert("Libreria jsPDF non disponibile al momento. Verifica la connessione a Internet.");
        return;
    }

    try {
        const doc = new JsPDFClass({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        const isMichael = (quote.channel === 'MICHAEL') || (!quote.shipping || parseFloat(quote.shipping) === 0);

        const primaryColor = [24, 43, 73];    // #182B49
        const goldColor = [242, 201, 76];     // #F2C94C
        const darkGray = [44, 62, 80];
        const lightGray = [245, 247, 250];

        // ── HEADER BANNER ──
        doc.setFillColor(...primaryColor);
        doc.rect(0, 0, 210, 38, 'F');

        // Title / Brand
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(22);
        doc.text('D.U.B.I.A.', 15, 18);

        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(200, 210, 225);
        doc.text('Dynamic Updating Biomass Inference Algorithm', 15, 24);
        doc.text('Allevamento Selezionato Blatta Lateralis & Blatta Dubia', 15, 29);

        // Document Type on right
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(...goldColor);
        const docTitle = isMichael ? 'PREVENTIVO RISERVATO INTERMEDIARIO' : 'PREVENTIVO COMMERCIALE';
        doc.text(docTitle, 195, 18, { align: 'right' });

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(255, 255, 255);
        doc.text(`Doc. N°: ${quote.number || 'PREV-001'}`, 195, 25, { align: 'right' });
        doc.text(`Data: ${quote.date || new Date().toISOString().split('T')[0]}`, 195, 30, { align: 'right' });

        // ── INFO BOXES (Fornitore & Cliente) ──
        const startY = 46;

        // Box Fornitore
        doc.setFillColor(...lightGray);
        doc.roundedRect(15, startY, 86, 32, 2, 2, 'F');
        doc.setDrawColor(220, 225, 230);
        doc.roundedRect(15, startY, 86, 32, 2, 2, 'S');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...primaryColor);
        doc.text('EMESSO DA (Allevatore):', 19, startY + 6);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...darkGray);
        doc.text('Allevamento D.U.B.I.A.', 19, startY + 12);
        doc.text(isMichael ? 'Canale: Fornitura Riservata Intermediario' : 'Specializzato in Insetti da Pasto & Colonie', 19, startY + 17);
        doc.text(isMichael ? 'Spedizione: Non applicata (Consegna Diretta)' : 'Termini: Box isotermico + Heat pack', 19, startY + 22);
        doc.text('Validità offerta: ' + (quote.validityDays || 15) + ' giorni', 19, startY + 27);

        // Box Cliente
        doc.setFillColor(...lightGray);
        doc.roundedRect(109, startY, 86, 32, 2, 2, 'F');
        doc.roundedRect(109, startY, 86, 32, 2, 2, 'S');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...primaryColor);
        doc.text(isMichael ? 'INTERMEDIARIO / DESTINATARIO:' : 'DESTINATARIO / CLIENTE:', 113, startY + 6);

        const client = quote.client || {};
        const clientName = client.nome ? `${client.nome} ${client.cognome || ''}` : (client.name || (isMichael ? 'Michael' : 'Gentile Cliente'));

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...darkGray);
        doc.text(clientName, 113, startY + 12);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(100, 110, 120);

        if (client.citta) {
            doc.text(`Città: ${client.citta}`, 113, startY + 17);
        }
        if (client.telefono) {
            doc.text(`Tel: ${client.telefono}`, 113, startY + 22);
        }
        if (client.email) {
            doc.text(`Email: ${client.email}`, 113, startY + 27);
        }

        // ── TABELLA ARTICOLI PREVENTIVATI ──
        const tableBody = (quote.items || []).map((it, idx) => [
            (idx + 1).toString(),
            it.categoryLabel || it.category,
            it.size || '—',
            `${it.quantity} ${it.unit || 'kg'}`,
            `€ ${parseFloat(it.unitPrice || 0).toFixed(2)}`,
            `€ ${parseFloat(it.total || 0).toFixed(2)}`
        ]);

        let finalY = safeAutoTable(doc, {
            startY: 84,
            head: [['#', 'Articolo / Specie', 'Taglia / Descrizione', 'Quantità', 'Prezzo Unit.', 'Totale']],
            body: tableBody,
            theme: 'striped',
            headStyles: {
                fillColor: primaryColor,
                textColor: [255, 255, 255],
                fontStyle: 'bold',
                fontSize: 9,
                halign: 'left'
            },
            columnStyles: {
                0: { halign: 'center', cellWidth: 10 },
                1: { halign: 'left', cellWidth: 60, fontStyle: 'bold' },
                2: { halign: 'left', cellWidth: 40 },
                3: { halign: 'center', cellWidth: 25 },
                4: { halign: 'right', cellWidth: 25 },
                5: { halign: 'right', cellWidth: 25, fontStyle: 'bold' }
            },
            styles: {
                fontSize: 8.5,
                cellPadding: 3.5,
                valign: 'middle'
            },
            alternateRowStyles: {
                fillColor: [248, 249, 250]
            }
        });

        finalY += 8;

        if (finalY > 230) {
            doc.addPage();
            finalY = 20;
        }

        // ── TOTALS BOX ──
        const totalsBoxX = 115;
        const totalsBoxWidth = 80;
        const totalsBoxHeight = isMichael ? 30 : 38;

        doc.setFillColor(...lightGray);
        doc.roundedRect(totalsBoxX, finalY, totalsBoxWidth, totalsBoxHeight, 2, 2, 'F');
        doc.setDrawColor(220, 225, 230);
        doc.roundedRect(totalsBoxX, finalY, totalsBoxWidth, totalsBoxHeight, 2, 2, 'S');

        doc.setFontSize(8.5);
        doc.setTextColor(...darkGray);
        doc.text('Subtotale Articoli:', totalsBoxX + 4, finalY + 7);
        doc.text(`€ ${parseFloat(quote.subtotal || 0).toFixed(2)}`, totalsBoxX + totalsBoxWidth - 4, finalY + 7, { align: 'right' });

        let curOffset = 13;
        if (!isMichael) {
            doc.text('Spedizione & Box Termico:', totalsBoxX + 4, finalY + curOffset);
            doc.text(`€ ${parseFloat(quote.shipping || 0).toFixed(2)}`, totalsBoxX + totalsBoxWidth - 4, finalY + curOffset, { align: 'right' });
            curOffset += 6;
        }

        if (parseFloat(quote.discount || 0) > 0) {
            doc.setTextColor(231, 76, 60);
            doc.text('Sconto Applicato:', totalsBoxX + 4, finalY + curOffset);
            doc.text(`- € ${parseFloat(quote.discount).toFixed(2)}`, totalsBoxX + totalsBoxWidth - 4, finalY + curOffset, { align: 'right' });
            curOffset += 6;
        }

        doc.setDrawColor(200, 200, 200);
        doc.line(totalsBoxX + 4, finalY + curOffset, totalsBoxX + totalsBoxWidth - 4, finalY + curOffset);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(39, 174, 96);
        doc.text('TOTALE PREVENTIVO:', totalsBoxX + 4, finalY + curOffset + 7);
        doc.text(`€ ${parseFloat(quote.grandTotal || 0).toFixed(2)}`, totalsBoxX + totalsBoxWidth - 4, finalY + curOffset + 7, { align: 'right' });

        // ── NOTE & CONDIZIONI ──
        const notesBoxWidth = 92;
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(15, finalY, notesBoxWidth, totalsBoxHeight, 2, 2, 'S');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(...primaryColor);
        doc.text(isMichael ? 'ACCORDI FORNITURA & CONSEGNA:' : 'CONDIZIONI DI TRASPORTO & PAGAMENTO:', 19, finalY + 6);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(100, 110, 120);

        const paymentText = `Metodo di Pagamento: ${quote.paymentTerms || (isMichael ? 'Saldo a consegna / Bonifico' : 'Bonifico / PayPal / Ritiro')}`;
        doc.text(paymentText, 19, finalY + 12);

        const defaultNotes = isMichael
            ? 'Accordi di fornitura riservata intermediario Michael. Consegna e ritiro diretti senza spese di spedizione.'
            : 'Spedizione con corriere espresso tracciato 24/48h. Imballaggio isotermico protetto con heat pack 72h stagionale.';

        const notesText = doc.splitTextToSize(quote.notes || defaultNotes, notesBoxWidth - 8);
        doc.text(notesText, 19, finalY + 18);

        // ── FOOTER ──
        doc.setFontSize(7.5);
        doc.setTextColor(150, 150, 150);
        doc.text('Documento generato automaticamente da D.U.B.I.A. Cervello Digitale · Preventivo commerciale', 105, 287, { align: 'center' });

        // Download
        const fileName = `${quote.number || 'Preventivo'}_DUBIA.pdf`;
        const saved = savePdfDocument(doc, fileName);
        if (saved && typeof showNotification === 'function') {
            showNotification("PDF Scaricato", `Preventivo ${fileName} generato con successo.`, "success");
        }
    } catch (err) {
        console.error("Errore durante la generazione del Preventivo PDF:", err);
        if (typeof showNotification === 'function') {
            showNotification("Errore PDF", `Impossibile generare il PDF: ${err.message}`, "error");
        }
    }
};

// ══════════════════════════════════════════════════════════════════════
// LISTINO PREZZI UFFICIALE — EXPORT PDF, WHATSAPP & UI RENDERING
// ══════════════════════════════════════════════════════════════════════

let listinoCurrentState = {
    channel: 'DIRECT',
    category: 'ALL',
    searchTerm: ''
};

/**
 * Genera il testo formattato del listino per WhatsApp o messaggistica.
 * @param {string} channel - 'DIRECT' o 'MICHAEL'
 * @returns {string} Testo pronto per la condivisione
 */
const generateWhatsAppPriceListText = (channel = 'DIRECT') => {
    const isMichael = (channel === 'MICHAEL');
    const headerTitle = isMichael ? 'LISTINO RISERVATO INGROSSO (MICHAEL)' : 'LISTINO PREZZI UFFICIALE 2026';
    
    let text = `🌿 *${headerTitle} — D.U.B.I.A.* 🌿\n`;
    text += `_Allevamento Selezionato Blaptica Dubia & Sistemi IoT per Terrari_\n\n`;

    PRICE_CATALOG_FULL.categories.forEach(cat => {
        text += `${cat.icon} *${cat.title.toUpperCase()}*\n`;
        cat.items.forEach(item => {
            const tiers = item.tiers[channel] || item.tiers.DIRECT;
            const tiersStr = tiers.map(t => `   • ${t.qty}: *€ ${t.price.toFixed(2)}* _(${t.note})_`).join('\n');
            text += `🔹 *${item.title}* (${item.size})\n${tiersStr}\n`;
        });
        text += `\n`;
    });

    text += `🚚 *SPEDIZIONI & GARANZIA QUALITÀ*:\n`;
    text += `✓ Partenze Lunedì-Mercoledì con Corriere Espresso 24/48h\n`;
    text += `✓ Box termico con Heat Pack 40h incluso nei mesi invernali\n`;
    text += `✓ Garanzia 100% vivi all'arrivo e supporto post-vendita\n\n`;
    text += `📍 *Per preventivi personalizzati o ordini:* scrivimi direttamente qui!`;

    return text;
};

/**
 * Copia il listino prezzi negli appunti per WhatsApp / Telegram.
 * @param {string} channel - 'DIRECT' o 'MICHAEL'
 */
const copyPriceListToWhatsApp = async (channel = 'DIRECT') => {
    const text = generateWhatsAppPriceListText(channel);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
        }
        if (typeof showNotification === 'function') {
            showNotification("Listino Copiato", "📋 Testo pronto per WhatsApp / Telegram copiato negli appunti!", "success");
        }
    } catch (err) {
        console.error("Errore durante la copia del listino:", err);
        if (typeof showNotification === 'function') {
            showNotification("Errore Copia", "Non è stato possibile copiare il testo negli appunti.", "error");
        }
    }
};

/**
 * Genera ed esporta il PDF completo del Listino Prezzi D.U.B.I.A.
 * @param {string} channel - 'DIRECT' o 'MICHAEL'
 */
const exportFullCatalogPDF = (channel = 'DIRECT') => {
    const JsPDFClass = getJsPDFClass();
    if (!JsPDFClass) {
        alert("Libreria jsPDF non disponibile al momento. Verifica la connessione a Internet.");
        return;
    }

    try {
        const doc = new JsPDFClass({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        const primaryColor = [24, 43, 73];    // #182B49
        const goldColor = [242, 201, 76];     // #F2C94C
        const darkGray = [44, 62, 80];
        const lightGray = [245, 247, 250];
        const isMichael = (channel === 'MICHAEL');

        // ── HEADER BANNER ──
        doc.setFillColor(...primaryColor);
        doc.rect(0, 0, 210, 36, 'F');

        // Brand Title
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(22);
        doc.text('D.U.B.I.A.', 15, 16);

        doc.setFontSize(8.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(200, 210, 225);
        doc.text('Dynamic Updating Biomass Inference Algorithm', 15, 22);
        doc.text('Allevamento Selezionato Insetti da Pasto & Sistemi IoT di Monitoraggio', 15, 27);

        // Document Type Header on Right
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(...goldColor);
        const listTitle = isMichael ? 'LISTINO RISERVATO INGROSSO' : 'LISTINO PREZZI COMMERCIALE';
        doc.text(listTitle, 195, 16, { align: 'right' });

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(255, 255, 255);
        const today = new Date().toLocaleDateString('it-IT');
        doc.text(`Edizione: 2026 · Aggiornato: ${today}`, 195, 22, { align: 'right' });
        doc.text(isMichael ? 'Canale: Fornitura Intermediario (Michael)' : 'Canale: Vendita Diretta & Privati', 195, 27, { align: 'right' });

        let currentY = 44;

        // Itera le categorie del catalogo
        PRICE_CATALOG_FULL.categories.forEach((cat, index) => {
            // Se non c'è abbastanza spazio per l'intestazione e almeno una riga, salta pagina
            if (currentY > 230) {
                doc.addPage();
                currentY = 20;
            }

            // Barra intestazione categoria
            doc.setFillColor(235, 240, 248);
            doc.roundedRect(15, currentY, 180, 8, 1.5, 1.5, 'F');

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(9.5);
            doc.setTextColor(...primaryColor);
            doc.text(cat.title, 18, currentY + 5.5);

            currentY += 10;

            const tableBody = [];
            cat.items.forEach(item => {
                const tiers = item.tiers[channel] || item.tiers.DIRECT;
                const tiersStr = tiers.map(t => `${t.qty}: € ${t.price.toFixed(2)} (${t.note})`).join('\n');
                tableBody.push([
                    item.title,
                    item.size,
                    item.desc,
                    tiersStr
                ]);
            });

            currentY = safeAutoTable(doc, {
                startY: currentY,
                head: [['Articolo / Prodotto', 'Taglia / Specifiche', 'Descrizione / Utilizzo', 'Prezzi & Formati']],
                body: tableBody,
                theme: 'striped',
                headStyles: {
                    fillColor: primaryColor,
                    textColor: [255, 255, 255],
                    fontSize: 8.5,
                    fontStyle: 'bold',
                    halign: 'left'
                },
                styles: {
                    fontSize: 8,
                    cellPadding: 2.5,
                    textColor: darkGray,
                    valign: 'middle'
                },
                columnStyles: {
                    0: { fontStyle: 'bold', cellWidth: 42 },
                    1: { cellWidth: 32, fontStyle: 'italic' },
                    2: { cellWidth: 62 },
                    3: { cellWidth: 44, fontStyle: 'bold', textColor: [20, 90, 50] }
                },
                margin: { left: 15, right: 15 }
            });

            currentY += 6;
        });

        // Box Garanzie e Condizioni
        if (currentY > 230) {
            doc.addPage();
            currentY = 20;
        }

        doc.setFillColor(...lightGray);
        doc.roundedRect(15, currentY, 180, 32, 2, 2, 'F');
        doc.setDrawColor(210, 215, 220);
        doc.roundedRect(15, currentY, 180, 32, 2, 2, 'S');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...primaryColor);
        doc.text('GARANZIA, SPEDIZIONE & CONDIZIONI DI FORNITURA:', 19, currentY + 6);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.8);
        doc.setTextColor(...darkGray);
        doc.text('• SPEDIZIONI: Lunedì e Mercoledì con corriere espresso 24/48h per evitare fermi deposito durante il fine settimana.', 19, currentY + 12);
        doc.text('• PACKAGING: Box isotermico con Heat Pack 40h incluso gratuitamente nei mesi invernali per proteggere gli insetti.', 19, currentY + 17);
        doc.text('• GARANZIA 100% VIVI: Sostituzione immediata o rimborso in caso di mortalità documentata alla consegna entro 2h.', 19, currentY + 22);
        doc.text('• CONTATTI & ORDINI: Per ordini personalizzati, preventivi su misura o supporto tecnico termoigrometri contattare D.U.B.I.A.', 19, currentY + 27);

        // Footer con numero di pagina
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(7.5);
            doc.setTextColor(150, 150, 150);
            doc.text('Documento generato da D.U.B.I.A. Cervello Digitale · Listino Prezzi Ufficiale', 105, 290, { align: 'center' });
            doc.text(`Pagina ${i} di ${pageCount}`, 195, 290, { align: 'right' });
        }

        const fileName = isMichael ? 'Listino_DUBIA_Ingrosso_Michael.pdf' : 'Listino_DUBIA_Ufficiale_2026.pdf';
        const saved = savePdfDocument(doc, fileName);
        if (saved && typeof showNotification === 'function') {
            showNotification("PDF Scaricato", `Il listino prezzi (${fileName}) è stato generato con successo!`, "success");
        }
    } catch (err) {
        console.error("Errore durante la generazione del Listino PDF:", err);
        if (typeof showNotification === 'function') {
            showNotification("Errore PDF", `Impossibile generare il PDF: ${err.message}`, "error");
        }
    }
};

/**
 * Renderizza l'intera interfaccia visiva del Listino Prezzi nella tab dedicata.
 */
const renderListinoPrezziUI = () => {
    const container = document.getElementById('listinoProductsContainer');
    if (!container) return;

    const channel = listinoCurrentState.channel || 'DIRECT';
    const categoryFilter = listinoCurrentState.category || 'ALL';
    const searchFilter = (listinoCurrentState.searchTerm || '').trim().toLowerCase();

    // Aggiorna conteggi pillole
    let totalAll = 0, totalBlatte = 0, totalIot = 0, totalAccessori = 0;
    PRICE_CATALOG_FULL.categories.forEach(cat => {
        cat.items.forEach(item => {
            totalAll++;
            if (cat.id === 'BLATTE') totalBlatte++;
            if (cat.id === 'IOT') totalIot++;
            if (cat.id === 'ACCESSORI') totalAccessori++;
        });
    });

    const elCountAll = document.getElementById('countAll');
    const elCountBlatte = document.getElementById('countBlatte');
    const elCountIot = document.getElementById('countIot');
    const elCountAccessori = document.getElementById('countAccessori');
    if (elCountAll) elCountAll.textContent = totalAll;
    if (elCountBlatte) elCountBlatte.textContent = totalBlatte;
    if (elCountIot) elCountIot.textContent = totalIot;
    if (elCountAccessori) elCountAccessori.textContent = totalAccessori;

    // Aggiorna testo anteprima WhatsApp
    const whatsappEl = document.getElementById('whatsappMessageContent');
    if (whatsappEl) {
        whatsappEl.textContent = generateWhatsAppPriceListText(channel);
    }

    let html = '';

    PRICE_CATALOG_FULL.categories.forEach(cat => {
        if (categoryFilter !== 'ALL' && cat.id !== categoryFilter) {
            return;
        }

        // Filtra per ricerca
        const filteredItems = cat.items.filter(item => {
            if (!searchFilter) return true;
            return item.title.toLowerCase().includes(searchFilter) ||
                   item.size.toLowerCase().includes(searchFilter) ||
                   item.desc.toLowerCase().includes(searchFilter);
        });

        if (filteredItems.length === 0) return;

        html += `
            <div class="listino-section">
                <div class="listino-section-header">
                    <h3 class="listino-section-title">
                        <span>${cat.icon}</span> ${cat.title}
                    </h3>
                    <span class="listino-badge listino-tag-${cat.tag}">${cat.tagLabel} (${filteredItems.length})</span>
                </div>
                <div class="listino-grid">
        `;

        filteredItems.forEach(item => {
            const tiers = item.tiers[channel] || item.tiers.DIRECT;
            const tiersRows = tiers.map(t => `
                <div class="listino-tier-row">
                    <span class="listino-tier-qty">${t.qty}</span>
                    <div>
                        <span class="listino-tier-price">€ ${t.price.toFixed(2)}</span>
                        <span class="listino-tier-note">${t.note}</span>
                    </div>
                </div>
            `).join('');

            html += `
                <div class="listino-product-card">
                    <div>
                        <div class="listino-card-top">
                            <div class="listino-card-icon-title">
                                <span class="listino-card-icon">${item.icon}</span>
                                <div>
                                    <h4 class="listino-card-title">${item.title}</h4>
                                    <span class="listino-card-size">${item.size}</span>
                                </div>
                            </div>
                            <span class="listino-tag listino-tag-${cat.tag}">${cat.tagLabel}</span>
                        </div>
                        <p class="listino-card-desc">${item.desc}</p>
                        <div class="listino-tiers-box">
                            ${tiersRows}
                        </div>
                    </div>
                    <div class="listino-card-footer">
                        <button type="button" class="listino-quick-btn btn-listino-copy-item" data-id="${item.id}" data-title="${item.title}" title="Copia prezzi di questo articolo">
                            📋 Copia
                        </button>
                        <button type="button" class="listino-quick-btn btn-listino-add-quote" data-cat="${item.id}" data-unit="${item.unit}" data-price="${tiers[0]?.price || 0}" style="background: rgba(142,68,173,0.2); border-color: rgba(142,68,173,0.4); color: #fff;" title="Aggiungi a preventivo">
                            📄 + Preventivo
                        </button>
                    </div>
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;
    });

    if (!html) {
        html = `
            <div class="card" style="text-align:center; padding: 2.5rem 1rem;">
                <span style="font-size:2.5rem; display:block; margin-bottom:0.5rem;">🔍</span>
                <h3>Nessun prodotto trovato</h3>
                <p class="subtitle-text">Nessun articolo corrisponde ai filtri o al termine di ricerca inserito.</p>
            </div>
        `;
    }

    container.innerHTML = html;

    // Event listeners su card bottoni
    container.querySelectorAll('.btn-listino-add-quote').forEach(btn => {
        btn.addEventListener('click', () => {
            const cat = btn.dataset.cat;
            const unit = btn.dataset.unit || '100pz';
            const price = parseFloat(btn.dataset.price) || 0;
            openQuoteModal({
                initialItem: {
                    category: cat,
                    unit: unit,
                    quantity: 1,
                    unitPrice: price
                }
            });
        });
    });

    container.querySelectorAll('.btn-listino-copy-item').forEach(btn => {
        btn.addEventListener('click', async () => {
            const itemId = btn.dataset.id;
            let targetItem = null;
            PRICE_CATALOG_FULL.categories.forEach(cat => {
                const found = cat.items.find(it => it.id === itemId);
                if (found) targetItem = found;
            });

            if (targetItem) {
                const tiers = targetItem.tiers[channel] || targetItem.tiers.DIRECT;
                let text = `🔹 *${targetItem.title}* (${targetItem.size})\n`;
                tiers.forEach(t => {
                    text += `   • ${t.qty}: *€ ${t.price.toFixed(2)}* _(${t.note})_\n`;
                });
                try {
                    await navigator.clipboard.writeText(text);
                    if (typeof showNotification === 'function') {
                        showNotification("Prezzo Copiato", `Prezzo di "${targetItem.title}" copiato!`, "success");
                    }
                } catch (e) {
                    console.error("Copia fallita:", e);
                }
            }
        });
    });
};

/**
 * Inizializza gli event listener specifici del modulo Listino Prezzi.
 */
const initListinoEventListeners = () => {
    // Scarica PDF
    const btnDownloadPDF = document.getElementById('btnDownloadListinoPDF');
    if (btnDownloadPDF) {
        btnDownloadPDF.addEventListener('click', () => exportFullCatalogPDF(listinoCurrentState.channel));
    }

    // Copia WhatsApp
    const btnCopyWA = document.getElementById('btnCopyListinoWhatsApp');
    if (btnCopyWA) {
        btnCopyWA.addEventListener('click', () => copyPriceListToWhatsApp(listinoCurrentState.channel));
    }

    const btnCopyWADirect = document.getElementById('btnCopyWhatsAppDirect');
    if (btnCopyWADirect) {
        btnCopyWADirect.addEventListener('click', () => copyPriceListToWhatsApp(listinoCurrentState.channel));
    }

    // Toggle Preview WhatsApp Box
    const btnToggleWAPreview = document.getElementById('btnToggleWhatsAppPreview');
    const waPreviewCard = document.getElementById('whatsappPreviewCard');
    const btnCloseWAPreview = document.getElementById('btnCloseWhatsAppPreview');

    if (btnToggleWAPreview && waPreviewCard) {
        btnToggleWAPreview.addEventListener('click', () => {
            const isHidden = waPreviewCard.style.display === 'none';
            waPreviewCard.style.display = isHidden ? 'block' : 'none';
            if (isHidden) {
                const whatsappEl = document.getElementById('whatsappMessageContent');
                if (whatsappEl) whatsappEl.textContent = generateWhatsAppPriceListText(listinoCurrentState.channel);
            }
        });
    }
    if (btnCloseWAPreview && waPreviewCard) {
        btnCloseWAPreview.addEventListener('click', () => {
            waPreviewCard.style.display = 'none';
        });
    }

    // Nuovo Preventivo da Listino
    const btnOpenQuoteFromListino = document.getElementById('btnOpenQuoteFromListino');
    if (btnOpenQuoteFromListino) {
        btnOpenQuoteFromListino.addEventListener('click', () => openQuoteModal(null));
    }

    // Channel Switcher (Direct vs Michael)
    const btnDirect = document.getElementById('btnListinoDirect');
    const btnMichael = document.getElementById('btnListinoMichael');

    if (btnDirect && btnMichael) {
        btnDirect.addEventListener('click', () => {
            btnDirect.classList.add('active');
            btnMichael.classList.remove('active');
            listinoCurrentState.channel = 'DIRECT';
            renderListinoPrezziUI();
        });
        btnMichael.addEventListener('click', () => {
            btnMichael.classList.add('active');
            btnDirect.classList.remove('active');
            listinoCurrentState.channel = 'MICHAEL';
            renderListinoPrezziUI();
        });
    }

    // Category Filter Pills
    const pills = document.querySelectorAll('.listino-pill');
    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            listinoCurrentState.category = pill.dataset.category || 'ALL';
            renderListinoPrezziUI();
        });
    });

    // Search Input
    const searchInput = document.getElementById('listinoSearchInput');
    if (searchInput) {
        let timeout = null;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                listinoCurrentState.searchTerm = e.target.value;
                renderListinoPrezziUI();
            }, 180);
        });
    }

    // Header Button "📋 Listino Prezzi"
    const btnOpenListinoPrezzi = document.getElementById('btnOpenListinoPrezzi');
    if (btnOpenListinoPrezzi) {
        btnOpenListinoPrezzi.addEventListener('click', () => {
            const listinoTab = document.querySelector('.tab-btn[data-target="listino"]');
            if (listinoTab) {
                listinoTab.click();
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        });
    }
};

/**
 * Apre il modale cliente (in modalità aggiunta o modifica).
 * @param {object|null} client - null per nuova aggiunta, oggetto cliente per modifica
 */
const openClientModal = (client = null) => {
    const modal = document.getElementById('clientModal');
    if (!modal) return;
    const form = document.getElementById('clientForm');
    form.reset();
    document.getElementById('clientModalTitle').textContent = client ? 'Modifica Cliente' : 'Nuovo Cliente';
    document.getElementById('clientId').value = client?.id || '';
    if (client) {
        document.getElementById('clientNome').value = client.nome || '';
        document.getElementById('clientCognome').value = client.cognome || '';
        document.getElementById('clientCitta').value = client.citta || '';
        document.getElementById('clientTelefono').value = client.telefono || '';
        document.getElementById('clientEmail').value = client.email || '';
        document.getElementById('clientAnimale').value = client.animale || 'rettile';
        document.getElementById('clientNote').value = client.note || '';
    }
    modal.classList.add('active');
};

/**
 * Apre il modale cessione, pre-selezionando un cliente se fornito.
 */
const openCessioneModal = (clienteId = null) => {
    const modal = document.getElementById('cessioneModal');
    if (!modal) return;
    const form = document.getElementById('cessioneForm');
    form.reset();

    // Popola il select clienti
    const selectCliente = document.getElementById('cessioneCliente');
    selectCliente.innerHTML = '<option value="">— Seleziona cliente —</option>' +
        appState.clients.map(c =>
            `<option value="${c.id}" ${c.id == clienteId ? 'selected' : ''}>${c.nome} ${c.cognome}</option>`
        ).join('');

    // Data di oggi
    document.getElementById('cessioneData').valueAsDate = new Date();

    // Popola select tipo blatta
    const selectTipo = document.getElementById('cessioneTipo');
    selectTipo.innerHTML = BLATTA_TYPES.map(b =>
        `<option value="${b.value}">${b.label}</option>`
    ).join('');

    // Aggiorna prezzo unitario default al cambio tipo
    const updatePrezzoUnitario = () => {
        const tipo = selectTipo.value;
        const prezzo = appState.customPrices[tipo] || DEFAULT_PRICES[tipo] || 0;
        document.getElementById('cessionePrezzoUnit').value = prezzo.toFixed(2);
        updateCessioneTotale();
    };
    const updateCessioneTotale = () => {
        const q = parseFloat(document.getElementById('cessioneQuantita').value) || 0;
        const p = parseFloat(document.getElementById('cessionePrezzoUnit').value) || 0;
        const tipo = selectTipo.value;
        const blattaType = BLATTA_TYPES.find(b => b.value === tipo);
        const nInd = blattaType ? Math.round(q / blattaType.mass) : 0;
        const totale = q * p;
        document.getElementById('cessioneTotalePreview').textContent =
            `Totale: € ${totale.toFixed(2)} · ≈ ${nInd} individui`;
        document.getElementById('cessioneTotale').value = totale.toFixed(2);
    };

    selectTipo.onchange = updatePrezzoUnitario;
    document.getElementById('cessioneQuantita').oninput = updateCessioneTotale;
    document.getElementById('cessionePrezzoUnit').oninput = updateCessioneTotale;
    updatePrezzoUnitario();

    modal.classList.add('active');
};

/**
 * Apre il modale prezzi e popola i campi con i prezzi correnti.
 */
const openPrezziModal = () => {
    const modal = document.getElementById('prezziModal');
    if (!modal) return;
    BLATTA_TYPES.forEach(b => {
        const input = document.getElementById(`price_${b.value}`);
        if (input) input.value = (appState.customPrices[b.value] || DEFAULT_PRICES[b.value] || 0).toFixed(2);
    });
    updatePrezziPreview();
    modal.classList.add('active');
};

/**
 * Aggiorna il riquadro anteprima valore colonia nel modale prezzi.
 */
const updatePrezziPreview = () => {
    if (appState.measurements.length === 0) return;
    const latest = appState.measurements[appState.measurements.length - 1];
    const lastAdultRatio = latest.adult_ratio || 0.35;
    const tempPrices = {};
    BLATTA_TYPES.forEach(b => {
        const input = document.getElementById(`price_${b.value}`);
        tempPrices[b.value] = parseFloat(input?.value) || 0;
    });
    const metrics = calculateColonyMetrics(latest.total_weight, lastAdultRatio, { ...appState.params, _tempPrices: tempPrices });
    // Calcola con i prezzi temporanei
    const { fCount, mCount, saCount, medCount, smCount, bCount } = metrics;
    const val = (fCount * tempPrices.FEMALE) + (mCount * tempPrices.MALE)
        + (saCount * tempPrices.SUBADULT) + (medCount * tempPrices.MEDIUM)
        + (smCount * tempPrices.SMALL) + (bCount * tempPrices.BABY);
    const previewEl = document.getElementById('prezziValoreColoniaPreview');
    if (previewEl) previewEl.textContent = `Valore Colonia stimato: € ${val.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const saveMeasurement = async (measurement) => {
    if (!measurement.event_id) measurement.event_id = generateUUID();
    const snapshotMeasurements = [...appState.measurements];
    await new Promise((resolve) => {
        const tx = db.transaction("measurements", "readwrite");
        const store = tx.objectStore("measurements");
        if (!measurement.id) measurement.id = Date.now();
        const req = store.put(measurement);
        req.onsuccess = () => resolve(measurement);
        req.onerror  = () => resolve(null);
    });
    const payload = {
        event_id:            measurement.event_id,
        event_type:          measurement.event_type || "pesata",
        date:                measurement.date,
        total_weight:        measurement.total_weight,
        food_amount:         measurement.food_amount         || 0,
        harvest_amount:      measurement.harvest_amount      || 0,
        adult_ratio:         measurement.adult_ratio         || 0,
        predicted_weight:    measurement.predicted_weight    || 0,
        health_index:        measurement.health_index        || 100,
        is_new_blood:        measurement.is_new_blood        || false,
        notes:               measurement.notes               || "",
        colony_id:           measurement.colony_id           || null,
        colony_weight_after: (measurement.event_type === "prelievo" && measurement.colony_id)
                                ? measurement.total_weight : undefined
    };
    cloudPostWithQueue(payload).then(result => {
        if (!result.ok && !result.queued) {
            appState.measurements = snapshotMeasurements;
            updateUI();
            showNotification("Errore Salvataggio Cloud", "Dati in locale. Ritenterà alla prossima connessione: " + result.error, "alert");
        }
    });
    return measurement;
};




// --- ML ENGINE (D.U.B.I.A.) ---

/**
 * FEED-FORWARD INFERENCE — delega al modulo dubia_module.js
 * 
 * Formula (da specifica):
 *   Ŵ_{t+1} = W_t + (θ₁ · C_t) + [θ₂ · (W_t · (1 − A_t)) · (Δg / 30)] − harvest
 * 
 * NOTA: usa A_t dinamico (NON il 65% fisso della vecchia implementazione).
 */
const calculatePrediction = (lastWeight, foodAmount, adultRatio, delta_g, params, harvestAmount = 0) => {
    const dubiaModule = D();
    if (dubiaModule) {
        // Usa la formula certificata dal modulo matematico
        return dubiaModule.feedForward(
            lastWeight, foodAmount, adultRatio,
            delta_g, params.theta1, params.theta2, harvestAmount
        );
    }
    // Fallback di sicurezza (non dovrebbe mai essere raggiunto)
    const W_neanidi = lastWeight * (1 - adultRatio);
    const w_pred = lastWeight
        + (params.theta1 * foodAmount)
        + (params.theta2 * W_neanidi * (delta_g / 30))
        - harvestAmount;
    return Math.max(0, w_pred);
};

/**
 * Calcola l'Indice di Salute H(t) = (θ₁ / θ₁*) × 100
 * 
 * Delegato al modulo matematico. Θ₁* = 0.30 (valore storico ottimale).
 */
const computeHealthIndex = (theta1) => {
    const dubiaModule = D();
    if (dubiaModule) return dubiaModule.healthIndex(theta1);
    return (theta1 / 0.30) * 100; // fallback
};

const processNewMeasurement = async (date, realWeight, foodAmount, adultRatio, notes, harvestAmount = 0, isNewBlood = false, isManualSubmit = false, eventType = 'pesata', colonyId = null, colonyWeightAfter = null) => {
    const lastMeasurement = appState.measurements.length > 0 
        ? appState.measurements[appState.measurements.length - 1] 
        : null;

    let predictedWeight = realWeight; // Default if first time
    let healthIndex = 100;
    let delta_g = 30; // default for the first measurement if needed

    if (lastMeasurement) {
        const dataUltimaPesata = new Date(lastMeasurement.date);
        const dataTargetFutura = new Date(date);
        delta_g = Math.max(0, (dataTargetFutura - dataUltimaPesata) / (1000 * 60 * 60 * 24));

        predictedWeight = calculatePrediction(lastMeasurement.total_weight, foodAmount, adultRatio, delta_g, appState.params, harvestAmount);
        
        if (eventType === 'pesata' || eventType === 'calibrazione' || eventType === 'nuovo_sangue') {
            // ── RETROPROPAGAZIONE DELL'ERRORE ──────────────────────────────────
            // E = Ŵ_{t+1} − W_{reale}  (errore di predizione)

            if (isManualSubmit) {
                const dubiaModule = D();
                if (dubiaModule) {
                    // Usa le derivate parziali certificate dal modulo matematico:
                    //   θ₁_new = θ₁_old − α · E · C_t
                    //   θ₂_new = θ₂_old − α · E · [W_t · (1 − A_t) · (Δg / 30)]
                    const bp = dubiaModule.backpropagate(
                        appState.params.theta1,
                        appState.params.theta2,
                        predictedWeight,
                        realWeight,
                        lastMeasurement.total_weight,
                        foodAmount,
                        adultRatio,
                        delta_g,
                        ALPHA
                    );
                    appState.params.theta1 = bp.theta1;
                    appState.params.theta2 = bp.theta2;
                } else {
                    // Fallback: calcolo diretto con derivate parziali corrette
                    const E = predictedWeight - realWeight;
                    const W_t_prev = lastMeasurement.total_weight;
                    const safe_At = Math.max(0, Math.min(1, (adultRatio !== undefined && adultRatio !== null) ? Number(adultRatio) : 0.35));
                    // ∂E/∂θ₁ = C_t
                    const delta_theta1 = ALPHA * E * (foodAmount || 0);
                    const clamped_delta1 = Math.max(-0.15, Math.min(0.15, delta_theta1));
                    const newTheta1 = appState.params.theta1 - clamped_delta1;

                    // ∂E/∂θ₂ = W_t · (1 − A_t) · (Δg / 30)
                    const grad2 = Math.max(0, W_t_prev || 0) * (1 - safe_At) * (Math.max(0, delta_g || 0) / 30);
                    const delta_theta2 = ALPHA * E * grad2;
                    const clamped_delta2 = Math.max(-0.25, Math.min(0.25, delta_theta2));
                    const newTheta2 = appState.params.theta2 - clamped_delta2;

                    appState.params.theta1 = Math.max(0.05, Math.min(2.0, newTheta1));
                    appState.params.theta2 = Math.max(0.20, Math.min(3.0, newTheta2));
                }
                saveParams(appState.params);
            }

            // ── INDICE DI SALUTE H(t) = (θ₁ / θ₁*) × 100 ─────────────────────
            // θ₁* = 0.30 (valore storico ottimale — NON il rapporto reale/predetto)
            healthIndex = computeHealthIndex(appState.params.theta1);

            checkHealthThresholds(healthIndex);
        } else {
            // For purely informational events (cibo, prelievo), we check if real weight was provided
            // (like when a prelievo is dynamically subtracting from the total).
            // se l'evento è un prelievo, il realWeight passato sarà già stato sottratto.
            // altrimenti per cibo teniamo il predicted.
            if (eventType === 'prelievo') {
                // Keep the realWeight passed into the function (which already had the harvest subtracted)
            } else {
                realWeight = predictedWeight;
            }
            healthIndex = lastMeasurement.health_index; // Maintain last health index
        }
    }

    const measurement = {
        date,
        total_weight: realWeight,
        food_amount: foodAmount,
        harvest_amount: harvestAmount,
        is_new_blood: isNewBlood,
        adult_ratio: adultRatio,
        notes,
        predicted_weight: predictedWeight,
        health_index: healthIndex,
        event_type: eventType,
        colony_id: colonyId,
        colony_weight_after: colonyWeightAfter
    };

    await saveMeasurement(measurement);
    updateUI();
};

const checkHealthThresholds = (healthIndex) => {
    if (healthIndex < HEALTH_THRESHOLD_ALERT) {
        showNotification("ALLARME CRITICO 🚨", `Indice H = ${healthIndex.toFixed(1)}% (< 75%). θ₁ è crollato. Rilevare causa: inbreeding, stress o carenza nutrizionale. Aprire la tab Diagnostica.`, "alert");
    } else if (healthIndex < HEALTH_THRESHOLD_WARNING) {
        showNotification("⚠️ Attenzione", `Indice H = ${healthIndex.toFixed(1)}% (< 90%). Monitorare θ₁ e θ₂. Aprire la tab Diagnostica.`, "warning");
    }
};

/**
 * Aggiorna il pannello di Diagnostica Differenziale nell'UI.
 * Viene chiamato dopo ogni aggiornamento dei parametri.
 */
const updateDiagnosticsPanel = () => {
    const dubiaModule = D();
    if (!dubiaModule) return;

    const { theta1, theta2 } = appState.params;
    const H = computeHealthIndex(theta1);
    const diagnostics = dubiaModule.differentialDiagnostics(theta1, theta2, H);

    const panel = document.getElementById('differentialDiagnosticsPanel');
    if (!panel) return;

    if (diagnostics.length === 0) {
        panel.innerHTML = `
            <div class="diag-ok">
                <span class="diag-icon">✅</span>
                <div>
                    <strong>Sistema Ottimale</strong>
                    <p>Tutti i parametri sono nei range nominali. Nessun intervento richiesto.</p>
                </div>
            </div>
        `;
        return;
    }

    panel.innerHTML = diagnostics.map(d => `
        <div class="diag-alert diag-${d.severity}">
            <h4>${d.title}</h4>
            <p class="diag-message">${d.message}</p>
            <p class="diag-suggestion">${d.suggestion}</p>
        </div>
    `).join('');
};

/**
 * calculateColonyMetrics — Funzione pura di calcolo (layout-agnostic).
 * 
 * Unico punto di verità per TUTTI i dati demografici, economici e di salute.
 * Non legge mai il DOM, non dipende dalla larghezza dello schermo.
 * Può essere chiamata da qualsiasi contesto (UI, grafico, tabella, mobile/desktop).
 * 
 * @param {number} W_t    - Biomassa totale reale (grammi)
 * @param {number} A_t    - Rapporto adulti [0..1]
 * @param {object} params - { theta1, theta2, manualCalibrations }
 * @returns {ColonyMetrics} Oggetto immutabile con tutti i valori calcolati
 */
const calculateColonyMetrics = (W_t, A_t, params) => {
    const dubiaModule = D();

    // ── Dati demografici dal Modulo 4 D.U.B.I.A. ────────────────────────────
    let censusData;
    if (dubiaModule) {
        censusData = dubiaModule.census(W_t, A_t);
    } else {
        // Fallback: stesse formule del modulo
        const W_adulti  = W_t * A_t;
        const W_neanidi = W_t * (1 - A_t);
        censusData = {
            W_adulti, W_neanidi,
            W_femmine:       W_adulti * 0.77,
            W_maschi:        W_adulti * 0.23,
            W_neanidi_medie: W_neanidi * 0.70,
            W_neanidi_baby:  W_neanidi * 0.30,
            N_femmine: Math.round(W_adulti * 0.77 / 2.5),
            N_maschi:  Math.round(W_adulti * 0.23 / 1.5),
            N_medie:   Math.round(W_neanidi * 0.70 / 0.8),
            N_baby:    Math.round(W_neanidi * 0.30 / 0.1),
            N_totale_adulti:  0, N_totale_neanidi: 0, N_totale: 0, sex_ratio: 0
        };
        censusData.N_totale_adulti  = censusData.N_femmine + censusData.N_maschi;
        censusData.N_totale_neanidi = censusData.N_medie + censusData.N_baby;
        censusData.N_totale         = censusData.N_totale_adulti + censusData.N_totale_neanidi;
        censusData.sex_ratio        = censusData.N_femmine > 0 ? censusData.N_maschi / censusData.N_femmine : 0;
    }

    // ── GESTIONE CALIBRAZIONI A CASCATA (Richiesta Utente) ─────────────
    // Le variabili calibrate manualmente NON devono cambiare.
    // Le altre variabili scalano proporzionalmente per rispettare il peso W_t.
    const calibs = (params && params.manualCalibrations) || {};
    let isManualOverrideActive = Object.keys(calibs).length > 0;

    let fCount, mCount, saCount, medCount, smCount, bCount;

    if (!isManualOverrideActive) {
        fCount   = censusData.N_femmine;
        mCount   = censusData.N_maschi;
        saCount  = 0;
        medCount = censusData.N_medie;
        smCount  = 0;
        bCount   = censusData.N_baby;
    } else {
        // 1. Calcola il peso delle categorie esplicitamente calibrate
        let calibratedWeight = 0;
        if (calibs["FEMALE"]   !== undefined) calibratedWeight += calibs["FEMALE"]   * MASS.FEMALE;
        if (calibs["MALE"]     !== undefined) calibratedWeight += calibs["MALE"]     * MASS.MALE;
        if (calibs["SUBADULT"] !== undefined) calibratedWeight += calibs["SUBADULT"] * MASS.SUBADULT;
        if (calibs["MEDIUM"]   !== undefined) calibratedWeight += calibs["MEDIUM"]   * MASS.MEDIUM;
        if (calibs["SMALL"]    !== undefined) calibratedWeight += calibs["SMALL"]    * MASS.SMALL;
        if (calibs["BABY"]     !== undefined) calibratedWeight += calibs["BABY"]     * MASS.BABY;

        // 2. Calcola il peso residuo per le categorie NON calibrate
        let remainingWeight = W_t - calibratedWeight;
        if (remainingWeight < 0) remainingWeight = 0;

        // 3. Calcola il peso teorico delle categorie NON calibrate per distribuirvi il residuo
        let uncalibratedTheoWeight = 0;
        if (calibs["FEMALE"] === undefined) uncalibratedTheoWeight += censusData.N_femmine * MASS.FEMALE;
        if (calibs["MALE"]   === undefined) uncalibratedTheoWeight += censusData.N_maschi  * MASS.MALE;
        if (calibs["MEDIUM"] === undefined) uncalibratedTheoWeight += censusData.N_medie   * MASS.MEDIUM;
        if (calibs["BABY"]   === undefined) uncalibratedTheoWeight += censusData.N_baby    * MASS.BABY;

        // Fattore di scala a cascata
        let scaleFactor = uncalibratedTheoWeight > 0 ? (remainingWeight / uncalibratedTheoWeight) : 0;

        // 4. Applica: i calibrati restano fissi, gli altri scalano a cascata
        fCount   = calibs["FEMALE"]   !== undefined ? calibs["FEMALE"]   : Math.round(censusData.N_femmine * scaleFactor);
        mCount   = calibs["MALE"]     !== undefined ? calibs["MALE"]     : Math.round(censusData.N_maschi  * scaleFactor);
        saCount  = calibs["SUBADULT"] !== undefined ? calibs["SUBADULT"] : 0;
        medCount = calibs["MEDIUM"]   !== undefined ? calibs["MEDIUM"]   : Math.round(censusData.N_medie   * scaleFactor);
        smCount  = calibs["SMALL"]    !== undefined ? calibs["SMALL"]    : 0;
        bCount   = calibs["BABY"]     !== undefined ? calibs["BABY"]     : Math.round(censusData.N_baby    * scaleFactor);
    }

    const totalCount = fCount + mCount + saCount + medCount + smCount + bCount;

    // IMPORTANTISSIMO: Dobbiamo iniettare i valori ricalibrati nel censusData stesso,
    // altrimenti la tabella UI e i controlli incrociati continueranno a mostrare i vecchi valori puramente matematici!
    censusData = {
        ...censusData,
        N_femmine: fCount,
        N_maschi: mCount,
        N_medie: medCount,
        N_baby: bCount,
        W_femmine: fCount * MASS.FEMALE,
        W_maschi: mCount * MASS.MALE,
        W_neanidi_medie: medCount * MASS.MEDIUM,
        W_neanidi_baby: bCount * MASS.BABY,
        W_adulti: (fCount * MASS.FEMALE) + (mCount * MASS.MALE),
        W_neanidi: (medCount * MASS.MEDIUM) + (bCount * MASS.BABY),
        N_totale_adulti: fCount + mCount,
        N_totale_neanidi: medCount + bCount,
        N_totale: fCount + mCount + medCount + bCount,
        sex_ratio: fCount > 0 ? mCount / fCount : 0
    };

    // ── Valore economico (usa prezzi personalizzati da appState) ───────────
    const prices = appState.customPrices || DEFAULT_PRICES;
    const economicValue = (fCount * prices.FEMALE) + (mCount * prices.MALE)
        + (saCount * prices.SUBADULT) + (medCount * prices.MEDIUM)
        + (smCount * prices.SMALL)   + (bCount   * prices.BABY);

    // ── Fabbisogno idrico ───────────────────────────────────────────────────
    const waterNeed = W_t * 0.035; // 3.5% del peso vivo al giorno

    // ── Indice H live ───────────────────────────────────────────────────────
    const H_live = (params && params.theta1)
        ? computeHealthIndex(params.theta1)
        : 100;

    // ── Timer maturazione (usa θ₂ come moltiplicatore di velocità) ──────────
    // θ₂ default = 1.05 → speed = 1.0; θ₂ = 2.10 → speed = 2.0 (crescita doppia)
    // Scaling: growthSpeed = θ₂ / θ₂_default = θ₂ / 1.05
    const theta2 = (params && params.theta2) || 1.05;
    const THETA2_DEFAULT = 1.05;
    const growthSpeed = Math.max(0.5, Math.min(3.0, theta2 / THETA2_DEFAULT));

    const maturStages = [
        { name: 'Micro-Neanidi',   count: bCount,   next: 'Neanidi Medie',  baseDays: 30 },
        { name: 'Neanidi Medie',   count: medCount,  next: 'Sub-Adulte',    baseDays: 40 },
        { name: 'Sub-Adulte',      count: saCount,   next: 'Adulte',        baseDays: 30 },
        { name: 'Neanidi Piccole', count: smCount,   next: 'Neanidi Medie', baseDays: 30 }
    ];
    maturStages.sort((a, b) => b.count - a.count);
    const peakStage = maturStages[0];
    const maturDays = Math.round(peakStage.baseDays / growthSpeed);
    const maturMessage = (peakStage.count > totalCount * 0.2)
        ? `Il picco attuale (${peakStage.name}) impiegherà circa ${maturDays} giorni per mutare in ${peakStage.next}. [θ₂=${theta2.toFixed(3)}]`
        : 'Distribuzione stabile. Nessun picco imminente rilevato.';

    return Object.freeze({
        // Censimento (da DUBIA.census)
        census: censusData,
        // Flag per calibrazioni attive valide
        isManualOverrideActive,
        // Conteggi (con eventuale override calibrazioni manuali)
        fCount, mCount, saCount, medCount, smCount, bCount, totalCount,
        // Metriche derivate
        economicValue,
        waterNeed,
        H_live,
        // Timer maturazione
        maturMessage,
        maturDays,
        growthSpeed
    });
};

/**
 * Rileva discrepanze di biomassa e quantità tra censimento teorico e colonie reali.
 */
const checkCensusDivergence = (W_t, A_t, colonies) => {
    const dubiaModule = D();
    let censusT = null;
    if (dubiaModule) {
        censusT = dubiaModule.census(W_t, A_t);
    } else {
        const W_adulti  = W_t * A_t;
        const W_neanidi = W_t * (1 - A_t);
        censusT = {
            N_femmine: Math.round(W_adulti * 0.77 / 2.5),
            N_maschi:  Math.round(W_adulti * 0.23 / 1.5),
            N_medie:   Math.round(W_neanidi * 0.70 / 0.8),
            N_baby:    Math.round(W_neanidi * 0.30 / 0.1)
        };
    }

    let emp = {
        males: 0, females: 0, subadults: 0, medium: 0, small: 0, baby: 0
    };

    if (Array.isArray(colonies)) {
        colonies.forEach(c => {
            emp.males += parseInt(c.males_count, 10) || 0;
            emp.females += parseInt(c.females_count, 10) || 0;
            emp.subadults += parseInt(c.subadults_count, 10) || 0;
            emp.medium += parseInt(c.medium_count, 10) || 0;
            emp.small += parseInt(c.small_count, 10) || 0;
            emp.baby += parseInt(c.baby_count, 10) || 0;
        });
    }

    const lockedWeight = 
        (emp.males * MASS.MALE) +
        (emp.females * MASS.FEMALE) +
        (emp.subadults * MASS.SUBADULT) +
        (emp.medium * MASS.MEDIUM) +
        (emp.small * MASS.SMALL) +
        (emp.baby * MASS.BABY);

    const isOverweight = lockedWeight > W_t;

    // A conflict is detected if there's more of ANY specific counted stage than theoretically available 
    // OR if the total weight of the colonies exceeds the total scale weight
    const hasConflict = 
        (emp.females > censusT.N_femmine) || 
        (emp.males > censusT.N_maschi) || 
        (emp.medium > censusT.N_medie) || 
        (emp.baby > censusT.N_baby) || 
        isOverweight;

    return {
        theoric: censusT,
        empirical: emp,
        lockedWeight: lockedWeight,
        isOverweight: isOverweight,
        deltas: {
            females: emp.females - censusT.N_femmine,
            males: emp.males - censusT.N_maschi,
            medium: emp.medium - censusT.N_medie,
            baby: emp.baby - censusT.N_baby
        },
        hasConflict: hasConflict
    };
};

/**
 * Aggiorna la Tabella di Censimento Demografico nell'UI.
 * Riceve metrics pre-calcolate da calculateColonyMetrics().
 */
const updateCensusTable = (W_t, A_t, metricsOverride) => {
    const dubiaModule = D();
    const tbody = document.querySelector('#censusTable tbody');
    if (!tbody) return;

    let rows;
    if (dubiaModule) {
        const censusData = metricsOverride ? metricsOverride.census : dubiaModule.census(W_t, A_t);
        rows = dubiaModule.censusTable(censusData);
    } else {
        // Fallback: calcolo diretto
        const W_adulti  = W_t * A_t;
        const W_neanidi = W_t * (1 - A_t);
        rows = [
            { stage: 'Femmine Adulte',       mass_avg: '2.5g', proportion: 'A_t × S_f (77%)', N: Math.round(W_adulti * 0.77 / 2.5), biomassa_g: (W_adulti * 0.77).toFixed(1),  destinazione: 'Riproduttrici — mantenere' },
            { stage: 'Maschi Adulti',        mass_avg: '1.5g', proportion: 'A_t × S_m (23%)', N: Math.round(W_adulti * 0.23 / 1.5), biomassa_g: (W_adulti * 0.23).toFixed(1),  destinazione: 'Riproduttori — verificare sex ratio' },
            { stage: 'Neanidi Medie',        mass_avg: '0.8g', proportion: '(1−A_t) × 70%',   N: Math.round(W_neanidi * 0.70 / 0.8), biomassa_g: (W_neanidi * 0.70).toFixed(1), destinazione: 'Crescita — prelievo futuro' },
            { stage: 'Micro-Neanidi (Baby)', mass_avg: '0.1g', proportion: '(1−A_t) × 30%',   N: Math.round(W_neanidi * 0.30 / 0.1), biomassa_g: (W_neanidi * 0.30).toFixed(1), destinazione: 'Riserva — non prelevare' }
        ];
    }

    const formulaBox = document.getElementById('censusFormulaBox');
    const banner = document.getElementById('censusOverrideBanner');
    if (metricsOverride && metricsOverride.isManualOverrideActive) {
        if (formulaBox) formulaBox.style.display = 'none';
        if (banner) banner.style.display = 'block';
    } else {
        if (formulaBox) formulaBox.style.display = ''; // Let CSS display: grid apply
        if (banner) banner.style.display = 'none';
    }

    tbody.innerHTML = rows.map(r => {
        let destColor = 'var(--text-muted)';
        let destIcon  = '📊';
        if (r.destinazione.includes('Riproduttr')) { destColor = 'var(--accent-purple)'; destIcon = '🔴'; }
        if (r.destinazione.includes('prelievo'))   { destColor = 'var(--accent-green)';  destIcon = '✂️'; }
        if (r.destinazione.includes('Riserva'))    { destColor = '#f1c40f';              destIcon = '🛡️'; }
        if (r.destinazione.includes('sex ratio'))  { destColor = '#3498db';             destIcon = '⚖️'; }
        return `
            <tr>
                <td><strong>${r.stage}</strong>${r.mass_avg ? `<br><small style="color:var(--text-muted)">${r.mass_avg} media · ${r.proportion || ''}</small>` : ''}</td>
                <td class="census-n">${r.N.toLocaleString('it-IT')}</td>
                <td>${parseFloat(r.biomassa_g).toFixed(1)} g</td>
                <td style="color:${destColor}">${destIcon} ${r.destinazione}</td>
            </tr>
        `;
    }).join('');
};

/**
 * Aggiorna la UI della card "Allineamento Colonie" nella Dashboard
 */
const updateAlignmentStatus = () => {
    const container = document.getElementById('alignmentStatusContainer');
    const msg = document.getElementById('alignmentStatusMessage');
    const details = document.getElementById('alignmentStatusDetails');
    const btnSync = document.getElementById('btnSyncCensus');

    if (!container || !msg || !details || !btnSync) return;

    if (appState.measurements.length === 0) {
        msg.innerText = "Nessuna pesata disponibile.";
        details.innerHTML = "Inserisci una pesata globale per attivare il controllo.";
        btnSync.style.display = 'none';
        return;
    }

    const latest = appState.measurements[appState.measurements.length - 1];
    const safeAdultRatio = (latest.adult_ratio !== undefined && latest.adult_ratio !== null) ? Number(latest.adult_ratio) : 0.35;
    const divergence = checkCensusDivergence(latest.total_weight, safeAdultRatio, appState.colonies);

    if (divergence.isOverweight) {
        container.style.backgroundColor = "rgba(255, 71, 87, 0.1)";
        container.style.borderColor = "var(--alert-red)";
        msg.innerText = "❌ Errore Critico: Sovrappeso Fisico";
        msg.style.color = "var(--alert-red)";
        details.innerHTML = `Le tue colonie pesano fisicamente <strong>${divergence.lockedWeight.toFixed(1)}g</strong>, che supera il peso totale sulla bilancia (${latest.total_weight.toFixed(1)}g). Impossibile calibrare. Controlla i tuoi conteggi.`;
        btnSync.style.display = 'none';
        
        const btnReset = document.getElementById('btnResetCalibrations');
        if (btnReset) {
            btnReset.style.display = 'block';
            btnReset.onclick = async () => {
                delete appState.params.manualCalibrations;
                saveParams(appState.params);
                
                let coloniesUpdated = false;
                
                const categories = [
                    { prop: 'females_count', empKey: 'females', theoKey: 'N_femmine' },
                    { prop: 'males_count', empKey: 'males', theoKey: 'N_maschi' },
                    { prop: 'medium_count', empKey: 'medium', theoKey: 'N_medie' },
                    { prop: 'baby_count', empKey: 'baby', theoKey: 'N_baby' }
                ];
                
                for (let colony of appState.colonies) {
                    let modified = false;
                    
                    // Modifica SOLO le colonie destinate a 'Pasto'
                    if (colony.type === 'Pasto') {
                        categories.forEach(cat => {
                            const empCount = divergence.empirical[cat.empKey];
                            const theoCount = divergence.theoric[cat.theoKey];
                            
                            if (empCount > theoCount && empCount > 0) {
                                const ratio = theoCount / empCount;
                                const current = parseInt(colony[cat.prop]) || 0;
                                if (current > 0) {
                                    colony[cat.prop] = Math.floor(current * ratio);
                                    modified = true;
                                }
                            }
                        });
                    }
                    
                    if (modified) {
                        coloniesUpdated = true;
                        await saveColony(colony); // Salva in locale + cloud in background
                    }
                }
                
                updateColoniesUI();
                updateUI();
                
                if (coloniesUpdated) {
                    showNotification('Riallineamento Completato', 'Le colonie in eccesso sono state ridotte per rientrare nei parametri teorici globali.', 'success');
                } else {
                    showNotification('Reset Completato', 'Le calibrazioni manuali sono state rimosse.', 'success');
                }
            };
        }
    } else if (divergence.hasConflict) {
        container.style.backgroundColor = "rgba(242, 201, 76, 0.1)";
        container.style.borderColor = "#F2C94C";
        msg.innerText = "⚠️ Discrepanza Rilevata";
        msg.style.color = "#F2C94C";
        
        let deltaHtml = "Hai più individui in colonia rispetto alla stima matematica per:<ul>";
        if (divergence.deltas.females > 0) deltaHtml += `<li>Femmine: +${divergence.deltas.females} in eccesso</li>`;
        if (divergence.deltas.males > 0) deltaHtml += `<li>Maschi: +${divergence.deltas.males} in eccesso</li>`;
        if (divergence.deltas.medium > 0) deltaHtml += `<li>Neanidi Medie: +${divergence.deltas.medium} in eccesso</li>`;
        if (divergence.deltas.baby > 0) deltaHtml += `<li>Baby: +${divergence.deltas.baby} in eccesso</li>`;
        deltaHtml += "</ul>Il peso globale è corretto, ma le stime non tornano con i tuoi box fisici.";
        
        details.innerHTML = deltaHtml;
        btnSync.style.display = 'block';
        const btnReset = document.getElementById('btnResetCalibrations');
        if (btnReset) btnReset.style.display = 'none';

        // Logica del pulsante Sync
        btnSync.onclick = () => {
            // Sincronizza: Calcola i pesi reali degli adulti
            const W_adulti_reali = (divergence.empirical.females * MASS.FEMALE) + (divergence.empirical.males * MASS.MALE);
            let new_At = W_adulti_reali / latest.total_weight;
            new_At = Math.max(0.01, Math.min(0.99, new_At)); // Limiti sicuri

            // Calcola biomassa bloccata e rimanente
            const locked_W = divergence.lockedWeight;
            const remaining_W = Math.max(0, latest.total_weight - locked_W);
            
            // Le neanidi assorbono il peso rimanente proporzionalmente 70/30
            const extraMediumW = remaining_W * 0.70;
            const extraBabyW = remaining_W * 0.30;
            const extraMediumN = Math.round(extraMediumW / MASS.MEDIUM);
            const extraBabyN = Math.round(extraBabyW / MASS.BABY);

            appState.params.manualCalibrations = {
                FEMALE: divergence.empirical.females,
                MALE: divergence.empirical.males,
                SUBADULT: divergence.empirical.subadults,
                MEDIUM: divergence.empirical.medium + extraMediumN,
                SMALL: divergence.empirical.small,
                BABY: divergence.empirical.baby + extraBabyN
            };

            // FIX CRITICO: Il rapporto adulti è A_t (in latest.adult_ratio), NON theta1 (resa alimentare)!
            latest.adult_ratio = new_At;
            
            saveParams(appState.params);
            
            saveMeasurement(latest).then(() => {
                updateUI();
                updateColoniesUI();
                showNotification('Sincronizzazione Riuscita', 'Il censimento ora riflette la realtà empirica delle tue colonie mantenendo il peso invariato.', 'success');
            });
        };
    } else {
        container.style.backgroundColor = "rgba(39, 174, 96, 0.1)";
        container.style.borderColor = "var(--accent-green)";
        msg.innerText = "✅ Sistema Allineato";
        msg.style.color = "var(--accent-green)";
        details.innerHTML = "Il peso teorico e le colonie fisiche sono in perfetto equilibrio.";
        btnSync.style.display = 'none';
        const btnReset = document.getElementById('btnResetCalibrations');
        if (btnReset) btnReset.style.display = 'none';
    }
};

const updateDoubleScenarioChart = (harvestAmount, simulatedFuture, days) => {
    if (!appState.charts.weight || !appState.measurements || appState.measurements.length === 0) return;

    const chart = appState.charts.weight;
    const latest = appState.measurements[appState.measurements.length - 1];

    // Normal Prediction
    const normalFuture = calculatePrediction(latest.total_weight, 0, latest.adult_ratio, days, appState.params);

    // Check if datasets exist for predictions
    let normalDataset = chart.data.datasets.find(d => d.label === 'Predizione Naturale (g)');
    let harvestDataset = chart.data.datasets.find(d => d.label === 'Simulazione Prelievo (g)');

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + days);
    const futureLabel = futureDate.toISOString().split('T')[0];

    // Remove existing future points from original datasets
    const baseLabels = appState.measurements.map(m => m.date);

    chart.data.labels = [...baseLabels, futureLabel];

    const baseRealData = appState.measurements.map(m => m.total_weight);
    const basePredData = appState.measurements.map(m => m.predicted_weight);

    chart.data.datasets[0].data = [...baseRealData, null];
    chart.data.datasets[1].data = [...basePredData, null];

    if (!normalDataset) {
        normalDataset = {
            label: 'Predizione Naturale (g)',
            data: [],
            borderColor: '#3498db',
            borderDash: [5, 5], // Tratteggiato
            borderWidth: 2,
            tension: 0
        };
        chart.data.datasets.push(normalDataset);
    } else {
        normalDataset.borderDash = [5, 5];
    }

    if (!harvestDataset) {
        harvestDataset = {
            label: 'Simulazione Prelievo (g)',
            data: [],
            borderColor: '#e74c3c',
            borderDash: [5, 5], // Tratteggiato
            borderWidth: 2,
            tension: 0
        };
        chart.data.datasets.push(harvestDataset);
    } else {
        harvestDataset.borderDash = [5, 5];
    }

    // Pad with nulls so line starts from latest point
    const padLength = baseLabels.length - 1;
    const nullArray = Array(padLength).fill(null);

    normalDataset.data = [...nullArray, latest.total_weight, normalFuture];

    // The harvest drops immediately, then grows
    const postHarvestWeight = Math.max(0, latest.total_weight - harvestAmount);
    harvestDataset.data = [...nullArray, postHarvestWeight, simulatedFuture];

    chart.update();
};

// --- UI UPDATES ---

/**
 * Restituisce il peso effettivo per una categoria biologica.
 * Usa customMass se l'utente ha calibrato la propria linea genetica,
 * altrimenti usa le costanti standard MASS.
 * @param {string} category - Es. 'FEMALE', 'MALE', ecc.
 * @returns {number} Peso medio in grammi
 */
const getEffectiveMass = (category) => {
    if (appState.customMass && appState.customMass[category] !== undefined) {
        return appState.customMass[category];
    }
    return MASS[category] || 0;
};

/**
 * BOTTOM-UP CENSUS — Peso globale come somma delle colonie fisiche.
 * Se ci sono colonie con peso definito, usa quello come fonte di verità.
 * Altrimenti fa fallback all'ultima misura globale in Timeline.
 * @returns {{ weight: number, source: 'colonies'|'timeline' }}
 */
const computeGlobalWeight = () => {
    // Normalizza is_deleted: gestisce stringa vuota, null, undefined, 'true', true
    const isDeletedNorm = (c) => c.is_deleted === true || c.is_deleted === 'true' || c.is_deleted === 1;
    const activeCols = appState.colonies.filter(c => !isDeletedNorm(c) && (parseFloat(c.current_weight) || 0) > 0);
    if (activeCols.length > 0) {
        const total = activeCols.reduce((s, c) => s + (parseFloat(c.current_weight) || 0), 0);
        return { weight: Math.round(total * 10) / 10, source: 'colonies' };
    }
    // Fallback: ultima misura in Timeline (solo record pesata)
    const pesate = (appState.measurements || []).filter(m => m.event_type === 'pesata' || !m.event_type);
    if (pesate.length > 0) {
        const latest = pesate[pesate.length - 1];
        return { weight: latest.total_weight, source: 'timeline' };
    }
    return { weight: 0, source: 'timeline' };
};

/**
 * Distribuisce un nuovo peso globale proporzionalmente tra le colonie attive.
 * Usata quando si registra una pesata globale (senza colony_id specifico).
 * @param {number} newTotal - Il nuovo peso globale misurato sulla bilancia
 */
const distributeGlobalWeight = async (newTotal) => {
    const isDeletedNorm = (c) => c.is_deleted === true || c.is_deleted === 'true' || c.is_deleted === 1;
    const activeCols = appState.colonies.filter(c => !isDeletedNorm(c));
    if (activeCols.length === 0) return;
    const totalCurrent = activeCols.reduce((s, c) => s + (parseFloat(c.current_weight) || 0), 0);
    if (totalCurrent <= 0) {
        // Se nessuna colonia ha peso, distribuisci equamente
        const share = newTotal / activeCols.length;
        for (const colony of activeCols) {
            colony.current_weight = Math.round(share * 10) / 10;
            await saveColony(colony);
        }
        return;
    }
    const ratio = newTotal / totalCurrent;
    for (const colony of activeCols) {
        colony.current_weight = Math.round((parseFloat(colony.current_weight) || 0) * ratio * 10) / 10;
        await saveColony(colony);
    }
    console.info(`[D.U.B.I.A.] distributeGlobalWeight: ${newTotal}g distribuiti tra ${activeCols.length} colonie (ratio=${ratio.toFixed(3)})`);
};

const updateUI = () => {
    // Usa il peso bottom-up se ci sono colonie, altrimenti fallback timeline
    const globalWeightData = computeGlobalWeight();

    if (globalWeightData.source === 'colonies') {
        // Bottom-up: usa il peso somma delle colonie come base per tutti i calcoli
        _updateUIWithWeight(globalWeightData.weight);
    } else {
        if (appState.measurements.length === 0) return;
        _updateUIWithWeight(appState.measurements[appState.measurements.length - 1].total_weight);
    }

    // Data Decay: aggiorna widget affidabilità
    if (typeof renderDataDecay === 'function') renderDataDecay();
};

const _updateUIWithWeight = (globalWeight) => {
    if (globalWeight <= 0 && appState.measurements.length === 0) return;

    // Usa l'ultima misura per i metadati (adultRatio, healthIndex ecc) ma il peso bottom-up
    const latest = appState.measurements.length > 0
        ? appState.measurements[appState.measurements.length - 1]
        : { total_weight: globalWeight, adult_ratio: 0.35, health_index: 100 };

    // Sovrascrive il peso con quello bottom-up (fondamenta)
    const effectiveWeight = globalWeight > 0 ? globalWeight : latest.total_weight;

    // Future Prediction based on current slider
    const deltaGValue = parseInt(document.getElementById('deltaGSlider').value) || 30;
    // For future projection, use the latest real weight and average recent food amount (or assume 0 if not provided), and recent adult ratio. We'll just use a proxy of 0 food for natural growth prediction, or maybe assume linear food consumption. Let's assume natural growth for future projection (C_t = 0), or same as last.
    // The prompt says: riproporzionando il numero stimato di individui in base alla crescita volumetrica attesa.
    // We will use the last adult ratio.
    const lastAdultRatio = (latest.adult_ratio !== undefined && latest.adult_ratio !== null) ? Number(latest.adult_ratio) : 0.35;
    const futurePred = calculatePrediction(effectiveWeight, 0, lastAdultRatio, deltaGValue, appState.params);

    // Dashboard — usa effectiveWeight (bottom-up se ci sono colonie)
    document.getElementById('realWeightValue').innerText = `${effectiveWeight.toFixed(1)} g`;
    document.getElementById('predWeightValue').innerText = `${futurePred.toFixed(1)} g`;

    document.getElementById('theta1Value').innerText = appState.params.theta1.toFixed(4);
    document.getElementById('theta2Value').innerText = appState.params.theta2.toFixed(4);
    if (appState.params.mortalityRate !== undefined) {
        const mortInput = document.getElementById('inputMortality');
        if (mortInput && document.activeElement !== mortInput) {
            mortInput.value = appState.params.mortalityRate.toFixed(1);
        }
    }

    // Indice H corrente (ricalcolato sempre dai parametri live)
    const H_live = computeHealthIndex(appState.params.theta1);
    const healthEl = document.getElementById('healthValue');
    healthEl.innerText = `${H_live.toFixed(1)}%`;
    healthEl.className = 'health-value';
    if (H_live < HEALTH_THRESHOLD_ALERT) healthEl.classList.add('alert');
    else if (H_live < HEALTH_THRESHOLD_WARNING) healthEl.classList.add('warning');

    // Aggiorna anche la barra/label di stato H nell'header
    const healthIndicator = document.getElementById('healthIndicator');
    if (healthIndicator) {
        healthIndicator.className = 'health-indicator';
        if (H_live < HEALTH_THRESHOLD_ALERT) {
            healthIndicator.classList.add('alert');
        } else if (H_live < HEALTH_THRESHOLD_WARNING) {
            healthIndicator.classList.add('warning');
        }
    }

    // FCR Calculation
    if (appState.measurements.length > 1) {
        let totalFood = 0;
        let totalWeightGain = 0;
        for (let i = 1; i < appState.measurements.length; i++) {
            const m = appState.measurements[i];
            const prev = appState.measurements[i-1];
            if (m.food_amount && m.total_weight > prev.total_weight) {
                totalFood += m.food_amount;
                totalWeightGain += (m.total_weight - prev.total_weight);
            }
        }
        if (totalWeightGain > 0) {
            const fcr = totalFood / totalWeightGain;
            document.getElementById('fcrValue').innerText = fcr.toFixed(2);
        } else {
            document.getElementById('fcrValue').innerText = "--";
        }
    } else {
        document.getElementById('fcrValue').innerText = "--";
    }

    // ── CALCOLO CENTRALIZZATO — un'unica chiamata pura, identica su ogni device ──
    // calculateColonyMetrics() NON legge il DOM, NON usa window.innerWidth.
    // I dati derivati (fCount, mCount, ecc.) vengono SEMPRE da questa funzione.
    const metrics = calculateColonyMetrics(
        effectiveWeight,
        lastAdultRatio,
        appState.params
    );

    const { fCount, mCount, saCount, medCount, smCount, bCount, totalCount } = metrics;

    // ── Valore economico e fabbisogno idrico ─────────────────────────────────
    const economicValueEl = document.getElementById('economicValueValue');
    if (economicValueEl) economicValueEl.innerText = `${metrics.economicValue.toFixed(2)} €`;

    const waterNeedEl = document.getElementById('waterNeedValue');
    if (waterNeedEl) waterNeedEl.innerText = `${metrics.waterNeed.toFixed(1)} g/giorno`;

    // ── Sex Ratio ─────────────────────────────────────────────────────────────
    if (fCount > 0) {
        const ratio = mCount / fCount;
        document.getElementById('sexRatioValue').innerText = `1 : ${(1/ratio).toFixed(1)}`;
        const statusEl = document.getElementById('sexRatioStatus');
        const cardEl = document.getElementById('sexRatioCard');

        if (ratio >= 0.2 && ratio <= 0.35) {
            statusEl.innerText = "Ottimale per la riproduzione (1:3 - 1:5).";
            statusEl.style.color = "var(--accent-green)";
            cardEl.style.borderColor = "var(--accent-green)";
            cardEl.style.backgroundColor = "rgba(39, 174, 96, 0.1)";
        } else if (ratio > 0.35) {
            statusEl.innerText = "Eccesso di maschi. Valutare la rimozione per evitare competizione/stress.";
            statusEl.style.color = "var(--alert-red)";
            cardEl.style.borderColor = "var(--alert-red)";
            cardEl.style.backgroundColor = "rgba(255, 71, 87, 0.1)";
        } else {
            statusEl.innerText = "Scarsità di maschi. Potrebbe ridurre la frequenza di accoppiamento.";
            statusEl.style.color = "#F2C94C";
            cardEl.style.borderColor = "#F2C94C";
            cardEl.style.backgroundColor = "rgba(242, 201, 76, 0.1)";
        }
    } else {
        document.getElementById('sexRatioValue').innerText = "--";
        document.getElementById('sexRatioStatus').innerText = "Dati insufficienti.";
    }



    // Harvest Simulator
    const harvestAmountInput = document.getElementById('harvestAmount');
    const harvestCategorySelect = document.getElementById('harvestCategory');
    const harvestCyclicCheckbox = document.getElementById('harvestCyclic');
    const msyWarning = document.getElementById('msyWarning');
    const harvestCountLabel = document.getElementById('harvestCountLabel');
    const harvestCountVal = document.getElementById('harvestCountVal');

    if (harvestAmountInput) {
        const updateHarvest = () => {



            let amount = parseFloat(harvestAmountInput.value) || 0;
            const category = harvestCategorySelect ? harvestCategorySelect.value : 'ALL';
            const isCyclic = harvestCyclicCheckbox ? harvestCyclicCheckbox.checked : false;
            const currentWeight = latest.total_weight;

            // Optional: calculate count based on category
            if (category !== 'ALL' && MASS[category]) {
                const count = Math.round(amount / MASS[category]);
                if (harvestCountLabel) {
                    harvestCountLabel.style.display = 'inline';
                    harvestCountVal.innerText = count;
                }
            } else {
                if (harvestCountLabel) harvestCountLabel.style.display = 'none';
            }

            // MSY & Simulation Logic
            const days = parseInt(document.getElementById('deltaGSlider').value) || 30;
            document.getElementById('harvestDaysLabel').innerText = days;

            // Calcolo impatto demografico se prelievo selettivo
            let simulatedAdultRatio = lastAdultRatio;
            if (category === 'FEMALE') {
                const newFemaleWeight = Math.max(0, currentWeight * lastAdultRatio * (fCount / (fCount + mCount + 0.1)) - amount);
                simulatedAdultRatio = Math.max(0.01, newFemaleWeight / (currentWeight - amount));
            } else if (category === 'MALE') {
                const oldMaleWeight = currentWeight * lastAdultRatio * (mCount / (fCount + mCount + 0.1));
                const newMaleWeight = Math.max(0, oldMaleWeight - amount);
                const femaleWeight = currentWeight * lastAdultRatio * (fCount / (fCount + mCount + 0.1));
                simulatedAdultRatio = Math.max(0.01, (femaleWeight + newMaleWeight) / (currentWeight - amount));
            } else if (category === 'SUBADULT' || category === 'MEDIUM' || category === 'SMALL' || category === 'BABY') {
                // Approximate ratio change if we pull out non-adults
                // Removing non-adults increases adult ratio slightly
                const remainingWeight = Math.max(1, currentWeight - amount);
                const adultWeight = currentWeight * lastAdultRatio;
                simulatedAdultRatio = Math.min(0.99, adultWeight / remainingWeight);
            }

            // Se prelievo ciclico, moltiplica l'amount per le settimane nel deltaG
            let totalSimulatedHarvest = amount;
            if (isCyclic) {
                const weeks = days / 7;
                totalSimulatedHarvest = amount * weeks;
            }

            const remainingWeight = Math.max(0, currentWeight - totalSimulatedHarvest);
            const simulatedFuture = calculatePrediction(remainingWeight, 0, simulatedAdultRatio, days, appState.params);
            const hfw = document.getElementById('harvestFutureWeight');
            if (hfw) hfw.innerText = `${simulatedFuture.toFixed(1)} g`;
            // MSY Warning: Se il peso futuro è inferiore al peso corrente prima del prelievo, la colonia è in declino
            if (simulatedFuture < currentWeight && totalSimulatedHarvest > 0) {
                if (msyWarning) msyWarning.style.display = 'block';
            } else {
                if (msyWarning) msyWarning.style.display = 'none';
            }

            // Aggiorna Grafico Doppio Scenario
            updateDoubleScenarioChart(totalSimulatedHarvest, simulatedFuture, days);
        };

        if (!harvestAmountInput.dataset.listenerAttached) {
            harvestAmountInput.addEventListener('input', updateHarvest);
            if (harvestCategorySelect) harvestCategorySelect.addEventListener('change', updateHarvest);
            if (harvestCyclicCheckbox) harvestCyclicCheckbox.addEventListener('change', updateHarvest);
            document.getElementById('deltaGSlider').addEventListener('input', updateHarvest);
            document.getElementById('deltaGInput').addEventListener('input', updateHarvest);
            harvestAmountInput.dataset.listenerAttached = 'true';
        }

        // Suggeritore Ottimale
        const suggesterText = document.getElementById('optimalSuggesterText');
        if (suggesterText) {

            // Calcolo MSY (Maximum Sustainable Yield) a 30 gg
            // MSY = W_pred_naturale(30gg) - W_attuale
            const naturalGrowth30 = calculatePrediction(latest.total_weight, 0, lastAdultRatio, 30, appState.params);
            const msy30 = Math.max(0, naturalGrowth30 - latest.total_weight);
            const msyEl = document.getElementById('msyValueText');
            if (msyEl) {
                msyEl.innerText = `${msy30.toFixed(1)} g`;
            }

            let amount = parseFloat(harvestAmountInput.value) || 0;
            if (fCount === 0) fCount = 1;
            const ratio = mCount / fCount;
            if (ratio > 0.4) {
                let suggestedMales = amount > 0 ? Math.round(amount / MASS.MALE) : Math.round(mCount - (fCount * 0.3));
                if (suggestedMales > 0) {
                    suggesterText.innerText = `Rapporto maschi/femmine troppo alto (${ratio.toFixed(2)}). Per il tuo prelievo, ti conviene raccogliere circa ${suggestedMales} Maschi Adulti. Questo aiuterà a bilanciare il Rapporto Sessuale portandolo verso 1:3.`;
                } else {
                    suggesterText.innerText = `Rapporto maschi/femmine troppo alto (${ratio.toFixed(2)}). Si consiglia di prelevare Maschi Adulti per riequilibrare la colonia verso 1:3.`;
                }
            } else if (medCount + smCount > (saCount + fCount + mCount) * 2) {
                let suggestedNymphs = amount > 0 ? Math.round(amount / MASS.MEDIUM) : Math.round(medCount * 0.2);
                suggesterText.innerText = `Eccesso di Neanidi. Si consiglia un prelievo di circa ${suggestedNymphs} Neanidi Medie per evitare futuri colli di bottiglia spaziali (sovraffollamento).`;
            } else {
                suggesterText.innerText = `Colonia ben bilanciata. Prelievo generico raccomandato per mantenere stabile la piramide demografica.`;
            }

            // Insights Prescrittivi Fase 4
            if (typeof generatePrescriptiveInsights === 'function') {
                const insights = generatePrescriptiveInsights(metrics);
                let insightsDiv = document.getElementById('prescriptiveInsights');
                if (!insightsDiv && suggesterText.parentElement) {
                    insightsDiv = document.createElement('div');
                    insightsDiv.id = 'prescriptiveInsights';
                    suggesterText.parentElement.appendChild(insightsDiv);
                }
                if (insightsDiv) {
                    if (insights.length > 0) {
                        insightsDiv.style.display = 'block';
                        insightsDiv.innerHTML = insights.map(ins => {
                            const borderColor = ins.priority === 'high' ? 'var(--alert-red)' : ins.priority === 'medium' ? '#F2C94C' : 'var(--accent-green)';
                            const bgAlpha = ins.priority === 'high' ? '192,41,43' : ins.priority === 'medium' ? '242,201,76' : '39,174,96';
                            return `<div style="display:flex;gap:0.5rem;align-items:flex-start;padding:0.5rem 0.75rem;margin-top:0.5rem;background:rgba(${bgAlpha},0.08);border-left:3px solid ${borderColor};border-radius:6px;font-size:0.82rem;"><span>${ins.icon}</span><span>${ins.text}</span></div>`;
                        }).join('');
                    } else {
                        insightsDiv.style.display = 'none';
                        insightsDiv.innerHTML = '';
                    }
                }
            }
        }

        setTimeout(() => updateHarvest(), 0);
    }

    const setSafeInner = (id, val) => { const el = document.getElementById(id); if(el) el.innerText = val; };
    setSafeInner('smartCountFemale', fCount);
    setSafeInner('smartCountMale', mCount);
    setSafeInner('smartCountSubAdult', saCount);
    setSafeInner('smartCountMedium', medCount);
    setSafeInner('smartCountSmall', smCount);
    setSafeInner('smartCountBaby', bCount);

    // Bottleneck detection
    const alarmCard = document.getElementById('demographicAlarmCard');
    const alarmText = document.getElementById('demographicAlarmText');
    if (alarmCard && alarmText) {
        if (bCount < smCount * 0.5 && latest.total_weight > 50) {
            alarmCard.style.display = 'block';
            alarmText.innerText = "Allarme: Carenza drastica di Micro-Neanidi. Previsto vuoto demografico tra 2-3 mesi. Si avrà una carenza drastica di sub-adulti disponibili al prelievo.";
        } else if (saCount < fCount * 0.2 && fCount > 10) {
            alarmCard.style.display = 'block';
            alarmText.innerText = "Allarme: Pochissime Sub-Adulte. Rischio di calo riproduttivo imminente (mancato rimpiazzo adulte).";
        } else {
            alarmCard.style.display = 'none';
        }
    }

    // ── Timer di Maturazione (Δg dinamico, θ₂-driven) ───────────────────────
    const maturationCard = document.getElementById('maturationTimerCard');
    const maturationText = document.getElementById('maturationTimerText');
    if (maturationCard && maturationText) {
        maturationCard.style.display = 'block';
        maturationText.innerText = metrics.maturMessage;
    }

    // ── Piramide Demografica Bilaterale (Age-Structure Pyramid) ─────────────
    renderAgePyramid(metrics);

    // Update Census Chart (Modulo 4 — 4 stadi D.U.B.I.A., dati da metrics centralizzate)
    const ctxCensus = document.getElementById('censusChart');
    if (ctxCensus) {
        if (appState.charts.census) {
            appState.charts.census.destroy();
        }

        // I dati vengono da calculateColonyMetrics() già eseguita — nessun ricalcolo
        const cd = metrics.census;
        const chartLabels = [
            `Femmine (${metrics.fCount})`,
            `Maschi (${metrics.mCount})`,
            `Neanidi Medie (${metrics.medCount})`,
            `Baby (${metrics.bCount})`
        ];
        const chartData   = [metrics.fCount, metrics.mCount, metrics.medCount, metrics.bCount];
        const chartColors = ['#9b59b6', '#3498db', '#2ecc71', '#f1c40f'];

        appState.charts.census = new Chart(ctxCensus.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: chartLabels,
                datasets: [{
                    data: chartData,
                    backgroundColor: chartColors,
                    borderWidth: 0,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 8, bottom: 8 } },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            color: 'white',
                            font: { size: 12 },
                            padding: 16,
                            usePointStyle: true,
                            pointStyleWidth: 10
                        }
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total > 0 ? Math.round((context.raw / total) * 100) : 0;
                                return ` ${context.label}: ${pct}%`;
                            }
                        }
                    }
                }
            }
        });
    }

    // History Table
    const tbody = document.querySelector('#historyTable tbody');
    tbody.innerHTML = '';
    // Reverse to show newest first
    const reversedMeasurements = [...appState.measurements].reverse();
    reversedMeasurements.forEach((m, index) => {
        const foodDisplay = m.food_amount !== undefined ? m.food_amount.toFixed(1) : '-';

        let fcrDisplay = '-';
        // Previous measurement is at index + 1 in the reversed array
        if (index + 1 < reversedMeasurements.length) {
            const prev = reversedMeasurements[index + 1];
            if (m.food_amount !== undefined && m.total_weight > prev.total_weight) {
                const fcr = m.food_amount / (m.total_weight - prev.total_weight);
                fcrDisplay = fcr.toFixed(2);
            }
        }

        const row = document.createElement('tr');
        const isNewBlood = m.is_new_blood ? '🩸 ' : '';
        row.innerHTML = `
            <td>${isNewBlood}${m.date}</td>
            <td>${m.total_weight.toFixed(1)}</td>
            <td>${foodDisplay}</td>
            <td style="color: var(--alert-red);">${m.harvest_amount ? '-' + m.harvest_amount.toFixed(1) : '0.0'}</td>
            <td>${fcrDisplay}</td>
            <td style="color: ${m.health_index < 75 ? 'var(--alert-red)' : 'var(--accent-green)'}">
                ${m.health_index.toFixed(1)}%
            </td>
            <td style="max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${m.notes || ''}">
                ${m.notes || '-'}
            </td>
            <td>
                <button class="btn-standard btn-danger btn-delete-row" data-id="${m.id}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; background-color: var(--alert-red);">X</button>
            </td>
        `;
        if (m.is_new_blood) row.style.backgroundColor = 'rgba(155, 89, 182, 0.1)';

        tbody.appendChild(row);
    });


    // Harvest History Table
    const harvestTbody = document.querySelector('#harvestHistoryTable tbody');
    if (harvestTbody) {
        harvestTbody.innerHTML = '';
        reversedMeasurements.forEach((m) => {
            if (m.harvest_amount > 0) {
                const hRow = document.createElement('tr');
                hRow.innerHTML = `
                    <td>${m.date}</td>
                    <td style="color: var(--alert-red);">${m.harvest_amount.toFixed(1)}</td>
                    <td style="max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${m.notes || ''}">${m.notes || '-'}</td>
                    <td>
                        <button class="btn-standard btn-danger btn-delete-row" data-id="${m.id}" style="padding: 0.2rem 0.5rem; font-size: 0.8rem; background-color: var(--alert-red);">X</button>
                    </td>
                `;
                harvestTbody.appendChild(hRow);
            }
        });
    }

    // Aggiorna Diagnostica Differenziale
    updateDiagnosticsPanel();

    // Aggiorna la Tabella di Censimento Demografico nell'UI.
    const latestForCensus = appState.measurements[appState.measurements.length - 1];
    if (latestForCensus) {
        // ── Tabella Censimento (usa metrics già calcolate — zero ricalcoli) ──────
        const safeCensusAdultRatio = (latestForCensus.adult_ratio !== undefined && latestForCensus.adult_ratio !== null) ? Number(latestForCensus.adult_ratio) : 0.35;
        updateCensusTable(
            latestForCensus.total_weight,
            safeCensusAdultRatio,
            metrics
        );
    
    // Aggiorna lo stato di allineamento
    updateAlignmentStatus();

    }

    // Aggiorna il Pregnant Ratio — usa metrics.census già calcolate (zero ricalcoli)
    if (appState.measurements.length > 1) {
        const curr = appState.measurements[appState.measurements.length - 1];
        const census = metrics.census;
        if (census && census.N_femmine > 0) {
            const deltaOverPred = curr.total_weight - (curr.predicted_weight || curr.total_weight);
            const maxExtra = census.N_femmine * 0.4;
            const pregnantPct = maxExtra > 0 ? Math.min(100, Math.max(0, (deltaOverPred / maxExtra) * 100)) : 0;
                const pregnantEl = document.getElementById('pregnantRatioValue');
            if (pregnantEl) pregnantEl.innerText = `${pregnantPct.toFixed(1)} %`;
        }
    }

    renderAgePyramid(metrics);
    renderDataDecay();

    updateCharts();
};

// ══════════════════════════════════════════════════════
// FASE 2A — PIRAMIDE DEMOGRAFICA BILATERALE
// ══════════════════════════════════════════════════════

/**
 * Renderizza la Piramide Demografica Age-Structure bilaterale.
 * Maschi a sinistra (blu), Femmine a destra (viola).
 * Include Bottleneck Detector: se uno stadio ha < 10% del precedente → avviso arancione.
 * @param {object} metrics - Oggetto da calculateColonyMetrics()
 */
const renderAgePyramid = (metrics) => {
    const pyramid = document.getElementById('agePyramid');
    if (!pyramid) return;

    const { fCount, mCount, saCount, medCount, smCount, bCount } = metrics;

    // Dati per ogni stadio: [stadioLabel, maschi, femmine, coloreM, coloreF]
    // Per gli stadi neanidi: i maschi sono 0 (non distinguibili visivamente fino all'adulto)
    // ma includiamo la proporzione teorica 23/77 anche alle neanidi per coerenza
    const stages = [
        { label: 'Femmine Adulte', subLabel: '2.5g', males: 0,       females: fCount,  colorM: '#3498db', colorF: '#9b59b6', femaleOnly: true  },
        { label: 'Maschi Adulti',  subLabel: '1.5g', males: mCount,  females: 0,       colorM: '#3498db', colorF: '#9b59b6', maleOnly: true   },
        { label: 'Sub-Adulte',     subLabel: '1.6g', males: Math.round(saCount * 0.23), females: Math.round(saCount * 0.77), colorM: '#2980b9', colorF: '#8e44ad' },
        { label: 'Neanidi Medie',  subLabel: '0.8g', males: Math.round(medCount * 0.23), females: Math.round(medCount * 0.77), colorM: '#1abc9c', colorF: '#27ae60' },
        { label: 'N. Piccole',     subLabel: '0.3g', males: Math.round(smCount * 0.23),  females: Math.round(smCount * 0.77),  colorM: '#16a085', colorF: '#1e8449' },
        { label: 'Micro-Neanidi',  subLabel: '0.1g', males: Math.round(bCount * 0.23),   females: Math.round(bCount * 0.77),   colorM: '#f39c12', colorF: '#e67e22' }
    ];

    const allTotals = stages.map(s => s.males + s.females);
    const maxTotal = Math.max(...allTotals, 1);

    // Bottleneck: se uno stadio ha < 10% del totale dello stadio precedente
    const bottleneckFlags = allTotals.map((t, i) => {
        if (i === 0) return false;
        return t > 0 && allTotals[i - 1] > 0 && t < allTotals[i - 1] * 0.10;
    });

    pyramid.innerHTML = stages.map((s, i) => {
        const total = s.males + s.females;
        const maxPct = 100; // Max percentage of the bar side
        const malePct  = maxTotal > 0 ? (s.males  / maxTotal) * maxPct : 0;
        const femPct   = maxTotal > 0 ? (s.females / maxTotal) * maxPct : 0;
        const isBottleneck = bottleneckFlags[i];
        const rowClass = isBottleneck ? 'pyramid-row bottleneck' : 'pyramid-row';
        const bottleneckBadge = isBottleneck ? `<span class="bottleneck-badge">⚠️ Strozzatura</span>` : '';

        return `
        <div class="${rowClass}">
            <div class="pyramid-bar-container left">
                <div class="pyramid-bar-fill" style="width: ${malePct.toFixed(1)}%; background: ${s.colorM};">
                    ${s.males > 0 ? `<span class="bar-count">${s.males}</span>` : ''}
                </div>
            </div>
            <div class="pyramid-label">
                <span class="stage-name">${s.label}</span>
                <span class="stage-sub">${s.subLabel}</span>
                ${bottleneckBadge}
            </div>
            <div class="pyramid-bar-container right">
                <div class="pyramid-bar-fill" style="width: ${femPct.toFixed(1)}%; background: ${s.colorF};">
                    ${s.females > 0 ? `<span class="bar-count">${s.females}</span>` : ''}
                </div>
            </div>
        </div>
        `;
    }).join('');
};

// ══════════════════════════════════════════════════════
// FASE 2B — DATA DECAY (Indice Affidabilità del Dato)
// ══════════════════════════════════════════════════════

/**
 * Renderizza il widget "Indice di Affidabilità del Dato" nella sezione Census.
 * La precisione scende del 2%/giorno dall'ultima pesata.
 * Verde >= 70%, Giallo 40-69%, Rosso < 40%.
 */
const renderDataDecay = () => {
    const widget = document.getElementById('dataDecayWidget');
    if (!widget) return;

    if (appState.measurements.length === 0) {
        widget.innerHTML = `
            <div class="decay-bar-wrapper">
                <span class="decay-label">Nessuna pesata registrata</span>
            </div>`;
        return;
    }

    // Trova l'ultima pesata (o calibrazione)
    const lastMeas = [...appState.measurements]
        .filter(m => m.event_type === 'pesata' || m.event_type === 'calibrazione')
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0]
        || appState.measurements[appState.measurements.length - 1];

    const daysSince = (Date.now() - new Date(lastMeas.date).getTime()) / 86400000;
    const reliability = Math.max(0, Math.min(100, 100 - daysSince * 2));
    const daysToUnreliable = Math.max(0, Math.ceil((reliability - 30) / 2));

    let colorClass = 'decay-green';
    let icon = '🟢';
    let statusLabel = 'Dati Affidabili';
    if (reliability < 40) { colorClass = 'decay-red'; icon = '🔴'; statusLabel = 'Dati Inaffidabili'; }
    else if (reliability < 70) { colorClass = 'decay-yellow'; icon = '🟡'; statusLabel = 'Precisione in Calo'; }

    const daysText = reliability < 30
        ? `⚠️ Dati scaduti da ${Math.floor(daysSince - 35)} giorni — <strong>pesare subito!</strong>`
        : `I dati diventeranno inaffidabili tra <strong>${daysToUnreliable} giorni</strong>`;

    widget.innerHTML = `
        <div class="decay-header">
            <span>${icon} Affidabilità Dati: <strong class="${colorClass}">${reliability.toFixed(0)}%</strong></span>
            <span class="decay-last">Ultima pesata: ${Math.floor(daysSince)} giorni fa</span>
        </div>
        <div class="decay-bar-track">
            <div class="decay-bar-fill ${colorClass}" style="width: ${reliability.toFixed(0)}%;"></div>
        </div>
        <div class="decay-info">${daysText}</div>
    `;
};

const updateCharts = () => {
    // 1) Raggruppa le misurazioni per giorno
    const dailyMap = new Map();
    appState.measurements.forEach(m => {
        const dStr = m.date.substring(0, 10);
        dailyMap.set(dStr, m); // Sovrascrive per tenere l'ultimo dato di ogni giorno
    });

    const uniqueMeasurements = Array.from(dailyMap.values()).sort((a, b) => new Date(a.date) - new Date(b.date));

    // 2) Estrai etichette e dati
    const labels = uniqueMeasurements.map(m => {
        const dStr = m.date.substring(0, 10);
        const parts = dStr.split('-');
        if (parts.length === 3) {
            return `${parts[2]}/${parts[1]}/${parts[0]}`; // DD/MM/YYYY
        }
        return dStr;
    });

    const realData = uniqueMeasurements.map(m => m.total_weight);
    const predData = uniqueMeasurements.map(m => m.predicted_weight);
    const notesData = uniqueMeasurements.map(m => m.notes || '');

    if (uniqueMeasurements.length > 0) {
        const latest = uniqueMeasurements[uniqueMeasurements.length - 1];
        const deltaGValue = parseInt(document.getElementById('deltaGSlider').value) || 30;
        const lastAdultRatio = (latest.adult_ratio !== undefined && latest.adult_ratio !== null) ? Number(latest.adult_ratio) : 0.35;
        const futurePred = calculatePrediction(latest.total_weight, 0, lastAdultRatio, deltaGValue, appState.params);

        // Add future projected point
        const futureDate = new Date(latest.date);
        futureDate.setDate(futureDate.getDate() + deltaGValue);
        const futureDateStr = futureDate.toISOString().split('T')[0];
        const fParts = futureDateStr.split('-');
        const fFormatted = fParts.length === 3 ? `${fParts[2]}/${fParts[1]}/${fParts[0]}` : futureDateStr;

        labels.push(fFormatted + ' (Proj)');
        realData.push(null); // No real data for future
        predData.push(futurePred);
        notesData.push('Proiezione Futura');
    }

    // Chart.js global defaults
    Chart.defaults.color = '#94A3B8';
    Chart.defaults.font.family = 'Inter';

    // Weight Chart
    const ctxWeight = document.getElementById('weightChart').getContext('2d');
    if (appState.charts.weight) appState.charts.weight.destroy();
    
    appState.charts.weight = new Chart(ctxWeight, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Peso Reale (g)',
                    data: realData,
                    borderColor: '#27AE60',
                    backgroundColor: 'rgba(39, 174, 96, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'Peso Teorico (g)',
                    data: predData,
                    borderColor: '#8E44AD',
                    borderDash: [5, 5],
                    borderWidth: 2,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            if (context.parsed.y !== null) {
                                label += context.parsed.y.toFixed(1) + ' g';
                            }
                            return label;
                        },
                        afterBody: function(tooltipItems) {
                            const dataIndex = tooltipItems[0].dataIndex;
                            let text = '';
                            if (notesData[dataIndex]) {
                                text += '\nNote: ' + notesData[dataIndex];
                            }
                            // Add extra information if available
                            return text;
                        }
                    }
                }
            },
            scales: {
                y: { grid: { color: 'rgba(255,255,255,0.05)' } },
                x: { grid: { display: false } }
            }
        }
    });

    // Health Chart
    const healthDataCorrected = uniqueMeasurements.map((m, i) => {
        // Se è l'ultimo record, usa l'H live calcolato dai parametri aggiornati
        if (i === uniqueMeasurements.length - 1) {
            return computeHealthIndex(appState.params.theta1);
        }
        // Per record storici, l'H salvato potrebbe essere la vecchia formula;
        // normalizziamo: se H > 200 o < 0 è chiaramente sbagliato, usa 100.
        const h = m.health_index;
        return (h >= 0 && h <= 200) ? h : 100;
    });
    healthDataCorrected.push(null); // punto futuro senza health

    const hMin = Math.max(40, Math.min(...healthDataCorrected.filter(v => v !== null)) - 10);
    const hMax = Math.min(130, Math.max(...healthDataCorrected.filter(v => v !== null)) + 10);

    const ctxHealth = document.getElementById('healthChart').getContext('2d');
    if (appState.charts.health) appState.charts.health.destroy();

    appState.charts.health = new Chart(ctxHealth, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Indice Salute H (%)',
                    data: healthDataCorrected,
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    fill: true,
                    spanGaps: false
                },
                // Linea soglia Warning (90%)
                {
                    label: 'Soglia Warning (90%)',
                    data: Array(labels.length).fill(90),
                    borderColor: '#F2C94C',
                    borderDash: [4, 4],
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false
                },
                // Linea soglia Critica (75%)
                {
                    label: 'Soglia Critica (75%)',
                    data: Array(labels.length).fill(75),
                    borderColor: '#C0292B',
                    borderDash: [4, 4],
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,   // ← obbligatorio per mobile-first
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: '#94A3B8',
                        font: { size: 11 },
                        filter: (item) => !item.text.includes('Soglia') || true
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (context.parsed.y === null) return null;
                            return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}%`;
                        },
                        afterBody: function(tooltipItems) {
                            const dataIndex = tooltipItems[0].dataIndex;
                            if (notesData[dataIndex]) {
                                return '\nNote: ' + notesData[dataIndex];
                            }
                            return '';
                        }
                    }
                }
            },
            scales: {
                y: {
                    min: hMin,
                    max: hMax,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { callback: v => v + '%' }
                },
                x: { grid: { display: false } }
            }
        }
    });
};


// --- EVENT LISTENERS & DOM LOGIC ---


const deleteMeasurement = async (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction("measurements", "readwrite");
        const store = tx.objectStore("measurements");
        const req = store.delete(Number(id)); // ID is usually a number

        req.onsuccess = () => {
            appState.measurements = appState.measurements.filter(m => m.id !== Number(id));
            updateUI();
            showNotification("Eliminato", "La rilevazione è stata rimossa con successo.", "success");
            resolve();
        };

        req.onerror = () => {
            showNotification("Errore", "Impossibile eliminare il dato.", "alert");
            resolve();
        };
    });
};

document.addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.btn-delete-row');
    if (deleteBtn) {
        const id = deleteBtn.getAttribute('data-id');

        // First Confirmation modal
        const confirmModal = document.createElement('div');
        confirmModal.className = 'modal-overlay active';
        confirmModal.innerHTML = `
            <div class="modal">
                <h2 style="color: var(--alert-red);">Conferma Eliminazione</h2>
                <p>Sei sicuro di voler eliminare questa singola rilevazione?</p>
                <div class="modal-actions">
                    <button type="button" class="btn-standard btn-cancel btnCancelDelRow">Annulla</button>
                    <button type="button" class="btn-standard btn-danger btnConfirmDelRow">Procedi</button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmModal);

        confirmModal.querySelectorAll('.btn-cancel')[0].addEventListener('click', () => {
            document.body.removeChild(confirmModal);
        });

        confirmModal.querySelectorAll('.btn-danger')[0].addEventListener('click', () => {
            document.body.removeChild(confirmModal);

            // Double Confirmation modal
            const doubleConfirmModal = document.createElement('div');
            doubleConfirmModal.className = 'modal-overlay active';
            doubleConfirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Ultimo Avviso</h2>
                    <p>Attenzione: l'eliminazione del dato è irreversibile e influenzerà le rilevazioni successive. Procedere comunque?</p>
                    <div class="modal-actions">
                        <button type="button" class="btn-standard btn-cancel">Non Eliminare</button>
                        <button type="button" class="btn-standard btn-danger">Si, Elimina Dato</button>
                    </div>
                </div>
            `;
            document.body.appendChild(doubleConfirmModal);

            doubleConfirmModal.querySelectorAll('.btn-cancel')[0].addEventListener('click', () => {
                document.body.removeChild(doubleConfirmModal);
            });

            doubleConfirmModal.querySelectorAll('.btn-danger')[0].addEventListener('click', async () => {
                document.body.removeChild(doubleConfirmModal);
                await deleteMeasurement(id);
            });
        });
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    const inputMortality = document.getElementById('inputMortality');
    if (inputMortality) {
        inputMortality.addEventListener('change', (e) => {
            appState.params.mortalityRate = parseFloat(e.target.value) || 1.5;
            saveParams(appState.params);
            updateUI();
        });
    }

    // Init DB
    try {
        await initDB();
        updateUI();
        // V2: flush offline queue al boot + avvio background sync
        if (navigator.onLine) flushOfflineQueue();
        startBackgroundSync();
    } catch (e) {
        console.error("Failed to initialize app data", e);
    }

    // Load Maintenance Task State
    const tasks = ['taskCleaning', 'taskCartons', 'taskTreatments'];
    tasks.forEach(taskId => {
        const el = document.getElementById(taskId);
        if (el) {
            const savedState = localStorage.getItem(taskId);
            if (savedState === 'true') {
                el.checked = true;
            }
            el.addEventListener('change', (e) => {
                localStorage.setItem(taskId, e.target.checked);
            });
        }
    });

    // Tabs logic
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            
            const target = tab.dataset.target;
            tab.classList.add('active');
            document.getElementById(target).classList.add('active');

            // Hook: aggiorna la UI specifica alla selezione della tab
            if (target === 'dashboard') {
                updateUI();
            } else if (target === 'colonies') {
                updateColoniesUI();
            } else if (target === 'clienti') {
                updateClientiUI();
            } else if (target === 'listino') {
                renderListinoPrezziUI();
            } else if (target === 'clima') {
                ClimateModule.init();
            }
        });
    });

    // Modal logic
    const modal = document.getElementById('entryModal');
    const fab = document.getElementById('fabAdd');
    const btnCancel = document.getElementById('btnCancelEntry');
    const form = document.getElementById('entryForm');

    const deltaGSlider = document.getElementById('deltaGSlider');
    const deltaGInput = document.getElementById('deltaGInput');

    // Sync slider and input for deltaG
    deltaGSlider.addEventListener('input', (e) => {
        deltaGInput.value = e.target.value;
        updateUI(); // Real-time recalculation
    });

    deltaGInput.addEventListener('input', (e) => {
        deltaGSlider.value = e.target.value;
        updateUI(); // Real-time recalculation
    });

    const presetBtns = document.querySelectorAll('.btn-preset');
    presetBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const val = e.target.dataset.val;
            deltaGSlider.value = val;
            deltaGInput.value = val;
            updateUI();
        });
    });

    // Calibration logic
    const calibModal = document.getElementById('calibrationModal');
    const btnCalibrate = document.getElementById('btnCalibrate');
    const btnCancelCalib = document.getElementById('btnCancelCalib');
    const calibForm = document.getElementById('calibrationForm');

    if (btnCalibrate) {
        btnCalibrate.addEventListener('click', () => {
            if (appState.measurements.length === 0) {
                showNotification("Errore", "Nessun dato presente. Inserisci prima una pesata.", "alert");
                return;
            }
            calibModal.classList.add('active');
        });
    }

    if (btnCancelCalib) {
        btnCancelCalib.addEventListener('click', () => calibModal.classList.remove('active'));
    }

    if (calibForm) {
        calibForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const category = document.getElementById('calibCategory').value;
            const count = parseInt(document.getElementById('calibCount').value);

            const latest = appState.measurements[appState.measurements.length - 1];
            const currentWeight = latest.total_weight;

            // Calculate theoretical weight of the category
            const categoryWeight = count * MASS[category];

            // Re-calculate Adult Ratio if female or male
            let newAdultRatio = latest.adult_ratio;
            if (category === 'FEMALE' || category === 'MALE') {
                // If we know exactly how many females, we can force the ratio
                if (category === 'FEMALE') {
                    newAdultRatio = categoryWeight / currentWeight;
                }
                // Cap it to sane bounds
                newAdultRatio = Math.min(0.9, Math.max(0.1, newAdultRatio));
            }

            // Apply a slight bump to theta2 to simulate learning from manual intervention
            appState.params.theta2 = Math.min(5.0, appState.params.theta2 * 1.05);

            if (!appState.params.manualCalibrations) {
                appState.params.manualCalibrations = {};
            }
            appState.params.manualCalibrations[category] = count;
            saveParams(appState.params);

            // Record a calibration event
            const todayDate = new Date().toISOString().split('T')[0];
            const catLabels = { FEMALE: 'Femmine Adulte', MALE: 'Maschi Adulti', SUBADULT: 'Sub-Adulte', MEDIUM: 'Neanidi Medie', SMALL: 'Neanidi Piccole', BABY: 'Micro-Neanidi' };
            await processNewMeasurement(
                todayDate,
                currentWeight,
                0, // 0 food for calibration event
                newAdultRatio,
                `[Calibrazione] Conteggio reale: ${count} ${catLabels[category] || category}`,
                0,
                false,
                false,
                'calibrazione'
            );

            calibModal.classList.remove('active');
            calibForm.reset();
            showNotification("Calibrazione Applicata", "I parametri demografici sono stati aggiornati.", "success");
        });
    }

    const adultRatioSlider = document.getElementById('inputAdultRatioSlider');
    const adultRatioInput = document.getElementById('inputAdultRatio');

    if (adultRatioSlider && adultRatioInput) {
        adultRatioSlider.addEventListener('input', (e) => {
            adultRatioInput.value = e.target.value;
        });
        adultRatioInput.addEventListener('input', (e) => {
            adultRatioSlider.value = e.target.value;
        });
    }

    // Set today's date as default
    document.getElementById('inputDate').valueAsDate = new Date();

    const inputType = document.getElementById('inputType');
    const groupWeight = document.getElementById('groupWeight');
    const groupFoodAmount = document.getElementById('groupFoodAmount');
    const groupHarvestAmount = document.getElementById('groupHarvestAmount');

    const updateFormVisibility = () => {
        const type = inputType.value;
        if (type === 'pesata') {
            groupWeight.style.display = 'block';
            groupFoodAmount.style.display = 'block';
            groupHarvestAmount.style.display = 'block';
            document.getElementById('inputWeight').required = true;
            document.getElementById('inputFoodAmount').required = false;
        } else if (type === 'cibo') {
            groupWeight.style.display = 'none';
            groupFoodAmount.style.display = 'block';
            groupHarvestAmount.style.display = 'none';
            document.getElementById('inputWeight').required = false;
            document.getElementById('inputFoodAmount').required = true;
        } else if (type === 'prelievo') {
            groupWeight.style.display = 'none';
            groupFoodAmount.style.display = 'none';
            groupHarvestAmount.style.display = 'block';
            document.getElementById('inputWeight').required = false;
            document.getElementById('inputFoodAmount').required = false;
        }
    };

    if (inputType) {
        inputType.addEventListener('change', updateFormVisibility);
        updateFormVisibility(); // Initialize
    }

    fab.addEventListener('click', () => {
        modal.classList.add('active');
        if (inputType) updateFormVisibility();
    });
    btnCancel.addEventListener('click', () => modal.classList.remove('active'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const eventType = inputType ? inputType.value : 'pesata';
        const date = document.getElementById('inputDate').value;
        const adultRatio = parseFloat(document.getElementById('inputAdultRatio').value);
        const notes = document.getElementById('inputNotes').value;

        const colonyIdVal = document.getElementById('inputColonyId')?.value;
        const colonyId = colonyIdVal ? Number(colonyIdVal) : null;

        let weight = 0;
        let foodAmount = 0;
        let harvestAmount = 0;

        if (eventType === 'pesata') {
            weight = parseFloat(document.getElementById('inputWeight').value);
            foodAmount = parseFloat(document.getElementById('inputFoodAmount').value) || 0;
            harvestAmount = parseFloat(document.getElementById('inputHarvestAmount')?.value) || 0;
        } else if (eventType === 'cibo') {
            foodAmount = parseFloat(document.getElementById('inputFoodAmount').value);
        } else if (eventType === 'prelievo') {
            harvestAmount = parseFloat(document.getElementById('inputHarvestAmount')?.value) || 0;
        }

        if (colonyId) {
            const colony = appState.colonies.find(c => c.id === colonyId);
            if (colony) {
                const oldWeight = colony.current_weight || 0;
                
                const males_count = Number(document.getElementById('inputColonyMales').value) || 0;
                const females_count = Number(document.getElementById('inputColonyFemales').value) || 0;
                let adultUpdated = false;
                if (males_count > 0 || females_count > 0) {
                    colony.males_count = males_count;
                    colony.females_count = females_count;
                    adultUpdated = true;
                }

                if (eventType === 'pesata') {
                    colony.current_weight = weight;
                    // Se non sono stati aggiornati manualmente gli adulti, riallinea coerentemente la demografia neanidi
                    if (!adultUpdated) {
                        const wAdults = (colony.males_count || 0) * MASS.MALE + (colony.females_count || 0) * MASS.FEMALE;
                        const wNinfeKnown = (colony.subadults_count || 0) * MASS.SUBADULT + (colony.medium_count || 0) * MASS.MEDIUM + (colony.small_count || 0) * MASS.SMALL;
                        const remainingWeight = colony.current_weight - wAdults;

                        if (remainingWeight > wNinfeKnown) {
                            // Surplus di biomassa neanidi assorbito da baby/piccole
                            const remainingForBaby = remainingWeight - wNinfeKnown;
                            colony.baby_count = Math.round(remainingForBaby / MASS.BABY);
                        } else if (remainingWeight > 0) {
                            // Se il peso è inferiore ma positivo, riscala proporzionalmente le neanidi
                            const currentNymphWeight = wNinfeKnown + ((colony.baby_count || 0) * MASS.BABY);
                            if (currentNymphWeight > 0) {
                                const nymphRatio = remainingWeight / currentNymphWeight;
                                colony.subadults_count = Math.round((colony.subadults_count || 0) * nymphRatio);
                                colony.medium_count = Math.round((colony.medium_count || 0) * nymphRatio);
                                colony.small_count = Math.round((colony.small_count || 0) * nymphRatio);
                                colony.baby_count = Math.round((colony.baby_count || 0) * nymphRatio);
                            } else {
                                colony.medium_count = Math.round((remainingWeight * 0.70) / MASS.MEDIUM);
                                colony.baby_count = Math.round((remainingWeight * 0.30) / MASS.BABY);
                            }
                        } else {
                            colony.baby_count = 0;
                            colony.small_count = 0;
                            colony.medium_count = 0;
                            colony.subadults_count = 0;
                        }
                    }
                } else if (eventType === 'prelievo') {
                    colony.current_weight = Math.max(0, oldWeight - harvestAmount);
                } else if (eventType === 'cibo') {
                    colony.current_weight = calculatePrediction(oldWeight, foodAmount, adultRatio, 0, appState.params, harvestAmount);
                }

                await saveColony(colony);
                
                // Calcola il peso globale effettivo (somma reale di tutte le colonie attive)
                const newGlobalWeight = computeGlobalWeight().weight;

                // Calcola il rapporto adulti effettivo A_t
                const isDeletedNorm = (c) => c.is_deleted === true || c.is_deleted === 'true' || c.is_deleted === 1;
                const activeCols = appState.colonies.filter(c => !isDeletedNorm(c) && (parseFloat(c.current_weight) || 0) > 0);
                let totalColonyBiomass = 0;
                let totalAdultBiomass = 0;
                activeCols.forEach(c => {
                    totalColonyBiomass += (parseFloat(c.current_weight) || 0);
                    totalAdultBiomass += ((c.males_count || 0) * MASS.MALE + (c.females_count || 0) * MASS.FEMALE);
                });

                const effectiveColonyAdultRatio = totalColonyBiomass > 0
                    ? Math.max(0, Math.min(1, totalAdultBiomass / totalColonyBiomass))
                    : ((colony.current_weight || 0) > 0 
                        ? Math.max(0, Math.min(1, ((colony.males_count || 0) * MASS.MALE + (colony.females_count || 0) * MASS.FEMALE) / colony.current_weight))
                        : (adultRatio !== undefined && adultRatio !== null ? adultRatio : 0.35));
                
                const globalNotes = `[${colony.name}] ${notes}`;
                // Registra l'evento a livello globale con il nuovo peso calcolato e A_t coerente
                await processNewMeasurement(date, newGlobalWeight, foodAmount, effectiveColonyAdultRatio, globalNotes, harvestAmount, false, true, eventType, colonyId, colony.current_weight);
            }
        } else {
            // Pesata Globale: distribuisce proporzionalmente tra le colonie attive
            if (eventType === 'pesata' && weight > 0 && appState.colonies.filter(c => !c.is_deleted).length > 0) {
                await distributeGlobalWeight(weight);
                console.info(`[D.U.B.I.A.] Pesata globale ${weight}g distribuita proporzionalmente.`);
            }
            // ━━ RICONCILIAZIONE: controlla delta > 5% per pesate ━━━━━━━━━━━━━━━━━━━━━━━━━━━
            if (eventType === 'pesata' && appState.measurements.length > 0) {
                const lastM = appState.measurements[appState.measurements.length - 1];
                const predicted = lastM.predicted_weight || lastM.total_weight;
                const pendingFn = async () => {
                    await processNewMeasurement(date, weight, foodAmount, adultRatio, notes, harvestAmount, false, true, eventType);
                };
                const intercepted = checkReconciliationTrigger(weight, predicted, pendingFn);
                if (intercepted) {
                    // Sospeso: il modal di riconciliazione gestirà il salvataggio
                    modal.classList.remove('active');
                    form.reset();
                    document.getElementById('inputDate').valueAsDate = new Date();
                    return;
                }
            }
            await processNewMeasurement(date, weight, foodAmount, adultRatio, notes, harvestAmount, false, true, eventType);
        }
        
        modal.classList.remove('active');
        form.reset();
        document.getElementById('inputDate').valueAsDate = new Date();

        if (colonyId) {
            updateColoniesUI();
            // Aggiorna anche i dati nel modal dettagli colonia se è aperto
            const detailCard = document.getElementById('colonyDetailCard');
            if (detailCard && detailCard.style.display !== 'none') {
                showColonyDetails(colonyId);
            }
        }

        if (inputType) {
            inputType.value = 'pesata';
            updateFormVisibility();
        }

        if (adultRatioSlider) adultRatioSlider.value = 0.35;
        if (adultRatioInput) adultRatioInput.value = 0.35;

        showNotification("Successo", "Nuova rilevazione elaborata dal D.U.B.I.A.", "success");
    });

    // Reset DB Logic
    // CSV Export Logic
    const btnExportCSV = document.getElementById('btnExportCSV');
    if (btnExportCSV) {
        btnExportCSV.addEventListener('click', () => {
            if (appState.measurements.length === 0) {
                showNotification("Attenzione", "Nessun dato da esportare.", "warning");
                return;
            }

            // CSV Header
            let csvContent = "data:text/csv;charset=utf-8,";
            csvContent += "Data,Peso Reale (g),Peso Teorico (g),Cibo (g),Ratio Adulti,Indice Salute (%),Note\n";

            appState.measurements.forEach(m => {
                // Escape quotes in notes
                const safeNotes = m.notes ? `"${m.notes.replace(/"/g, '""')}"` : "";
                const row = [
                    m.date,
                    m.total_weight.toFixed(2),
                    (m.predicted_weight || m.total_weight).toFixed(2),
                    (m.food_amount || 0).toFixed(2),
                    (m.adult_ratio || 0).toFixed(2),
                    m.health_index.toFixed(2),
                    safeNotes
                ];
                csvContent += row.join(",") + "\n";
            });

            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", "dubia_storico_dati.csv");
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            showNotification("Esportazione Completata", "Il file CSV è stato scaricato.", "success");
        });
    }


    const btnNewBlood = document.getElementById('btnNewBlood');
    if (btnNewBlood) {
        btnNewBlood.addEventListener('click', async () => {
            if (appState.measurements.length === 0) {
                showNotification("Errore", "Nessun dato presente.", "alert");
                return;
            }
            const latest = appState.measurements[appState.measurements.length - 1];
            const today = new Date().toISOString().split('T')[0];

            // Inserisci un evento di tracciamento consanguineità senza peso (o copiando l'ultimo peso)
            await processNewMeasurement(
                today,
                latest.total_weight,
                0,
                latest.adult_ratio,
                "[Nuovo Sangue] Inseriti nuovi riproduttori per migliorare la genetica.",
                0,
                true,
                false,
                'nuovo_sangue'
            );

            showNotification("Successo", "Nuova linea genetica registrata con successo.", "success");
        });
    }

    const btnConfirmHarvestSim = document.getElementById('btnConfirmHarvestSim');
    if (btnConfirmHarvestSim) {
        btnConfirmHarvestSim.addEventListener('click', async () => {
            const amount = parseFloat(document.getElementById('harvestAmount').value);
            if (isNaN(amount) || amount <= 0) {
                showNotification("Errore", "Inserisci una quantità valida da prelevare.", "error");
                return;
            }

            const isCyclic = document.getElementById('harvestCyclic').checked;
            const categoryElement = document.getElementById('harvestCategory');
            const categoryText = categoryElement.options[categoryElement.selectedIndex].text;

            let noteStr = `Prelievo: ${categoryText}`;
            if (isCyclic) {
                noteStr += " (Ciclico settimanale)";
            }

            // Using custom modal for confirmation instead of alert/confirm
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2>Conferma Prelievo</h2>
                    <p>Sei sicuro di voler registrare un prelievo reale di <strong>${amount} g</strong>?</p>
                    <div style="display: flex; gap: 1rem; margin-top: 1.5rem; justify-content: flex-end;">
                        <button id="btnCancelSimHarvest" class="btn-standard" style="background-color: var(--card-bg);">Annulla</button>
                        <button id="btnConfirmSimHarvestAction" class="btn-standard btn-danger">Sì, Registra</button>
                    </div>
                </div>
            `;
            document.body.appendChild(confirmModal);

            document.getElementById('btnCancelSimHarvest').addEventListener('click', () => {
                document.body.removeChild(confirmModal);
            });

            document.getElementById('btnConfirmSimHarvestAction').addEventListener('click', async () => {
                document.body.removeChild(confirmModal);

                const today = new Date().toISOString().split('T')[0];
                let lastWeight = appState.measurements.length > 0 ?
                    appState.measurements[appState.measurements.length - 1].total_weight : 0;

                // Subtract the harvest amount immediately from the current weight
                // so it reflects as an actual deduction, not a future projection.
                const newCurrentWeight = Math.max(0, lastWeight - amount);

                const btn = document.getElementById('btnConfirmHarvestSim');
                const originalText = btn.innerText;
                btn.innerText = "Salvataggio...";
                btn.disabled = true;

                const latestM = appState.measurements.length > 0 ? appState.measurements[appState.measurements.length - 1] : null;
                const adultRatioToUse = latestM ? ((latestM.adult_ratio !== undefined && latestM.adult_ratio !== null) ? Number(latestM.adult_ratio) : 0.35) : 0.35;

                await processNewMeasurement(
                    today,
                    newCurrentWeight,
                    0,
                    adultRatioToUse,
                    noteStr,
                    amount,
                    false,
                    true,
                    'prelievo'
                );

                btn.innerText = originalText;
                btn.disabled = false;

                // Reset amount in simulator
                document.getElementById('harvestAmount').value = 0;

                showNotification("Successo", `Prelievo di ${amount}g registrato.`, "success");
            });
        });
    }

    // ══════════════════════════════════════════════════════
    // EVENT LISTENERS — SEZIONE CLIENTI
    // ══════════════════════════════════════════════════════

    // Aggiorna UI clienti al caricamento (dopo loadInitialData)
    updateClientiUI();

    // Inizializza Listino Prezzi Completo
    initListinoEventListeners();
    renderListinoPrezziUI();

    // ── Nuovo Cliente ─────────────────────────────────────────
    const btnNuovoCliente = document.getElementById('btnNuovoCliente');
    if (btnNuovoCliente) {
        btnNuovoCliente.addEventListener('click', () => openClientModal(null));
    }
    const btnCancelClient = document.getElementById('btnCancelClient');
    if (btnCancelClient) {
        btnCancelClient.addEventListener('click', () => document.getElementById('clientModal').classList.remove('active'));
    }

    const clientForm = document.getElementById('clientForm');
    if (clientForm) {
        clientForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const idVal = document.getElementById('clientId').value;
            const client = {
                nome:     document.getElementById('clientNome').value.trim(),
                cognome:  document.getElementById('clientCognome').value.trim(),
                citta:    document.getElementById('clientCitta').value.trim(),
                telefono: document.getElementById('clientTelefono').value.trim(),
                email:    document.getElementById('clientEmail').value.trim(),
                animale:  document.getElementById('clientAnimale').value,
                note:     document.getElementById('clientNote').value.trim(),
                data_aggiunta: new Date().toISOString().split('T')[0]
            };
            if (idVal) client.id = Number(idVal);

            await saveClient(client);
            document.getElementById('clientModal').classList.remove('active');
            updateClientiUI();
            showNotification('Cliente Salvato', `${client.nome} ${client.cognome} aggiunto al database.`, 'success');
        });
    }

    // ── Delegazione click su lista clienti ───────────────────
    document.addEventListener('click', async (e) => {
        // Bottone Modifica cliente
        const editBtn = e.target.closest('.btn-client-edit');
        if (editBtn) {
            const id = Number(editBtn.dataset.id);
            const client = appState.clients.find(c => c.id === id);
            if (client) openClientModal(client);
            return;
        }

        // Bottone Elimina cliente
        const deleteClientBtn = e.target.closest('.btn-client-delete');
        if (deleteClientBtn) {
            const id = Number(deleteClientBtn.dataset.id);
            const client = appState.clients.find(c => c.id === id);
            const name = client ? `${client.nome} ${client.cognome}` : 'questo cliente';

            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Elimina Cliente</h2>
                    <p>Eliminare <strong>${name}</strong> e tutto il suo storico cessioni?</p>
                    <div class="modal-actions">
                        <button class="btn-standard btn-cancel" id="btnCancelDelClient">Annulla</button>
                        <button class="btn-standard btn-danger" id="btnConfirmDelClient">Sì, Elimina</button>
                    </div>
                </div>`;
            document.body.appendChild(confirmModal);
            document.getElementById('btnCancelDelClient').addEventListener('click', () => document.body.removeChild(confirmModal));
            document.getElementById('btnConfirmDelClient').addEventListener('click', async () => {
                document.body.removeChild(confirmModal);
                await deleteClient(id);
                updateClientiUI();
                showNotification('Cliente Eliminato', `${name} rimosso dal database.`, 'success');
            });
            return;
        }

        // Bottone Nuova Cessione dalla card cliente
        const cessioneBtn = e.target.closest('.btn-client-cessione');
        if (cessioneBtn) {
            openCessioneModal(Number(cessioneBtn.dataset.id));
            return;
        }

        // Bottone Elimina cessione
        const deleteCessioneBtn = e.target.closest('.btn-delete-cessione');
        if (deleteCessioneBtn) {
            const id = Number(deleteCessioneBtn.dataset.id);
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Elimina Cessione</h2>
                    <p>Rimuovere questa cessione dallo storico?</p>
                    <div class="modal-actions">
                        <button class="btn-standard btn-cancel" id="btnCancelDelCessione">Annulla</button>
                        <button class="btn-standard btn-danger" id="btnConfirmDelCessione">Sì, Elimina</button>
                    </div>
                </div>`;
            document.body.appendChild(confirmModal);
            document.getElementById('btnCancelDelCessione').addEventListener('click', () => document.body.removeChild(confirmModal));
            document.getElementById('btnConfirmDelCessione').addEventListener('click', async () => {
                document.body.removeChild(confirmModal);
                await deleteCessione(id);
                updateClientiUI();
                showNotification('Cessione Eliminata', 'Registro rimosso dallo storico.', 'success');
            });
            return;
        }
    });

    // ── Nuova Cessione (bottone nella tabella) ────────────────
    const btnNuovaCessione = document.getElementById('btnNuovaCessione');
    if (btnNuovaCessione) {
        btnNuovaCessione.addEventListener('click', () => openCessioneModal(null));
    }
    const btnCancelCessione = document.getElementById('btnCancelCessione');
    if (btnCancelCessione) {
        btnCancelCessione.addEventListener('click', () => document.getElementById('cessioneModal').classList.remove('active'));
    }

    const cessioneForm = document.getElementById('cessioneForm');
    if (cessioneForm) {
        cessioneForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const clienteId = Number(document.getElementById('cessioneCliente').value);
            if (!clienteId) {
                showNotification('Errore', 'Seleziona un cliente prima di registrare la cessione.', 'alert');
                return;
            }
            const cessione = {
                cliente_id:     clienteId,
                data:           document.getElementById('cessioneData').value,
                tipo_blatta:    document.getElementById('cessioneTipo').value,
                quantita_g:     parseFloat(document.getElementById('cessioneQuantita').value) || 0,
                prezzo_unit:    parseFloat(document.getElementById('cessionePrezzoUnit').value) || 0,
                totale_euro:    parseFloat(document.getElementById('cessioneTotale').value) || 0,
                note:           document.getElementById('cessioneNote').value.trim()
            };
            await saveCessione(cessione);
            document.getElementById('cessioneModal').classList.remove('active');
            updateClientiUI();
            const cliente = appState.clients.find(c => c.id === clienteId);
            const nomeCl = cliente ? `${cliente.nome} ${cliente.cognome}` : 'cliente';
            showNotification('Cessione Registrata', `${cessione.quantita_g} g ceduti a ${nomeCl} — € ${cessione.totale_euro.toFixed(2)}`, 'success');
        });
    }

    // ── Filtro storico cessioni per cliente ───────────────────
    const cessioniFilterCliente = document.getElementById('cessioniFilterCliente');
    if (cessioniFilterCliente) {
        cessioniFilterCliente.addEventListener('change', (e) => {
            updateClientiUI(e.target.value || null);
        });
    }

    // ── Search bar clienti (debounced) ─────────────────────────
    const clientiSearch = document.getElementById('clientiSearch');
    if (clientiSearch) {
        let searchTimeout;
        clientiSearch.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => updateClientiUI(), 250);
        });
    }

    // ── Bottone Prezzi ─────────────────────────────────────────
    const btnOpenPrezzi = document.getElementById('btnOpenPrezzi');
    if (btnOpenPrezzi) {
        btnOpenPrezzi.addEventListener('click', openPrezziModal);
    }
    const btnCancelPrezzi = document.getElementById('btnCancelPrezzi');
    if (btnCancelPrezzi) {
        btnCancelPrezzi.addEventListener('click', () => document.getElementById('prezziModal').classList.remove('active'));
    }

    const prezziForm = document.getElementById('prezziForm');
    if (prezziForm) {
        // Aggiorna preview live ad ogni modifica di un prezzo
        prezziForm.querySelectorAll('input[type="number"]').forEach(input => {
            input.addEventListener('input', updatePrezziPreview);
        });

        prezziForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const newPrices = {};
            ['FEMALE','MALE','SUBADULT','MEDIUM','SMALL','BABY'].forEach(key => {
                const input = document.getElementById(`price_${key}`);
                newPrices[key] = parseFloat(input?.value) || 0;
            });
            savePrices(newPrices);
            document.getElementById('prezziModal').classList.remove('active');
            updateUI(); // Aggiorna il valore economico in Home
            showNotification('Prezzi Salvati', 'Il Valore Economico in Home è stato aggiornato.', 'success');
        });
    }

    // ── CONTROLLI GRAFICO PREZZI ─────────────────────────────────
    const btnPrezziPerKg = document.getElementById('btnPrezziPerKg');
    const btnPrezziPer100pz = document.getElementById('btnPrezziPer100pz');
    const btnPrezziLog = document.getElementById('btnPrezziLog');

    const updateChartToggleButtons = (activeBtn) => {
        [btnPrezziPerKg, btnPrezziPer100pz, btnPrezziLog].forEach(b => {
            if (b) b.classList.remove('active');
        });
        if (activeBtn) activeBtn.classList.add('active');
    };

    if (btnPrezziPerKg) {
        btnPrezziPerKg.addEventListener('click', () => {
            updateChartToggleButtons(btnPrezziPerKg);
            renderPrezziChart('kg');
        });
    }
    if (btnPrezziPer100pz) {
        btnPrezziPer100pz.addEventListener('click', () => {
            updateChartToggleButtons(btnPrezziPer100pz);
            renderPrezziChart('100pz');
        });
    }
    if (btnPrezziLog) {
        btnPrezziLog.addEventListener('click', () => {
            updateChartToggleButtons(btnPrezziLog);
            renderPrezziChart('log');
        });
    }

    // ── PREVENTIVI & QUOTE BUILDER LISTENERS ──────────────────────
    const btnNuovoPreventivo = document.getElementById('btnNuovoPreventivo');
    if (btnNuovoPreventivo) {
        btnNuovoPreventivo.addEventListener('click', () => openQuoteModal(null));
    }

    const btnCloseQuoteModal = document.getElementById('btnCloseQuoteModal');
    const btnCancelQuote = document.getElementById('btnCancelQuote');
    const closeQuote = () => {
        const modal = document.getElementById('quoteModal');
        if (modal) modal.classList.remove('active');
    };
    if (btnCloseQuoteModal) btnCloseQuoteModal.addEventListener('click', closeQuote);
    if (btnCancelQuote) btnCancelQuote.addEventListener('click', closeQuote);

    const btnAddQuoteItem = document.getElementById('btnAddQuoteItem');
    if (btnAddQuoteItem) {
        btnAddQuoteItem.addEventListener('click', () => renderQuoteItemRow(null));
    }

    // Toggle radio cliente registrato / manuale nel preventivo
    document.querySelectorAll('input[name="quoteClientType"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const isExisting = e.target.value === 'existing';
            const existBlock = document.getElementById('quoteClientExistingBlock');
            const manBlock = document.getElementById('quoteClientManualBlock');
            if (existBlock) existBlock.style.display = isExisting ? 'block' : 'none';
            if (manBlock) manBlock.style.display = isExisting ? 'none' : 'grid';
        });
    });

    // Selettore Canale (Michael vs Diretto)
    const quoteChannelSelect = document.getElementById('quoteChannel');
    if (quoteChannelSelect) {
        quoteChannelSelect.addEventListener('change', (e) => {
            const isMichael = e.target.value === 'MICHAEL';
            const shippingGroup = document.getElementById('quoteShippingGroup');
            if (shippingGroup) shippingGroup.style.display = isMichael ? 'none' : 'block';
            
            const shippingInput = document.getElementById('quoteShipping');
            if (isMichael && shippingInput) shippingInput.value = '0.00';

            const notesArea = document.getElementById('quoteNotes');
            if (notesArea) {
                if (isMichael) {
                    notesArea.value = 'Accordi di fornitura riservata intermediario Michael. Consegna diretta senza spese di spedizione.';
                } else {
                    notesArea.value = 'Spedizione in box termico isotermico protetto con heat pack 72h stagionale. Consegna tracciata express 24/48h.';
                }
            }

            recalculateQuoteTotals();
        });
    }

    const quoteShipping = document.getElementById('quoteShipping');
    const quoteDiscount = document.getElementById('quoteDiscount');
    if (quoteShipping) quoteShipping.addEventListener('input', recalculateQuoteTotals);
    if (quoteDiscount) quoteDiscount.addEventListener('input', recalculateQuoteTotals);

    // Esporta PDF direttamente dal modal preventivo
    const btnExportQuotePDFModal = document.getElementById('btnExportQuotePDF');
    if (btnExportQuotePDFModal) {
        btnExportQuotePDFModal.addEventListener('click', () => {
            const totals = recalculateQuoteTotals();
            const channel = document.getElementById('quoteChannel')?.value || 'MICHAEL';
            const isMichael = channel === 'MICHAEL';
            const items = [];
            document.querySelectorAll('#quoteItemsContainer .quote-item-row').forEach(row => {
                const cat = row.querySelector('.quote-item-cat')?.value || 'ADULT';
                const unit = row.querySelector('.quote-item-unit')?.value || 'kg';
                const qty = parseFloat(row.querySelector('.quote-item-qty')?.value) || 0;
                const price = parseFloat(row.querySelector('.quote-item-price')?.value) || 0;
                items.push({
                    category: cat,
                    categoryLabel: COMMERCIAL_CATALOG[cat]?.label || cat,
                    size: COMMERCIAL_CATALOG[cat]?.size || '—',
                    unit: unit,
                    quantity: qty,
                    unitPrice: price,
                    total: qty * price
                });
            });

            let clientData = {};
            const isExisting = document.getElementById('radioClientExisting')?.checked;
            if (isExisting) {
                const cId = Number(document.getElementById('quoteClientSelect')?.value);
                const found = appState.clients.find(c => c.id === cId);
                if (found) {
                    clientData = { nome: found.nome, cognome: found.cognome, citta: found.citta, telefono: found.telefono, email: found.email };
                }
            } else {
                clientData = {
                    nome: document.getElementById('quoteClientNome')?.value.trim() || (isMichael ? 'Michael' : 'Cliente'),
                    citta: document.getElementById('quoteClientCitta')?.value.trim(),
                    telefono: document.getElementById('quoteClientTelefono')?.value.trim(),
                    email: document.getElementById('quoteClientEmail')?.value.trim()
                };
            }

            const tempQuote = {
                id: document.getElementById('quoteId')?.value ? Number(document.getElementById('quoteId').value) : Date.now(),
                channel: channel,
                number: document.getElementById('quoteNumber')?.value.trim() || 'PREV-001',
                date: document.getElementById('quoteDate')?.value || new Date().toISOString().split('T')[0],
                validityDays: parseInt(document.getElementById('quoteValidity')?.value) || 15,
                status: document.getElementById('quoteStatus')?.value || 'SENT',
                client: clientData,
                clientId: isExisting ? Number(document.getElementById('quoteClientSelect')?.value) : null,
                items: items,
                subtotal: totals.subtotal,
                shipping: isMichael ? 0 : totals.shipping,
                discount: totals.discount,
                grandTotal: totals.grandTotal,
                paymentTerms: document.getElementById('quotePaymentTerms')?.value.trim() || (isMichael ? 'Saldo a consegna / Bonifico' : 'Bonifico / PayPal / Ritiro'),
                notes: document.getElementById('quoteNotes')?.value.trim() || ''
            };

            exportQuotePDF(tempQuote);
        });
    }

    // Submit form preventivo
    const quoteForm = document.getElementById('quoteForm');
    if (quoteForm) {
        quoteForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const totals = recalculateQuoteTotals();
            const channel = document.getElementById('quoteChannel')?.value || 'MICHAEL';
            const isMichael = channel === 'MICHAEL';
            const items = [];
            document.querySelectorAll('#quoteItemsContainer .quote-item-row').forEach(row => {
                const cat = row.querySelector('.quote-item-cat')?.value || 'ADULT';
                const unit = row.querySelector('.quote-item-unit')?.value || 'kg';
                const qty = parseFloat(row.querySelector('.quote-item-qty')?.value) || 0;
                const price = parseFloat(row.querySelector('.quote-item-price')?.value) || 0;
                items.push({
                    category: cat,
                    categoryLabel: COMMERCIAL_CATALOG[cat]?.label || cat,
                    size: COMMERCIAL_CATALOG[cat]?.size || '—',
                    unit: unit,
                    quantity: qty,
                    unitPrice: price,
                    total: qty * price
                });
            });

            if (items.length === 0) {
                showNotification('Attenzione', 'Aggiungi almeno una voce al preventivo.', 'warning');
                return;
            }

            let clientData = {};
            const isExisting = document.getElementById('radioClientExisting')?.checked;
            let clientId = null;
            if (isExisting) {
                clientId = Number(document.getElementById('quoteClientSelect')?.value) || null;
                const found = appState.clients.find(c => c.id === clientId);
                if (found) {
                    clientData = { nome: found.nome, cognome: found.cognome, citta: found.citta, telefono: found.telefono, email: found.email };
                }
            } else {
                clientData = {
                    nome: document.getElementById('quoteClientNome')?.value.trim() || (isMichael ? 'Michael' : 'Cliente Estemporaneo'),
                    citta: document.getElementById('quoteClientCitta')?.value.trim(),
                    telefono: document.getElementById('quoteClientTelefono')?.value.trim(),
                    email: document.getElementById('quoteClientEmail')?.value.trim()
                };
            }

            const idVal = document.getElementById('quoteId')?.value;
            const quoteObj = {
                channel: channel,
                number: document.getElementById('quoteNumber')?.value.trim() || `PREV-${Date.now()}`,
                date: document.getElementById('quoteDate')?.value || new Date().toISOString().split('T')[0],
                validityDays: parseInt(document.getElementById('quoteValidity')?.value) || 15,
                status: document.getElementById('quoteStatus')?.value || 'SENT',
                client: clientData,
                clientId: clientId,
                items: items,
                subtotal: totals.subtotal,
                shipping: isMichael ? 0 : totals.shipping,
                discount: totals.discount,
                grandTotal: totals.grandTotal,
                biomassG: totals.totalBiomassG,
                insectCount: totals.totalInsectCount,
                paymentTerms: document.getElementById('quotePaymentTerms')?.value.trim() || (isMichael ? 'Saldo a consegna / Bonifico' : 'Bonifico / PayPal / Ritiro'),
                notes: document.getElementById('quoteNotes')?.value.trim() || ''
            };
            if (idVal) quoteObj.id = Number(idVal);

            await saveQuote(quoteObj);
            document.getElementById('quoteModal').classList.remove('active');
            updatePreventiviUI();
            showNotification('Preventivo Salvato', `Preventivo ${quoteObj.number} (${isMichael ? 'Michael' : 'Diretto'}) salvato nello storico.`, 'success');
        });
    }

    // ── Delegazione click per tabella preventivi ──────────────────
    document.addEventListener('click', async (e) => {
        // Scarica PDF
        const pdfBtn = e.target.closest('.btn-quote-pdf');
        if (pdfBtn) {
            const id = Number(pdfBtn.dataset.id);
            const q = appState.quotes.find(item => item.id === id);
            if (q) exportQuotePDF(q);
            return;
        }

        // Modifica preventivo
        const editQuoteBtn = e.target.closest('.btn-quote-edit');
        if (editQuoteBtn) {
            const id = Number(editQuoteBtn.dataset.id);
            const q = appState.quotes.find(item => item.id === id);
            if (q) openQuoteModal(q);
            return;
        }

        // Converti in Cessione
        const convertBtn = e.target.closest('.btn-quote-convert');
        if (convertBtn) {
            const id = Number(convertBtn.dataset.id);
            convertQuoteToCessione(id);
            return;
        }

        // Elimina preventivo
        const deleteQuoteBtn = e.target.closest('.btn-quote-delete');
        if (deleteQuoteBtn) {
            const id = Number(deleteQuoteBtn.dataset.id);
            const q = appState.quotes.find(item => item.id === id);
            const name = q ? (q.number || 'questo preventivo') : 'questo preventivo';
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Elimina Preventivo</h2>
                    <p>Rimuovere <strong>${name}</strong> dallo storico preventivi?</p>
                    <div class="modal-actions">
                        <button class="btn-standard btn-cancel" id="btnCancelDelQuote">Annulla</button>
                        <button class="btn-standard btn-danger" id="btnConfirmDelQuote">Sì, Elimina</button>
                    </div>
                </div>`;
            document.body.appendChild(confirmModal);
            document.getElementById('btnCancelDelQuote').addEventListener('click', () => document.body.removeChild(confirmModal));
            document.getElementById('btnConfirmDelQuote').addEventListener('click', async () => {
                document.body.removeChild(confirmModal);
                await deleteQuote(id);
                updatePreventiviUI();
                showNotification('Preventivo Eliminato', `${name} rimosso con successo.`, 'success');
            });
            return;
        }
    });

    const btnResetParams = document.getElementById('btnResetParams');
    if (btnResetParams) {
        btnResetParams.addEventListener('click', () => {
            resetDubiaParams();
        });
    }

    const btnResetDB = document.getElementById('btnResetDB');
    if (btnResetDB) {
        btnResetDB.addEventListener('click', () => {
            // Using custom modal for confirmation
            const confirmModal = document.createElement('div');
            confirmModal.className = 'modal-overlay active';
            confirmModal.innerHTML = `
                <div class="modal">
                    <h2 style="color: var(--alert-red);">Conferma Reset</h2>
                    <p>Attenzione: questo eliminerà tutti i dati inseriti manualmente e ricaricherà solo lo storico iniziale. Procedere?</p>
                    <div class="modal-actions">
                        <button type="button" class="btn-standard btn-cancel" id="btnCancelReset">Annulla</button>
                        <button type="button" class="btn-standard btn-danger" id="btnConfirmReset">Procedi</button>
                    </div>
                </div>
            `;
            document.body.appendChild(confirmModal);

            document.getElementById('btnCancelReset').addEventListener('click', () => {
                document.body.removeChild(confirmModal);
            });

            document.getElementById('btnConfirmReset').addEventListener('click', () => {
                document.body.removeChild(confirmModal);
                // Double confirmation modal
                const doubleConfirmModal = document.createElement('div');
                doubleConfirmModal.className = 'modal-overlay active';
                doubleConfirmModal.innerHTML = `
                    <div class="modal">
                        <h2 style="color: var(--alert-red);">Ultimo Avviso</h2>
                        <p>Sei ASSOLUTAMENTE sicuro? L'operazione è irreversibile e i dati andranno persi per sempre.</p>
                        <div class="modal-actions">
                            <button type="button" class="btn-standard btn-cancel" id="btnCancelDoubleReset">Non Resettare</button>
                            <button type="button" class="btn-standard btn-danger" id="btnDoubleConfirmReset">Si, Elimina Tutto</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(doubleConfirmModal);

                document.getElementById('btnCancelDoubleReset').addEventListener('click', () => {
                    document.body.removeChild(doubleConfirmModal);
                });

                document.getElementById('btnDoubleConfirmReset').addEventListener('click', () => {
                    document.body.removeChild(doubleConfirmModal);
                    const req = indexedDB.deleteDatabase(dbName);
                    req.onsuccess = () => {
                        showNotification("Reset completato", "Database resettato. Ricaricamento in corso...", "success");
                        setTimeout(() => window.location.reload(), 1500);
                    };
                    req.onerror = () => {
                        showNotification("Errore", "Errore nel reset del database.", "alert");
                    };
                });
            });
        });
    }
});

const showNotification = (title, message, type = "success") => {
    const area = document.getElementById('notificationArea');
    if (!area) return;
    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    notif.innerHTML = `
        <div class="notification-content">
            <strong>${title}</strong>
            <p>${message}</p>
        </div>
        <button class="notification-close">&times;</button>
    `;
    
    area.appendChild(notif);
    
notif.querySelector('.notification-close').addEventListener('click', () => notif.remove());
    
    setTimeout(() => {
        if(notif.parentElement) notif.remove();
    }, 5000);
};

// ══════════════════════════════════════════════════════
// FASE 3A — TRASFERIMENTI TRA COLONIE
// ══════════════════════════════════════════════════════

// Stato interno: tiene la colonia di partenza per il modal
let _transferSourceColonyId = null;

/**
 * Apre il modal di trasferimento pre-compilando la colonia sorgente.
 * @param {number|null} fromColonyId - ID della colonia sorgente (opzionale)
 */
const openTransferModal = (fromColonyId = null) => {
    _transferSourceColonyId = fromColonyId;
    const modal = document.getElementById('transferModal');
    if (!modal) return;

    const fromSelect = document.getElementById('transferFrom');
    const toSelect   = document.getElementById('transferTo');
    if (!fromSelect || !toSelect) return;

    const options = appState.colonies
        .filter(c => !c.is_deleted)
        .map(c => `<option value="${c.id}">${c.name} (${(parseFloat(c.current_weight)||0).toFixed(1)}g)</option>`)
        .join('');

    fromSelect.innerHTML = options;
    toSelect.innerHTML   = options;

    // Pre-seleziona la colonia sorgente se passata
    if (fromColonyId) {
        fromSelect.value = String(fromColonyId);
        // Seleziona la prima colonia diversa per la destinazione
        const otherColony = appState.colonies.find(c => !c.is_deleted && c.id !== fromColonyId);
        if (otherColony) toSelect.value = String(otherColony.id);
    }

    updateTransferPreview();
    modal.classList.add('active');
};

/**
 * Aggiorna l'anteprima live del trasferimento nel modal.
 */
const updateTransferPreview = () => {
    const amount   = parseFloat(document.getElementById('transferAmount')?.value) || 0;
    const fromId   = Number(document.getElementById('transferFrom')?.value);
    const toId     = Number(document.getElementById('transferTo')?.value);
    const fromCol  = appState.colonies.find(c => c.id === fromId);
    const toCol    = appState.colonies.find(c => c.id === toId);

    if (!fromCol || !toCol) return;

    const fromAfter = Math.max(0, (parseFloat(fromCol.current_weight)||0) - amount);
    const toAfter   = (parseFloat(toCol.current_weight)||0) + amount;

    document.getElementById('transferFromName').textContent = fromCol.name;
    document.getElementById('transferToName').textContent   = toCol.name;
    document.getElementById('transferFromAfter').textContent = `${fromAfter.toFixed(1)} g`;
    document.getElementById('transferToAfter').textContent   = `${toAfter.toFixed(1)} g`;
    document.getElementById('transferFromAfter').style.color  = fromAfter < 10 ? 'var(--alert-red)' : 'var(--accent-green)';
};

/**
 * Esegue il trasferimento: aggiorna i pesi e crea 2 eventi Timeline di tipo 'transfer'.
 */
const handleTransfer = async () => {
    const amount    = parseFloat(document.getElementById('transferAmount')?.value) || 0;
    const category  = document.getElementById('transferCategory')?.value || 'ALL';
    const fromId    = Number(document.getElementById('transferFrom')?.value);
    const toId      = Number(document.getElementById('transferTo')?.value);

    if (amount <= 0) { showNotification('Errore', 'Inserisci una quantità valida.', 'alert'); return; }
    if (fromId === toId) { showNotification('Errore', 'Le colonie sorgente e destinazione devono essere diverse.', 'alert'); return; }

    const fromCol = appState.colonies.find(c => c.id === fromId);
    const toCol   = appState.colonies.find(c => c.id === toId);
    if (!fromCol || !toCol) { showNotification('Errore', 'Colonia non trovata.', 'alert'); return; }

    if ((parseFloat(fromCol.current_weight)||0) < amount) {
        showNotification('Errore', `La colonia "${fromCol.name}" non ha abbastanza biomassa (${fromCol.current_weight}g disponibili).`, 'alert');
        return;
    }

    const today = new Date().toISOString().split('T')[0];
    const catLabel = category === 'ALL' ? 'mix' : category;

    // 1. Aggiorna i pesi
    fromCol.current_weight = Math.max(0, (parseFloat(fromCol.current_weight)||0) - amount);
    toCol.current_weight   = (parseFloat(toCol.current_weight)||0) + amount;

    await saveColony(fromCol);
    await saveColony(toCol);

    // 2. Crea evento Timeline per la sorgente (trasferimento OUT)
    const eventFrom = {
        event_id: generateUUID(),
        event_type: 'transfer',
        date: today,
        total_weight: 0,
        colony_id: fromCol.id,
        colony_weight_after: fromCol.current_weight,
        notes: `[TRANSFER OUT] ${amount}g [${catLabel}] → ${toCol.name}`,
        adult_ratio: 0,
        food_amount: 0,
        harvest_amount: amount,
        health_index: 100,
        predicted_weight: 0
    };

    // 3. Crea evento Timeline per la destinazione (trasferimento IN)
    const eventTo = {
        event_id: generateUUID(),
        event_type: 'transfer',
        date: today,
        total_weight: 0,
        colony_id: toCol.id,
        colony_weight_after: toCol.current_weight,
        notes: `[TRANSFER IN] +${amount}g [${catLabel}] ← ${fromCol.name}`,
        adult_ratio: 0,
        food_amount: 0,
        harvest_amount: 0,
        health_index: 100,
        predicted_weight: 0
    };

    await saveMeasurement(eventFrom);
    await saveMeasurement(eventTo);

    // 4. Chiudi modal e aggiorna UI
    document.getElementById('transferModal').classList.remove('active');
    updateColoniesUI();
    updateUI();
    showNotification('Trasferimento Completato', `${amount}g spostati da "${fromCol.name}" a "${toCol.name}". Timeline aggiornata.`, 'success');
};

// Attacca i listener al modal Trasferimento
document.addEventListener('DOMContentLoaded', () => {
    const btnCancel  = document.getElementById('btnTransferCancel');
    const btnConfirm = document.getElementById('btnTransferConfirm');
    const fromSel    = document.getElementById('transferFrom');
    const toSel      = document.getElementById('transferTo');
    const amountInp  = document.getElementById('transferAmount');

    if (btnCancel)  btnCancel.addEventListener('click', () => document.getElementById('transferModal').classList.remove('active'));
    if (btnConfirm) btnConfirm.addEventListener('click', handleTransfer);
    if (fromSel)    fromSel.addEventListener('change', updateTransferPreview);
    if (toSel)      toSel.addEventListener('change', updateTransferPreview);
    if (amountInp)  amountInp.addEventListener('input', updateTransferPreview);

    // Bottone Trasferisci nel dettaglio colonia
    const btnDetailTransfer = document.getElementById('btnDetailTransfer');
    if (btnDetailTransfer) {
        btnDetailTransfer.addEventListener('click', () => {
            const detailCard = document.getElementById('colonyDetailCard');
            const nameEl = document.getElementById('detailColonyName');
            if (detailCard && detailCard.style.display !== 'none' && nameEl) {
                const activeColony = appState.colonies.find(c => c.name === nameEl.textContent);
                openTransferModal(activeColony ? activeColony.id : null);
            } else {
                openTransferModal();
            }
        });
    }
});

// ══════════════════════════════════════════════════════
// FASE 3B — CONSOLE DI RICONCILIAZIONE
// ══════════════════════════════════════════════════════

// Closure per tenere il contesto dell'operazione di riconciliazione
let _pendingReconciliation = null;

/**
 * Controlla se la nuova pesata diverge > 5% dalla previsione.
 * Se sì, apre il modal di riconciliazione invece di salvare subito.
 * @returns {boolean} true se il modal è stato aperto (l'operazione è sospesa)
 */
const checkReconciliationTrigger = (realWeight, predictedWeight, pendingFn) => {
    if (!predictedWeight || predictedWeight <= 0) return false;
    const delta = realWeight - predictedWeight;
    const deltaPct = Math.abs(delta / predictedWeight) * 100;

    if (deltaPct < 5) return false; // Scarto accettabile, procedi normalmente

    // Apri il modal di riconciliazione
    _pendingReconciliation = pendingFn;

    const modal = document.getElementById('reconciliationModal');
    if (!modal) return false;

    document.getElementById('reconEstimated').textContent = `${predictedWeight.toFixed(1)} g`;
    document.getElementById('reconReal').textContent      = `${realWeight.toFixed(1)} g`;
    document.getElementById('reconDeltaVal').textContent  = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} g`;
    document.getElementById('reconDeltaPct').textContent  = `${deltaPct.toFixed(1)}%`;
    document.getElementById('reconDeltaVal').style.color  = delta < 0 ? 'var(--alert-red)' : 'var(--accent-green)';

    modal.classList.add('active');
    return true; // Operazione sospesa in attesa della scelta utente
};

/**
 * Applica la correzione scelta dall'utente nella console di riconciliazione.
 * @param {string} reason - 'mortality' | 'unrecorded_harvest' | 'cold_food' | 'error'
 */
const applyReconciliationChoice = async (reason, realWeight, predictedWeight) => {
    const delta = realWeight - predictedWeight;

    if (reason === 'error') {
        // ANNULLA: non salvare il dato sbagliato
        document.getElementById('reconciliationModal').classList.remove('active');
        _pendingReconciliation = null;
        showNotification('Operazione Annullata', 'La pesata errata non è stata salvata. Ripesa la scatola e reinserisci il dato.', 'warning');
        return;
    }

    if (reason === 'mortality') {
        // Aumenta il tasso di mortalità fisiologica
        const mortalityInput = document.getElementById('inputMortality');
        const currentMort = parseFloat(mortalityInput?.value) || 1.5;
        const newMort = Math.min(10, currentMort + 0.5);
        if (mortalityInput) mortalityInput.value = newMort.toFixed(1);
        appState.params.mortalityRate = newMort;
        saveParams(appState.params);
        showNotification('Modello Aggiornato', `Tasso mortalità aumentato a ${newMort.toFixed(1)}%. Pesata salvata.`, 'success');
    } else if (reason === 'unrecorded_harvest') {
        // Crea un evento prelievo storico per la differenza
        const harvestAmount = Math.abs(delta);
        const today = new Date().toISOString().split('T')[0];
        const eventHarvest = {
            event_id: generateUUID(),
            event_type: 'prelievo',
            date: today,
            total_weight: realWeight,
            colony_id: null,
            notes: '[AUTO] Prelievo non registrato — rilevato da Riconciliazione',
            adult_ratio: 0.35,
            food_amount: 0,
            harvest_amount: harvestAmount,
            health_index: appState.params ? computeHealthIndex(appState.params.theta1) : 100,
            predicted_weight: predictedWeight
        };
        await saveMeasurement(eventHarvest);
        showNotification('Prelievo Registrato', `Aggiunto prelievo implicito di ${harvestAmount.toFixed(1)}g. Pesata salvata.`, 'success');
    } else if (reason === 'cold_food') {
        // Abbassa theta1 e theta2 del 5% — backpropagazione manuale
        appState.params.theta1 = Math.max(0.001, appState.params.theta1 * 0.95);
        appState.params.theta2 = Math.max(0.001, appState.params.theta2 * 0.95);
        saveParams(appState.params);
        showNotification('Modello Ricalibrato', `θ₁ e θ₂ ridotti del 5% per riflettere lo stress ambientale. Pesata salvata.`, 'success');
    }

    // Chiudi modal ed esegui la pesata pendente
    document.getElementById('reconciliationModal').classList.remove('active');
    if (_pendingReconciliation) {
        await _pendingReconciliation();
        _pendingReconciliation = null;
    }
    updateUI();
};

// Attacca i listener ai bottoni di riconciliazione
document.addEventListener('DOMContentLoaded', () => {
    const grid = document.querySelector('.recon-reason-grid');
    if (grid) {
        grid.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-reason]');
            if (!btn) return;
            const reason = btn.getAttribute('data-reason');
            const estimatedEl = document.getElementById('reconEstimated');
            const realEl = document.getElementById('reconReal');
            const est = parseFloat(estimatedEl?.textContent) || 0;
            const real = parseFloat(realEl?.textContent) || 0;
            await applyReconciliationChoice(reason, real, est);
        });
    }
});

// ══════════════════════════════════════════════════════
// FASE 4A — AUTO-TUNING COSTANTI BIOLOGICHE
// ══════════════════════════════════════════════════════

/**
 * Controlla se una calibrazione suggerisce di aggiornare la costante biologica.
 * Aggiorna solo dopo 3 calibrazioni consecutive con la stessa deviazione (> 10%).
 * @param {string} category - 'FEMALE' | 'MALE' | 'SUBADULT' | 'MEDIUM' | 'SMALL' | 'BABY'
 * @param {number} realCount - Numero di individui contati fisicamente
 * @param {number} realWeight - Peso totale di quella categoria misurato
 */
const checkAutoTuningOpportunity = (category, realCount, realWeight) => {
    if (!realCount || realCount <= 0 || !realWeight || realWeight <= 0) return;

    const measuredMass = realWeight / realCount;
    const standardMass = getEffectiveMass(category);
    const deviation = Math.abs(measuredMass - standardMass) / standardMass;

    if (deviation < 0.10) return; // Deviazione < 10%: nessuna azione

    // Aggiungi alla storia
    if (!appState.calibrationHistory[category]) appState.calibrationHistory[category] = [];
    appState.calibrationHistory[category].push({ mass: measuredMass, date: new Date().toISOString().split('T')[0] });

    // Mantieni solo gli ultimi 10 dati
    if (appState.calibrationHistory[category].length > 10) {
        appState.calibrationHistory[category] = appState.calibrationHistory[category].slice(-10);
    }

    // Controlla se le ultime 3 calibrazioni mostrano TUTTE la stessa deviazione > 10%
    const history = appState.calibrationHistory[category].slice(-3);
    if (history.length < 3) return; // Non abbastanza dati

    const consistentDeviation = history.every(h => {
        const dev = Math.abs(h.mass - standardMass) / standardMass;
        return dev > 0.10;
    });
    if (!consistentDeviation) return;

    const avgMass = history.reduce((s, h) => s + h.mass, 0) / history.length;
    const catLabels = { FEMALE: 'Femmine Adulte', MALE: 'Maschi Adulti', SUBADULT: 'Sub-Adulte', MEDIUM: 'Neanidi Medie', SMALL: 'Neanidi Piccole', BABY: 'Micro-Neanidi' };

    // Mostra toast di suggerimento
    suggestMassUpdate(category, avgMass, catLabels[category] || category);
};

/**
 * Mostra un toast non invasivo per suggerire l'aggiornamento della costante biologica.
 */
const suggestMassUpdate = (category, avgMass, catLabel) => {
    const standardMass = MASS[category] || 0;
    const toast = document.createElement('div');
    toast.className = 'notification';
    toast.style.cssText = 'border-left-color: #f39c12; cursor: default;';
    toast.innerHTML = `
        <div class="notification-content">
            <strong>🧬 Auto-Tuning Disponibile</strong>
            <p>${catLabel} nel tuo allevamento pesano mediamente <strong>${avgMass.toFixed(2)}g</strong> invece di ${standardMass}g standard.<br>
            <span style="color:#f39c12;">Aggiornare il modello per questo allevamento?</span></p>
            <div style="display:flex; gap:0.5rem; margin-top:0.5rem;">
                <button onclick="applyMassUpdate('${category}', ${avgMass})" style="padding:0.3rem 0.7rem; border-radius:6px; border:none; background:var(--accent-green); color:white; font-size:0.8rem; cursor:pointer; font-weight:600;">Aggiorna (${avgMass.toFixed(2)}g)</button>
                <button onclick="this.closest('.notification').remove()" style="padding:0.3rem 0.7rem; border-radius:6px; border:1px solid var(--border-color); background:transparent; color:var(--text-muted); font-size:0.8rem; cursor:pointer;">Ignora</button>
            </div>
        </div>
    `;
    const area = document.getElementById('notificationArea');
    if (area) area.appendChild(toast);
    // Non auto-rimuovere: l'utente deve scegliere
};

/**
 * Applica l'aggiornamento della costante biologica (chiamato dal toast).
 */
window.applyMassUpdate = (category, newMass) => {
    if (!appState.customMass) appState.customMass = {};
    appState.customMass[category] = newMass;

    // Resetta la storia per questa categoria
    if (appState.calibrationHistory[category]) {
        appState.calibrationHistory[category] = [];
    }

    // Persisti in localStorage (leggero, non IndexedDB)
    try {
        localStorage.setItem('dubia_customMass', JSON.stringify(appState.customMass));
    } catch(e) {}

    updateUI();
    // Rimuovi tutti i toast auto-tuning aperti
    document.querySelectorAll('.notification').forEach(n => {
        if (n.querySelector('strong')?.textContent.includes('Auto-Tuning')) n.remove();
    });
    showNotification('Modello Aggiornato', `La costante per ${category} aggiornata a ${newMass.toFixed(2)}g. Tutti i calcoli futuri useranno questo valore.`, 'success');
};

// Carica customMass salvato da localStorage all'avvio
try {
    const savedMass = localStorage.getItem('dubia_customMass');
    if (savedMass) appState.customMass = JSON.parse(savedMass);
} catch(e) {}

// ══════════════════════════════════════════════════════
// FASE 4B — SUGGERITORE PRESCRITTIVO AVANZATO
// ══════════════════════════════════════════════════════

/**
 * Genera un array di insights prescrittivi basati sullo stato demografico corrente.
 * @param {object} metrics - Oggetto da calculateColonyMetrics()
 * @returns {Array<{icon:string, text:string, priority:'high'|'medium'|'low'}>}
 */
const generatePrescriptiveInsights = (metrics) => {
    const insights = [];
    const { fCount, mCount, saCount, medCount, smCount, bCount, totalCount, H_live } = metrics;

    if (fCount <= 0) return insights;

    const ratio = mCount / fCount;
    const subadultFraction = saCount / Math.max(totalCount, 1);
    const babyFraction = (bCount * getEffectiveMass('BABY') + smCount * getEffectiveMass('SMALL'))
        / Math.max(metrics.census?.W_neanidi || 1, 1);
    const msy30g = calculatePrediction(computeGlobalWeight().weight, 0, 0.35, 30, appState.params)
        - computeGlobalWeight().weight;

    // Regola 1: Eccesso di maschi
    if (ratio > 0.4) {
        const surplusMales = Math.round(mCount - fCount * 0.3);
        const surplusGrams = (surplusMales * getEffectiveMass('MALE')).toFixed(1);
        insights.push({
            icon: '⚖️',
            text: `Rapporto ♂/♀ = ${ratio.toFixed(2)} — troppo alto. Preleva ~${surplusGrams}g di maschi adulti (~${surplusMales} individui) per portare il ratio verso 1:3 e migliorare l'FCR.`,
            priority: 'high'
        });
    }

    // Regola 2: Strozzatura sub-adulte
    if (saCount < totalCount * 0.05 && totalCount > 50) {
        insights.push({
            icon: '⚠️',
            text: `Collo di bottiglia: le Sub-Adulte sono solo ${saCount} (${(subadultFraction*100).toFixed(0)}%). Tra 30-45 giorni mancheranno adulti per rimpiazzare i prelievi. Blocca i prelievi per questo ciclo.`,
            priority: 'high'
        });
    }

    // Regola 3: Alta produzione baby
    if (babyFraction > 0.5 && bCount > 100) {
        const expectedSurplusWeeks = 6;
        insights.push({
            icon: '📊',
            text: `Alta densità di baby/piccole (${(babyFraction*100).toFixed(0)}% della biomassa neonati). Prevedi un surplus di prelievo tra ${expectedSurplusWeeks} settimane. Pianifica cessioni ora.`,
            priority: 'medium'
        });
    }

    // Regola 4: Indice di salute critico
    if (H_live < 75) {
        insights.push({
            icon: '🧬',
            text: `Indice H = ${H_live.toFixed(1)}% — CRITICO. Rischio inbreeding sistemico o senescenza genetica. Introduci nuovo ceppo genetico immediatamente.`,
            priority: 'high'
        });
    }

    // Regola 5: MSY positivo (buona crescita, suggerisci prelievo)
    if (msy30g > 50 && ratio <= 0.4) {
        insights.push({
            icon: '✂️',
            text: `La colonia è in crescita sostenuta. Puoi prelevare fino a ${msy30g.toFixed(0)}g nei prossimi 30 giorni senza rischi (MSY). Priorizza maschi adulti o sub-adulte.`,
            priority: 'low'
        });
    }

    return insights;
};

const resetDubiaParams = () => {
    appState.params.theta1 = DEFAULT_PARAMS.theta1;
    appState.params.theta2 = DEFAULT_PARAMS.theta2;
    appState.params.mortalityRate = DEFAULT_PARAMS.mortalityRate;
    delete appState.params.manualCalibrations;
    saveParams(appState.params);
    updateUI();
    if (typeof updateColoniesUI === 'function') updateColoniesUI();
    if (typeof showNotification === 'function') {
        showNotification('Parametri D.U.B.I.A. Ripristinati', `θ₁ = ${DEFAULT_PARAMS.theta1.toFixed(2)}, θ₂ = ${DEFAULT_PARAMS.theta2.toFixed(2)} (Standard Certificato).`, 'success');
    }
};

if (typeof window !== 'undefined') {
    window.resetDubiaParams = resetDubiaParams;
    window.PRICE_CATALOG_FULL = PRICE_CATALOG_FULL;
    window.generateWhatsAppPriceListText = generateWhatsAppPriceListText;
    window.copyPriceListToWhatsApp = copyPriceListToWhatsApp;
    window.exportFullCatalogPDF = exportFullCatalogPDF;
    window.renderListinoPrezziUI = renderListinoPrezziUI;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculatePrediction,
        appState,
        DEFAULT_PARAMS,
        resetDubiaParams,
        validateAndMigrateParams,
        rebuildParamsFromMeasurements,
        COMMERCIAL_CATALOG,
        saveQuote,
        deleteQuote,
        convertQuoteToCessione,
        exportQuotePDF,
        recalculateQuoteTotals,
        PRICE_CATALOG_FULL,
        generateWhatsAppPriceListText,
        copyPriceListToWhatsApp,
        exportFullCatalogPDF,
        renderListinoPrezziUI
    };
}

// ══════════════════════════════════════════════════════
// COLONIE & QR CODE LOGIC
// ══════════════════════════════════════════════════════

/**
 * Carica tutte le colonie da IndexedDB.
 */
const loadColonies = () => {
    return new Promise((resolve) => {
        const tx = db.transaction("colonies", "readonly");
        const store = tx.objectStore("colonies");
        const req = store.getAll();
        req.onsuccess = () => {
            appState.colonies = req.result || [];
            resolve();
        };
        req.onerror = () => {
            resolve();
        };
    });
};

/**
 * Salva una nuova colonia o aggiorna una esistente in IndexedDB.
 */
const saveColony = (colony) => {
    return new Promise((resolve) => {
        const tx = db.transaction("colonies", "readwrite");
        const store = tx.objectStore("colonies");
        const req = store.put(colony);
        req.onsuccess = (e) => {
            if (!colony.id) colony.id = e.target.result;
            const idx = appState.colonies.findIndex(c => c.id === colony.id);
            if (idx >= 0) appState.colonies[idx] = colony;
            else appState.colonies.push(colony);
            
            // Backup on Google Sheets
            saveColonyToCloud(colony);

            resolve(colony);
        };
        req.onerror = () => resolve(null);
    });
};

/**
 * Sync colonia base data to Google Sheets 
 */
const saveColonyToCloud = async (colony) => {
    // Usa cloudPostWithQueue per supportare offline queue e retry
    const payload = {
        event_type:       "colonia_sync",
        id:               colony.id,
        date:             colony.creation_date,
        name:             colony.name,
        type:             colony.type,
        current_weight:   colony.current_weight   || 0,
        males_count:      colony.males_count       || 0,
        females_count:    colony.females_count     || 0,
        subadults_count:  colony.subadults_count   || 0,
        medium_count:     colony.medium_count      || 0,
        small_count:      colony.small_count       || 0,
        baby_count:       colony.baby_count        || 0,
        notes:            colony.notes             || "",
        is_deleted:       colony.is_deleted        || false  // ← Fix: era mancante nel sync cloud
    };
    cloudPostWithQueue(payload).catch(e =>
        console.warn("[D.U.B.I.A.] saveColonyToCloud failed:", e.message)
    );
};

/**
 * Sync colonie dal Cloud (Scarica il foglio Colonie e unisce i dati in IndexedDB)
 */
/**
 * syncColoniesFromCloud — mantenuta per compatibilità.
 * La sincronizzazione avviene ora in loadInitialData via cloudGet parallelo.
 */
const syncColoniesFromCloud = async () => {
    // No-op: gestita da loadInitialData V2
    console.info("[D.U.B.I.A.] syncColoniesFromCloud: handled by loadInitialData V2.");
};

/**
 * Elimina una colonia (locale + cloud)
 */
const deleteColony = (id) => {
    return new Promise((resolve) => {
        const tx = db.transaction("colonies", "readwrite");
        const store = tx.objectStore("colonies");
        store.delete(Number(id));
        appState.colonies = appState.colonies.filter(c => c.id !== Number(id));
        
        // Elimina anche dal cloud
        deleteColonyFromCloud(id);
        
        resolve();
    });
};

/**
 * Invia evento di eliminazione colonia a Google Sheets
 */
const deleteColonyFromCloud = async (id) => {
    try {
        const payload = {
            event_type: 'colonia_delete',
            id: Number(id)
        };
        fetch(GAS_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.warn("Colony cloud delete failed.", e);
    }
};

/**
 * Aggiorna la UI della lista colonie
 */
const updateColoniesUI = () => {
    const listEl = document.getElementById('coloniesList');
    if (!listEl) return;

    if (appState.colonies.length === 0) {
        if (appState.isSyncing) {
            listEl.innerHTML = `
                <div class="clienti-empty">
                    <span class="clienti-empty-icon loading-spin">⏳</span>
                    <p>Sincronizzazione colonie in corso...</p>
                    <p class="subtitle-text">Attendere prego, caricamento dei dati dal cloud.</p>
                </div>`;
        } else {
            listEl.innerHTML = `
                <div class="clienti-empty">
                    <span class="clienti-empty-icon">📦</span>
                    <p>Nessun contenitore registrato.</p>
                    <p class="subtitle-text">Clicca su <strong>+ Nuova Colonia</strong> per iniziare.</p>
                </div>`;
        }
    } else {
        listEl.innerHTML = appState.colonies.map(c => {
            const isBaby = c.type === 'Baby';
            const isPasto = c.type === 'Pasto';
            const color = isBaby ? '#f1c40f' : (isPasto ? '#3498db' : 'var(--accent-purple)');
            
            // Calcolo infografica
            const males = parseInt(c.males_count) || 0;
            const females = parseInt(c.females_count) || 0;
            const nymphs = (parseInt(c.subadults_count) || 0) + (parseInt(c.medium_count) || 0) + (parseInt(c.small_count) || 0) + (parseInt(c.baby_count) || 0);
            const total = males + females + nymphs;
            
            let infographicHTML = '';
            if (total > 0) {
                const pFemales = (females / total) * 100;
                const pMales = (males / total) * 100;
                const pNymphs = (nymphs / total) * 100;
                infographicHTML = `
                <div style="margin-top: 12px; margin-bottom: 4px; padding: 0 4px;">
                    <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: #888; margin-bottom: 6px;">
                        <span style="color: #e84393; font-weight: bold;">♀️ ${pFemales.toFixed(0)}%</span>
                        <span style="color: #0984e3; font-weight: bold;">♂️ ${pMales.toFixed(0)}%</span>
                        <span style="color: #fdcb6e; font-weight: bold;">🐛 ${pNymphs.toFixed(0)}%</span>
                    </div>
                    <div style="width: 100%; height: 6px; border-radius: 3px; display: flex; overflow: hidden; background: #2a2a40; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);">
                        <div style="width: ${pFemales}%; background: #e84393; transition: width 0.5s ease;"></div>
                        <div style="width: ${pMales}%; background: #0984e3; transition: width 0.5s ease;"></div>
                        <div style="width: ${pNymphs}%; background: #fdcb6e; transition: width 0.5s ease;"></div>
                    </div>
                </div>`;
            }
            
            return `
            <div class="colony-card" data-id="${c.id}">
                <div class="colony-card-header">
                    <div>
                        <div class="colony-name">${c.name}</div>
                        <span class="animal-badge" style="background: ${color}22; color: ${color}; border-color: ${color}44;">${c.type}</span>
                    </div>
                    <button class="btn-standard" onclick="showColonyDetails(${c.id})" style="padding: 0.3rem 0.6rem;">Apri</button>
                </div>
                <div class="colony-stats">
                    <span>⚖️ ${c.current_weight ? c.current_weight.toFixed(1) + ' g' : '-- g'}</span>
                    <span>♂️ ${c.males_count || '--'}</span>
                    <span>♀️ ${c.females_count || '--'}</span>
                </div>
                ${infographicHTML}
                ${c.notes ? `<div class="subtitle-text" style="font-size: 0.8rem; margin-top: 0.5rem;">${c.notes}</div>` : ''}
            </div>`;
        }).join('');
    }

    // Populate dropdown in the entry modal
    const colonySelect = document.getElementById('inputColonyId');
    if (colonySelect) {
        const currentVal = colonySelect.value;
        colonySelect.innerHTML = '<option value="">-- Massa Globale (Tutte le colonie) --</option>' +
            appState.colonies.map(c => `<option value="${c.id}" ${c.id == currentVal ? 'selected' : ''}>${c.name} (${c.type})</option>`).join('');
    }
};

/**
 * Mostra i dettagli di una colonia specifica (chiamata dal bottone Apri o dal QR Code)
 */
window.showColonyDetails = (id) => {
    const colony = appState.colonies.find(c => c.id === id);
    if (!colony) {
        showNotification("Errore", "Colonia non trovata", "alert");
        return;
    }

    // Passa al tab colonie se non ci siamo
    document.querySelector('.tab-btn[data-target="colonies"]').click();

    document.getElementById('detailColonyName').innerText = colony.name;
    document.getElementById('detailColonyType').innerText = colony.type;
    document.getElementById('detailColonyWeight').innerText = colony.current_weight ? `${colony.current_weight.toFixed(1)} g` : '-- g';
    document.getElementById('detailColonyMales').innerText = colony.males_count || '--';
    document.getElementById('detailColonyFemales').innerText = colony.females_count || '--';

    // Calcolo Sex Ratio
    let ratioText = "";
    if (colony.males_count > 0 && colony.females_count > 0) {
        const r = (colony.females_count / colony.males_count).toFixed(1);
        // Formatta come (1:2.5) e gestisci il .0 se intero
        ratioText = `(1:${r.replace('.0', '')})`;
    } else if (colony.males_count === 0 && colony.females_count > 0) {
        ratioText = `(Solo ♀)`;
    } else if (colony.males_count > 0 && colony.females_count === 0) {
        ratioText = `(Solo ♂)`;
    }
    document.getElementById('detailColonySexRatio').innerText = ratioText;
    document.getElementById('detailColonySubadults').innerText = colony.subadults_count || '--';
    document.getElementById('detailColonyMedium').innerText = colony.medium_count || '--';
    document.getElementById('detailColonySmall').innerText = colony.small_count || '--';
    document.getElementById('detailColonyBaby').innerText = colony.baby_count || '--';
    document.getElementById('detailColonyNotes').innerText = colony.notes || 'Nessuna nota.';

    const detailCard = document.getElementById('colonyDetailCard');
    detailCard.style.display = 'block';
    
    // Smooth scroll
    detailCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Buttons bindings
    document.getElementById('btnDetailClose').onclick = () => detailCard.style.display = 'none';
    
    document.getElementById('btnDetailAddMeasure').onclick = () => {
        document.getElementById('inputColonyId').value = colony.id;
        document.getElementById('inputColonyId').dispatchEvent(new Event('change'));
        document.getElementById('entryModal').classList.add('active');
    };

    document.getElementById('btnDetailShowQR').onclick = () => {
        generateQRCode(colony);
    };

    document.getElementById('btnDetailDelete').onclick = () => {
        if(confirm(`Vuoi eliminare la colonia ${colony.name}? (I dati storici globali rimarranno intatti)`)) {
            deleteColony(colony.id).then(() => {
                detailCard.style.display = 'none';
                updateColoniesUI();
                showNotification("Eliminata", "Colonia eliminata con successo.", "success");
            });
        }
    };

    // Render initial chart
    const slider = document.getElementById('colonyPredictionSlider');
    const label = document.getElementById('colonyPredictionDaysLabel');
    if (slider && label) {
        slider.value = 0; // Inizia da oggi (0 gg)
        let currentDays = 0;
        label.innerText = currentDays + ' gg';
        renderColonyPredictionChart(colony, currentDays);
        
        // Remove old listeners to prevent memory leaks or duplicate calls when switching colonies
        const newSlider = slider.cloneNode(true);
        slider.parentNode.replaceChild(newSlider, slider);
        newSlider.addEventListener('input', (e) => {
            const val = e.target.value;
            document.getElementById('colonyPredictionDaysLabel').innerText = val + ' gg';
            renderColonyPredictionChart(colony, parseInt(val));
        });
    }
};

let colonyPredictionChartInstance = null;
let colonyPredDoughnutInstance = null;

const renderColonyPredictionChart = (colony, days) => {
    const canvas = document.getElementById('colonyPredictionChart');
    if (!canvas) return;
    
    if (colonyPredictionChartInstance) {
        colonyPredictionChartInstance.destroy();
    }
    
    // Calculation of W_t and A_t purely based on specific colony's known data
    let W_t = colony.current_weight || 10;
    
    // Adult biomass
    let mCount = colony.males_count || 0;
    let fCount = colony.females_count || 0;
    let W_adulti = (mCount * MASS.MALE) + (fCount * MASS.FEMALE);
    
    // Nymph biomass
    let subCount = colony.subadults_count || 0;
    let medCount = colony.medium_count || 0;
    let smCount = colony.small_count || 0;
    let bCount = colony.baby_count || 0;
    let W_ninfe = (subCount * MASS.SUBADULT) + (medCount * MASS.MEDIUM) + (smCount * MASS.SMALL) + (bCount * MASS.BABY);
    
    let W_totale_calcolato = W_adulti + W_ninfe;
    
    const latestForAt = appState.measurements && appState.measurements.length > 0 ? appState.measurements[appState.measurements.length - 1] : null;
    let A_t = latestForAt ? ((latestForAt.adult_ratio !== undefined && latestForAt.adult_ratio !== null) ? Number(latestForAt.adult_ratio) : 0.35) : 0.35;

    if (W_totale_calcolato > 0) {
        A_t = W_adulti / W_totale_calcolato;
        // Aggiorniamo W_t con il calcolato se non era stato forzato un peso maggiore
        if (!colony.current_weight || Math.abs(colony.current_weight - W_totale_calcolato) < W_totale_calcolato * 0.2) {
            W_t = W_totale_calcolato;
        }
    }
    
    const theta2 = appState.params.theta2 || 1.05;

    const labels = [];
    const dataBiomass = [];
    const dataPop = [];

    // Initialize buckets
    let simM = mCount;
    let simF = fCount;
    let simSub = subCount;
    let simMed = medCount;
    let simSmall = smCount;
    let simBaby = bCount;
    
    // If we only have weight and no counts, fallback to census
    if (simM + simF + simSub + simMed + simSmall + simBaby === 0 && W_t > 0) {
        const dubiaModule = D();
        if (dubiaModule) {
            let initialCensus = dubiaModule.census(W_t, A_t);
            simM = initialCensus.N_maschi;
            simF = initialCensus.N_femmine;
            simSub = initialCensus.N_medie * 0.2; // Approssimazione dal modello piramidale
            simMed = initialCensus.N_medie * 0.8;
            simSmall = initialCensus.N_baby * 0.3;
            simBaby = initialCensus.N_baby * 0.7;
        }
    }

    // Parametri biologici
    const baseTheta2 = 1.05;
    const envFactor = Math.max(0.1, theta2 / baseTheta2); // Scaliamo metabolismo in base a theta2

    const RATE_BABY_SMALL = 1 / 30;
    const RATE_SMALL_MED = 1 / 45;
    const RATE_MED_SUB = 1 / 45;
    const RATE_SUB_ADULT = 1 / 30;
    const BIRTH_RATE_PER_FEMALE = 25 / 45; 
    const MORTALITY_ADULT = 1 / 400;

    // Simulate
    const stepSize = Math.max(1, Math.floor(days / 15));
    for (let day = 0; day <= days; day += stepSize) {
        labels.push(day);
        
        let current_W = (simM * MASS.MALE) + (simF * MASS.FEMALE) + (simSub * MASS.SUBADULT) + (simMed * MASS.MEDIUM) + (simSmall * MASS.SMALL) + (simBaby * MASS.BABY);
        let current_N = simM + simF + simSub + simMed + simSmall + simBaby;
        
        dataBiomass.push(current_W);
        dataPop.push(current_N);
        
        // Simula lo step successivo
        let effDays = stepSize * envFactor; // Effetto di theta2 sulla biologia
        
        // Nascite
        let newBabies = simF * BIRTH_RATE_PER_FEMALE * effDays;
        
        // Transizioni (con formula continua per stabilità su step grandi)
        let b_to_s = simBaby * (1 - Math.pow(1 - RATE_BABY_SMALL, effDays));
        let s_to_m = simSmall * (1 - Math.pow(1 - RATE_SMALL_MED, effDays));
        let m_to_sub = simMed * (1 - Math.pow(1 - RATE_MED_SUB, effDays));
        let sub_to_a = simSub * (1 - Math.pow(1 - RATE_SUB_ADULT, effDays));
        
        let m_deaths = simM * (1 - Math.pow(1 - MORTALITY_ADULT, effDays));
        let f_deaths = simF * (1 - Math.pow(1 - MORTALITY_ADULT, effDays));
        
        // Aggiorna buckets
        simBaby = Math.max(0, simBaby + newBabies - b_to_s);
        simSmall = Math.max(0, simSmall + b_to_s - s_to_m);
        simMed = Math.max(0, simMed + s_to_m - m_to_sub);
        simSub = Math.max(0, simSub + m_to_sub - sub_to_a);
        
        simM = Math.max(0, simM + (sub_to_a * 0.5) - m_deaths);
        simF = Math.max(0, simF + (sub_to_a * 0.5) - f_deaths);
    }

    // --- Aggiornamento Doughnut Chart Dinamico ---
    const finalM = Math.round(simM);
    const finalF = Math.round(simF);
    const finalSub = Math.round(simSub);
    const finalMed = Math.round(simMed);
    const finalSmall = Math.round(simSmall);
    const finalBaby = Math.round(simBaby);
    const totalPop = finalM + finalF + finalSub + finalMed + finalSmall + finalBaby;

    const doughnutData = [finalF, finalM, finalSub, finalMed, finalSmall, finalBaby];
    const doughnutCanvas = document.getElementById('colonyPredDoughnutChart');
    
    if (doughnutCanvas) {
        if (!colonyPredDoughnutInstance) {
            // Plugin custom per il testo al centro
            const centerTextPlugin = {
                id: 'centerTextPlugin',
                beforeDraw: function(chart) {
                    if (chart.config.type !== 'doughnut') return;
                    const ctx = chart.ctx;
                    const width = chart.width;
                    const height = chart.height;
                    ctx.restore();
                    
                    const centerX = width / 2;
                    const centerY = height / 2;
                    
                    // Disegna il totale
                    ctx.font = 'bold 32px Inter, sans-serif';
                    ctx.fillStyle = '#2ecc71';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
                    ctx.fillText(total, centerX, centerY - 10);
                    
                    // Disegna la label
                    ctx.font = '12px Inter, sans-serif';
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
                    ctx.fillText("Insetti Previsti", centerX, centerY + 18);
                    
                    ctx.save();
                }
            };

            colonyPredDoughnutInstance = new Chart(doughnutCanvas, {
                type: 'doughnut',
                data: {
                    labels: ['Femmine', 'Maschi', 'Sub-Adulte', 'Medie', 'Piccole', 'Baby'],
                    datasets: [{
                        data: doughnutData,
                        backgroundColor: [
                            '#9b59b6', // Femmine (Viola)
                            '#3498db', // Maschi (Blu)
                            '#e67e22', // Sub-Adulte (Arancio)
                            '#2ecc71', // Medie (Verde)
                            '#1abc9c', // Piccole (Ottanio)
                            '#f1c40f'  // Baby (Giallo)
                        ],
                        borderWidth: 3,
                        borderColor: '#111928', // Stesso colore del background della card
                        hoverOffset: 6,
                        borderRadius: 6 // Angoli arrotondati premium
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '75%', // Molto sottile per un look premium
                    animation: {
                        duration: 400,
                        easing: 'easeOutQuart'
                    },
                    plugins: {
                        legend: {
                            display: false
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const val = context.raw;
                                    const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                    const percentage = total > 0 ? Math.round((val / total) * 100) : 0;
                                    return ` ${context.label}: ${val} (${percentage}%)`;
                                }
                            }
                        }
                    }
                },
                plugins: [centerTextPlugin]
            });
        } else {
            // Aggiorna solo i dati per un'animazione fluida (Time-lapse)
            colonyPredDoughnutInstance.data.datasets[0].data = doughnutData;
            colonyPredDoughnutInstance.update();
        }

        // Aggiorna la Smart Legend Grid (Contatori singoli)
        document.getElementById('smartCountFemale').innerText = finalF;
        document.getElementById('smartCountMale').innerText = finalM;
        document.getElementById('smartCountSubAdult').innerText = finalSub;
        document.getElementById('smartCountMedium').innerText = finalMed;
        document.getElementById('smartCountSmall').innerText = finalSmall;
        document.getElementById('smartCountBaby').innerText = finalBaby;
    }
    // ---------------------------------------

    colonyPredictionChartInstance = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Biomassa (g)',
                    data: dataBiomass,
                    borderColor: '#2ecc71',
                    backgroundColor: 'rgba(46, 204, 113, 0.1)',
                    yAxisID: 'y',
                    tension: 0.3,
                    fill: true
                },
                {
                    label: 'Popolazione (N)',
                    data: dataPop,
                    borderColor: '#8e44ad',
                    backgroundColor: 'transparent',
                    yAxisID: 'y1',
                    borderDash: [5, 5],
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { title: { display: true, text: 'Giorni Futuri' } },
                y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Grammi (g)' } },
                y1: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Individui (N)' }, grid: { drawOnChartArea: false } }
            }
        }
    });
};

/**
 * Genera il QR Code visuale per una colonia
 */
const generateQRCode = (colony) => {
    const container = document.getElementById('qrCanvasContainer');
    if (!container) return;
    container.innerHTML = '';
    const qrData = JSON.stringify({ dubia_colony_id: colony.id });
    
    new QRCode(container, {
        text: qrData,
        width: 250,
        height: 250,
        colorDark : "#182B49",
        colorLight : "#ffffff",
        correctLevel : QRCode.CorrectLevel.H
    });

    document.getElementById('qrColonyName').innerText = colony.name;
    document.getElementById('qrDisplayModal').classList.add('active');
};

/**
 * Gestione scanner QR — usa Html5Qrcode (API low-level)
 * per avviare direttamente la fotocamera posteriore senza
 * mostrare nessun menu di selezione all'utente.
 */
let html5QrInstance = null;
let qrScannerRunning = false;

const startQRScanner = async () => {
    document.getElementById('qrScanError').style.display = 'none';
    document.getElementById('qrScannerModal').classList.add('active');

    // Mostra il loader, nasconde il video finché la cam non è pronta
    document.getElementById('qrCameraLoader').style.display = 'flex';
    document.getElementById('qrVideoWrapper').style.display = 'none';

    // Se c'è già un'istanza attiva, fermala prima di ricominciare
    if (html5QrInstance && qrScannerRunning) {
        try { await html5QrInstance.stop(); } catch(e) {}
        qrScannerRunning = false;
    }

    // Crea una nuova istanza che userà #qr-reader come container video
    html5QrInstance = new Html5Qrcode("qr-reader");

    const config = {
        fps: 12,
        qrbox: { width: 220, height: 220 },
        aspectRatio: 1.0,
        disableFlip: false
    };

    const onSuccess = (decodedText) => {
        try {
            const data = JSON.parse(decodedText);
            if (data && data.dubia_colony_id) {
                stopQRScanner();
                showColonyDetails(data.dubia_colony_id);
            } else {
                document.getElementById('qrScanError').style.display = 'block';
            }
        } catch(e) {
            document.getElementById('qrScanError').style.display = 'block';
        }
    };

    const onFailure = () => { /* scansione continua in silenzio */ };

    try {
        // Prova prima con la fotocamera posteriore (environment)
        await html5QrInstance.start(
            { facingMode: "environment" },
            config,
            onSuccess,
            onFailure
        );
        qrScannerRunning = true;

        // Fotocamera avviata: nascondi loader, mostra video con mirino
        document.getElementById('qrCameraLoader').style.display = 'none';
        document.getElementById('qrVideoWrapper').style.display = 'block';

        // Sposta il <video> generato dalla libreria dentro il wrapper
        const video = document.querySelector('#qr-reader video');
        if (video) {
            video.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:12px;';
        }

    } catch (err) {
        // Fallback: nessuna fotocamera posteriore — usa qualsiasi fotocamera disponibile
        console.warn('[D.U.B.I.A.] Fotocamera posteriore non disponibile, provo con qualsiasi cam:', err);
        try {
            const cameras = await Html5Qrcode.getCameras();
            if (!cameras || cameras.length === 0) {
                throw new Error('Nessuna fotocamera disponibile su questo dispositivo.');
            }
            await html5QrInstance.start(
                cameras[cameras.length - 1].id, // ultima = di solito la posteriore
                config,
                onSuccess,
                onFailure
            );
            qrScannerRunning = true;
            document.getElementById('qrCameraLoader').style.display = 'none';
            document.getElementById('qrVideoWrapper').style.display = 'block';
        } catch (fallbackErr) {
            qrScannerRunning = false;
            document.getElementById('qrCameraLoader').style.display = 'none';
            document.getElementById('qrScanError').style.display = 'block';
            document.getElementById('qrScanError').textContent = '❌ Impossibile accedere alla fotocamera: ' + fallbackErr.message;
            console.error('[D.U.B.I.A.] QR scanner error:', fallbackErr);
        }
    }
};

const stopQRScanner = async () => {
    document.getElementById('qrScannerModal').classList.remove('active');
    document.getElementById('qrCameraLoader').style.display = 'none';
    document.getElementById('qrVideoWrapper').style.display = 'none';

    if (html5QrInstance && qrScannerRunning) {
        try {
            await html5QrInstance.stop();
        } catch(e) {
            console.warn('[D.U.B.I.A.] Errore nello stop scanner:', e);
        }
        qrScannerRunning = false;
    }
};


// ── Inizializzazione Event Listener Colonie ─────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    
    // Aggiorna UI colonie
    setTimeout(() => updateColoniesUI(), 500);

    // Modal Nuova Colonia
    const btnNuovaColonia = document.getElementById('btnNuovaColonia');
    if (btnNuovaColonia) {
        btnNuovaColonia.addEventListener('click', () => {
            document.getElementById('colonyForm').reset();
            document.getElementById('colonyId').value = '';
            document.getElementById('colonyMales').value = '';
            document.getElementById('colonyFemales').value = '';
            document.getElementById('colonySubadults').value = '';
            document.getElementById('colonyMedium').value = '';
            document.getElementById('colonySmall').value = '';
            document.getElementById('colonyBaby').value = '';
            document.getElementById('colonyModalTitle').innerText = 'Nuova Colonia';
            const liveWeightEl = document.getElementById('colonyEstimatedWeightLive');
            if (liveWeightEl) liveWeightEl.style.display = 'none';
            document.getElementById('colonyModal').classList.add('active');
        });
    }

    const btnCancelColony = document.getElementById('btnCancelColony');
    if (btnCancelColony) {
        btnCancelColony.addEventListener('click', () => document.getElementById('colonyModal').classList.remove('active'));
    }

    // -- Logica per stima peso live nel modulo colonia --
    const updateColonyEstimatedWeight = () => {
        const mCount = parseInt(document.getElementById('colonyMales')?.value) || 0;
        const fCount = parseInt(document.getElementById('colonyFemales')?.value) || 0;
        const subCount = parseInt(document.getElementById('colonySubadults')?.value) || 0;
        const medCount = parseInt(document.getElementById('colonyMedium')?.value) || 0;
        const smCount = parseInt(document.getElementById('colonySmall')?.value) || 0;
        const bCount = parseInt(document.getElementById('colonyBaby')?.value) || 0;

        const totalWeight = (mCount * MASS.MALE) + (fCount * MASS.FEMALE) + (subCount * MASS.SUBADULT) + 
                            (medCount * MASS.MEDIUM) + (smCount * MASS.SMALL) + (bCount * MASS.BABY);

        const liveWeightEl = document.getElementById('colonyEstimatedWeightLive');
        if (liveWeightEl) {
            if (mCount + fCount + subCount + medCount + smCount + bCount > 0) {
                liveWeightEl.innerText = `Stima Peso: ${totalWeight.toFixed(1)} g`;
                liveWeightEl.style.display = 'block';
            } else {
                liveWeightEl.style.display = 'none';
            }
        }

        // Divergence Check Live
        const warningEl = document.getElementById('colonyCountWarning');
        if (warningEl && appState.measurements.length > 0) {
            const latest = appState.measurements[appState.measurements.length - 1];
            // Calcola censimento teorico globale
            const metrics = calculateColonyMetrics(latest.total_weight, latest.adult_ratio, appState.params);
            const censusT = metrics.census;

            // Sottrai agli individui teorici tutti quelli GIA' assegnati ad ALTRE colonie
            let availM = parseInt(metrics.mCount, 10) || 0;
            let availF = parseInt(metrics.fCount, 10) || 0;
            let availMed = parseInt(metrics.medCount, 10) || 0;
            let availB = parseInt(metrics.bCount, 10) || 0;

            const currentIdVal = document.getElementById('colonyId').value;
            const skipIdString = currentIdVal ? String(currentIdVal).trim() : null;

            appState.colonies.forEach(c => {
                if (!c) return;
                if (skipIdString !== null && String(c.id).trim() === skipIdString) return;

                availM -= parseInt(c.males_count, 10) || 0;
                availF -= parseInt(c.females_count, 10) || 0;
                availMed -= parseInt(c.medium_count, 10) || 0;
                availB -= parseInt(c.baby_count, 10) || 0;
            });

            // Mostra alert se il conteggio corrente supera i disponibili teorici
            let warnings = [];
            if (fCount > availF) warnings.push(`Femmine (${fCount} inserite, stima: ${Math.max(0, availF)})`);
            if (mCount > availM) warnings.push(`Maschi (${mCount} inseriti, stima: ${Math.max(0, availM)})`);
            if (medCount > availMed) warnings.push(`N. Medie (${medCount} inserite, stima: ${Math.max(0, availMed)})`);
            if (bCount > availB) warnings.push(`Baby (${bCount} inseriti, stima: ${Math.max(0, availB)})`);

            if (warnings.length > 0) {
                warningEl.innerHTML = `⚠️ <strong>Attenzione:</strong> I numeri inseriti superano il censimento teorico per: <ul><li>${warnings.join('</li><li>')}</li></ul> Il salvataggio assorbirà biomassa da altre taglie.`;
                warningEl.style.display = 'block';
            } else {
                warningEl.style.display = 'none';
            }
        }
    };

    const countInputs = document.querySelectorAll('.colony-count-input');
    countInputs.forEach(input => input.addEventListener('input', updateColonyEstimatedWeight));

    // -- Logica Riempi con Rimanenti --
    const btnFillRemainingColony = document.getElementById('btnFillRemainingColony');
    if (btnFillRemainingColony) {
        btnFillRemainingColony.addEventListener('click', () => {
            if (!appState.measurements || appState.measurements.length === 0) {
                showNotification('Attenzione', 'Nessuna pesata globale trovata. Inserisci prima una pesata globale.', 'alert');
                return;
            }
            const latest = appState.measurements[appState.measurements.length - 1];
            // Ottieni metriche globali - Safe parsing garantito
            const metrics = calculateColonyMetrics(latest.total_weight, latest.adult_ratio, appState.params);
            
            let globM = parseInt(metrics.mCount, 10) || 0;
            let globF = parseInt(metrics.fCount, 10) || 0;
            let globSub = parseInt(metrics.saCount, 10) || 0;
            let globMed = parseInt(metrics.medCount, 10) || 0;
            let globSm = parseInt(metrics.smCount, 10) || 0;
            let globB = parseInt(metrics.bCount, 10) || 0;

            const currentIdVal = document.getElementById('colonyId').value;
            const skipIdString = currentIdVal ? String(currentIdVal).trim() : null;

            // Sottrai tutti gli assegnati (Safe Parsing estremo)
            appState.colonies.forEach(c => {
                // Controllo di esistenza
                if (!c) return;

                // Escludi la colonia corrente se in modifica usando comparazione tra stringhe
                if (skipIdString !== null && String(c.id).trim() === skipIdString) return;

                globM -= parseInt(c.males_count, 10) || 0;
                globF -= parseInt(c.females_count, 10) || 0;
                globSub -= parseInt(c.subadults_count, 10) || 0;
                globMed -= parseInt(c.medium_count, 10) || 0;
                globSm -= parseInt(c.small_count, 10) || 0;
                globB -= parseInt(c.baby_count, 10) || 0;
            });

            // Assegnazione rigorosamente >= 0
            document.getElementById('colonyMales').value = Math.max(0, globM);
            document.getElementById('colonyFemales').value = Math.max(0, globF);
            document.getElementById('colonySubadults').value = Math.max(0, globSub);
            document.getElementById('colonyMedium').value = Math.max(0, globMed);
            document.getElementById('colonySmall').value = Math.max(0, globSm);
            document.getElementById('colonyBaby').value = Math.max(0, globB);

            // Aggiorna il peso
            updateColonyEstimatedWeight();
            showNotification('Completato', 'Quantità compilate con gli individui rimanenti dal censimento.', 'success');
        });
    }

    const colonyForm = document.getElementById('colonyForm');
    if (colonyForm) {
        colonyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const idVal = document.getElementById('colonyId').value;
            const mCount = parseInt(document.getElementById('colonyMales')?.value) || 0;
            const fCount = parseInt(document.getElementById('colonyFemales')?.value) || 0;
            const subCount = parseInt(document.getElementById('colonySubadults')?.value) || 0;
            const medCount = parseInt(document.getElementById('colonyMedium')?.value) || 0;
            const smCount = parseInt(document.getElementById('colonySmall')?.value) || 0;
            const bCount = parseInt(document.getElementById('colonyBaby')?.value) || 0;
            
            const totalIndividuals = mCount + fCount + subCount + medCount + smCount + bCount;
            const estimatedWeight = totalIndividuals > 0 ? 
                (mCount * MASS.MALE) + (fCount * MASS.FEMALE) + (subCount * MASS.SUBADULT) + 
                (medCount * MASS.MEDIUM) + (smCount * MASS.SMALL) + (bCount * MASS.BABY) : null;

            const colony = {
                name:  document.getElementById('colonyName').value.trim(),
                type:  document.getElementById('colonyType').value,
                notes: document.getElementById('colonyNotes').value.trim()
            };

            let isNewWithWeight = false;

            if (idVal) {
                colony.id = Number(idVal);
                const existing = appState.colonies.find(c => c.id === colony.id);
                colony.creation_date = existing ? existing.creation_date : new Date().toISOString().split('T')[0];

                if (totalIndividuals > 0) {
                    colony.current_weight = estimatedWeight;
                    colony.males_count = mCount;
                    colony.females_count = fCount;
                    colony.subadults_count = subCount;
                    colony.medium_count = medCount;
                    colony.small_count = smCount;
                    colony.baby_count = bCount;
                } else if (existing) {
                    colony.current_weight = existing.current_weight;
                    colony.males_count = existing.males_count;
                    colony.females_count = existing.females_count;
                    colony.subadults_count = existing.subadults_count;
                    colony.medium_count = existing.medium_count;
                    colony.small_count = existing.small_count;
                    colony.baby_count = existing.baby_count;
                }
            } else {
                colony.creation_date = new Date().toISOString().split('T')[0];
                if (estimatedWeight) {
                    colony.current_weight = estimatedWeight;
                    colony.males_count = mCount;
                    colony.females_count = fCount;
                    colony.subadults_count = subCount;
                    colony.medium_count = medCount;
                    colony.small_count = smCount;
                    colony.baby_count = bCount;
                    isNewWithWeight = true;
                }
            }

            await saveColony(colony);
            document.getElementById('colonyModal').classList.remove('active');
            updateColoniesUI();

            showNotification(idVal ? 'Aggiornata' : 'Creata', `Colonia ${colony.name} salvata con successo.`, 'success');
        });
    }

    // Modal Display QR
    document.getElementById('btnCloseQrDisplay')?.addEventListener('click', () => {
        document.getElementById('qrDisplayModal').classList.remove('active');
    });

    document.getElementById('btnPrintQR')?.addEventListener('click', () => {
        const container = document.getElementById('qrCanvasContainer');
        if (!container) return;
        const canvas = container.querySelector('canvas');
        if (!canvas) return;
        const colonyName = document.getElementById('qrColonyName').innerText;
        const imgData = canvas.toDataURL("image/png");
        
        const printWindow = window.open('', '', 'height=600,width=800');
        if (!printWindow) {
            showNotification("Errore Popup", "Abilita i popup per stampare il QR.", "alert");
            return;
        }
        printWindow.document.write('<html><head><title>Stampa QR Code</title>');
        printWindow.document.write('<style>');
        printWindow.document.write('body { font-family: "Inter", sans-serif; text-align: center; padding: 2rem; color: #333; }');
        printWindow.document.write('h1 { margin-bottom: 0.5rem; font-size: 2rem; }');
        printWindow.document.write('p { margin-bottom: 2rem; color: #666; }');
        printWindow.document.write('img { max-width: 300px; height: auto; border: 2px solid #ccc; padding: 10px; border-radius: 8px; }');
        printWindow.document.write('</style>');
        printWindow.document.write('</head><body>');
        printWindow.document.write('<h1>' + colonyName + '</h1>');
        printWindow.document.write('<p>Codice per scanner D.U.B.I.A.</p>');
        printWindow.document.write('<img src="' + imgData + '" />');
        printWindow.document.write('</body></html>');
        
        printWindow.document.close();
        
        setTimeout(() => {
            printWindow.focus();
            printWindow.print();
            printWindow.close();
        }, 500);
    });

    // Modal Scanner QR
    document.getElementById('btnScanQR')?.addEventListener('click', startQRScanner);
    document.getElementById('btnCloseQrScanner')?.addEventListener('click', stopQRScanner);

    // Gestione input maschi/femmine nel form pesata quando si seleziona una colonia
    const inputColonyId = document.getElementById('inputColonyId');
    const groupColonyCounts = document.getElementById('groupColonyCounts');
    const groupAdultRatio = document.getElementById('groupAdultRatio');
    
    if (inputColonyId) {
        inputColonyId.addEventListener('change', () => {
            if (inputColonyId.value !== "") {
                // Una colonia specifica è selezionata
                groupColonyCounts.style.display = 'grid';
                // Nascondiamo il cursore Ratio, che viene calcolato indirettamente o lasciato globale
                groupAdultRatio.style.display = 'none';
            } else {
                // Massa globale
                groupColonyCounts.style.display = 'none';
                groupAdultRatio.style.display = 'block';
            }
        });
    }
});

// ── Override o Patch per processNewMeasurement ───────────────────────
// Dobbiamo assicurarci che i dati della singola colonia vengano aggiornati quando si salva un evento
// Fine del file

// ══════════════════════════════════════════════════════════════════════
// CLIMATE MODULE — Monitoraggio Termoigrometri
// ══════════════════════════════════════════════════════════════════════
// Responsabilità:
//   - fetchClimateData()       → cloudGet('Termoigrometri')
//   - renderLiveCards(data)    → aggiorna valori T e U + badge LIVE
//   - renderSparklines(data)   → mini-grafici nelle card
//   - renderHistoryChart(data) → grafico storico dual-axis Chart.js
//   - renderStatsStrip(data)   → min/avg/max per T e U
//   - init()                   → primo caricamento + auto-refresh 5 min
// ══════════════════════════════════════════════════════════════════════

const ClimateModule = (() => {
    /* ─── Stato interno ─────────────────────────────────────────── */
    let _allData     = [];       // Array grezzo completo dal GAS
    let _mappings    = {};       // Dizionario seriale -> nome terrario
    let _histChart   = null;     // Istanza Chart.js storico
    let _tempSpark   = null;     // Istanza sparkline temperatura
    let _humSpark    = null;     // Istanza sparkline umidità
    let _currentRange = '7d';   // Range selezionato
    let _currentDevice = 'all'; // Sensore selezionato
    let _initialized  = false;  // Evita doppie init
    let _refreshTimer = null;   // Timer auto-refresh
    const REFRESH_MS  = 5 * 60 * 1000; // 5 minuti (= TTL cache GAS)
    const SPARKLINE_POINTS = 48;        // Ultimi 48 punti per la sparkline (~48 ore)

    /* ─── Colori tema ───────────────────────────────────────────── */
    const C_TEMP     = '#E67E22';
    const C_TEMP_BG  = 'rgba(230,126,34,0.15)';
    const C_HUM      = '#3498DB';
    const C_HUM_BG   = 'rgba(52,152,219,0.15)';
    const C_GRID     = 'rgba(255,255,255,0.07)';
    const C_TICK     = '#94A3B8';

    /* ─── Utility ───────────────────────────────────────────────── */
    function parseTimestamp(ts) {
        if (!ts) return null;
        // Il GAS scrive ISO 8601: "2026-06-23T14:30:00"
        const d = new Date(ts);
        return isNaN(d.getTime()) ? null : d;
    }

    function fmt1(n) {
        return typeof n === 'number' ? n.toFixed(1) : '--';
    }

    function fmtTimestamp(d) {
        if (!d) return '--';
        const pad = n => String(n).padStart(2,'0');
        return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /* ─── Filtra per range ──────────────────────────────────────── */
    function filterByRange(data, range) {
        if (!data || !data.length) return [];
        if (range === 'all') return data;

        const now = Date.now();
        const cutMap = { '24h': 24*3600*1000, '7d': 7*24*3600*1000, '30d': 30*24*3600*1000 };
        const cut = cutMap[range] || cutMap['7d'];
        return data.filter(row => {
            const d = parseTimestamp(row.timestamp);
            return d && (now - d.getTime()) <= cut;
        });
    }

    /* ─── Aggiorna badge LIVE ───────────────────────────────────── */
    function updateBadge(hasData, lastDate) {
        const badge    = document.getElementById('climaLiveBadge');
        const badgeTxt = document.getElementById('climaLiveBadgeText');
        const lastUpd  = document.getElementById('climaLastUpdate');
        if (!badge) return;

        if (hasData) {
            badge.classList.add('active');
            if (badgeTxt) badgeTxt.textContent = 'LIVE';
            if (lastUpd && lastDate) {
                lastUpd.textContent = 'Ultimo dato: ' + fmtTimestamp(lastDate);
            }
        } else {
            badge.classList.remove('active');
            if (badgeTxt) badgeTxt.textContent = 'IN ATTESA';
            if (lastUpd) lastUpd.textContent = 'Nessun dato ricevuto';
        }
    }

    /* ─── Card live ─────────────────────────────────────────────── */
    function renderLiveCards(data) {
        const tempEl = document.getElementById('climaTempValue');
        const humEl  = document.getElementById('climaHumValue');

        if (!data || !data.length) {
            if (tempEl) tempEl.textContent = '--.-';
            if (humEl)  humEl.textContent  = '--.-';
            updateBadge(false, null);
            return;
        }

        // Ultimo record valido
        const last = data[data.length - 1];
        const temp = parseFloat(last.temperature);
        const hum  = parseFloat(last.humidity);
        const lastDate = parseTimestamp(last.timestamp);

        if (tempEl) tempEl.textContent = fmt1(temp);
        if (humEl)  humEl.textContent  = fmt1(hum);

        // Colore dinamico temperatura
        if (tempEl) {
            if (temp < 20)      tempEl.style.color = '#3498DB';
            else if (temp > 35) tempEl.style.color = '#C0392B';
            else                tempEl.style.color = '#E67E22';
        }

        updateBadge(true, lastDate);
    }

    /* ─── Sparkline mini-grafico ────────────────────────────────── */
    function renderSparklines(data) {
        const slice = data.slice(-SPARKLINE_POINTS);
        const labels = slice.map(() => '');
        const temps  = slice.map(r => parseFloat(r.temperature));
        const hums   = slice.map(r => parseFloat(r.humidity));

        const sparkCfg = (values, color, bgColor) => ({
            type: 'line',
            data: {
                labels,
                datasets: [{ data: values, borderColor: color, backgroundColor: bgColor,
                             borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: {
                    x: { display: false },
                    y: { display: false, min: Math.min(...values) - 1, max: Math.max(...values) + 1 }
                }
            }
        });

        // Temperatura sparkline
        const tempCanvas = document.getElementById('climaTempSparkline');
        if (tempCanvas) {
            if (_tempSpark) { _tempSpark.destroy(); _tempSpark = null; }
            _tempSpark = new Chart(tempCanvas, sparkCfg(temps, C_TEMP, C_TEMP_BG));
        }

        // Umidità sparkline
        const humCanvas = document.getElementById('climaHumSparkline');
        if (humCanvas) {
            if (_humSpark) { _humSpark.destroy(); _humSpark = null; }
            _humSpark = new Chart(humCanvas, sparkCfg(hums, C_HUM, C_HUM_BG));
        }
    }

    /* ─── Grafico storico dual-axis ─────────────────────────────── */
    function renderHistoryChart(data) {
        const container = document.getElementById('climaChartContainer');
        const emptyState = document.getElementById('climaEmptyState');
        const canvas = document.getElementById('climaHistoryChart');

        if (!data || !data.length) {
            if (container)  container.style.display  = 'none';
            if (emptyState) emptyState.style.display  = 'block';
            return;
        }

        if (container)  container.style.display  = 'block';
        if (emptyState) emptyState.style.display  = 'none';

        if (!canvas) return;

        // Down-sample se troppi punti (max 200 per performance)
        let pts = data;
        if (pts.length > 200) {
            const step = Math.ceil(pts.length / 200);
            pts = pts.filter((_, i) => i % step === 0);
        }

        const getMovingAverage = (arr, windowSize) => {
            const result = [];
            const half = Math.floor(windowSize / 2);
            for (let i = 0; i < arr.length; i++) {
                let sum = 0;
                let count = 0;
                for (let j = i - half; j <= i + half; j++) {
                    if (j >= 0 && j < arr.length && !isNaN(arr[j]) && arr[j] !== null) {
                        sum += arr[j];
                        count++;
                    }
                }
                result.push(count > 0 ? sum / count : arr[i]);
            }
            return result;
        };

        const labels = pts.map(r => {
            const d = parseTimestamp(r.timestamp);
            return d ? fmtTimestamp(d) : '';
        });
        const tempsRaw = pts.map(r => parseFloat(r.temperature));
        const humsRaw  = pts.map(r => parseFloat(r.humidity));

        const temps = getMovingAverage(tempsRaw, 5);
        const hums  = getMovingAverage(humsRaw, 5);

        // Calcolo span minimo (per evitare grafici troppo frastagliati)
        const validTemps = temps.filter(t => !isNaN(t));
        const validHums = hums.filter(h => !isNaN(h));
        
        let minT, maxT, minH, maxH;
        if (validTemps.length > 0) {
            const tMin = Math.min(...validTemps);
            const tMax = Math.max(...validTemps);
            if (tMax - tMin < 4) {
                const tMid = (tMax + tMin) / 2;
                minT = tMid - 2;
                maxT = tMid + 2;
            } else {
                minT = tMin - 1;
                maxT = tMax + 1;
            }
        }
        
        if (validHums.length > 0) {
            const hMin = Math.min(...validHums);
            const hMax = Math.max(...validHums);
            if (hMax - hMin < 10) {
                const hMid = (hMax + hMin) / 2;
                minH = hMid - 5;
                maxH = hMid + 5;
            } else {
                minH = hMin - 2;
                maxH = hMax + 2;
            }
        }

        if (_histChart) { _histChart.destroy(); _histChart = null; }

        _histChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Temperatura (°C)',
                        data: temps,
                        borderColor: C_TEMP,
                        backgroundColor: C_TEMP_BG,
                        borderWidth: 2,
                        pointRadius: pts.length < 50 ? 3 : 0,
                        pointHoverRadius: 5,
                        tension: 0.4,
                        fill: true,
                        yAxisID: 'yTemp'
                    },
                    {
                        label: 'Umidità (%)',
                        data: hums,
                        borderColor: C_HUM,
                        backgroundColor: C_HUM_BG,
                        borderWidth: 2,
                        pointRadius: pts.length < 50 ? 3 : 0,
                        pointHoverRadius: 5,
                        tension: 0.4,
                        fill: true,
                        yAxisID: 'yHum'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                animation: { duration: 400 },
                plugins: {
                    legend: {
                        display: true,
                        labels: { color: C_TICK, font: { family: 'Inter', size: 12 }, boxWidth: 14, padding: 16 }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(24,43,73,0.95)',
                        titleColor: '#E2E8F0',
                        bodyColor: '#94A3B8',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            label: ctx => {
                                const v = ctx.parsed.y;
                                return ctx.datasetIndex === 0
                                    ? `  🔥 ${v.toFixed(1)} °C`
                                    : `  💧 ${v.toFixed(1)} %`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: C_TICK, maxTicksLimit: 8, font: { size: 11, family: 'Inter' } },
                        grid:  { color: C_GRID }
                    },
                    yTemp: {
                        type: 'linear', position: 'left',
                        suggestedMin: minT, suggestedMax: maxT,
                        ticks: { color: C_TEMP, font: { size: 11, family: 'Inter', weight: '600' },
                                 callback: v => v.toFixed(1) + ' °C' },
                        grid: { color: C_GRID }
                    },
                    yHum: {
                        type: 'linear', position: 'right',
                        suggestedMin: minH, suggestedMax: maxH,
                        ticks: { color: C_HUM, font: { size: 11, family: 'Inter', weight: '600' },
                                 callback: v => v.toFixed(0) + ' %' },
                        grid: { drawOnChartArea: false }
                    }
                }
            }
        });
    }

    /* ─── Strip statistiche ─────────────────────────────────────── */
    function renderStatsStrip(data) {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        if (!data || !data.length) {
            ['climaStatTempMin','climaStatTempAvg','climaStatTempMax',
             'climaStatHumMin','climaStatHumAvg','climaStatHumMax']
             .forEach(id => set(id, '--'));
            return;
        }

        const temps = data.map(r => parseFloat(r.temperature)).filter(v => !isNaN(v));
        const hums  = data.map(r => parseFloat(r.humidity)).filter(v => !isNaN(v));

        const min = arr => Math.min(...arr);
        const max = arr => Math.max(...arr);
        const avg = arr => arr.reduce((a,b) => a+b, 0) / arr.length;

        set('climaStatTempMin', temps.length ? fmt1(min(temps)) + ' °C' : '--');
        set('climaStatTempAvg', temps.length ? fmt1(avg(temps)) + ' °C' : '--');
        set('climaStatTempMax', temps.length ? fmt1(max(temps)) + ' °C' : '--');
        set('climaStatHumMin',  hums.length  ? fmt1(min(hums))  + ' %'  : '--');
        set('climaStatHumAvg',  hums.length  ? fmt1(avg(hums))  + ' %'  : '--');
        set('climaStatHumMax',  hums.length  ? fmt1(max(hums))  + ' %'  : '--');
    }

    /* ─── Setup bottoni range ───────────────────────────────────── */
    function setupRangeButtons() {
        const btns = document.querySelectorAll('.clima-range-btn');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                btns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _currentRange = btn.dataset.range;
                applyRange();
            });
        });
    }

    /* ─── Ottieni dati filtrati per dispositivo ─────────────────── */
    function getFilteredData() {
        if (_currentDevice === 'all') {
            return _allData;
        }
        return _allData.filter(row => row.device_id === _currentDevice);
    }

    /* ─── Applica range corrente ai grafici e stats ─────────────── */
    function applyRange() {
        const devData = getFilteredData();
        const filtered = filterByRange(devData, _currentRange);
        renderHistoryChart(filtered);
        renderStatsStrip(filtered);
    }

    /* ─── Popola il selettore dispositivi ──────────────────────── */
    function populateDeviceSelector(data) {
        const selector = document.getElementById('climaDeviceSelector');
        if (!selector) return;

        // Estrai i device_id unici
        const devices = [...new Set(data.map(r => r.device_id).filter(id => id && id !== 'unknown' && id !== ''))];
        
        const prevValue = selector.value;
        selector.innerHTML = '<option value="all">Tutti i Terrari</option>';

        devices.forEach((dev) => {
            const opt = document.createElement('option');
            opt.value = dev;
            const mappedName = _mappings[dev];
            opt.textContent = mappedName ? mappedName : `Sensore non configurato (${dev})`;
            selector.appendChild(opt);
        });

        if (devices.includes(prevValue)) {
            selector.value = prevValue;
        } else {
            selector.value = 'all';
            _currentDevice = 'all';
        }
    }

    /* ─── Setup selettore dispositivo ───────────────────────────── */
    function setupDeviceSelector() {
        const selector = document.getElementById('climaDeviceSelector');
        if (!selector) return;

        selector.addEventListener('change', () => {
            _currentDevice = selector.value;
            applyRange();
            
            // Aggiorna anche le card live e le sparkline per il device specifico
            const devData = getFilteredData();
            renderLiveCards(devData);
            renderSparklines(devData);
        });
    }

    /* ─── Fetch dati dal GAS ────────────────────────────────────── */
    async function fetchClimateData() {
        try {
            const raw = await cloudGet('Termoigrometri');
            if (!Array.isArray(raw)) return [];

            // Converti valori numerici (GAS li manda come stringhe a volte)
            return raw
                .map(r => ({
                    timestamp:   r.timestamp || '',
                    device_id:   r.device_id  || '',
                    temperature: parseFloat(r.temperature),
                    humidity:    parseFloat(r.humidity)
                }))
                .filter(r => !isNaN(r.temperature) && !isNaN(r.humidity))
                .sort((a, b) => {
                    const da = parseTimestamp(a.timestamp);
                    const db = parseTimestamp(b.timestamp);
                    if (!da && !db) return 0;
                    if (!da) return -1;
                    if (!db) return 1;
                    return da - db;
                });
        } catch (e) {
            console.warn('[ClimateModule] fetchClimateData errore:', e.message);
            return [];
        }
    }

    /* ─── Fetch mappature sensori dal GAS ───────────────────────── */
    async function fetchSensorMappings() {
        try {
            const raw = await cloudGet('Sensori');
            return Array.isArray(raw) ? raw : [];
        } catch (e) {
            console.warn('[ClimateModule] fetchSensorMappings errore:', e.message);
            return [];
        }
    }

    /* ─── Rendering della lista di configurazione sensori ──────── */
    function renderConfigList() {
        const listEl = document.getElementById('climaConfigList');
        if (!listEl) return;

        // Estrai device_id dallo storico
        const uniqueDevices = [...new Set(_allData.map(r => r.device_id).filter(id => id && id !== 'unknown' && id !== ''))];
        
        // E aggiungi quelli mappati che magari non sono ancora nello storico
        Object.keys(_mappings).forEach(devId => {
            if (!uniqueDevices.includes(devId)) {
                uniqueDevices.push(devId);
            }
        });

        if (uniqueDevices.length === 0) {
            listEl.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-muted);">
                        Nessun sensore rilevato o configurato.
                    </td>
                </tr>
            `;
            return;
        }

        listEl.innerHTML = '';

        uniqueDevices.forEach(devId => {
            const deviceData = _allData.filter(r => r.device_id === devId);
            let isOnline = false;
            let lastUpdateStr = 'Nessun dato';
            if (deviceData.length > 0) {
                const lastRow = deviceData[deviceData.length - 1];
                const lastDate = parseTimestamp(lastRow.timestamp);
                if (lastDate) {
                    const diffMs = Date.now() - lastDate.getTime();
                    // 2 ore = 7200000 ms
                    if (diffMs < 7200000) {
                        isOnline = true;
                    }
                    lastUpdateStr = fmtTimestamp(lastDate);
                }
            }

            const mappedName = _mappings[devId] || '';

            const row = document.createElement('tr');
            row.className = 'clima-config-row';
            row.innerHTML = `
                <td>
                    <span class="clima-status-badge ${isOnline ? 'online' : 'offline'}">
                        <span class="${isOnline ? 'clima-pulse-green' : 'clima-pulse-gray'}"></span>
                        ${isOnline ? 'Online' : 'Offline'}
                    </span>
                </td>
                <td style="font-family: monospace; font-size: 0.9rem;">${devId}</td>
                <td style="color: var(--text-muted); font-size: 0.85rem;">${lastUpdateStr}</td>
                <td>
                    <input type="text" class="clima-config-input" id="cfg-input-${devId.replace(/:/g, '-')}" value="${mappedName}" placeholder="es. Terrario Pitone" />
                </td>
                <td style="text-align: right; gap: 0.5rem; display: inline-flex; justify-content: flex-end; align-items: center;">
                    <button class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size: 0.8rem; background-color: var(--accent-green); color: white;" onclick="ClimateModule.saveMapping('${devId}')">Salva</button>
                    ${mappedName ? `<button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.8rem; background-color: var(--alert-red); color: white;" onclick="ClimateModule.deleteMapping('${devId}')">Scollega</button>` : ''}
                </td>
            `;
            listEl.appendChild(row);
        });
    }

    /* ─── Salva associazione sensore ────────────────────────────── */
    async function saveMapping(devId) {
        const inputId = `cfg-input-${devId.replace(/:/g, '-')}`;
        const inputEl = document.getElementById(inputId);
        if (!inputEl) return;
        const name = inputEl.value.trim();
        if (!name) {
            showNotification('Errore', 'Inserisci un nome valido per il terrario.', 'alert');
            return;
        }

        try {
            showNotification('Salvataggio', 'Salvataggio associazione in corso...', 'success');
            const payload = {
                event_type: 'sensore_sync',
                id: devId,
                nome: name,
                is_deleted: false
            };
            
            const res = await cloudPostWithQueue(payload);
            if (res && res.ok) {
                showNotification('Successo', `Sensore ${devId} associato a "${name}"`, 'success');
                await refresh();
            } else {
                showNotification('Errore', 'Errore durante il salvataggio: ' + (res ? res.error : 'connessione fallita'), 'alert');
            }
        } catch (e) {
            console.error('[ClimateModule] saveMapping errore:', e);
            showNotification('Errore', 'Errore durante il salvataggio: ' + e.message, 'alert');
        }
    }

    /* ─── Rimuovi associazione sensore ──────────────────────────── */
    async function deleteMapping(devId) {
        if (!confirm(`Sei sicuro di voler scollegare il sensore ${devId}?`)) {
            return;
        }

        try {
            showNotification('Rimozione', 'Rimozione associazione in corso...', 'success');
            const payload = {
                event_type: 'sensore_delete',
                id: devId
            };
            
            const res = await cloudPostWithQueue(payload);
            if (res && res.ok) {
                showNotification('Successo', `Sensore ${devId} scollegato con successo.`, 'success');
                await refresh();
            } else {
                showNotification('Errore', 'Errore durante la disassociazione: ' + (res ? res.error : 'connessione fallita'), 'alert');
            }
        } catch (e) {
            console.error('[ClimateModule] deleteMapping errore:', e);
            showNotification('Errore', 'Errore durante la disassociazione: ' + e.message, 'alert');
        }
    }

    /* ─── Refresh completo (fetch + render tutto) ───────────────── */
    async function refresh() {
        const rawMappings = await fetchSensorMappings();
        _mappings = {};
        if (Array.isArray(rawMappings)) {
            rawMappings.forEach(m => {
                if (m.id && m.nome && m.is_deleted !== true && m.is_deleted !== "true") {
                    _mappings[m.id] = m.nome;
                }
            });
        }

        _allData = await fetchClimateData();
        populateDeviceSelector(_allData);
        
        const devData = getFilteredData();
        const filtered = filterByRange(devData, _currentRange);

        renderLiveCards(devData);     // Card live usano sempre l'ultimo dato del device selezionato
        renderSparklines(devData);    // Sparkline usano gli ultimi SPARKLINE_POINTS punti
        renderHistoryChart(filtered);  // Storico usa il range selezionato del device selezionato
        renderStatsStrip(filtered);    // Stats usano il range selezionato del device selezionato
        
        renderConfigList();
    }

    /* ─── Pre-caricamento dati in background ────────────────────── */
    async function preload() {
        if (_initialized) return;
        try {
            console.log('[ClimateModule] Avvio precaricamento dati clima...');
            const rawMappings = await fetchSensorMappings();
            _mappings = {};
            if (Array.isArray(rawMappings)) {
                rawMappings.forEach(m => {
                    if (m.id && m.nome && m.is_deleted !== true && m.is_deleted !== "true") {
                        _mappings[m.id] = m.nome;
                    }
                });
            }
            _allData = await fetchClimateData();
            console.info(`[ClimateModule] Precaricamento completato. ${_allData.length} record trovati.`);
        } catch (e) {
            console.warn('[ClimateModule] Preload fallito:', e.message);
        }
    }

    /* ─── Inizializzazione (chiamata al primo click sulla tab) ──── */
    async function init() {
        const domAlreadySetup = _initialized;
        
        if (domAlreadySetup && _refreshTimer) {
            return;
        }

        if (!domAlreadySetup) {
            _initialized = true;
            setupRangeButtons();
            setupDeviceSelector();
            
            // Setup toggle per pannello collassabile
            const configHeader = document.getElementById('climaConfigHeader');
            const configBody = document.getElementById('climaConfigBody');
            const configToggleBtn = document.getElementById('climaConfigToggleBtn');

            if (configHeader && configBody && configToggleBtn) {
                configHeader.addEventListener('click', () => {
                    if (configBody.style.display === 'none') {
                        configBody.style.display = 'block';
                        configToggleBtn.textContent = 'Riduci';
                    } else {
                        configBody.style.display = 'none';
                        configToggleBtn.textContent = 'Espandi';
                    }
                });
            }
        }

        // Se abbiamo già dati in memoria, li renderizziamo all'istante!
        if (_allData && _allData.length > 0) {
            populateDeviceSelector(_allData);
            
            const devData = getFilteredData();
            const filtered = filterByRange(devData, _currentRange);

            renderLiveCards(devData);
            renderSparklines(devData);
            renderHistoryChart(filtered);
            renderStatsStrip(filtered);
            renderConfigList();
            console.log('[ClimateModule] UI clima renderizzata all\'istante dai dati precaricati.');

            // Esegui refresh asincrono silenzioso
            refresh().catch(() => {});
        } else {
            await refresh();
        }

        // Auto-refresh ogni 5 minuti
        if (!_refreshTimer) {
            _refreshTimer = setInterval(refresh, REFRESH_MS);
            console.log('[ClimateModule] Inizializzato. Auto-refresh ogni', REFRESH_MS / 60000, 'minuti.');
        }
    }

    /* ─── API pubblica ──────────────────────────────────────────── */
    return { init, refresh, saveMapping, deleteMapping, preload };

})();

// Esponi globalmente per debug
window.ClimateModule = ClimateModule;
