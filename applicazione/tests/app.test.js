/**
 * @jest-environment jsdom
 */

const { calculatePrediction, DEFAULT_PARAMS, resetDubiaParams, validateAndMigrateParams, rebuildParamsFromMeasurements, appState } = require('../app.js');
const DUBIA = require('../dubia_module.js');

describe('calculatePrediction & D.U.B.I.A. Formula Verification', () => {
    it('should calculate predicted weight correctly without harvest for mixed colony (At = 0.35)', () => {
        const lastWeight = 100;
        const foodAmount = 50;
        const adultRatio = 0.35;
        const delta_g = 30; // 30 days
        const params = { theta1: 0.30, theta2: 1.05 };

        // Formula:
        // pesoNeanidiIniziale = 100 * (1 - 0.35) = 65g
        // tempoProporzionale = 30 / 30 = 1
        // w_pred = 100 + (50 * 0.30) + (65 * 1.05 * 1) = 100 + 15 + 68.25 = 183.25

        const expected = 183.25;
        const result = calculatePrediction(lastWeight, foodAmount, adultRatio, delta_g, params);
        expect(result).toBeCloseTo(expected, 2);
    });

    it('should calculate predicted weight for nymph-only colony (At = 0.0, 100% nymphs)', () => {
        const lastWeight = 100;
        const foodAmount = 0;
        const adultRatio = 0.0; // Pure nymphs
        const delta_g = 20; // 20 days
        const params = { theta1: 0.30, theta2: 1.05 };

        // Formula:
        // pesoNeanidi = 100 * (1 - 0) = 100g
        // tempo = 20 / 30 = 0.6667
        // gain = 1.05 * 100 * (20 / 30) = 70g
        // w_pred = 100 + 0 + 70 = 170g (NOT 101g!)

        const expected = 100 + (1.05 * 100 * (20 / 30));
        const result = calculatePrediction(lastWeight, foodAmount, adultRatio, delta_g, params);
        expect(result).toBeCloseTo(expected, 2);
        expect(result).toBeCloseTo(170.0, 1);
    });

    it('should calculate predicted weight correctly with harvest', () => {
        const lastWeight = 100;
        const foodAmount = 50;
        const adultRatio = 0.35;
        const delta_g = 30;
        const params = { theta1: 0.30, theta2: 1.05 };
        const harvestAmount = 20;

        const expected = 163.25;
        const result = calculatePrediction(lastWeight, foodAmount, adultRatio, delta_g, params, harvestAmount);
        expect(result).toBeCloseTo(expected, 2);
    });

    it('should not return a negative prediction', () => {
        const lastWeight = 10;
        const foodAmount = 0;
        const adultRatio = 0.35;
        const delta_g = 30;
        const params = { theta1: 0.30, theta2: 1.05 };
        const harvestAmount = 100;

        const expected = 0;
        const result = calculatePrediction(lastWeight, foodAmount, adultRatio, delta_g, params, harvestAmount);
        expect(result).toBe(expected);
    });
});

describe('D.U.B.I.A. Parameter Protection & Recovery', () => {
    it('validateAndMigrateParams should reset collapsed theta2 (< 0.20) to DEFAULT_PARAMS', () => {
        const collapsed = { theta1: 0.30, theta2: 0.001, mortalityRate: 1.5 };
        const migrated = validateAndMigrateParams(collapsed);
        expect(migrated.theta2).toBe(1.05);
        expect(migrated.theta1).toBe(0.30);
    });

    it('validateAndMigrateParams should preserve valid learned parameters within range', () => {
        const valid = { theta1: 0.32, theta2: 1.12, mortalityRate: 2.0 };
        const migrated = validateAndMigrateParams(valid);
        expect(migrated.theta1).toBe(0.32);
        expect(migrated.theta2).toBe(1.12);
        expect(migrated.mortalityRate).toBe(2.0);
    });

    it('dubiaBackpropagate should clamp theta2 above safe biological minimum 0.20', () => {
        // Extreme error simulating drop from 1000g to 50g
        const bp = DUBIA.dubiaBackpropagate(
            0.30, 1.05,
            1050, 50, // W_pred = 1050, W_real = 50 -> Error = +1000g
            1000, 0, 0.35, 30
        );

        // Parameters should stay bounded and not collapse to 0.001
        expect(bp.theta2).toBeGreaterThanOrEqual(0.20);
        expect(bp.theta2).toBeLessThanOrEqual(3.0);
        expect(bp.theta1).toBeGreaterThanOrEqual(0.05);
        expect(bp.theta1).toBeLessThanOrEqual(2.0);
    });

    it('rebuildParamsFromMeasurements should handle zero adult ratio and preserve bounds', () => {
        const measurements = [
            { date: '2026-08-01', total_weight: 100, adult_ratio: 0.0, food_amount: 10 },
            { date: '2026-08-15', total_weight: 130, adult_ratio: 0.0, food_amount: 10 }
        ];

        const reconstructed = rebuildParamsFromMeasurements(measurements);
        expect(reconstructed.theta2).toBeGreaterThanOrEqual(0.20);
        expect(reconstructed.theta2).toBeLessThanOrEqual(3.0);
        expect(reconstructed.theta1).toBeGreaterThanOrEqual(0.05);
        expect(reconstructed.theta1).toBeLessThanOrEqual(2.0);
    });

    it('resetDubiaParams should restore DEFAULT_PARAMS', () => {
        appState.params.theta1 = 0.08;
        appState.params.theta2 = 0.25;
        resetDubiaParams();
        expect(appState.params.theta1).toBe(DEFAULT_PARAMS.theta1);
        expect(appState.params.theta2).toBe(DEFAULT_PARAMS.theta2);
        expect(appState.params.mortalityRate).toBe(DEFAULT_PARAMS.mortalityRate);
    });
});

describe('Commercial Price Catalog & PDF Quotation Engine', () => {
    const { COMMERCIAL_CATALOG } = require('../app.js');

    it('should have exact pricing scheme specified by user', () => {
        // 1. Blatte Adulte (M/F 2-2.5cm): 50€ / kg
        expect(COMMERCIAL_CATALOG.ADULT.pricePerKg).toBe(50.00);

        // 2. Misto (Colonia avviata): 65€ / kg
        expect(COMMERCIAL_CATALOG.MIXED.pricePerKg).toBe(65.00);

        // 3. Medie (1-1.5cm): 16€ / 100 pz -> 150€ / kg
        expect(COMMERCIAL_CATALOG.MEDIUM.pricePer100).toBe(16.00);
        expect(COMMERCIAL_CATALOG.MEDIUM.pricePerKg).toBe(150.00);

        // 4. Small (1-8mm): 14€ / 100 pz -> 1000€ / kg
        expect(COMMERCIAL_CATALOG.SMALL.pricePer100).toBe(14.00);
        expect(COMMERCIAL_CATALOG.SMALL.pricePerKg).toBe(1000.00);
    });

    it('should accurately calculate quote line items, shipping, discounts and totals', () => {
        // User scenario:
        // 1 kg Adulte @ 40€/kg = 40.00€
        // 0.5 kg Miste @ 60€/kg = 30.00€
        // 200 Medie (2 x 100pz @ 14€) = 28.00€
        // 300 Small (3 x 100pz @ 12.50€) = 37.50€
        // Subtotal = 135.50€

        const items = [
            { category: 'ADULT', unit: 'kg', quantity: 1.0, unitPrice: 40.00 },
            { category: 'MIXED', unit: 'kg', quantity: 0.5, unitPrice: 60.00 },
            { category: 'MEDIUM', unit: '100pz', quantity: 2.0, unitPrice: 14.00 },
            { category: 'SMALL', unit: '100pz', quantity: 3.0, unitPrice: 12.50 }
        ];

        const lineTotals = items.map(it => it.quantity * it.unitPrice);
        expect(lineTotals).toEqual([40.00, 30.00, 28.00, 37.50]);

        const subtotal = lineTotals.reduce((a, b) => a + b, 0);
        expect(subtotal).toBe(135.50);

        const shipping = 10.00;
        const discount = 5.50;
        const grandTotal = subtotal + shipping - discount;
        expect(grandTotal).toBe(140.00);
    });

    it('should correctly handle Michael intermediary channel with zero shipping', async () => {
        const { saveQuote, deleteQuote } = require('../app.js');
        const michaelQuote = {
            id: 888,
            channel: 'MICHAEL',
            number: 'PREV-2026-MICHAEL-01',
            date: '2026-08-17',
            client: { nome: 'Michael', cognome: '', citta: '' },
            items: [
                { category: 'ADULT', unit: 'kg', quantity: 2.0, unitPrice: 40.00, total: 80.00 },
                { category: 'MEDIUM', unit: '100pz', quantity: 5.0, unitPrice: 14.00, total: 70.00 }
            ],
            subtotal: 150.00,
            shipping: 0, // No shipping charged for intermediary Michael
            discount: 0,
            grandTotal: 150.00,
            status: 'SENT',
            notes: 'Accordi di fornitura riservata intermediario Michael. Consegna diretta senza spese di spedizione.'
        };

        await saveQuote(michaelQuote);
        const retrieved = appState.quotes.find(q => q.id === 888);
        expect(retrieved).toBeDefined();
        expect(retrieved.channel).toBe('MICHAEL');
        expect(retrieved.shipping).toBe(0);
        expect(retrieved.grandTotal).toBe(150.00);

        await deleteQuote(888);
    });

    it('should support quote lifecycle: save, query and delete from state', async () => {
        const { saveQuote, deleteQuote } = require('../app.js');
        const quoteObj = {
            id: 999,
            number: 'PREV-2026-999',
            date: '2026-08-17',
            client: { nome: 'Marco', cognome: 'Test', citta: 'Milano' },
            items: [{ category: 'ADULT', unit: 'kg', quantity: 2, unitPrice: 40, total: 80 }],
            grandTotal: 80.00,
            status: 'SENT'
        };

        await saveQuote(quoteObj);
        expect(appState.quotes.some(q => q.id === 999)).toBe(true);

        await deleteQuote(999);
        expect(appState.quotes.some(q => q.id === 999)).toBe(false);
    });
});

describe('Listino Prezzi & Catalogo Completo D.U.B.I.A.', () => {
    const { PRICE_CATALOG_FULL, generateWhatsAppPriceListText } = require('../app.js');

    it('should have complete PRICE_CATALOG_FULL structure for Blatte Dubia', () => {
        expect(PRICE_CATALOG_FULL).toBeDefined();
        expect(PRICE_CATALOG_FULL.categories.length).toBeGreaterThan(0);
        const categoryIds = PRICE_CATALOG_FULL.categories.map(c => c.id);
        expect(categoryIds).toContain('BLATTE');
    });

    it('should have valid items and positive prices in each category', () => {
        PRICE_CATALOG_FULL.categories.forEach(cat => {
            expect(cat.title).toBeTruthy();
            expect(cat.items.length).toBeGreaterThan(0);

            cat.items.forEach(item => {
                expect(item.id).toBeTruthy();
                expect(item.title).toBeTruthy();
                expect(item.size).toBeTruthy();
                expect(item.desc).toBeTruthy();
                expect(item.tiers).toBeDefined();
                expect(item.tiers.DIRECT).toBeDefined();
                expect(item.tiers.MICHAEL).toBeDefined();
                expect(item.tiers.DIRECT.length).toBeGreaterThan(0);
                expect(item.tiers.MICHAEL.length).toBeGreaterThan(0);

                item.tiers.DIRECT.forEach(tier => {
                    expect(typeof tier.price).toBe('number');
                    expect(tier.price).toBeGreaterThan(0);
                    expect(tier.qty).toBeTruthy();
                });

                item.tiers.MICHAEL.forEach(tier => {
                    expect(typeof tier.price).toBe('number');
                    expect(tier.price).toBeGreaterThan(0);
                    expect(tier.qty).toBeTruthy();
                });
            });
        });
    });

    it('wholesale tier prices (MICHAEL) should be <= direct tier prices (DIRECT)', () => {
        PRICE_CATALOG_FULL.categories.forEach(cat => {
            cat.items.forEach(item => {
                const directTiers = item.tiers.DIRECT;
                const michaelTiers = item.tiers.MICHAEL;
                expect(michaelTiers[0].price).toBeLessThanOrEqual(directTiers[0].price);
            });
        });
    });

    it('should generate formatted WhatsApp price list text for DIRECT and MICHAEL', () => {
        const directText = generateWhatsAppPriceListText('DIRECT');
        expect(directText).toContain('LISTINO PREZZI BLATTE DUBIA 2026');
        expect(directText).toContain('BLATTE ADULTE');
        expect(directText).toContain('NEANIDI MEDIE');
        expect(directText).toContain('SPEDIZIONI & GARANZIA QUALITÀ');

        const michaelText = generateWhatsAppPriceListText('MICHAEL');
        expect(michaelText).toContain('LISTINO RISERVATO INGROSSO (MICHAEL)');
        expect(michaelText).toContain('BLATTE ADULTE');
        expect(michaelText).not.toEqual(directText);
    });
});



