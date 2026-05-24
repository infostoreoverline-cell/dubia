const { calculatePrediction } = require('../app');

describe('calculatePrediction', () => {
  const defaultParams = {
    theta1: 0.30,
    theta2: 1.05,
    mortalityRate: 1.5
  };

  it('calculates the natural prediction correctly without harvest', () => {
    // Math:
    // base = 1000 + (0.30 * 100) + (1.05 * (1000 * (1 - 0.35)) * (30/30))
    //      = 1000 + 30 + (1.05 * 650 * 1)
    //      = 1030 + 682.5 = 1712.5
    // mortalityFactor = (1.5 / 100) * (30/30) = 0.015
    // 1712.5 * (1 - 0.015) = 1712.5 * 0.985 = 1686.8125
    const result = calculatePrediction(1000, 100, 0.35, 30, defaultParams, 0);
    expect(result).toBeCloseTo(1686.8125, 4);
  });

  it('subtracts harvest amount correctly', () => {
    // 1686.8125 - 200 = 1486.8125
    const result = calculatePrediction(1000, 100, 0.35, 30, defaultParams, 200);
    expect(result).toBeCloseTo(1486.8125, 4);
  });

  it('never returns negative weight', () => {
    // Harvest of 5000 > 1686.8125, should return 0
    const result = calculatePrediction(1000, 100, 0.35, 30, defaultParams, 5000);
    expect(result).toBe(0);
  });

  it('handles zero values (no food, no time elapsed) correctly', () => {
    // 1000 + 0 + 0 = 1000
    // mortality = 0
    // w_pred = 1000 * 1 = 1000
    const result = calculatePrediction(1000, 0, 0.35, 0, defaultParams, 0);
    expect(result).toBe(1000);
  });

  it('handles different parameters and ratios', () => {
    // adultRatio = 0.5
    // delta_g = 60
    // base = 1000 + (0.5 * 200) + (1.2 * (1000 * (1 - 0.5)) * (60/30))
    //      = 1000 + 100 + (1.2 * 500 * 2) = 1100 + 1200 = 2300
    // mortalityFactor = (2.0 / 100) * 2 = 0.04
    // 2300 * (1 - 0.04) = 2300 * 0.96 = 2208
    const params = { theta1: 0.5, theta2: 1.2, mortalityRate: 2.0 };
    const result = calculatePrediction(1000, 200, 0.5, 60, params, 0);
    expect(result).toBeCloseTo(2208, 4);
  });

  it('uses default mortalityRate if not provided in params', () => {
    // Same as the first test but without mortalityRate in params
    const params = { theta1: 0.30, theta2: 1.05 };
    const result = calculatePrediction(1000, 100, 0.35, 30, params, 0);
    expect(result).toBeCloseTo(1686.8125, 4);
  });
});
