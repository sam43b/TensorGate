// dashboard.js - Lazy-loaded dashboard functionality

// Make function available globally
window.dashboardLoadDashboard = async function() {
    // Clear any existing dashboard interval
    if (dashboardInterval) {
        clearInterval(dashboardInterval);
    }

    // Load dashboard immediately
    await refreshDashboard();

    // Set up periodic refresh every 60 seconds
    dashboardInterval = setInterval(refreshDashboard, 60000);
};

async function refreshDashboard() {
    try {
        const dashboardContent = document.getElementById('dashboard-content');
        if (!dashboardContent) return;

        // Show loading state
        dashboardContent.innerHTML = `
            <div class="dashboard-loading">
                <div class="loading-spinner"></div>
                <p>Loading dashboard data...</p>
            </div>
        `;

        // Fetch logs from all sources (using buffer endpoints to avoid consuming logs)
        const [llmLogs, embLogs, rerankerLogs] = await Promise.all([
            fetch('/logs/buffer').then(r => r.json()),
            fetch('/embedding/logs/buffer').then(r => r.json()),
            fetch('/reranker/logs/buffer').then(r => r.json())
        ]);

        // Combine all logs
        const allLogs = [];
        const now = new Date();

        // Process LLM logs
        if (llmLogs.entries) {
            llmLogs.entries.forEach(entry => {
                if (entry.text) {
                    const parsed = parseLogLine(entry.text);
                    if (parsed) {
                        parsed.source = 'LLM';
                        allLogs.push(parsed);
                    }
                }
            });
        }

        // Process embedding logs
        if (embLogs.entries) {
            embLogs.entries.forEach(entry => {
                if (entry.text) {
                    const parsed = parseLogLine(entry.text);
                    if (parsed) {
                        parsed.source = 'EMB';
                        allLogs.push(parsed);
                    }
                }
            });
        }

        // Process reranker logs
        if (rerankerLogs.entries) {
            rerankerLogs.entries.forEach(entry => {
                if (entry.text) {
                    const parsed = parseLogLine(entry.text);
                    if (parsed) {
                        parsed.source = 'RER';
                        allLogs.push(parsed);
                    }
                }
            });
        }

        // Sort logs by time (most recent first)
        allLogs.sort((a, b) => b.timestamp - a.timestamp);

        // Parse logs into dashboard data
        const dashboardData = parseLogsForDashboard(allLogs);

        // Build and display dashboard
        buildDashboard(dashboardData);

    } catch (error) {
        console.error('Error loading dashboard:', error);
        document.getElementById('dashboard-content').innerHTML = `
            <div class="dashboard-loading">
                <p style="color: var(--accent-danger);">Error loading dashboard data</p>
            </div>
        `;
    }
}

function parseLogLine(logText) {
    // Parse log line format: [YYYY-MM-DD HH:MM:SS] PREFIX: message
    const match = logText.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.+?): (.+)$/);
    if (!match) return null;

    const [, timeStr, prefix, rawMessage] = match;
    const timestamp = new Date(timeStr);

    // Clean up the message by removing prefixes like "LLM-ERR:"
    let message = rawMessage.replace(/^LLM-ERR:\s*/, '').replace(/^EMB-ERR:\s*/, '').replace(/^RER-ERR:\s*/, '');

    // Extract source from prefix (LLM-ERR -> LLM, EMB-ERR -> EMB, etc.)
    let source = 'UNK';
    if (prefix.startsWith('LLM')) source = 'LLM';
    else if (prefix.startsWith('EMB')) source = 'EMB';
    else if (prefix.startsWith('RER')) source = 'RER';

    return {
        timestamp,
        time: timeStr.split(' ')[1], // HH:MM:SS
        prefix: source,
        message,
        raw: logText
    };
}

function parseLogsForDashboard(logs) {
    try {
        const tasks = {};
        const taskOrder = [];
        const entries = logs;

        // Process logs similar to claude_llama_monitor.html
        for (const e of entries) {
            const m = e.message;

            // Task start - update_slots format
            const launchM = m.match(/slot update_slots:\s*id\s+(\d+).*?task (\d+).*?n_tokens = (\d+)/);
            if (launchM) {
                const tid = parseInt(launchM[2]);
                if (!tasks[tid]) {
                    tasks[tid] = {
                        id: tid,
                        slotId: parseInt(launchM[1]),
                        startTime: e.time,
                        events: [],
                        source: e.source
                    };
                    taskOrder.push(tid);
                }
                tasks[tid].startTime = e.time;
                // Also capture initial n_tokens
                if (!tasks[tid].reqTokens) {
                    tasks[tid].reqTokens = parseInt(launchM[3]);
                }
            }

            // prompt progress - update_slots format
            const ppM = m.match(/slot update_slots:\s*id\s+\d+.*?task (\d+).*?prompt processing progress.*?n_tokens = (\d+).*?batch\.n_tokens = (\d+).*?progress = ([\d.]+)/);
            if (ppM) {
                const tid = parseInt(ppM[1]);
                if (tasks[tid]) {
                    if (!tasks[tid].batches) tasks[tid].batches = [];
                    tasks[tid].batches.push({
                        time: e.time,
                        n: parseInt(ppM[2]),
                        progress: parseFloat(ppM[4])
                    });
                }
            }

            // prompt done
            const pdM = m.match(/task (\d+) \| prompt processing done.*?n_tokens = (\d+)/);
            if (pdM) {
                const tid = parseInt(pdM[1]);
                if (tasks[tid]) tasks[tid].promptTokensFinal = parseInt(pdM[2]);
            }

            // checkpoint created
            const ckM = m.match(/task (\d+) \| created context checkpoint (\d+) of (\d+).*?n_tokens = (\d+).*?size = ([\d.]+) MiB/);
            if (ckM) {
                const tid = parseInt(ckM[1]);
                if (tasks[tid]) {
                    if (!tasks[tid].checkpoints) tasks[tid].checkpoints = [];
                    tasks[tid].checkpoints.push({
                        id: parseInt(ckM[2]),
                        max: parseInt(ckM[3]),
                        n_tokens: parseInt(ckM[4]),
                        mib: parseFloat(ckM[5])
                    });
                }
            }

            // timing lines - multiple patterns
            let ptM = m.match(/prompt eval time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens.*?([\d.]+) ms per token,\s*([\d.]+) tokens per second/);
            if (!ptM) {
                ptM = m.match(/prompt eval time.*?([\d.]+).*?ms.*?(\d+).*?tokens.*?([\d.]+).*?ms.*?([\d.]+).*?tokens/);
            }
            if (!ptM) {
                ptM = m.match(/prompt eval.*?time.*?([\d.]+).*?ms.*?\/\s*(\d+).*?tokens.*?([\d.]+).*?ms.*?token.*?([\d.]+).*?tokens.*?second/);
            }
            if (ptM) {
                const tid = taskOrder[taskOrder.length - 1];
                if (tasks[tid]) {
                    tasks[tid].promptEvalMs = parseFloat(ptM[1]);
                    tasks[tid].promptTokens = parseInt(ptM[2]);
                    tasks[tid].promptMsPTok = parseFloat(ptM[3]);
                    tasks[tid].promptTPS = parseFloat(ptM[4]);
                }
            }

            let etM = m.match(/eval time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens.*?([\d.]+) ms per token,\s*([\d.]+) tokens per second/);
            if (!etM) {
                etM = m.match(/eval time.*?([\d.]+).*?ms.*?(\d+).*?tokens.*?([\d.]+).*?ms.*?([\d.]+).*?tokens/);
            }
            if (!etM) {
                etM = m.match(/eval.*?time.*?([\d.]+).*?ms.*?\/\s*(\d+).*?tokens.*?([\d.]+).*?ms.*?token.*?([\d.]+).*?tokens.*?second/);
            }
            if (etM && !m.includes('prompt')) {
                const tid = taskOrder[taskOrder.length - 1];
                if (tasks[tid]) {
                    tasks[tid].evalMs = parseFloat(etM[1]);
                    tasks[tid].evalTokens = parseInt(etM[2]);
                    tasks[tid].evalMsPTok = parseFloat(etM[3]);
                    tasks[tid].evalTPS = parseFloat(etM[4]);
                }
            }

            const ttM = m.match(/total time\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens/);
            if (ttM) {
                const tid = taskOrder[taskOrder.length - 1];
                if (tasks[tid]) {
                    tasks[tid].totalMs = parseFloat(ttM[1]);
                    tasks[tid].totalTokens = parseInt(ttM[2]);
                }
            }

            // slot release
            const relM = m.match(/task (\d+) \| stop processing.*?n_tokens = (\d+).*?truncated = (\d+)/);
            if (relM) {
                const tid = parseInt(relM[1]);
                if (tasks[tid]) {
                    tasks[tid].endTime = e.time;
                    tasks[tid].finalTokens = parseInt(relM[2]);
                    tasks[tid].truncated = parseInt(relM[3]);
                }
            }

            // sampler chain
            const sampM = m.match(/sampler chain: (.+)/);
            if (sampM && !window._samplerChain) {
                window._samplerChain = sampM[1].split('->').map(s => s.trim());
            }
        }

        // Cache state (initial state)
        const cachePrompts = [];
        for (const e of entries) {
            const m = e.message;
            const cacheTotal = m.match(/cache state: (\d+) prompts,\s*([\d.]+) MiB.*?limits:\s*([\d.]+) MiB,\s*(\d+) tokens/);
            if (cacheTotal && cachePrompts.length === 0) {
                window._cacheState = {
                    prompts: parseInt(cacheTotal[1]),
                    mib: parseFloat(cacheTotal[2]),
                    limMib: parseFloat(cacheTotal[3]),
                    limTok: parseInt(cacheTotal[4]),
                };
            }
            const promptEntry = m.match(/- prompt (0x\w+): (\d+) tokens.*?checkpoints: (\d+),\s*([\d.]+) MiB/);
            if (promptEntry) {
                cachePrompts.push({
                    addr: promptEntry[1],
                    tokens: parseInt(promptEntry[2]),
                    checkpoints: parseInt(promptEntry[3]),
                    mib: parseFloat(promptEntry[4])
                });
            }
        }
        window._cachePrompts = cachePrompts;

        // Session info
        const sessionStart = entries.length > 0 ? entries[entries.length - 1].time : '--:--:--';
        const sessionEnd = entries.length > 0 ? entries[0].time : '--:--:--';

        const taskList = taskOrder.map(tid => tasks[tid]); // Keep all tasks, even without TPS

        return {
            tasks: taskList,
            entries,
            sessionStart,
            sessionEnd
        };
    } catch (error) {
        console.error('Error in parseLogsForDashboard:', error);
        return {
            tasks: [],
            entries: logs,
            sessionStart: '--:--:--',
            sessionEnd: '--:--:--'
        };
    }
}

function buildDashboard(data) {
    const { tasks, entries, sessionStart, sessionEnd } = data;

    window._samplerChain = null;
    window._bigTask = null;
    window._cachePrompts = [];
    window._cacheState = null;
    window._ckptIdxs = null;

    if (entries.length === 0) {
        // No logs at all
        document.getElementById('dashboard-content').innerHTML = `
            <div class="dashboard-header">
                <div>
                    <div class="dashboard-h-file">No logs available</div>
                </div>
                <div class="dashboard-h-right">
                    <button class="dashboard-reset-btn" onclick="refreshDashboard()">↩ REFRESH</button>
                </div>
            </div>
            <div class="dashboard-loading">
                <p>No logs found yet.</p>
                <p style="font-size: 14px; margin-top: 10px;">Start an LLM server to begin collecting logs and analytics.</p>
            </div>
        `;
        return;
    }

    if (tasks.length === 0) {
        // Have logs but no tasks found - show log viewer
        const recentLogs = entries.slice(0, 50);
        const logStats = {
            total: entries.length,
            llm: entries.filter(e => e.source === 'LLM').length,
            emb: entries.filter(e => e.source === 'EMB').length,
            rer: entries.filter(e => e.source === 'RER').length
        };

        const logsHtml = `
            <div class="dashboard-section">Log Activity (${logStats.total} entries)</div>
            <div class="dashboard-stats-grid">
                <div class="dashboard-stat-card c0">
                    <div class="stat-label">LLM Logs</div>
                    <div class="stat-value">${logStats.llm}</div>
                    <div class="stat-unit">entries</div>
                </div>
                <div class="dashboard-stat-card c1">
                    <div class="stat-label">Embedding Logs</div>
                    <div class="stat-value">${logStats.emb}</div>
                    <div class="stat-unit">entries</div>
                </div>
                <div class="dashboard-stat-card c2">
                    <div class="stat-label">Reranker Logs</div>
                    <div class="stat-value">${logStats.rer}</div>
                    <div class="stat-unit">entries</div>
                </div>
            </div>
            <div class="dashboard-section">Recent Activity</div>
            <div class="dashboard-log-tabs" id="dashboard-log-tabs">
                <div class="dashboard-log-tab active" onclick="switchDashboardLogTab('ALL')">ALL</div>
                <div class="dashboard-log-tab" onclick="switchDashboardLogTab('LLM')">LLM</div>
                <div class="dashboard-log-tab" onclick="switchDashboardLogTab('EMB')">EMBEDDING</div>
                <div class="dashboard-log-tab" onclick="switchDashboardLogTab('RER')">RERANKER</div>
            </div>
            <div id="dashboard-log-panes">
                <div class="dashboard-log-pane active" id="dashboard-log-ALL">
                    <div class="dashboard-log-box" style="max-height: 400px;">
                        ${recentLogs.map(e => `
                            <div class="dashboard-log-entry">
                                <span class="dashboard-log-time">${e.time}</span>
                                <span class="dashboard-log-source">${e.source}</span>
                                <span class="dashboard-log-message">${e.message}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="dashboard-log-pane" id="dashboard-log-LLM">
                    <div class="dashboard-log-box" style="max-height: 400px;">
                        ${recentLogs.filter(e => e.source === 'LLM').map(e => `
                            <div class="dashboard-log-entry">
                                <span class="dashboard-log-time">${e.time}</span>
                                <span class="dashboard-log-source">${e.source}</span>
                                <span class="dashboard-log-message">${e.message}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="dashboard-log-pane" id="dashboard-log-EMB">
                    <div class="dashboard-log-box" style="max-height: 400px;">
                        ${recentLogs.filter(e => e.source === 'EMB').map(e => `
                            <div class="dashboard-log-entry">
                                <span class="dashboard-log-time">${e.time}</span>
                                <span class="dashboard-log-source">${e.source}</span>
                                <span class="dashboard-log-message">${e.message}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="dashboard-log-pane" id="dashboard-log-RER">
                    <div class="dashboard-log-box" style="max-height: 400px;">
                        ${recentLogs.filter(e => e.source === 'RER').map(e => `
                            <div class="dashboard-log-entry">
                                <span class="dashboard-log-time">${e.time}</span>
                                <span class="dashboard-log-source">${e.source}</span>
                                <span class="dashboard-log-message">${e.message}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;

        document.getElementById('dashboard-content').innerHTML = `
            <div class="dashboard-header">
                <div>
                    
                    <div class="dashboard-h-file">Session ${sessionStart} → ${sessionEnd}</div>
                </div>
                <div class="dashboard-h-right">
                    <div class="dashboard-h-stat">
                        <div class="dashboard-h-stat-val">${logStats.total}</div>
                        <div class="dashboard-h-stat-lbl">LOG ENTRIES</div>
                    </div>
                    <button class="dashboard-reset-btn" onclick="refreshDashboard()">↩ REFRESH</button>
                </div>
            </div>
            ${logsHtml}
        `;
        return;
    }

    const totalMs = tasks.reduce((s, t) => s + (t.totalMs || 0), 0);
    const totalPTok = tasks.reduce((s, t) => s + (t.promptTokens || 0), 0);
    const totalETok = tasks.reduce((s, t) => s + (t.evalTokens || 0), 0);
    const avgPTPS = tasks.reduce((s, t) => s + (t.promptTPS || 0), 0) / tasks.length;
    const avgETPS = tasks.reduce((s, t) => s + (t.evalTPS || 0), 0) / tasks.length;
    const allCkpts = tasks.flatMap(t => t.checkpoints || []);

    // Calculate actual session duration from log timestamps
    let sessionDurationMinutes = 0;
    if (entries.length > 1) {
        const startTime = new Date(entries[entries.length - 1].timestamp);
        const endTime = new Date(entries[0].timestamp);
        const durationMs = endTime - startTime;
        sessionDurationMinutes = (durationMs / (1000 * 60)).toFixed(1);
    }

    const stats = [
        { l: 'Session Duration', v: sessionDurationMinutes, u: 'minutes', c: 0 },
        { l: 'Tasks Completed', v: tasks.length, u: 'inference calls', c: 2 },
        { l: 'Prompt Tokens Total', v: totalPTok.toLocaleString(), u: 'tokens ingested', c: 1 },
        { l: 'Generated Tokens', v: totalETok, u: 'tokens out', c: 3 },
        { l: 'Avg Prompt TPS', v: avgPTPS.toFixed(1), u: 'tokens/sec', c: 0 },
        { l: 'Avg Eval TPS', v: avgETPS.toFixed(2), u: 'tokens/sec', c: 2 },
        { l: 'Context Checkpoints', v: allCkpts.length, u: 'total created', c: 3 },
        //{ l: 'Context Window', v: (tasks[0]?.ctxSlot || '?').toLocaleString(), u: 'max tokens', c: 1 },
    ];

    let html = `
        <div class="dashboard-header">
            <div>
                
                <div class="dashboard-h-file">Session ${sessionStart} → ${sessionEnd}</div>
            </div>
            <div class="dashboard-h-right">
                <div class="dashboard-h-stat">
                    <div class="dashboard-h-stat-val">${tasks.length}</div>
                    <div class="dashboard-h-stat-lbl">TASKS</div>
                </div>
                <div class="dashboard-h-stat">
                    <div class="dashboard-h-stat-val">${(totalMs / 1000).toFixed(1)}</div>
                    <div class="dashboard-h-stat-lbl">TOTAL SEC</div>
                </div>
                <button class="dashboard-reset-btn" onclick="refreshDashboard()">↩ REFRESH</button>
            </div>
        </div>

        <div class="dashboard-section">Overview</div>
        <div class="dashboard-stats-grid">
    `;

    stats.forEach(s => {
        html += `
            <div class="dashboard-stat-card c${s.c}">
                <div class="stat-label">${s.l}</div>
                <div class="stat-value">${s.v}</div>
                <div class="stat-unit">${s.u}</div>
            </div>
        `;
    });

    html += '</div>';



    // Charts
    if (tasks.length > 0) {
        html += `
            <div class="dashboard-section">Prompt Processing Speed (tokens / s) Dashboard</div>
            <div class="dashboard-chart-row">
                <div class="dashboard-chart-box">
                    <div class="dashboard-chart-title">Prompt Tokens / Second</div>
                    <canvas id="dashboard-c-ptps" class="dashboard-canvas" width="600" height="300"></canvas>
                </div>
                <div class="dashboard-chart-box">
                    <div class="dashboard-chart-title">Generation Tokens / Second</div>
                    <canvas id="dashboard-c-etps" class="dashboard-canvas" width="600" height="300"></canvas>
                </div>
            </div>
        `;

        // Ingestion timeline for first big task
        const bigTask = tasks.reduce((a,b)=>((a.batches||[]).length > (b.batches||[]).length ? a : b), tasks[0]);
        if (bigTask && bigTask.batches && bigTask.batches.length > 1) {
            const ckptIdxs = (bigTask.checkpoints||[]).map(cp =>
                bigTask.batches.findIndex(b => b.n >= cp.n_tokens));
            html += `<div class="dashboard-section">Task ${bigTask.id} — Prompt Ingestion Timeline</div>
            <div class="dashboard-chart-box"><div class="dashboard-chart-title">BATCH PROGRESS OVER TIME · VERTICAL LINES = CHECKPOINTS</div>
              <canvas id="dashboard-c-prog" class="dashboard-canvas" width="800" height="250"></canvas></div>`;
            window._bigTask = bigTask;
            window._ckptIdxs = ckptIdxs;
        }

        // Checkpoints
        if (allCkpts.length > 0) {
            const refTask = tasks.find(t => (t.checkpoints||[]).length > 0);
            html += `<div class="dashboard-section">Context Checkpoints (Task ${refTask?.id||''})</div>
            <div class="dashboard-chart-box"><canvas id="dashboard-c-ckpt" class="dashboard-canvas" width="800" height="${Math.max(150, allCkpts.length*50)}"></canvas></div>`;
        }

        // Sampler
        const chain = window._samplerChain;
        if (chain && chain.length) {
            html += `<div class="dashboard-section">Sampler Pipeline</div>
            <div class="dashboard-chart-box"><div class="dashboard-chart-title">SAMPLER CHAIN · ? = OPTIONAL STAGE</div>
            <div class="dashboard-chain" id="dashboard-chain-el"></div></div>`;
        }

        // Cache
        const cp = window._cachePrompts;
        const cs = window._cacheState;
        if ((cp && cp.length) || cs) {
            html += `<div class="dashboard-section">Prompt Cache State</div><div class="dashboard-cache-grid">`;
            if (cs) {
              html += `<div class="dashboard-cc"><div class="dashboard-cc-title">📦 Cache Summary</div>
                <div class="dashboard-cr">Loaded prompts <span>${cs.prompts}</span></div>
                <div class="dashboard-cr">Used <span>${cs.mib} MiB</span></div>
                <div class="dashboard-cr">Limit <span>${cs.limMib} MiB</span></div>
                <div class="dashboard-cr">Token limit <span>${cs.limTok.toLocaleString()}</span></div></div>`;
            }
            (cp||[]).forEach(p => {
              html += `<div class="dashboard-cc"><div class="dashboard-cc-title">🗂 ${p.addr}</div>
                <div class="dashboard-cr">Tokens <span>${p.tokens.toLocaleString()}</span></div>
                <div class="dashboard-cr">Checkpoints <span>${p.checkpoints}</span></div>
                <div class="dashboard-cr">Memory <span>${p.mib} MiB</span></div></div>`;
            });
            html += '</div>';
        }
    }

    // Log viewer
    const filters = { 'ALL': null, 'LLM': 'LLM', 'EMBEDDING': 'EMB', 'RERANKER': 'RER' };
    html += `
        <div class="dashboard-section">Recent Logs</div>
        <div class="dashboard-log-tabs" id="dashboard-log-tabs">
    `;

    Object.keys(filters).forEach((name, i) => {
        const active = i === 0 ? 'active' : '';
        html += `<div class="dashboard-log-tab ${active}" onclick="switchDashboardLogTab('${name}')">${name}</div>`;
    });

    html += `
        </div>
        <div id="dashboard-log-panes">
    `;

    Object.entries(filters).forEach(([name, filter], i) => {
        const active = i === 0 ? 'active' : '';
        const filtered = filter ? entries.filter(e => e.source === filter) : entries.slice(0, 50);
        const logHtml = filtered.map(e => `
            <div class="dashboard-log-entry">
                <span class="dashboard-log-time">${e.time}</span>
                <span class="dashboard-log-source">${e.source}</span>
                <span class="dashboard-log-message">${e.message}</span>
            </div>
        `).join('');

        html += `<div class="dashboard-log-pane ${active}" id="dashboard-log-${name}"><div class="dashboard-log-box">${logHtml || '<div style="color: var(--text-muted); padding: 20px;">No logs found</div>'}</div></div>`;
    });

    html += '</div>';

    document.getElementById('dashboard-content').innerHTML = html;

    // Animate task cards
    setTimeout(() => {
        tasks.forEach(t => {
            const el = document.getElementById(`dashboard-task-${t.id}`);
            if (el) el.classList.add('visible');
        });
    }, 50);

    // Render charts after DOM update
    if (tasks.length > 0) {
        // Use multiple animation frames to ensure DOM is fully updated
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const labels = tasks.map(t => `T-${t.id}`);
                const ptpsValues = tasks.map(t => t.promptTPS || 0);
                const etpsValues = tasks.map(t => t.evalTPS || 0);

                // Render charts
                const ptpsCanvas = document.getElementById('dashboard-c-ptps');
                const etpsCanvas = document.getElementById('dashboard-c-etps');

                if (ptpsCanvas) {
                    drawDashboardBars('dashboard-c-ptps', labels, ptpsValues);
                }
                if (etpsCanvas) {
                    drawDashboardBars('dashboard-c-etps', labels, etpsValues);
                }

                // Render ingestion timeline if available
                const progCanvas = document.getElementById('dashboard-c-prog');
                if (window._bigTask?.batches && progCanvas) {
                    drawDashboardLine('dashboard-c-prog',
                        window._bigTask.batches.map(b => b.time.slice(3)),
                        window._bigTask.batches.map(b => b.progress),
                        '#00d9ff', window._ckptIdxs || []);
                }

                // Render checkpoints if available
                const ckptCanvas = document.getElementById('dashboard-c-ckpt');
                if (allCkpts.length > 0 && ckptCanvas && window._bigTask) {
                    const bigTotalTok = window._bigTask.promptTokensFinal || window._bigTask.promptTokens || 1;
                    drawDashboardCheckpointBars('dashboard-c-ckpt', allCkpts, bigTotalTok);
                }

                // Render sampler chain if available
                const chainEl = document.getElementById('dashboard-chain-el');
                if (chainEl && window._samplerChain) {
                    chainEl.innerHTML = window._samplerChain.map((s, i) => {
                        const on = !s.startsWith('?');
                        return `<span class="dashboard-cs ${on ? 'on' : ''}">${s}</span>${i < window._samplerChain.length - 1 ? '<span class="dashboard-ca">→</span>' : ''}`;
                    }).join('');
                }
            });
        });
    }
}

// Make function available globally
window.switchDashboardLogTab = function(name) {
    document.querySelectorAll('.dashboard-log-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.dashboard-log-pane').forEach(p => p.classList.remove('active'));

    const tab = document.querySelector(`.dashboard-log-tab:nth-child(${Object.keys({'ALL':1, 'LLM':2, 'EMBEDDING':3, 'RERANKER':4})[name] || 1})`);
    const pane = document.getElementById(`dashboard-log-${name}`);

    if (tab) tab.classList.add('active');
    if (pane) pane.classList.add('active');
}

// Chart drawing functions
function initDashboardCanvas(id) {
    const canvas = document.getElementById(id);
    if (!canvas) {
        console.error('Canvas not found:', id);
        return null;
    }
    const dpr = window.devicePixelRatio || 1;
    let W = canvas.offsetWidth, H = canvas.offsetHeight;

    // Fallback to canvas attributes if offset dimensions are zero
    if (W === 0) W = canvas.width / dpr || 600;
    if (H === 0) H = canvas.height / dpr || 300;
    if (W === 0 || H === 0) {
        const cs = getComputedStyle(canvas);
        W = parseFloat(cs.minWidth) || 600;
        H = parseFloat(cs.minHeight) || 300;
    }

    if (W === 0 || H === 0) {
        console.error(`Canvas ${id} has zero dimensions: ${W}x${H}`);
        return null;
    }
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    return { ctx, W, H };
}

function drawDashboardBars(id, labels, values) {
    const r = initDashboardCanvas(id);
    if (!r) return;
    const { ctx, W, H } = r;
    const P = { t: 24, r: 16, b: 40, l: 52 };
    const cW = W - P.l - P.r, cH = H - P.t - P.b;
    const maxV = Math.max(...values, 1) * 1.18 || 1;

    // Grid
    for (let i = 0; i <= 4; i++) {
        const y = P.t + cH * (1 - i / 4);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(P.l, y);
        ctx.lineTo(P.l + cW, y);
        ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText((maxV * i / 4).toFixed(1), P.l - 5, y + 4);
    }

    const bW = Math.max((cW / labels.length) * 0.55, 10); // Minimum bar width
    values.forEach((v, i) => {
        const bH = Math.max((v / maxV) * cH, 1); // Minimum bar height
        const x = P.l + (i + 0.5) * (cW / labels.length) - bW / 2;
        const y = P.t + cH - bH;

        // Simple fill for now
        ctx.fillStyle = '#6366f1';
        ctx.fillRect(x, y, bW, bH);

        // Value text
        ctx.fillStyle = '#6366f1';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(v.toFixed(1), x + bW / 2, y - 5);

        // Label text
        ctx.fillStyle = '#64748b';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillText(labels[i], x + bW / 2, H - P.b + 14);
    });
}

function drawDashboardLine(id, xLabels, data, color = '#00d9ff', markerIdxs = []) {
    const r = initDashboardCanvas(id);
    if (!r) return;
    const { ctx, W, H } = r;
    const P = { t: 20, r: 16, b: 44, l: 48 };
    const cW = W - P.l - P.r, cH = H - P.t - P.b;
    const maxV = Math.max(...data) * 1.1 || 1;
    const n = data.length;

    // Grid
    for (let i = 0; i <= 4; i++) {
        const y = P.t + cH * (1 - i / 4);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(P.l, y);
        ctx.lineTo(P.l + cW, y);
        ctx.stroke();
        ctx.fillStyle = '#64748b';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.textAlign = 'right';
        ctx.fillText((maxV * i / 4 * 100).toFixed(0) + '%', P.l - 5, y + 4);
    }

    // Checkpoint markers
    markerIdxs.forEach(mi => {
        if (mi >= n) return;
        const x = P.l + (mi / (n - 1 || 1)) * cW;
        ctx.strokeStyle = 'rgba(245, 166, 35, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, P.t);
        ctx.lineTo(x, P.t + cH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f5a623';
        ctx.font = 'bold 8px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('CKPT', x, P.t + cH + 28);
    });

    // Area fill
    const grad = ctx.createLinearGradient(0, P.t, 0, P.t + cH);
    grad.addColorStop(0, color + '33');
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    data.forEach((v, i) => {
        const x = P.l + (i / (n - 1 || 1)) * cW;
        const y = P.t + cH * (1 - v / maxV);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(P.l + cW, P.t + cH);
    ctx.lineTo(P.l, P.t + cH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    data.forEach((v, i) => {
        const x = P.l + (i / (n - 1 || 1)) * cW;
        const y = P.t + cH * (1 - v / maxV);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Dots and x labels
    ctx.fillStyle = color;
    data.forEach((v, i) => {
        const x = P.l + (i / (n - 1 || 1)) * cW;
        const y = P.t + cH * (1 - v / maxV);
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (i % Math.max(1, Math.floor(n / 6)) === 0) {
            ctx.fillStyle = '#64748b';
            ctx.font = '8px JetBrains Mono, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(xLabels[i], x, H - P.b + 13);
            ctx.fillStyle = color;
        }
    });
}

function drawDashboardCheckpointBars(id, checkpoints, totalTokens) {
    const r = initDashboardCanvas(id);
    if (!r) return;
    const { ctx, W, H } = r;
    if (!checkpoints || checkpoints.length === 0) {
        ctx.fillStyle = '#64748b';
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('No checkpoints found in this log', W / 2, H / 2);
        return;
    }
    const P = { t: 14, r: 20, b: 28, l: 52 };
    const cW = W - P.l - P.r;
    const barH = Math.min(28, (H - P.t - P.b) / checkpoints.length - 8);

    // X axis
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(P.l, H - P.b);
    ctx.lineTo(P.l + cW, H - P.b);
    ctx.stroke();
    for (let i = 0; i <= 4; i++) {
        const x = P.l + (i / 4) * cW;
        ctx.fillStyle = '#64748b';
        ctx.font = '8px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(totalTokens * (i / 4) / 1000) + 'k', x, H - P.b + 12);
    }

    checkpoints.forEach((cp, i) => {
        const w = (cp.n_tokens / totalTokens) * cW;
        const y = P.t + i * (barH + 8);
        const a = 0.15 + 0.15 * i;
        ctx.fillStyle = `rgba(0, 217, 255, ${a})`;
        ctx.strokeStyle = `rgba(0, 217, 255, ${a * 3})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(P.l, y, w, barH, 3) : ctx.rect(P.l, y, w, barH);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#00d9ff';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`CP${cp.id}`, P.l + 4, y + barH / 2 + 4);
        ctx.fillStyle = '#7a8fa8';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillText(`${cp.n_tokens.toLocaleString()} tok · ${cp.mib} MiB`, P.l + 36, y + barH / 2 + 4);
    });
}