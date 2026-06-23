/**
 * D.U.B.I.A. CORE MODULE
 * Dynamic Updating Biomass Inference Algorithm
 * 
 * Implementazione rigorosa delle formule del Teorema D.U.B.I.A.
 * Sanity-checked: tutte le equazioni, costanti e derivate parziali
 * sono implementate esattamente come da specifica.
 */

'use strict';

// ============================================================
// MODULO 1 — COSTANTI E STATO INIZIALE
// ============================================================

/** Costante: rapporto adulti iniziale (A_t default) */
const DUBIA_AT_DEFAULT = 0.35;

/** Costante: θ₁ iniziale (resa alimentazione) */
const DUBIA_THETA1_DEFAULT = 0.30;

/** Costante: θ₂ iniziale (crescita naturale neanidi) */
const DUBIA_THETA2_DEFAULT = 1.05;

/** Costante: tasso di apprendimento α per la discesa del gradiente */
const DUBIA_ALPHA = 1e-6;

/**
 * Valore storico ottimale di θ₁ (θ₁*).
 * Viene fissato al valore iniziale di default e NON cambia mai —
 * è il riferimento "benchmark" contro cui si calcola l'Indice H.
 */
const DUBIA_THETA1_STAR = DUBIA_THETA1_DEFAULT; // 0.30

// Costanti demografiche massa media individui (grammi)
const DUBIA_MASS = {
    FEMALE:   2.5,   // Femmina adulta
    MALE:     1.5,   // Maschio adulto
    SUBADULT: 1.6,   // Sub-adulta
    MEDIUM:   0.8,   // Neanide media
    SMALL:    0.3,   // Neanide piccola
    BABY:     0.1    // Micro-neanide / Baby
};

// Proporzioni demografiche adulti
const DUBIA_ADULT_SEX = {
    S_f: 0.77,   // Proporzione femmine su adulti totali
    S_m: 0.23    // Proporzione maschi su adulti totali
};

// Proporzioni demografiche neanidi
const DUBIA_NYMPH = {
    P_medium: 0.70,  // Percentuale neanidi medie
    P_baby:   0.30   // Percentuale neanidi baby/micro
};

// Soglie Indice di Salute H
const DUBIA_H_OPTIMAL = 90;   // H >= 90% → Ottimale
const DUBIA_H_WARNING = 75;   // H >= 75% e < 90% → Warning
// H < 75% → Allarme Critico

// ============================================================
// MODULO 2 — CORE MATEMATICO: FEED-FORWARD + BACK-PROPAGATION
// ============================================================

/**
 * FEED-FORWARD INFERENCE — Equazione di Stato
 * 
 * Calcola la Biomassa Predetta al passo successivo:
 *   Ŵ_{t+1} = W_t + (θ₁ · C_t) + [θ₂ · (W_t · (1 − A_t)) · (Δg / 30)]
 * 
 * @param {number} W_t        - Biomassa iniziale (peso colonia attuale, grammi)
 * @param {number} C_t        - Cibo somministrato (grammi)
 * @param {number} A_t        - Rapporto adulti [0..1]
 * @param {number} delta_g    - Giorni trascorsi (Δg)
 * @param {number} theta1     - Parametro θ₁ (resa alimentazione)
 * @param {number} theta2     - Parametro θ₂ (crescita naturale neanidi)
 * @param {number} [harvest]  - Prelievo in grammi (opzionale, default 0)
 * @returns {number} Biomassa predetta Ŵ_{t+1}
 */
function dubiaFeedForward(W_t, C_t, A_t, delta_g, theta1, theta2, harvest = 0) {
    // Componente crescita neanidi: W_t · (1 − A_t) = peso neanidi
    const W_neanidi = W_t * (1 - A_t);

    // Equazione di stato completa
    const W_pred = W_t
        + (theta1 * C_t)
        + (theta2 * W_neanidi * (delta_g / 30))
        - harvest;

    return Math.max(0, W_pred);
}

/**
 * RETROPROPAGAZIONE DELL'ERRORE — Regola del Delta (Discesa del Gradiente)
 * 
 * Aggiorna i parametri θ₁ e θ₂ sulla base dell'errore di predizione.
 * 
 * Errore:  E = Ŵ_{t+1} − W_{reale}
 * 
 * Derivate parziali (dalla specifica):
 *   ∂E/∂θ₁ = C_t
 *   ∂E/∂θ₂ = W_t · (1 − A_t) · (Δg / 30)
 * 
 * Aggiornamento:
 *   θ₁_new = θ₁_old − α · E · C_t
 *   θ₂_new = θ₂_old − α · E · [W_t · (1 − A_t) · (Δg / 30)]
 * 
 * @param {number} theta1_old    - θ₁ corrente
 * @param {number} theta2_old    - θ₂ corrente
 * @param {number} W_pred        - Biomassa predetta Ŵ_{t+1}
 * @param {number} W_reale       - Biomassa reale misurata
 * @param {number} W_t           - Biomassa iniziale al passo precedente
 * @param {number} C_t           - Cibo somministrato (grammi)
 * @param {number} A_t           - Rapporto adulti [0..1]
 * @param {number} delta_g       - Giorni trascorsi (Δg)
 * @param {number} [alpha]       - Tasso di apprendimento (default DUBIA_ALPHA)
 * @returns {{ theta1: number, theta2: number, error: number }}
 */
function dubiaBackpropagate(theta1_old, theta2_old, W_pred, W_reale, W_t, C_t, A_t, delta_g, alpha = DUBIA_ALPHA) {
    // Calcolo errore
    const E = W_pred - W_reale;

    // Gradiente rispetto a θ₁: ∂E/∂θ₁ = C_t
    const grad_theta1 = C_t;

    // Gradiente rispetto a θ₂: ∂E/∂θ₂ = W_t · (1 − A_t) · (Δg / 30)
    const grad_theta2 = W_t * (1 - A_t) * (delta_g / 30);

    // Aggiornamento parametri
    const theta1_new = theta1_old - (alpha * E * grad_theta1);
    const theta2_new = theta2_old - (alpha * E * grad_theta2);

    // Floor a 0.001 per evitare parametri negativi o nulli
    return {
        theta1: Math.max(0.001, theta1_new),
        theta2: Math.max(0.001, theta2_new),
        error: E
    };
}

// ============================================================
// MODULO 3 — INDICE DI SALUTE H E DIAGNOSTICA DIFFERENZIALE
// ============================================================

/**
 * Calcola l'Indice di Salute Metabolica H(t).
 * 
 *   H(t) = (θ₁^(t) / θ₁*) × 100
 * 
 * dove θ₁* = 0.30 (valore storico ottimale).
 * 
 * @param {number} theta1      - θ₁ corrente
 * @param {number} [theta1Star] - θ₁* ottimale (default 0.30)
 * @returns {number} Indice H in percentuale
 */
function dubiaHealthIndex(theta1, theta1Star = DUBIA_THETA1_STAR) {
    if (theta1Star <= 0) return 100;
    return (theta1 / theta1Star) * 100;
}

/**
 * Classifica lo stato dell'Indice di Salute H.
 * @param {number} H - Indice di Salute in %
 * @returns {'optimal'|'warning'|'critical'}
 */
function dubiaHealthStatus(H) {
    if (H >= DUBIA_H_OPTIMAL) return 'optimal';
    if (H >= DUBIA_H_WARNING) return 'warning';
    return 'critical';
}

/**
 * DIAGNOSTICA DIFFERENZIALE
 * 
 * Analizza l'andamento dei parametri e genera avvisi diagnostici.
 * 
 * Regole:
 *   - Se θ₁ crolla (< 80% del default): "Qualità Nutrizionale / Idratazione"
 *   - Se θ₂ crolla (< 80% del default): "Stress Termico / Umidità"
 *   - Se H < 75%: "Senescenza / Inbreeding"
 * 
 * @param {number} theta1      - θ₁ corrente
 * @param {number} theta2      - θ₂ corrente
 * @param {number} H           - Indice H corrente
 * @returns {Array<{type: string, title: string, message: string, suggestion: string}>}
 */
function dubiaDifferentialDiagnostics(theta1, theta2, H) {
    const diagnostics = [];

    // Soglie: 80% del valore di default
    const theta1Threshold = DUBIA_THETA1_DEFAULT * 0.80; // 0.24
    const theta2Threshold = DUBIA_THETA2_DEFAULT * 0.80; // 0.84

    // Regola 1: θ₁ crolla → problema nutrizionale/idrico
    if (theta1 < theta1Threshold) {
        diagnostics.push({
            type:       'theta1_drop',
            severity:   'warning',
            title:      '⚠️ Qualità Nutrizionale / Idratazione',
            message:    `θ₁ = ${theta1.toFixed(4)} (soglia: ${theta1Threshold.toFixed(4)}). La resa alimentare è significativamente inferiore all'ottimale.`,
            suggestion: '💡 Integrare proteine (es. lievito di birra, mangime ricco) o acqua gel. Verificare qualità e freschezza del cibo offerto.'
        });
    }

    // Regola 2: θ₂ crolla → stress termico o umidità insufficiente
    if (theta2 < theta2Threshold) {
        diagnostics.push({
            type:       'theta2_drop',
            severity:   'warning',
            title:      '⚠️ Stress Termico / Umidità',
            message:    `θ₂ = ${theta2.toFixed(4)} (soglia: ${theta2Threshold.toFixed(4)}). La crescita naturale delle neanidi è rallentata.`,
            suggestion: '💡 Verificare i moduli riscaldanti (target: 32–35°C). Controllare che l\'umidità non sia sotto il 40%. Assicurarsi che le lampade/tappetini siano a 80W o equivalenti.'
        });
    }

    // Regola 3: H < 75% → senescenza/inbreeding
    if (H < DUBIA_H_WARNING) {
        diagnostics.push({
            type:       'health_critical',
            severity:   'critical',
            title:      '🚨 Senescenza / Inbreeding Rilevato',
            message:    `Indice H = ${H.toFixed(1)}% (< 75%). La colonia mostra segni di declino sistemico non spiegabile da fattori ambientali o alimentari.`,
            suggestion: '💡 Introdurre un nuovo ceppo genetico (nuovo sangue) di Blaptica dubia non imparentato. Isolare i riproduttori più vecchi.'
        });
    }

    return diagnostics;
}

// ============================================================
// MODULO 4 — CENSIMENTO DEMOGRAFICO
// ============================================================

/**
 * Calcola il censimento demografico completo della colonia.
 * 
 * Macromoduli:
 *   W_adulti  = W_t · A_t
 *   W_neanidi = W_t · (1 − A_t)
 * 
 * Adulti:
 *   N_femmine = (W_adulti · S_f) / m_f    (S_f = 0.77, m_f = 2.5g)
 *   N_maschi  = (W_adulti · S_m) / m_m    (S_m = 0.23, m_m = 1.5g)
 * 
 * Neanidi (Modello Piramidale):
 *   N_medie = (W_neanidi · 0.70) / 0.8g
 *   N_baby  = (W_neanidi · 0.30) / 0.1g
 * 
 * @param {number} W_t   - Biomassa reale totale (grammi)
 * @param {number} A_t   - Rapporto adulti [0..1]
 * @returns {DubiaCensus} Oggetto census con tutti i dati demografici
 */
function dubiaCensus(W_t, A_t) {
    // ── Macromoduli ──────────────────────────────────────────
    const W_adulti  = W_t * A_t;
    const W_neanidi = W_t * (1 - A_t);

    // ── Adulti ───────────────────────────────────────────────
    const W_femmine = W_adulti * DUBIA_ADULT_SEX.S_f;
    const W_maschi  = W_adulti * DUBIA_ADULT_SEX.S_m;

    const N_femmine = W_femmine / DUBIA_MASS.FEMALE;   // / 2.5g
    const N_maschi  = W_maschi  / DUBIA_MASS.MALE;     // / 1.5g

    // ── Neanidi (Modello Piramidale) ──────────────────────────
    const W_neanidi_medie = W_neanidi * DUBIA_NYMPH.P_medium; // 70%
    const W_neanidi_baby  = W_neanidi * DUBIA_NYMPH.P_baby;   // 30%

    const N_medie = W_neanidi_medie / DUBIA_MASS.MEDIUM;  // / 0.8g
    const N_baby  = W_neanidi_baby  / DUBIA_MASS.BABY;    // / 0.1g

    // ── Riepilogo ─────────────────────────────────────────────
    return {
        // Biomasse macromoduli
        W_adulti,
        W_neanidi,

        // Adulti
        W_femmine,
        W_maschi,
        N_femmine: Math.round(N_femmine),
        N_maschi:  Math.round(N_maschi),

        // Neanidi
        W_neanidi_medie,
        W_neanidi_baby,
        N_medie: Math.round(N_medie),
        N_baby:  Math.round(N_baby),

        // Totali
        N_totale_adulti:  Math.round(N_femmine) + Math.round(N_maschi),
        N_totale_neanidi: Math.round(N_medie) + Math.round(N_baby),
        N_totale:         Math.round(N_femmine) + Math.round(N_maschi) + Math.round(N_medie) + Math.round(N_baby),

        // Rapporto sessuale maschi/femmine
        sex_ratio: N_femmine > 0 ? N_maschi / N_femmine : 0
    };
}

/**
 * Genera la tabella di output del censimento demografico.
 * 
 * Colonne: Stadio Vitale | Individui (N) | Biomassa (g) | Stato/Destinazione
 * 
 * @param {ReturnType<typeof dubiaCensus>} census - Output di dubiaCensus()
 * @returns {Array<CensusRow>} Array di righe per la tabella
 */
function dubiaCensusTable(census) {
    return [
        {
            stage:       'Femmine Adulte',
            mass_avg:    `${DUBIA_MASS.FEMALE}g`,
            proportion:  `A_t × S_f (${(DUBIA_ADULT_SEX.S_f * 100).toFixed(0)}%)`,
            N:           census.N_femmine,
            biomassa_g:  census.W_femmine.toFixed(1),
            destinazione: 'Riproduttrici — mantenere'
        },
        {
            stage:       'Maschi Adulti',
            mass_avg:    `${DUBIA_MASS.MALE}g`,
            proportion:  `A_t × S_m (${(DUBIA_ADULT_SEX.S_m * 100).toFixed(0)}%)`,
            N:           census.N_maschi,
            biomassa_g:  census.W_maschi.toFixed(1),
            destinazione: 'Riproduttori — verificare sex ratio'
        },
        {
            stage:       'Neanidi Medie',
            mass_avg:    `${DUBIA_MASS.MEDIUM}g`,
            proportion:  `(1−A_t) × 70%`,
            N:           census.N_medie,
            biomassa_g:  census.W_neanidi_medie.toFixed(1),
            destinazione: 'Crescita — prelievo futuro'
        },
        {
            stage:       'Micro-Neanidi (Baby)',
            mass_avg:    `${DUBIA_MASS.BABY}g`,
            proportion:  `(1−A_t) × 30%`,
            N:           census.N_baby,
            biomassa_g:  census.W_neanidi_baby.toFixed(1),
            destinazione: 'Riserva — non prelevare'
        }
    ];
}

// ============================================================
// ESPORTAZIONI
// ============================================================

// Supporto sia per ambienti browser (window) che Node.js (module.exports)
if (typeof window !== 'undefined') {
    window.DUBIA = {
        // Costanti
        AT_DEFAULT:     DUBIA_AT_DEFAULT,
        THETA1_DEFAULT: DUBIA_THETA1_DEFAULT,
        THETA2_DEFAULT: DUBIA_THETA2_DEFAULT,
        ALPHA:          DUBIA_ALPHA,
        THETA1_STAR:    DUBIA_THETA1_STAR,
        MASS:           DUBIA_MASS,
        ADULT_SEX:      DUBIA_ADULT_SEX,
        NYMPH:          DUBIA_NYMPH,
        H_OPTIMAL:      DUBIA_H_OPTIMAL,
        H_WARNING:      DUBIA_H_WARNING,

        // Funzioni
        feedForward:            dubiaFeedForward,
        backpropagate:          dubiaBackpropagate,
        healthIndex:            dubiaHealthIndex,
        healthStatus:           dubiaHealthStatus,
        differentialDiagnostics: dubiaDifferentialDiagnostics,
        census:                 dubiaCensus,
        censusTable:            dubiaCensusTable
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DUBIA_AT_DEFAULT,
        DUBIA_THETA1_DEFAULT,
        DUBIA_THETA2_DEFAULT,
        DUBIA_ALPHA,
        DUBIA_THETA1_STAR,
        DUBIA_MASS,
        DUBIA_ADULT_SEX,
        DUBIA_NYMPH,
        DUBIA_H_OPTIMAL,
        DUBIA_H_WARNING,
        dubiaFeedForward,
        dubiaBackpropagate,
        dubiaHealthIndex,
        dubiaHealthStatus,
        dubiaDifferentialDiagnostics,
        dubiaCensus,
        dubiaCensusTable
    };
}
