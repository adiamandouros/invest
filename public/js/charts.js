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
const roundEuros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

// Lines (value over time) or stacked bars (income) in euros
function inEuros(canvas, data, line) {
    return new Chart(canvas, {
        type: line ? 'line' : 'bar',
        data: {
            labels: data.labels,
            datasets: data.series.map((s, i) => ({
                label: s.name, data: s.values, backgroundColor: COLOURS[i], borderColor: COLOURS[i],
                // The second line (money put in) dashed, so the two differ by more than colour
                borderDash: line && i > 0 ? [6, 4] : [], pointRadius: 0, pointHitRadius: 8, borderWidth: 2, stepped: line && i > 0,
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

for (const canvas of document.querySelectorAll('canvas[data-chart]')) {
    const source = document.getElementById(canvas.dataset.chart);
    if (!Chart || !source) continue;
    const data = JSON.parse(source.textContent);
    if (data.type === 'doughnut') doughnut(canvas, data);
    else if (data.type === 'stacked') stacked(canvas, data);
    else if (data.type === 'line' || data.type === 'bars') inEuros(canvas, data, data.type === 'line');
}
