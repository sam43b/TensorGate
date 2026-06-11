// Context options mapping - will be set via window context from template
const contextOptions = window.contextOptions || {};
const kv_cache_options = window.kv_cache_options || {};
let llmRunning = false;
let embeddingRunning = false;
let rerankerRunning = false;
let customAppsRunning = {};
let llmLogInterval;
let embLogInterval;
let rerankerLogInterval;
let customAppLogIntervals = {};
let statsInterval;
let currentCustomAppId = null;
let timedProgress = [];
let processingStartTime = null;

// ==================== SETTINGS PERSISTENCE ====================
const SAVED_SETTINGS_KEY = 'ui_settings';

async function saveSettings(settings) {
    try {
        await fetch('/settings/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
    } catch (error) {
        console.error('Error saving settings:', error);
    }
}

async function loadSettings() {
    try {
        const response = await fetch('/settings/load');
        return await response.json();
    } catch (error) {
        console.error('Error loading settings:', error);
        return {};
    }
}

// Collect all form fields that should be persisted
function collectSettings() {
    const settings = {};
    const formFields = [
        'model', 'preset_mode', 'context', 'threads', 'ngl', 'port', 'host', 'sm', 'np',
        'cache_type_k', 'cache_type_v', 'swa-full', 'vision-off', 'flash-attn', 'thinking-off',
        'embedding_model', 'embedding_port', 'embedding_host', 'embedding_threads', 'pooling', 'ubatch_size', 'embedding_ngl',
        'reranker_model', 'reranker_port', 'reranker_host', 'reranker_threads'
    ];

    for (const id of formFields) {
        const el = document.getElementById(id);
        if (!el) continue;

        if (el.type === 'checkbox') {
            settings[id] = el.checked;
        } else {
            settings[id] = el.value;
        }
    }

    // Theme is handled separately via initTheme
    return settings;
}

// Restore saved settings to form fields
function restoreSettings(settings) {
    if (!settings || typeof settings !== 'object') return;

    const checkboxes = ['swa-full', 'vision-off', 'flash-attn', 'thinking-off'];
    for (const [key, value] of Object.entries(settings)) {
        const el = document.getElementById(key);
        if (!el) continue;

        if (checkboxes.includes(key)) {
            el.checked = value;
        } else {
            el.value = value;
        }
    }

    // Update display elements
    const contextEl = document.getElementById('context');
    if (contextEl && contextOptions[contextEl.value]) {
        document.getElementById('context-display').textContent = contextOptions[contextEl.value] + ' tokens';
    }
    const cacheK = document.getElementById('cache_type_k');
    if (cacheK) {
        document.getElementById('cache-type-display').textContent = cacheK.value + ' ';
    }

    updateContextDisplay();
}

// Auto-save on any form input change
function setupAutoSave() {
    // Save on input/checkbox/select changes with debounce
    const inputs = document.querySelectorAll('#llmForm input, #llmForm select, #llmForm textarea, ' +
        '#embeddingForm input, #embeddingForm select, #embeddingForm textarea, ' +
        '#rerankerForm input, #rerankerForm select, #rerankerForm textarea');

    let saveTimeout = null;
    inputs.forEach(input => {
        input.addEventListener('input', () => {
            if (saveTimeout) clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                saveSettings(collectSettings());
            }, 300);
        });
        // Also handle checkbox changes
        if (input.type === 'checkbox') {
            input.addEventListener('change', () => {
                if (saveTimeout) clearTimeout(saveTimeout);
                saveTimeout = setTimeout(() => {
                    saveSettings(collectSettings());
                }, 300);
            });
        }
    });
}

// Add Clear Settings button to UI on load
function addClearSettingsButton() {
    const llmForm = document.getElementById('llmForm');
    if (!llmForm) return;

    const btnGroup = llmForm.querySelector('.btn-group');
    if (!btnGroup) return;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-secondary btn-sm';
    clearBtn.id = 'clearSettingsBtn';
    clearBtn.textContent = '🗑️ Clear Settings';
    clearBtn.style.marginLeft = 'auto';
    clearBtn.onclick = async () => {
        if (confirm('Clear all saved settings?')) {
            await fetch('/settings/clear', { method: 'POST' });
            showMessage('Settings cleared. Reload the page to reset.', 'success');
        }
    };

    btnGroup.appendChild(clearBtn);
}
let presetConfigs = {};

// Load presets from server
async function loadPresetConfigs() {
    try {
        const response = await fetch('/presets');
        presetConfigs = await response.json();
        // Apply default preset on load
        if (presetConfigs['default']) {
            applyPresetMode();
        }
    } catch (error) {
        console.error('Error loading presets:', error);
        // Fallback to hardcoded defaults if file fails
        presetConfigs = {
            default: {
                temperature: 0.8, top_p: 0.95, top_k: 40, min_p: 0.0,
                presence_penalty: 0.0, repetition_penalty: 1.0,
                description: '⛩️ Default for general tasks • temp=0.8 • top_p=0.95'
            }
        };
    }
}

function applyPresetMode() {
    const preset = document.getElementById('preset_mode').value;
    const config = presetConfigs[preset];
    if (!config) return;

    document.getElementById('temperature').value = config.temperature;
    document.getElementById('top_p').value = config.top_p;
    document.getElementById('top_k').value = config.top_k;
    document.getElementById('min_p').value = config.min_p;
    document.getElementById('presence_penalty').value = config.presence_penalty;
    document.getElementById('repetition_penalty').value = config.repetition_penalty;
    document.getElementById('preset-description').textContent = config.description;
}

// Update DOMContentLoaded to load presets
document.addEventListener('DOMContentLoaded', function() {
    initTheme();
    loadPresetConfigs(); // Load presets from server
    checkStatus();
    refreshStats();
    // ... rest of initialization
});

// Theme Management
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeButton(savedTheme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateThemeButton(newTheme);
}

function updateThemeButton(theme) {
    const icon = document.getElementById('themeIcon');
    const text = document.getElementById('themeText');
    if (theme === 'dark') {
        icon.textContent = '☀️';
        text.textContent = 'Light Mode';
    } else {
        icon.textContent = '🌙';
        text.textContent = 'Dark Mode';
    }
}

// Tab Management
function switchTab(tab, e) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(tab + '-tab').classList.add('active');

    if (tab === 'custom') {
        loadCustomApps();
    }
    if (tab === 'dashboard') {
        loadDashboard();
    }
    if (tab === 'settings') {
        loadSettingsTab();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', async function() {
    initTheme();
    checkStatus();
    refreshStats();

    // Load and restore saved settings
    const savedSettings = await loadSettings();
    if (Object.keys(savedSettings).length > 0) {
        restoreSettings(savedSettings);
    }

    updateContextDisplay();

    setInterval(checkStatus, 5000);
    setInterval(refreshStats, 2000);

    // Setup auto-save for form inputs
    setupAutoSave();

    // Setup custom apps form
    document.getElementById('addCustomAppForm').addEventListener('submit', handleAddCustomApp);

    // Setup custom app log controls
    document.getElementById('clearCustomAppLogs').addEventListener('click', () => {
        document.getElementById('custom-app-logs').innerHTML = '<div class="log-entry system"><span class="timestamp">--:--:--</span> <span class="content">Logs cleared...</span></div>';
    });

    document.getElementById('autoScrollCustomApp').addEventListener('click', function() {
        toggleAutoScroll(this);
    });

    // Add Clear Settings button
    addClearSettingsButton();
});

function updateContextDisplay() {
    const contextEl = document.getElementById('context');
    const contextSize = contextOptions[contextEl.value] || 0;
    let display = '--';
    if (contextSize > 0) {
        if (contextSize >= 1024) {
            display = (contextSize / 1024).toFixed(0) + 'k';
        } else {
            display = contextSize.toString();
        }
    }
    document.getElementById('cf-context').textContent = display;
}

// Context selection
function selectContext(key) {
    document.querySelectorAll('.context-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`.context-btn[data-value="${key}"]`).classList.add('active');
    document.getElementById('context').value = key;
    document.getElementById('context-display').textContent = contextOptions[key] + ' tokens';
    updateContextDisplay();
}

function selectCacheType(value) {
    document.querySelectorAll('#cache-type-container .context-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`#cache-type-container .context-btn[data-value="${value}"]`).classList.add('active');
    document.getElementById('cache_type_k').value = value;
    document.getElementById('cache_type_v').value = value;
    document.getElementById('cache-type-display').textContent = value;
}

// Model selection handlers
document.getElementById('model').addEventListener('change', function() {
    const selected = this.options[this.selectedIndex];
    const container = document.getElementById('model-badge-container');
    if (selected.dataset.vision === 'true') {
        container.innerHTML = '<span class="model-badge vision">👁 Vision Model</span>';
    } else if (this.value) {
        container.innerHTML = '<span class="model-badge text">📝 Text Model</span>';
    } else {
        container.innerHTML = '';
    }
});

document.getElementById('embedding_model').addEventListener('change', function() {
    const container = document.getElementById('embedding-badge-container');
    if (this.value) {
        container.innerHTML = '<span class="model-badge embedding">🔤 Embedding Model</span>';
    } else {
        container.innerHTML = '';
    }
});

document.getElementById('reranker_model').addEventListener('change', function() {
    const container = document.getElementById('reranker-badge-container');
    if (this.value) {
        container.innerHTML = '<span class="model-badge reranker">🔍 Reranker Model</span>';
    } else {
        container.innerHTML = '';
    }
});

// LLM Form submission
document.getElementById('llmForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const modelPath = document.getElementById('model').value;
    if (!modelPath) {
        showMessage('Please select a model', 'error');
        return;
    }

    const formData = new FormData(event.target);

    try {
        setLoading('startBtn', true);

        let response = await fetch('/start', {
            method: 'POST',
            body: formData
        });

        let result = await response.json();

        if (result.success || response.ok) {
            showMessage(result.status || 'LLM started successfully', 'success');
            llmRunning = true;
            updateLlmStatusUI();
            startLlmLogRefresh();
        } else {
            showMessage(result.status || 'Failed to start LLM', 'error');
        }
    } catch (error) {
        showMessage('Error starting LLM: ' + error.message, 'error');
    } finally {
        setLoading('startBtn', false);
    }
});

// LLM Stop button
document.getElementById('stopBtn').addEventListener('click', async () => {
    try {
        setLoading('stopBtn', true);

        let response = await fetch('/stop', { method: 'POST' });
        let result = await response.json();

        if (result.success || response.ok) {
            showMessage(result.status || 'LLM stopped successfully', 'success');
            llmRunning = false;
            updateLlmStatusUI();
            stopLlmLogRefresh();
        } else {
            showMessage(result.status || 'Failed to stop LLM', 'error');
        }
    } catch (error) {
        showMessage('Error stopping LLM: ' + error.message, 'error');
    } finally {
        setLoading('stopBtn', false);
    }
});

// Embedding Form submission
document.getElementById('embeddingForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const modelPath = document.getElementById('embedding_model').value;
    if (!modelPath) {
        showMessage('Please select an embedding model', 'error');
        return;
    }

    const formData = new FormData(event.target);

    try {
        setLoading('startEmbBtn', true);

        let response = await fetch('/embedding/start', {
            method: 'POST',
            body: formData
        });

        let result = await response.json();

        if (result.success || response.ok) {
            showMessage(result.status || 'Embedding model started successfully', 'success');
            embeddingRunning = true;
            updateEmbStatusUI();
            startEmbLogRefresh();
        } else {
            showMessage(result.status || 'Failed to start embedding model', 'error');
        }
    } catch (error) {
        showMessage('Error starting embedding model: ' + error.message, 'error');
    } finally {
        setLoading('startEmbBtn', false);
    }
});

// Embedding Stop button
document.getElementById('stopEmbBtn').addEventListener('click', async () => {
    try {
        setLoading('stopEmbBtn', true);

        let response = await fetch('/embedding/stop', { method: 'POST' });
        let result = await response.json();

        if (result.success || response.ok) {
            showMessage(result.status || 'Embedding model stopped successfully', 'success');
            embeddingRunning = false;
            updateEmbStatusUI();
            stopEmbLogRefresh();
        } else {
            showMessage(result.status || 'Failed to stop embedding model', 'error');
        }
    } catch (error) {
        showMessage('Error stopping embedding model: ' + error.message, 'error');
    } finally {
        setLoading('stopEmbBtn', false);
    }
});

// Reranker Form submission
document.getElementById('rerankerForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    const modelPath = document.getElementById('reranker_model').value;
    if (!modelPath) {
        showMessage('Please select a reranker model', 'error');
        return;
    }

    const formData = new FormData(event.target);

    try {
        setLoading('startRerankerBtn', true);

        let response = await fetch('/reranker/start', {
            method: 'POST',
            body: formData
        });

        let result = await response.json();

        if (result.success || response.ok) {
            showMessage(result.status || 'Reranker model started successfully', 'success');
            rerankerRunning = true;
            updateRerankerStatusUI();
            startRerankerLogRefresh();
        } else {
            showMessage(result.status || 'Failed to start reranker model', 'error');
        }
    } catch (error) {
        showMessage('Error starting reranker model: ' + error.message, 'error');
    } finally {
        setLoading('startRerankerBtn', false);
    }
});

// Reranker Stop button
document.getElementById('stopRerankerBtn').addEventListener('click', async () => {
    try {
        setLoading('stopRerankerBtn', true);

        let response = await fetch('/reranker/stop', { method: 'POST' });
        let result = await response.json();

        if (result.success || response.ok) {
            showMessage(result.status || 'Reranker model stopped successfully', 'success');
            rerankerRunning = false;
            updateRerankerStatusUI();
            stopRerankerLogRefresh();
        } else {
            showMessage(result.status || 'Failed to stop reranker model', 'error');
        }
    } catch (error) {
        showMessage('Error stopping reranker model: ' + error.message, 'error');
    } finally {
        setLoading('stopRerankerBtn', false);
    }
});

// Check server status
async function checkStatus() {
    try {
        let response = await fetch('/status');
        let result = await response.json();

        llmRunning = result.llm_running;
        embeddingRunning = result.embedding_running;
        rerankerRunning = result.reranker_running;

        // Update custom apps status
        if (result.custom_apps) {
            Object.assign(customAppsRunning, result.custom_apps);
            updateCustomAppsUI();
        }

        updateLlmStatusUI();
        updateEmbStatusUI();
        updateRerankerStatusUI();

        if (llmRunning) startLlmLogRefresh();
        if (embeddingRunning) startEmbLogRefresh();
        if (rerankerRunning) startRerankerLogRefresh();
    } catch (error) {
        console.error('Error checking status:', error);
    }
}

// Update LLM Status UI
function updateLlmStatusUI() {
    const statusText = document.getElementById('llmStatus');
    const statusDot = document.getElementById('llmStatusDot');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');

    if (llmRunning) {
        statusText.innerText = 'LLM Model is running';
        statusText.className = 'status-text running';
        statusDot.className = 'status-indicator running';
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } else {
        statusText.innerText = 'LLM Model is stopped';
        statusText.className = 'status-text stopped';
        statusDot.className = 'status-indicator stopped';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
}

// Update Embedding Status UI
function updateEmbStatusUI() {
    const statusText = document.getElementById('embStatus');
    const statusDot = document.getElementById('embStatusDot');
    const startBtn = document.getElementById('startEmbBtn');
    const stopBtn = document.getElementById('stopEmbBtn');

    if (embeddingRunning) {
        statusText.innerText = 'Embedding Model is running';
        statusText.className = 'status-text running';
        statusDot.className = 'status-indicator running';
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } else {
        statusText.innerText = 'Embedding Model is stopped';
        statusText.className = 'status-text stopped';
        statusDot.className = 'status-indicator stopped';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
}

// Update Reranker Status UI
function updateRerankerStatusUI() {
    const statusText = document.getElementById('rerankerStatus');
    const statusDot = document.getElementById('rerankerStatusDot');
    const startBtn = document.getElementById('startRerankerBtn');
    const stopBtn = document.getElementById('stopRerankerBtn');

    if (rerankerRunning) {
        statusText.innerText = 'Reranker Model is running';
        statusText.className = 'status-text running';
        statusDot.className = 'status-indicator running';
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } else {
        statusText.innerText = 'Reranker Model is stopped';
        statusText.className = 'status-text stopped';
        statusDot.className = 'status-indicator stopped';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
}

// Show message
function showMessage(text, type) {
    const msgEl = document.getElementById('message');
    msgEl.innerText = text;
    msgEl.className = type;
    msgEl.classList.remove('hidden');

    setTimeout(() => {
        msgEl.classList.add('hidden');
    }, 5000);
}

// Set button loading state
function setLoading(btnId, loading) {
    const btn = document.getElementById(btnId);
    btn.disabled = loading;
}

// Refresh system stats
async function refreshStats() {
    try {
        let response = await fetch('/system');
        let stats = await response.json();

        let html = '';

        if (stats.cpu && !stats.cpu.error) {
            html += `
                <div class="stat-card">
                    <h3>CPU Usage</h3>
                    <div class="value">${stats.cpu.usage_percent}</div>
                    <div class="subvalue">${stats.cpu.cores} cores @ ${stats.cpu.frequency}</div>
                </div>
            `;
        }

        if (stats.memory && !stats.memory.error) {
            html += `
                <div class="stat-card memory">
                    <h3>Memory Usage</h3>
                    <div class="value">${stats.memory.percent}</div>
                    <div class="subvalue">${stats.memory.used} / ${stats.memory.total}</div>
                </div>
            `;
        }

        if (stats.gpus && stats.gpus.length > 0 && !stats.gpus[0].error) {
            stats.gpus.forEach((gpu, index) => {
                html += `
                    <div class="stat-card gpu">
                        <h3>${gpu.name || 'GPU ' + (index + 1)}</h3>
                        <div class="value">${gpu.usage}</div>
                        <div class="subvalue">${gpu.memory} • ${gpu.temp}</div>
                    </div>
                `;
            });
        }

        if (html === '') {
            html = '<div class="stat-card" style="grid-column: 1/-1;"><div class="value">No stats available</div></div>';
        }

        document.getElementById('systemStats').innerHTML = html;
    } catch (error) {
        console.error('Error fetching stats:', error);
    }
}

// Prompt Processing Progress — always visible, no conditions
async function fetchPromptProgress() {
    try {
        const response = await fetch('/prompt-progress');
        if (!response.ok) return;

        const data = await response.json();
        const now = Date.now();
        const contextEl = document.getElementById('context');
        const contextSize = contextOptions[contextEl.value] || 0;
        const generationState = data.generation_state || 'idle';
        const stateLower = String(generationState).toLowerCase();

        const progress = Math.min(data.progress, 100);
        const ppStatus = document.getElementById('pp-status');
        const ppBar = document.getElementById('pp-bar');
        const ppBarText = document.getElementById('pp-bar-text');
        const ppPercent = document.getElementById('pp-percentage');
        const card = document.getElementById('prompt-progress-card');
        const ppSpeedEl = document.getElementById('pp-speed');
        const genSpeedEl = document.getElementById('gen-speed');

        if (ppBar) ppBar.style.width = progress + '%';
        if (ppBarText) ppBarText.textContent = progress.toFixed(1) + '%';
        if (ppPercent) ppPercent.textContent = progress.toFixed(1) + '%';

        if (stateLower === 'prompt_processing') {
            if (!processingStartTime) {
                processingStartTime = now;
                timedProgress = [];
            }

            if (ppStatus) ppStatus.textContent = 'PP Processing ...';

            const logsElement = document.getElementById('llm-logs');
            const allLogEntries = Array.from(logsElement.querySelectorAll('.log-entry')).reverse();

            const lastTokenLine = allLogEntries.find(el => {
                const content = el.querySelector('.content');
                if (!content) return false;
                const text = content.textContent;
                return text.includes('prompt processing') && text.includes('n_tokens');
            }) || allLogEntries.find(el => {
                const content = el.querySelector('.content');
                if (!content) return false;
                const text = content.textContent;
                return text.includes('n_tokens') && !text.includes('stop processing');
            });

            if (lastTokenLine) {
                const contentText = lastTokenLine.querySelector('.content').textContent;
                const tokenMatch = contentText.match(/n_tokens\s*=\s*(\d+)/);

                const inlineProgressMatch = contentText.match(/progress\s*=\s*([\d.]+)/);
                if (inlineProgressMatch) {
                    const inlineProgress = Math.min(parseFloat(inlineProgressMatch[1]) * 100, 100);
                    if (ppBar) ppBar.style.width = inlineProgress + '%';
                    if (ppBarText) ppBarText.textContent = inlineProgress.toFixed(1) + '%';
                    if (ppPercent) ppPercent.textContent = inlineProgress.toFixed(1) + '%';
                }

                const tpsMatch = contentText.match(/([\d.]+)\s*tokens per second/);
                if (tpsMatch) {
                    if (ppSpeedEl) ppSpeedEl.textContent = parseFloat(tpsMatch[1]).toFixed(0);
                }

                if (tokenMatch) {
                    timedProgress.push({ ts: now, tokens: parseInt(tokenMatch[1]), progress: data.progress });

                    let ppSpeed = 0;
                    if (timedProgress.length > 1) {
                        const speeds = [];
                        for (let i = 1; i < timedProgress.length; i++) {
                            const dt = (timedProgress[i].ts - timedProgress[i-1].ts) / 1000;
                            const dtok = timedProgress[i].tokens - timedProgress[i-1].tokens;
                            if (dt > 0 && dtok > 0) {
                                speeds.push(dtok / dt);
                            }
                        }
                        if (speeds.length > 0) {
                            ppSpeed = speeds.reduce((a,b)=>a+b,0) / speeds.length;
                        }
                    }
                    if (ppSpeedEl && !tpsMatch) {
                        ppSpeedEl.textContent = ppSpeed > 0 ? ppSpeed.toFixed(0) : '--';
                    }

                    const elapsedMs = now - processingStartTime;
                    const elapsedSec = Math.floor(elapsedMs / 1000);
                    const hh = Math.floor(elapsedSec / 3600);
                    const mm = Math.floor((elapsedSec % 3600) / 60);
                    const ss = elapsedSec % 60;
                    let elapsedStr = '';
                    if (hh > 0) elapsedStr += hh + 'h ';
                    if (mm > 0 || hh > 0) elapsedStr += mm + 'm ';
                    elapsedStr += ss + 's';
                    const elapsedEl = document.getElementById('elapsed');
                    if (elapsedEl) elapsedEl.textContent = elapsedStr;

                    const cfPercentage = contextSize > 0 ? Math.min(100, (parseInt(tokenMatch[1]) / contextSize) * 100) : 0;
                    const cfBar = document.getElementById('cf-bar');
                    cfBar.style.width = cfPercentage + '%';
                    cfBar.classList.remove('warn', 'danger');
                    if (cfPercentage > 90) {
                        cfBar.classList.add('danger');
                    } else if (cfPercentage > 75) {
                        cfBar.classList.add('warn');
                    }
                    document.getElementById('cf-bar-text').textContent = cfPercentage.toFixed(1) + '%';
                    let cfContextDisplay = '--';
                    if (contextSize > 0) {
                        if (contextSize >= 1024) {
                            cfContextDisplay = (contextSize / 1024).toFixed(0) + 'k';
                        } else {
                            cfContextDisplay = contextSize.toString();
                        }
                    }
                    document.getElementById('cf-context').textContent = cfContextDisplay;
                }
            }

            if (card) card.classList.add('prompt-progress');
        } else if (stateLower === 'generating') {
            if (ppStatus) ppStatus.textContent = 'Generating ...';

            const logsElement = document.getElementById('llm-logs');
            const allLogEntries = Array.from(logsElement.querySelectorAll('.log-entry')).reverse();

            const lastTokenLine = allLogEntries.find(el => {
                const content = el.querySelector('.content');
                if (!content) return false;
                const text = content.textContent;
                return text.includes('n_decoded') && text.includes('tg');
            }) || allLogEntries.find(el => {
                const content = el.querySelector('.content');
                if (!content) return false;
                const text = content.textContent;
                return text.includes('eval time') && text.includes('tokens per second');
            });

            if (lastTokenLine) {
                const contentText = lastTokenLine.querySelector('.content').textContent;
                const genTpsMatch = contentText.match(/([\d.]+)\s*t\s*\/\s*s/) || contentText.match(/([\d.]+)\s*tokens per second/);
                if (genTpsMatch && genSpeedEl) {
                    genSpeedEl.textContent = parseFloat(genTpsMatch[1]).toFixed(0);
                }
            }

            if (card) card.classList.add('prompt-progress');
        } else {
            processingStartTime = null;
            timedProgress = [];
            if (ppStatus) ppStatus.textContent = 'Idle ...';
            if (ppSpeedEl) ppSpeedEl.textContent = '--';
            if (genSpeedEl) genSpeedEl.textContent = '--';
            const elapsedEl = document.getElementById('elapsed');
            if (elapsedEl) elapsedEl.textContent = '--';

             const cfBarReset = document.getElementById('cf-bar');
            cfBarReset.style.width = '0%';
            cfBarReset.classList.remove('warn', 'danger');
            document.getElementById('cf-bar-text').textContent = '0%';
            let cfContextReset = '--';
            if (contextSize > 0) {
                if (contextSize >= 1024) {
                    cfContextReset = (contextSize / 1024).toFixed(0) + 'k';
                } else {
                    cfContextReset = contextSize.toString();
                }
            }
            document.getElementById('cf-context').textContent = cfContextReset;

            if (card) card.classList.remove('prompt-progress');
        }
    } catch (error) {
        console.error('Error fetching prompt progress:', error);
    }
}

// Start polling prompt progress when LLM starts
function startPromptProgressPolling() {
    if (!window.promptProgressInterval) {
        window.promptProgressInterval = setInterval(fetchPromptProgress, 1000);
    }
}

// Stop polling when LLM stops
function stopPromptProgressPolling() {
    if (window.promptProgressInterval) {
        clearInterval(window.promptProgressInterval);
        window.promptProgressInterval = null;
    }
}

// Fetch LLM logs
async function fetchLlmLogs() {
    try {
        const response = await fetch('/logs');
        if (!response.ok) return;

        const logs = await response.json();
        const logsElement = document.getElementById('llm-logs');

        if (logs.reset) {
            logsElement.innerHTML = '';
        }

        if (logs.entries && logs.entries.length > 0) {
            logs.entries.forEach(entry => {
                appendLogEntry(logsElement, entry.text, 'llm');
            });

            autoScroll('llmLogsContainer', 'autoScrollLlm');
        }
    } catch (error) {
        console.error('Error fetching LLM logs:', error);
    }
}

// Fetch Embedding logs
async function fetchEmbLogs() {
    try {
        const response = await fetch('/embedding/logs');
        if (!response.ok) return;

        const logs = await response.json();
        const logsElement = document.getElementById('emb-logs');

        if (logs.reset) {
            logsElement.innerHTML = '';
        }

        if (logs.entries && logs.entries.length > 0) {
            logs.entries.forEach(entry => {
                appendLogEntry(logsElement, entry.text, 'emb');
            });

            autoScroll('embLogsContainer', 'autoScrollEmb');
        }
    } catch (error) {
        console.error('Error fetching embedding logs:', error);
    }
}

function appendLogEntry(container, text, prefix) {
    const logLine = document.createElement('div');
    let logClass = 'system';

    const lowerText = text.toLowerCase();
    if (lowerText.includes('error') || lowerText.includes('err:') || lowerText.includes('critical')) {
        logClass = 'error';
    } else if (lowerText.includes('warn') || lowerText.includes('warning')) {
        logClass = 'warning';
    } else if (lowerText.includes('token') || lowerText.includes('out:')) {
        logClass = 'token';
    } else if (lowerText.includes('starting') || lowerText.includes('success') || lowerText.includes('loaded')) {
        logClass = 'success';
    } else if (lowerText.includes('system') || lowerText.includes('info')) {
        logClass = 'info';
    }

    const readyTrigger = 'server is listening on http://0.0.0.0:8080';
    if (lowerText.includes(readyTrigger)) {
        logClass = 'ready';
    }

    let timestamp = '--:--:--';
    let content = text;
    if (logClass === 'ready') {
        timestamp = new Date().toLocaleTimeString();
        content = readyTrigger;
    } else {
        const timeMatch = text.match(/\[(.*?)\]/);
        if (timeMatch) {
            timestamp = timeMatch[1].split(' ')[1] || timeMatch[1];
            content = text.replace(/\[(.*?)\]\s*/, '');
        }
    }

    logLine.className = `log-entry ${logClass} ${prefix}`;
    if (logClass === 'ready') {
        logLine.textContent = `[${prefix.toUpperCase()}] ${content}`;
    } else {
        logLine.innerHTML = `
            <span class="timestamp">${timestamp}</span>
            <span class="prefix">[${prefix.toUpperCase()}]</span>
            <span class="content">${escapeHtml(content)}</span>
        `;
    }
    container.appendChild(logLine);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function autoScroll(containerId, btnId) {
    const container = document.getElementById(containerId);
    const btn = document.getElementById(btnId);
    if (btn.getAttribute('data-enabled') === 'true') {
        container.scrollTop = container.scrollHeight;
    }
}

// Log controls
document.getElementById('clearLlmLogs').addEventListener('click', () => {
    document.getElementById('llm-logs').innerHTML = '<div class="log-entry system"><span class="timestamp">--:--:--</span> <span class="content">Logs cleared. Waiting for new entries...</span></div>';
});

document.getElementById('clearEmbLogs').addEventListener('click', () => {
    document.getElementById('emb-logs').innerHTML = '<div class="log-entry system"><span class="timestamp">--:--:--</span> <span class="content">Logs cleared. Waiting for new entries...</span></div>';
});

document.getElementById('autoScrollLlm').addEventListener('click', function() {
    toggleAutoScroll(this);
});

document.getElementById('autoScrollEmb').addEventListener('click', function() {
    toggleAutoScroll(this);
});

function toggleAutoScroll(btn) {
    const currentState = btn.getAttribute('data-enabled') === 'true';
    const newState = !currentState;
    btn.setAttribute('data-enabled', newState);
    btn.innerHTML = newState ? '⬇️ Auto-scroll: ON' : '⬇️ Auto-scroll: OFF';
    btn.style.opacity = newState ? '1' : '0.7';
}

// Log refresh intervals
function startLlmLogRefresh() {
    if (!llmLogInterval) {
        llmLogInterval = setInterval(fetchLlmLogs, 1000);
    }
    startPromptProgressPolling();
}

function stopLlmLogRefresh() {
    if (llmLogInterval) {
        clearInterval(llmLogInterval);
        llmLogInterval = null;
    }
    stopPromptProgressPolling();
}

function startEmbLogRefresh() {
    if (!embLogInterval) {
        embLogInterval = setInterval(fetchEmbLogs, 1000);
    }
}

function stopEmbLogRefresh() {
    if (embLogInterval) {
        clearInterval(embLogInterval);
        embLogInterval = null;
    }
}

// Fetch Reranker logs
async function fetchRerankerLogs() {
    try {
        const response = await fetch('/reranker/logs');
        if (!response.ok) return;

        const logs = await response.json();
        const logsElement = document.getElementById('reranker-logs');

        if (logs.reset) {
            logsElement.innerHTML = '';
        }

        if (logs.entries && logs.entries.length > 0) {
            logs.entries.forEach(entry => {
                appendLogEntry(logsElement, entry.text, 'reranker');
            });

            autoScroll('rerankerLogsContainer', 'autoScrollReranker');
        }
    } catch (error) {
        console.error('Error fetching reranker logs:', error);
    }
}

// Reranker log controls
document.getElementById('clearRerankerLogs').addEventListener('click', () => {
    document.getElementById('reranker-logs').innerHTML = '<div class="log-entry system"><span class="timestamp">--:--:--</span> <span class="content">Logs cleared. Waiting for new entries...</span></div>';
});

document.getElementById('autoScrollReranker').addEventListener('click', function() {
    toggleAutoScroll(this);
});

function startRerankerLogRefresh() {
    if (!rerankerLogInterval) {
        rerankerLogInterval = setInterval(fetchRerankerLogs, 1000);
    }
}

function stopRerankerLogRefresh() {
    if (rerankerLogInterval) {
        clearInterval(rerankerLogInterval);
        rerankerLogInterval = null;
    }
}

// ==================== CUSTOM APPS FUNCTIONS ====================

async function loadCustomApps() {
    try {
        const response = await fetch('/custom-apps');
        const apps = await response.json();
        renderCustomApps(apps);
    } catch (error) {
        console.error('Error loading custom apps:', error);
        document.getElementById('customAppsList').innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">❌</div>
                <p>Error loading applications</p>
            </div>
        `;
    }
}

function renderCustomApps(apps) {
    const container = document.getElementById('customAppsList');

    if (apps.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <p>No custom applications configured</p>
                <p style="font-size: 0.9em; margin-top: 10px;">Add one using the form above</p>
            </div>
        `;
        return;
    }

    container.innerHTML = apps.map(app => `
        <div class="custom-app-card ${app.running ? 'running' : ''}" id="app-card-${app.id}">
            <div class="custom-app-header">
                <div class="custom-app-name">
                    ${app.display_name}
                    <span class="model-badge custom">${app.id}</span>
                    ${app.running ?
                        '<span class="custom-app-status" style="color: var(--accent-success);"><span class="status-indicator running" style="width: 10px; height: 10px;"></span> Running</span>' :
                        '<span class="custom-app-status" style="color: var(--accent-danger);"><span class="status-indicator stopped" style="width: 10px; height: 10px;"></span> Stopped</span>'
                    }
                </div>
            </div>
            <div class="custom-app-path">${app.path}</div>
            <div class="custom-app-actions">
                ${app.running ?
                    `<button class="btn btn-danger btn-sm" onclick="stopCustomApp('${app.id}')" id="stop-${app.id}">
                        <span>⏹ Stop</span>
                    </button>` :
                    `<button class="btn btn-success btn-sm" onclick="startCustomApp('${app.id}')" id="start-${app.id}">
                        <span>▶ Start</span>
                    </button>`
                }
                <button class="btn btn-secondary btn-sm" onclick="viewCustomAppLogs('${app.id}', '${app.display_name}')">
                    <span>📜 Logs</span>
                </button>
                <button class="btn btn-secondary btn-sm" onclick="deleteCustomApp('${app.id}')" style="margin-left: auto;">
                    <span>🗑️ Delete</span>
                </button>
            </div>
        </div>
    `).join('');
}

function updateCustomAppsUI() {
    // Refresh the list to update running states
    loadCustomApps();
}

async function handleAddCustomApp(event) {
    event.preventDefault();

    const name = document.getElementById('custom_app_name').value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const path = document.getElementById('custom_app_path').value.trim();
    const desc = document.getElementById('custom_app_desc').value.trim();

    const formData = new FormData();
    formData.append('name', name);
    formData.append('path', path);
    formData.append('description', desc);

    try {
        const response = await fetch('/custom-apps/save', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            showMessage(result.status, 'success');
            document.getElementById('addCustomAppForm').reset();
            loadCustomApps();
        } else {
            showMessage(result.status, 'error');
        }
    } catch (error) {
        showMessage('Error saving custom app: ' + error.message, 'error');
    }
}

async function startCustomApp(appId) {
    const formData = new FormData();
    formData.append('app_id', appId);

    try {
        const btn = document.getElementById(`start-${appId}`);
        if (btn) btn.disabled = true;

        const response = await fetch('/custom-apps/start', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            showMessage(result.status, 'success');
            customAppsRunning[appId] = true;
            loadCustomApps();
            startCustomAppLogRefresh(appId);
        } else {
            showMessage(result.status, 'error');
            if (btn) btn.disabled = false;
        }
    } catch (error) {
        showMessage('Error starting custom app: ' + error.message, 'error');
    }
}

async function stopCustomApp(appId) {
    const formData = new FormData();
    formData.append('app_id', appId);

    try {
        const btn = document.getElementById(`stop-${appId}`);
        if (btn) btn.disabled = true;

        const response = await fetch('/custom-apps/stop', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            showMessage(result.status, 'success');
            customAppsRunning[appId] = false;
            loadCustomApps();
            stopCustomAppLogRefresh(appId);
        } else {
            showMessage(result.status, 'error');
            if (btn) btn.disabled = false;
        }
    } catch (error) {
        showMessage('Error stopping custom app: ' + error.message, 'error');
    }
}

async function deleteCustomApp(appId) {
    if (!confirm(`Are you sure you want to delete "${appId}"?`)) {
        return;
    }

    const formData = new FormData();
    formData.append('name', appId);

    try {
        const response = await fetch('/custom-apps/delete', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            showMessage(result.status, 'success');
            loadCustomApps();
        } else {
            showMessage(result.status, 'error');
        }
    } catch (error) {
        showMessage('Error deleting custom app: ' + error.message, 'error');
    }
}

function viewCustomAppLogs(appId, appName) {
    currentCustomAppId = appId;
    document.getElementById('customAppLogsTitle').textContent = `Logs: ${appName}`;
    document.getElementById('customAppLogsModal').classList.add('active');

    // Clear previous logs
    document.getElementById('custom-app-logs').innerHTML = '<div class="log-entry system"><span class="timestamp">--:--:--</span> <span class="content">Loading logs...</span></div>';

    // Start fetching logs
    startCustomAppLogRefresh(appId);
}

function closeCustomAppLogs() {
    document.getElementById('customAppLogsModal').classList.remove('active');
    if (currentCustomAppId) {
        stopCustomAppLogRefresh(currentCustomAppId);
        currentCustomAppId = null;
    }
}

async function fetchCustomAppLogs(appId) {
    try {
        const response = await fetch(`/custom-apps/logs?app_id=${appId}`);
        if (!response.ok) return;

        const logs = await response.json();
        const logsElement = document.getElementById('custom-app-logs');

        // Remove loading message if present
        const loadingMsg = logsElement.querySelector('.content');
        if (loadingMsg && loadingMsg.textContent === 'Loading logs...') {
            logsElement.innerHTML = '';
        }

        if (logs.entries && logs.entries.length > 0) {
            logs.entries.forEach(entry => {
                appendLogEntry(logsElement, entry.text, 'custom');
            });

            autoScroll('customAppLogsContainer', 'autoScrollCustomApp');
        }
    } catch (error) {
        console.error('Error fetching custom app logs:', error);
    }
}

function startCustomAppLogRefresh(appId) {
    if (!customAppLogIntervals[appId]) {
        customAppLogIntervals[appId] = setInterval(() => fetchCustomAppLogs(appId), 1000);
    }
}

function stopCustomAppLogRefresh(appId) {
    if (customAppLogIntervals[appId]) {
        clearInterval(customAppLogIntervals[appId]);
        delete customAppLogIntervals[appId];
    }
}

// Close modal on outside click
document.getElementById('customAppLogsModal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeCustomAppLogs();
    }
});

// ==================== SETTINGS TAB FUNCTIONS ====================

let updateLogInterval = null;

async function loadSettingsTab() {
    try {
        const response = await fetch('/settings/env');
        const settings = await response.json();
        renderSettings(settings);
    } catch (error) {
        console.error('Error loading settings:', error);
        document.getElementById('settingsList').innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">❌</div>
                <p>Error loading settings</p>
            </div>
        `;
    }
}

function renderSettings(settings) {
    const container = document.getElementById('settingsList');

    if (settings.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📭</div>
                <p>No settings found. Create a .env file in the project root.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = settings.map(setting => `
        <div class="custom-app-card" id="setting-card-${setting.key}">
            <div class="custom-app-header">
                <div class="custom-app-name">
                    ${setting.key}
                    
                </div>
            </div>
            <div class="custom-app-path">
                <label for="edit-${setting.key}" style="margin-right: 10px;">Value:</label>
                <input type="text" id="edit-${setting.key}" value="${escapeHtml(setting.value)}"
                       style="width: 100%;flex: 1; padding: 5px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); border-radius: 4px;"
                       onchange="enableSettingEdit('${setting.key}')">
            </div>
            <div class="custom-app-actions">
                <button class="btn btn-success btn-sm" onclick="saveSetting('${setting.key}')" id="save-${setting.key}" disabled>
                    <span>💾 Save</span>
                </button>
            </div>
        </div>
    `).join('');
}

function enableSettingEdit(key) {
    const btn = document.getElementById(`save-${key}`);
    if (btn) btn.disabled = false;
}

async function saveSetting(key) {
    const input = document.getElementById(`edit-${key}`);
    if (!input) return;

    const newValue = input.value.trim();
    setLoading('save-' + key, true);

    try {
        const response = await fetch('/settings/env', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: key, value: newValue })
        });

        const result = await response.json();

        if (result.success) {
            showMessage(result.status, 'success');
            const btn = document.getElementById(`save-${key}`);
            if (btn) btn.disabled = true;
            await loadSettingsTab();
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        } else {
            showMessage(result.status, 'error');
            if (btn) btn.disabled = false;
        }
    } catch (error) {
        showMessage('Error saving setting: ' + error.message, 'error');
        const btn = document.getElementById(`save-${key}`);
        if (btn) btn.disabled = false;
    } finally {
        setLoading('save-' + key, false);
    }
}

// ==================== UPDATE BINARIES ====================

async function startUpdateBinaries() {
    const btn = document.getElementById('startUpdateBtn');
    const progressContainer = document.getElementById('updateProgress');
    const progressBar = document.getElementById('updateProgressBar');
    const progressText = document.getElementById('updateProgressText');

    try {
        setLoading('startUpdateBtn', true);
        document.getElementById('update-logs').innerHTML = '<div class="log-entry system"><span class="timestamp">--:--:--</span> <span class="content">Starting update...</span></div>';
        progressContainer.style.display = 'block';
        progressBar.style.width = '0%';
        progressText.textContent = '0%';

        const response = await fetch('/update-binaries/start', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            showMessage(result.status, 'success');
            startUpdateLogRefresh();
        } else {
            showMessage(result.status || 'Failed to start update', 'error');
            progressContainer.style.display = 'none';
        }
    } catch (error) {
        showMessage('Error starting update: ' + error.message, 'error');
        progressContainer.style.display = 'none';
    } finally {
        setLoading('startUpdateBtn', false);
    }
}

async function fetchUpdateLogs() {
    try {
        const response = await fetch('/update-binaries/logs');
        if (!response.ok) return;

        const logs = await response.json();
        const logsElement = document.getElementById('update-logs');

        if (logs.reset) {
            logsElement.innerHTML = '';
        }

        if (logs.entries && logs.entries.length > 0) {
            logs.entries.forEach(entry => {
                appendLogEntry(logsElement, entry.text, 'update');
            });

            autoScroll('updateLogsContainer', 'autoScrollUpdate');
        }
    } catch (error) {
        console.error('Error fetching update logs:', error);
    }
}

async function fetchUpdateStatus() {
    try {
        const response = await fetch('/update-binaries/status');
        if (!response.ok) return;
        const data = await response.json();

        const progressBar = document.getElementById('updateProgressBar');
        const progressText = document.getElementById('updateProgressText');
        const progressContainer = document.getElementById('updateProgress');

        if (progressBar) progressBar.style.width = data.percent + '%';
        if (progressText) progressText.textContent = data.percent + '%';

        if (!data.running && data.percent >= 100) {
            stopUpdateLogRefresh();
            if (progressContainer) progressContainer.style.display = 'none';
        }
    } catch (error) {
        console.error('Error fetching update status:', error);
    }
}

function startUpdateLogRefresh() {
    if (!updateLogInterval) {
        updateLogInterval = setInterval(() => {
            fetchUpdateLogs();
            fetchUpdateStatus();
        }, 500);
    }
}

function stopUpdateLogRefresh() {
    if (updateLogInterval) {
        clearInterval(updateLogInterval);
        updateLogInterval = null;
    }
}

document.getElementById('startUpdateBtn').addEventListener('click', startUpdateBinaries);

document.getElementById('clearUpdateLogs').addEventListener('click', () => {
    document.getElementById('update-logs').innerHTML = '<div class="log-entry system"><span class="timestamp">--:--:--</span> <span class="content">Logs cleared...</span></div>';
});

document.getElementById('autoScrollUpdate').addEventListener('click', function() {
    toggleAutoScroll(this);
});

// ==================== DASHBOARD FUNCTIONALITY ====================

let dashboardLoaded = false;
let dashboardInterval;

async function loadDashboard() {
    if (dashboardLoaded) {
        // Dashboard already loaded, just call the dashboard's function
        if (window.dashboardLoadDashboard) {
            await window.dashboardLoadDashboard();
        }
        return;
    }

    // Load dashboard.js dynamically
    try {
        const script = document.createElement('script');
        script.src = '/static/dashboard.js';
        script.onload = async () => {
            dashboardLoaded = true;
            if (window.dashboardLoadDashboard) {
                await window.dashboardLoadDashboard();
            }
        };
        script.onerror = () => {
            console.error('Failed to load dashboard.js');
            document.getElementById('dashboard-content').innerHTML = `
                <div class="dashboard-loading">
                    <p style="color: var(--accent-danger);">Failed to load dashboard</p>
                </div>
            `;
        };
        document.head.appendChild(script);
    } catch (error) {
        console.error('Error loading dashboard:', error);
        document.getElementById('dashboard-content').innerHTML = `
            <div class="dashboard-loading">
                <p style="color: var(--accent-danger);">Error loading dashboard</p>
            </div>
        `;
    }
}

// Dashboard functions are now loaded lazily from dashboard.js
