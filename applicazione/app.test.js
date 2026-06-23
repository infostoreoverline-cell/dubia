/**
 * @jest-environment jsdom
 */

const { calculatePrediction, DEFAULT_PARAMS } = require('./app.js');

describe('calculatePrediction', () => {
    it('should calculate predicted weight correctly without harvest', () => {
        const lastWeight = 100;
        const foodAmount = 50;
        const adultRatio = 0.35; // not strictly used in this version of the formula for prediction calculation directly, wait, formula uses lastWeight * 0.65 for pesoNeanidiIniziale.
        const delta_g = 30; // 30 days
        const params = { theta1: 0.30, theta2: 1.05 };

        // Formula:
        // pesoNeanidiIniziale = lastWeight * 0.65 = 65
        // tempoProporzionale = 30 / 30 = 1
        // w_pred = 100 + (50 * 0.30) + (65 * 1.05 * 1) = 100 + 15 + 68.25 = 183.25

        const expected = 183.25;
        const result = calculatePrediction(lastWeight, foodAmount, adultRatio, delta_g, params);
        expect(result).toBeCloseTo(expected, 2);
    });

    it('should calculate predicted weight correctly with harvest', () => {
        const lastWeight = 100;
        const foodAmount = 50;
        const adultRatio = 0.35;
        const delta_g = 30;
        const params = { theta1: 0.30, theta2: 1.05 };
        const harvestAmount = 20;

        // Formula result before harvest: 183.25
        // After harvest: 183.25 - 20 = 163.25

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

        // Formula result before harvest: 10 + 0 + (6.5 * 1.05 * 1) = 16.825
        // After harvest: 16.825 - 100 = -83.175 => should be max(0, -83.175) = 0

        const expected = 0;
        const result = calculatePrediction(lastWeight, foodAmount, adultRatio, delta_g, params, harvestAmount);
        expect(result).toBe(expected);
    });
});
