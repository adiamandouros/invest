// Draws the report charts with Chart.js (loaded before this as a UMD
// script). Each <canvas data-chart="id"> reads its figures from the
// <script type="application/json" id="id">; the table next to it has the same.

const Chart = globalThis.Chart;
// Distinct on the dark background (3:1 or more against #0f1117), in this order
const COLOURS = ['#6ea8fe', '#75b798', '#ffda6a', '#ea868f', '#a98eda', '#6edff6', '#feb272'];
const OTHER = '#8c95a0';
const TEXT = '#dee2e6';
const GRID = 'rgba(222, 226, 230, 0.15)';
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const colour = (name, i) => (name === 'Not in a group' ? OTHER : COLOURS[i % COLOURS.length]);
const percentLabel = value => `${Number(value).toFixed(1)}%`;
const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });
const euroLabel = value => euros.format(value).replace('-', '−');
// Axis labels: whole euros, with cents only when the steps are smaller than a euro
const roundEuros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Lines (value over time) or stacked bars (income) in euros
function inEuros(canvas, data, line) {
    return new Chart(canvas, {
        type: line ? 'line' : 'bar',
        data: {
            labels: data.labels,
            datasets: data.series.map((s, i) => ({
                label: s.name, data: s.values, backgroundColor: COLOURS[i], borderColor: COLOURS[i],
                // Lines differ by more than colour: money put in dashed and stepped, a benchmark dotted
                borderDash: line && i === 1 ? [6, 4] : line && i > 1 ? [2, 3] : [], pointRadius: 0, pointHitRadius: 8, borderWidth: 2, stepped: line && i === 1,
            })),
        },
        options: {
            animation: still ? false : undefined,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { stacked: !line, ticks: { color: TEXT, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: GRID } },
                y: { stacked: !line, beginAtZero: true, ticks: { color: TEXT, callback: value => roundEuros.format(value) }, grid: { color: GRID } },
            },
            plugins: {
                legend: { position: 'bottom', labels: { color: TEXT } },
                tooltip: { callbacks: { label: item => `${item.dataset.label}: ${euroLabel(item.raw)}` } },
            },
        },
    });
}

function doughnut(canvas, data) {
    const total = data.values.reduce((sum, v) => sum + (v ?? 0), 0);
    return new Chart(canvas, {
        type: 'doughnut',
        data: {
            labels: data.labels,
            datasets: [{ data: data.values, backgroundColor: data.labels.map(colour), borderColor: '#0f1117', borderWidth: 2 }],
        },
        options: {
            animation: still ? false : undefined,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: TEXT } },
                tooltip: {
                    callbacks: {
                        label: item => {
                            const share = total ? (item.raw / total) * 100 : 0;
                            const target = data.targets[item.dataIndex];
                            return `${item.label}: ${percentLabel(share)}${target === null ? '' : ` (target ${percentLabel(target)})`}`;
                        },
                    },
                },
            },
        },
    });
}

function stacked(canvas, data) {
    return new Chart(canvas, {
        type: 'bar',
        data: {
            labels: data.labels,
            datasets: data.series.map((s, i) => ({ label: s.name, data: s.values, backgroundColor: colour(s.name, i) })),
        },
        options: {
            animation: still ? false : undefined,
            maintainAspectRatio: false,
            scales: {
                x: { stacked: true, ticks: { color: TEXT }, grid: { color: GRID } },
                y: { stacked: true, max: 100, ticks: { color: TEXT, callback: percentLabel }, grid: { color: GRID } },
            },
            plugins: {
                legend: { position: 'bottom', labels: { color: TEXT } },
                tooltip: { callbacks: { label: item => `${item.dataset.label}: ${percentLabel(item.raw)}` } },
            },
        },
    });
}

// One holding's price: the closes, buys (triangles up) and sales (triangles
// down) on the nearest trading day, and the average cost a unit as a dashed step
function price(canvas, data) {
    const money = new Intl.NumberFormat('en-IE', { style: 'currency', currency: data.currency });
    const show = value => money.format(value).replace('-', '−');
    // The index of the last close on or before a day (or the first)
    const indexOf = date => {
        let at = 0;
        data.dates.forEach((d, i) => { if (d <= date) at = i; });
        return at;
    };
    const marks = (list, verb) => {
        const points = data.dates.map(() => null);
        const notes = {};
        for (const m of list) {
            const i = indexOf(m.date);
            points[i] = m.price ?? data.closes[i];
            notes[i] = [...(notes[i] ?? []), `${verb} ${m.units} at ${m.price === null ? '?' : show(m.price)} on ${m.date}`];
        }
        return { points, notes };
    };
    const buys = marks(data.buys, 'Bought');
    const sells = marks(data.sells, 'Sold');
    const averages = data.dates.map(d => {
        const last = data.averages.filter(a => a.date <= d).at(-1);
        return last && last.value > 0 ? last.value : null;
    });
    const datasets = [
        { label: 'Close', data: data.closes, borderColor: COLOURS[0], backgroundColor: COLOURS[0], pointRadius: 0, pointHitRadius: 4, borderWidth: 2 },
        ...(data.averages.length ? [{ label: 'Your average cost', data: averages, borderColor: COLOURS[2], backgroundColor: COLOURS[2], borderDash: [6, 4], stepped: true, pointRadius: 0, borderWidth: 2 }] : []),
        { label: 'Bought', data: buys.points, showLine: false, pointStyle: 'triangle', pointRadius: 7, pointHoverRadius: 9, borderColor: COLOURS[1], backgroundColor: COLOURS[1] },
        { label: 'Sold', data: sells.points, showLine: false, pointStyle: 'triangle', rotation: 180, pointRadius: 7, pointHoverRadius: 9, borderColor: COLOURS[3], backgroundColor: COLOURS[3] },
    ];
    return new Chart(canvas, {
        type: 'line',
        data: { labels: data.dates, datasets },
        options: {
            animation: still ? false : undefined,
            maintainAspectRatio: false,
            spanGaps: true,
            interaction: { mode: 'nearest', intersect: false },
            scales: {
                x: { ticks: { color: TEXT, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { color: GRID } },
                y: { ticks: { color: TEXT, callback: value => show(value) }, grid: { color: GRID } },
            },
            plugins: {
                legend: { position: 'bottom', labels: { color: TEXT, usePointStyle: true } },
                tooltip: {
                    callbacks: {
                        label: item => {
                            if (item.dataset.label === 'Bought') return buys.notes[item.dataIndex];
                            if (item.dataset.label === 'Sold') return sells.notes[item.dataIndex];
                            return `${item.dataset.label}: ${show(item.raw)}`;
                        },
                    },
                },
            },
        },
    });
}

for (const canvas of document.querySelectorAll('canvas[data-chart]')) {
    const source = document.getElementById(canvas.dataset.chart);
    if (!Chart || !source) continue;
    const data = JSON.parse(source.textContent);
    if (data.type === 'doughnut') doughnut(canvas, data);
    else if (data.type === 'stacked') stacked(canvas, data);
    else if (data.type === 'line' || data.type === 'bars') inEuros(canvas, data, data.type === 'line');
    else if (data.type === 'price') price(canvas, data);
}
