import type { ExtractedFields, Decision } from "./types.js";

export function evaluateEligibility(fields: ExtractedFields): Decision {
  // 1. GATE A: Window Check (2011-01-01 <= cover_start_date <= 2023-12-31)
  if (!fields.cover_start_date) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      reasonCode: 'MISSING.cover_start_date',
      reasonText: 'Insufficient data: cover_start_date is missing.',
      drivingField: 'cover_start_date'
    };
  }

  const startDate = new Date(fields.cover_start_date);
  const minDate = new Date('2011-01-01');
  const maxDate = new Date('2023-12-31');

  if (startDate < minDate || startDate > maxDate) {
    return {
      verdict: 'NOT_ELIGIBLE',
      reasonCode: 'A.window',
      reasonText: `Excluded under Gate A: cover start date ${fields.cover_start_date} is outside the 2011-2023 qualifying window.`,
      drivingField: 'cover_start_date'
    };
  }

  // 2. GATE C4: Early Cancellation Carve-Out (< 90 days)
  // Evaluated early if cancelled_date is present
  if (fields.cancelled_date) {
    const cancelDate = new Date(fields.cancelled_date);
    const diffDays = (cancelDate.getTime() - startDate.getTime()) / (1000 * 3600 * 24);
    
    if (diffDays < 90) {
      return {
        verdict: 'NOT_ELIGIBLE',
        reasonCode: 'C4.early_cancellation',
        reasonText: `Excluded under Gate C4: policy cancelled after ${diffDays} days (below 90-day threshold).`,
        drivingField: 'cancelled_date'
      };
    }
  }

  // 3. GATE C3: Prior Ruling Exclusion
  if (fields.prior_ruling && fields.prior_ruling !== 'none') {
    return {
      verdict: 'NOT_ELIGIBLE',
      reasonCode: 'C3.prior_ruling',
      reasonText: `Excluded under Gate C3: prior ruling recorded as ${fields.prior_ruling}.`,
      drivingField: 'prior_ruling'
    };
  }

  // 4. GATE C2: No Commission Exclusion
  if (fields.commission_basis === 'none') {
    return {
      verdict: 'NOT_ELIGIBLE',
      reasonCode: 'C2.no_commission',
      reasonText: 'Excluded under Gate C2: commission basis is recorded as none.',
      drivingField: 'commission_basis'
    };
  }

  // 5. GATE B & C1: Qualifying Basis & De Minimis
  const hasDiscretion = fields.commission_basis === 'discretionary' && fields.discretion_exercised === true;
  
  let ratioQualifies = false;
  if (fields.commission_amount != null && fields.total_premiums_paid != null && fields.total_premiums_paid > 0) {
    const ratio = fields.commission_amount / fields.total_premiums_paid;
    ratioQualifies = ratio >= 0.35;
  }

  // Check De Minimis (C1) if commission is present
  if (fields.commission_amount != null && fields.commission_amount <= 75.00) {
    return {
      verdict: 'NOT_ELIGIBLE',
      reasonCode: 'C1.de_minimis',
      reasonText: `Excluded under Gate C1: commission of £${fields.commission_amount.toFixed(2)} is at or below the £75 de minimis threshold.`,
      drivingField: 'commission_amount'
    };
  }

  // Evaluate Limb B1 vs Limb B2
  if (hasDiscretion) {
    return {
      verdict: 'ELIGIBLE',
      reasonCode: 'ELIGIBLE.b1_discretion',
      reasonText: 'Eligible under Gate B1: discretionary premium setting was exercised by agent.',
      drivingField: 'discretion_exercised'
    };
  }

  if (ratioQualifies) {
    return {
      verdict: 'ELIGIBLE',
      reasonCode: 'ELIGIBLE.b2_ratio',
      reasonText: `Eligible under Gate B2: commission ratio of ${((fields.commission_amount! / fields.total_premiums_paid!) * 100).toFixed(1)}% meets or exceeds 35%.`,
      drivingField: 'commission_amount'
    };
  }

  // 6. Check for Missing Decisive Fields before declaring NOT_ELIGIBLE
  if (fields.commission_basis === 'discretionary' && fields.discretion_exercised === null) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      reasonCode: 'MISSING.discretion_exercised',
      reasonText: 'Insufficient data: discretion_exercised boolean is missing.',
      drivingField: 'discretion_exercised'
    };
  }

  if (fields.commission_amount === null) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      reasonCode: 'MISSING.commission_amount',
      reasonText: 'Insufficient data: commission_amount is missing.',
      drivingField: 'commission_amount'
    };
  }

  if (fields.prior_ruling === null) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      reasonCode: 'MISSING.prior_ruling',
      reasonText: 'Insufficient data: prior_ruling field is missing.',
      drivingField: 'prior_ruling'
    };
  }

  // Default Fallback
  return {
    verdict: 'NOT_ELIGIBLE',
    reasonCode: 'B.neither_limb',
    reasonText: 'Excluded: policy does not qualify under Limb B1 (discretion) or Limb B2 (ratio >= 35%).',
    drivingField: 'commission_basis'
  };
}