/**
 * ChatPruner Performance Profiler — injected into page context
 * Monitors main thread health during SSE streaming to identify freeze causes.
 * 
 * Measures:
 * - Long Tasks (>50ms main thread blocks) via PerformanceObserver
 * - Frame rate (requestAnimationFrame delta)
 * - SSE event processing time
 * 
 * Results logged to console and stored in window.__chatPrunerProfile
 */
(() => {
    if (window.__chatPrunerProfilerActive) return;
    window.__chatPrunerProfilerActive = true;
    const LIVE_LOGS = (() => {
        try { return localStorage.getItem('chatpruner:profiler-live-logs') === '1'; }
        catch { return false; }
    })();

    const profile = {
        streaming: false,
        streamStart: 0,
        longTasks: [],        // { start, duration, scripts[] }
        frameTimes: [],       // ms between frames during stream
        freezes: [],          // frames where delta > 200ms
        totalChunks: 0,
        totalChunkProcessMs: 0,
    };

    window.__chatPrunerProfile = profile;

    // ─── 1) Long Task Observer ───
    // Fires whenever the main thread is blocked >50ms
    let longTaskObserver;
    try {
        longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const task = {
                    start: entry.startTime,
                    duration: entry.duration,
                    wallTime: new Date().toISOString(),
                };

                // Try to get attribution (what script caused it)
                if (entry.attribution && entry.attribution.length > 0) {
                    task.scripts = entry.attribution.map(a => ({
                        name: a.name,
                        containerSrc: a.containerSrc,
                        containerName: a.containerName,
                    }));
                }

                profile.longTasks.push(task);

                if (profile.streaming && LIVE_LOGS) {
                    const severity = entry.duration > 200 ? '🔴' : entry.duration > 100 ? '🟡' : '🟢';
                    console.log(
                        `[ChatPruner Profiler] ${severity} Long Task: ${entry.duration.toFixed(0)}ms`,
                        task.scripts || '(no attribution)'
                    );
                }
            }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: false });
        console.log('[ChatPruner Profiler] ✅ Long Task observer active');
    } catch (e) {
        console.warn('[ChatPruner Profiler] Long Task API not available:', e.message);
    }

    // ─── 2) Frame Rate Monitor ───
    // Measures real frame intervals during streaming
    let lastFrameTime = 0;
    let rafId = null;

    function frameLoop(now) {
        if (!profile.streaming) {
            rafId = null;
            return;
        }

        if (lastFrameTime > 0) {
            const delta = now - lastFrameTime;
            profile.frameTimes.push(delta);

            if (delta > 200) {
                profile.freezes.push({
                    delta: Math.round(delta),
                    at: (now - profile.streamStart).toFixed(0) + 'ms into stream',
                    wallTime: new Date().toISOString(),
                });
                if (LIVE_LOGS) {
                    console.error(
                        `[ChatPruner Profiler] 🧊 UI FREEZE: ${Math.round(delta)}ms gap between frames`,
                        `(${((now - profile.streamStart) / 1000).toFixed(1)}s into stream)`
                    );
                }
            }
        }

        lastFrameTime = now;
        rafId = requestAnimationFrame(frameLoop);
    }

    // ─── 3) Hook into fetch to detect stream start/end ───
    const _origFetch = window.fetch;
    const _patchedFetch = window.fetch; // might already be patched by debounce.js

    // We wrap whatever fetch is current (debounce.js's patched version)
    const wrapFetch = () => {
        const currentFetch = window.fetch;
        window.fetch = function (...args) {
            const [resource] = args;
            const url = typeof resource === 'string' ? resource : resource?.url || '';

            if (url.includes('/backend-api/f/conversation') && !url.includes('/prepare')) {
                // Stream starting
                profile.streaming = true;
                profile.streamStart = performance.now();
                profile.longTasks = [];
                profile.frameTimes = [];
                profile.freezes = [];
                profile.totalChunks = 0;
                profile.totalChunkProcessMs = 0;
                lastFrameTime = 0;

                if (LIVE_LOGS) console.log('[ChatPruner Profiler] 📊 Stream started — profiling...');
                rafId = requestAnimationFrame(frameLoop);

                return currentFetch.apply(this, args).then(response => {
                    // Monitor when stream ends by watching the body
                    if (response.body) {
                        const origReader = response.body.getReader;
                        const profilerRef = profile;

                        // We can't easily wrap ReadableStream again without breaking things,
                        // so we set a timer to produce the report after streaming settles
                        const checkDone = setInterval(() => {
                            // If no new frames for 3s, assume stream ended
                            if (profilerRef.frameTimes.length > 0) {
                                const lastDelta = profilerRef.frameTimes[profilerRef.frameTimes.length - 1];
                                if (performance.now() - profilerRef.streamStart > 5000 && lastDelta !== undefined) {
                                    // Check if frames stopped
                                }
                            }
                        }, 2000);

                        // Auto-report after 60s max
                        setTimeout(() => {
                            clearInterval(checkDone);
                            if (profilerRef.streaming) {
                                profilerRef.streaming = false;
                                printReport();
                            }
                        }, 60000);
                    }

                    return response;
                });
            }

            return currentFetch.apply(this, args);
        };
    };

    // ─── 4) MutationObserver to detect when streaming text stops ───
    let streamEndTimer;
    const mutObs = new MutationObserver(() => {
        if (!profile.streaming) return;

        // Reset the "idle" timer on every DOM mutation
        clearTimeout(streamEndTimer);
        streamEndTimer = setTimeout(() => {
            // No DOM changes for 2s = stream probably ended
            if (profile.streaming) {
                profile.streaming = false;
                printReport();
            }
        }, 2000);
    });
    mutObs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    // ─── 5) Report ───
    function printReport() {
        const ft = profile.frameTimes;
        if (ft.length === 0) {
            console.log('[ChatPruner Profiler] No frame data collected.');
            return;
        }

        const avgFps = 1000 / (ft.reduce((a, b) => a + b, 0) / ft.length);
        const maxGap = Math.max(...ft);
        const freezeCount = profile.freezes.length;
        const longTaskCount = profile.longTasks.length;
        const totalLongTaskMs = profile.longTasks.reduce((s, t) => s + t.duration, 0);
        const worstTask = profile.longTasks.sort((a, b) => b.duration - a.duration)[0];
        const streamStats = window.__chatPrunerStreamStats || null;

        const streamDuration = ((performance.now() - profile.streamStart) / 1000).toFixed(1);

        console.log('\n' + '='.repeat(60));
        console.log('[ChatPruner Profiler] 📊 STREAM PERFORMANCE REPORT');
        console.log('='.repeat(60));
        console.log(`  Stream duration:      ${streamDuration}s`);
        console.log(`  Avg FPS:              ${avgFps.toFixed(1)}`);
        console.log(`  Worst frame gap:      ${maxGap.toFixed(0)}ms`);
        console.log(`  UI Freezes (>200ms):  ${freezeCount}`);
        console.log(`  Long Tasks (>50ms):   ${longTaskCount} (total: ${totalLongTaskMs.toFixed(0)}ms)`);

        if (worstTask) {
            console.log(`  Worst Long Task:      ${worstTask.duration.toFixed(0)}ms`);
            if (worstTask.scripts) {
                console.log(`    Caused by:`, worstTask.scripts);
            }
        }

        if (streamStats) {
            console.log(`  Stream batches:       ${streamStats.batches || 0}`);
            console.log(`  Stream dedupe total:  ${streamStats.totalDropped || 0}`);
            console.log(`  Last render/cooldown: ${(streamStats.lastRenderCostMs || 0)}ms / ${(streamStats.lastCooldownMs || 0)}ms`);
            console.log(`  Queue backlog:        ${(streamStats.backlogEvents || 0)} raw, ${(streamStats.pendingEvents || 0)} pending`);
        }

        if (profile.freezes.length > 0) {
            console.log('\n  🧊 Freeze details:');
            for (const f of profile.freezes.slice(0, 10)) {
                console.log(`    ${f.delta}ms freeze at ${f.at}`);
            }
        }

        console.log('\n  Diagnosis:');
        if (avgFps < 20) {
            console.log('    🔴 SEVERE: FPS consistently below 20 — main thread heavily blocked');
        } else if (avgFps < 40) {
            console.log('    🟡 MODERATE: FPS below 40 — noticeable jank');
        } else {
            console.log('    🟢 GOOD: FPS above 40');
        }

        if (totalLongTaskMs > 5000) {
            console.log('    🔴 Main thread blocked for', (totalLongTaskMs / 1000).toFixed(1), 's in long tasks');
        }

        if (freezeCount > 5) {
            console.log('    🔴 Multiple UI freezes detected — likely React reconciliation or layout thrashing');
        }

        console.log('='.repeat(60));
        console.log('[ChatPruner Profiler] Full data: window.__chatPrunerProfile');
        console.log('');
    }

    // Delay wrapping fetch slightly to ensure debounce.js has patched first
    setTimeout(wrapFetch, 50);

    console.log('[ChatPruner Profiler] ✅ Performance profiler ready');
})();
