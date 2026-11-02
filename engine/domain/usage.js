// Normalisation of /api/oauth/usage responses.
// The engine hands out ISO dates; countdowns/clock strings are the UI's job.

function window(w) {
    if (!w || typeof w !== 'object' || typeof w.utilization !== 'number' ||
        !Number.isFinite(w.utilization))
        return null;
    return {
        pct: w.utilization,
        resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
        locked: typeof w.locked_reason === 'string' && w.locked_reason ? w.locked_reason : null,
    };
}

function money(m) {
    if (m === null || m === undefined)
        return null;
    if (typeof m === 'number')
        return m;
    if (typeof m === 'object' && typeof m.amount_minor === 'number') {
        const exp = typeof m.exponent === 'number' ? m.exponent : 2;
        return m.amount_minor / 10 ** exp;
    }
    return null;
}

function spendOf(d) {
    const s = d.spend;
    if (s && typeof s === 'object') {
        if (s.enabled !== true)
            return null;
        const used = money(s.used);
        if (used === null)
            return null;
        return {
            used,
            limit: money(s.limit),
            pct: typeof s.percent === 'number' ? s.percent : null,
            currency: s.used?.currency ?? s.currency ?? 'USD',
            severity: typeof s.severity === 'string' ? s.severity : null,
        };
    }
    const eu = d.extra_usage;
    if (eu && typeof eu === 'object' && eu.is_enabled === true &&
        typeof eu.used_credits === 'number' && typeof eu.monthly_limit === 'number' &&
        typeof eu.utilization === 'number') {
        return {
            used: eu.used_credits / 100,
            limit: eu.monthly_limit / 100,
            pct: eu.utilization,
            currency: eu.currency ?? 'USD',
            severity: null,
        };
    }
    return null;
}

function scopedOf(d) {
    if (!Array.isArray(d.limits))
        return [];
    const out = [];
    for (const l of d.limits) {
        const name = l?.scope?.model?.display_name;
        if (typeof name !== 'string' || !name || typeof l.percent !== 'number')
            continue;
        out.push({
            name,
            pct: l.percent,
            resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
        });
    }
    return out;
}

/**
 * @param {unknown} d raw API JSON
 * @returns {object|null} {fiveHour, sevenDay, spend, scoped}
 */
export function normalizeUsage(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d))
        return null;
    return {
        fiveHour: window(d.five_hour),
        sevenDay: window(d.seven_day),
        spend: spendOf(d),
        scoped: scopedOf(d),
    };
}

function estimateWindow(w, nowMs) {
    if (!w)
        return w;
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (Number.isFinite(t) && t <= nowMs)
        return {...w, pct: 0, estimated: true, resetsAt: null};
    return {...w, estimated: false};
}

/**
 * A window whose reset time already passed is shown at 0 % (estimated) instead
 * of spending a request.
 */
export function withEstimates(usage, nowMs) {
    if (!usage)
        return usage;
    return {
        fiveHour: estimateWindow(usage.fiveHour, nowMs),
        sevenDay: estimateWindow(usage.sevenDay, nowMs),
        spend: usage.spend ?? null,
        scoped: (usage.scoped ?? []).map(s => estimateWindow(s, nowMs)),
    };
}

/** Headroom of the binding window: 100 - max(5h, 7d). null if unknown. */
export function headroom(usage) {
    const pcts = [usage?.fiveHour?.pct, usage?.sevenDay?.pct].filter(p => typeof p === 'number');
    return pcts.length ? 100 - Math.max(...pcts) : null;
}
