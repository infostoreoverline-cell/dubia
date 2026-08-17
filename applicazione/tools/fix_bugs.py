import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add mortality event listener
# We can just put it at the top of document.addEventListener('DOMContentLoaded', ...)
old_dom = "document.addEventListener('DOMContentLoaded', () => {"
new_dom = "document.addEventListener('DOMContentLoaded', () => {\n    const inputMortality = document.getElementById('inputMortality');\n    if (inputMortality) {\n        inputMortality.addEventListener('change', (e) => {\n            appState.params.mortalityRate = parseFloat(e.target.value) || 1.5;\n            saveParams(appState.params);\n            updateUI();\n        });\n    }\n"
content = content.replace(old_dom, new_dom)

# 2. Fix the Table Regression
old_table_row = """        row.innerHTML = `
            <td>${m.date}</td>
            <td>${m.total_weight.toFixed(1)}</td>
            <td>${foodDisplay}</td>
            <td>${fcrDisplay}</td>
            <td style="color: ${m.health_index < 75 ? 'var(--alert-red)' : 'var(--accent-green)'}">
                ${m.health_index.toFixed(1)}%
            </td>
            <td style="max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${m.notes || ''}">
                ${m.notes || '-'}
            </td>
        `;"""

new_table_row = """        const isNewBlood = m.is_new_blood ? '🩸 ' : '';
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
        `;
        if (m.is_new_blood) row.style.backgroundColor = 'rgba(155, 89, 182, 0.1)';
        """
content = content.replace(old_table_row, new_table_row)

# 3. Fix Chart Tooltip issue (Duplicate key in options.plugins.tooltip)
# Wait, let's see how healthChart is defined.
# I'll manually replace the healthChart options using regex if possible.

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
