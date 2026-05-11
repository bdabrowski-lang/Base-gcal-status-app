// ==UserScript==
// @name         GCal Event → Baselinker
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Odczytuje wszystkie aktywne zdarzenia z Google Calendar i wyświetla je w pływającym widgecie na Baselinker tickets.
// @author       Bartłomiej Dąbrowski
// @match        https://calendar.google.com/*
// @match        https://supportislove2.baselinker.com/tickets.php*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/bdabrowski-lang/Base-gcal-status-app/main/gcal-baselinker.user.js
// @downloadURL  https://raw.githubusercontent.com/bdabrowski-lang/Base-gcal-status-app/main/gcal-baselinker.user.js
// ==/UserScript==

(function () {
    'use strict';

    const KEY_EVENTS = 'gcal_active_events_v2'; // JSON tablica nazw
    const KEY_TIME   = 'gcal_scan_ts_v2';
    const SCAN_MS    = 30000;  // skanowanie co 30 sekund (setInterval)
    const DISPLAY_MS = 5000;   // odświeżanie widgetu co 5 sekund

    const LOG = (...a) => console.log('[GCal→BL]', ...a);
    const ERR = (...a) => console.error('[GCal→BL]', ...a);

    try {
        if (location.hostname === 'calendar.google.com') {
            LOG('Uruchamianie części kalendarza...');
            runCalendarSide();
        } else {
            LOG('Uruchamianie widgetu Baselinker...');
            runBaselinkerSide();
        }
    } catch (e) {
        ERR('Błąd startowy:', e);
    }

    /* ═══════════════════════════════════════════════════════════════════════
       CZĘŚĆ 1 – GOOGLE CALENDAR
    ═══════════════════════════════════════════════════════════════════════ */

    function runCalendarSide() {
        let lastJSON  = '';
        let gridCache = null;
        let scanTimer = null;

        // Oznacz stronę — widoczne z kontekstu strony dla diagnostyki
        document.documentElement.dataset.gcalBLActive = '1';

        // Debounced MutationObserver — scan co najwyżej raz na 3 sekundy
        let mutDebounce = null;
        const observer = new MutationObserver(() => {
            clearTimeout(mutDebounce);
            mutDebounce = setTimeout(scan, 3000);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // Periodyczny scan co SCAN_MS
        scanTimer = setInterval(scan, SCAN_MS);

        // Pierwszy scan — z opóźnieniem, żeby GCal zdążył załadować DOM
        setTimeout(scan, 2000);
        LOG('MutationObserver i setInterval uruchomione.');

        function persist(events) {
            try {
                GM_setValue(KEY_TIME, Date.now());
                const json = JSON.stringify([...events]);
                if (json === lastJSON) return;
                lastJSON = json;
                GM_setValue(KEY_EVENTS, json);
                LOG('Zapisano zdarzenia:', [...events]);
            } catch (e) {
                ERR('persist() błąd GM_setValue:', e);
            }
        }

        function scan() {
            try {
                const found  = new Set();
                const nowMin = nowMinutes();
                LOG(`Skan o ${Math.floor(nowMin/60)}:${String(nowMin%60).padStart(2,'0')} (${nowMin} min)`);

                // ── A: Otwarty popup / dialog ────────────────────────────────
                for (const dlg of document.querySelectorAll('[role="dialog"]')) {
                    if (dlg.offsetWidth === 0 && dlg.offsetHeight === 0) continue;
                    const h1 = dlg.querySelector('h1');
                    if (h1?.textContent.trim()) found.add(h1.textContent.trim());
                }

                // ── B: Chipy zdarzeń ─────────────────────────────────────────
                const lineY    = getTimeLineY();
                const selector = '[data-eventid], [data-eventchip], ' +
                                 '[role="button"][style*="top:"][style*="height:"]';
                const allChips = document.querySelectorAll(selector);
                LOG(`Znaleziono ${allChips.length} chipów (lineY=${lineY})`);

                for (const chip of allChips) {
                    if (chip.offsetWidth === 0 && chip.offsetHeight === 0) continue;
                    if (isActiveNow(chip, lineY, nowMin)) {
                        const name = extractChipName(chip);
                        if (name) found.add(name);
                    }
                }

                LOG('Aktywne zdarzenia:', [...found]);
                persist(found);
            } catch (e) {
                ERR('scan() błąd:', e);
            }
        }

        // ── Czy chip trwa teraz? ─────────────────────────────────────────────
        function isActiveNow(chip, lineY, nowMin) {
            // B0: textContent w polskim formacie GCal "Od HH:MM do HH:MM"
            const plRange = parsePolishTimeRange(chip.textContent || '');
            if (plRange) return plRange.start <= nowMin && nowMin < plRange.end;

            // B1: inline style top/height → czas absolutny w siatce 24h
            const styleRange = getTimeRangeFromStyle(chip);
            if (styleRange) return styleRange.start <= nowMin && nowMin < styleRange.end;

            // B2: nakładanie z linią czasu
            if (lineY !== null) {
                const r = chip.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && r.top <= lineY && r.bottom >= lineY) return true;
            }

            // B3: parsowanie czasu z aria-label lub textContent (inne formaty)
            const timeStr = chip.getAttribute('aria-label') || chip.textContent || '';
            const range   = parseTimeRange(timeStr);
            if (range) return range.start <= nowMin && nowMin < range.end;

            return false;
        }

        // Parsowanie polskiego formatu GCal: "Od 08:00 do 09:00, Nazwa, ..."
        function parsePolishTimeRange(text) {
            const m = text.match(/Od\s+(\d{1,2}):(\d{2})\s+do\s+(\d{1,2}):(\d{2})/i);
            if (!m) return null;
            return {
                start: +m[1] * 60 + +m[2],
                end:   +m[3] * 60 + +m[4],
            };
        }

        // ── B1: Czas zdarzenia z inline stylów CSS ───────────────────────────
        function getTimeRangeFromStyle(chip) {
            const style = chip.getAttribute('style') || '';
            const topM  = style.match(/top:\s*([\d.]+)px/);
            const htM   = style.match(/height:\s*([\d.]+)px/);
            if (!topM || !htM) return null;

            const grid = getCalendarGrid();
            if (!grid) return null;

            const totalH    = grid.scrollHeight;
            const pxPerHour = totalH / 24;
            if (pxPerHour < 30 || pxPerHour > 200) return null;

            const startMin = Math.round((+topM[1] / pxPerHour) * 60);
            const endMin   = Math.round(((+topM[1] + +htM[1]) / pxPerHour) * 60);
            if (startMin < 0 || endMin > 1440 || startMin >= endMin) return null;

            return { start: startMin, end: endMin };
        }

        // Znajdź główną siatkę kalendarza — pomijamy HEADER
        function getCalendarGrid() {
            if (gridCache && document.contains(gridCache) && gridCache.scrollHeight > 600) {
                return gridCache;
            }
            const selector = '[role="button"][style*="top:"][style*="height:"], ' +
                             '[data-eventid][style*="top:"]';
            for (const chip of document.querySelectorAll(selector)) {
                if (!parsePolishTimeRange(chip.textContent || '')) continue;
                let el = chip.parentElement;
                while (el && el !== document.body) {
                    if (el.tagName !== 'HEADER' &&
                        el.scrollHeight > el.clientHeight + 400 &&
                        el.scrollHeight > 800) {
                        gridCache = el;
                        return el;
                    }
                    el = el.parentElement;
                }
            }
            return null;
        }

        // ── Pozycja Y linii bieżącego czasu ─────────────────────────────────
        function getTimeLineY() {
            for (const sel of ['[data-draw-current-time-indicator]', '[data-current-time-marker]']) {
                const el = document.querySelector(sel);
                if (el) {
                    const r = el.getBoundingClientRect();
                    if (r.height > 0) return r.top + r.height / 2;
                    if (r.width  > 0) return r.top;
                }
            }
            return interpolateFromHourLabels();
        }

        function interpolateFromHourLabels() {
            const now  = new Date();
            const nowH = now.getHours() + now.getMinutes() / 60;

            const leftEdge = Math.min(130, window.innerWidth * 0.13);
            const cands    = new Map();

            for (const el of document.querySelectorAll('div, span')) {
                if (el.children.length > 0) continue;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (r.width > 65)           continue;
                if (r.right > leftEdge + 65) continue;

                const text = el.textContent.trim();
                const m    = text.match(/^(\d{1,2})(?:[:\.]\d{2})?\s*(AM|PM)?$/i);
                if (!m) continue;

                let h      = parseInt(m[1]);
                const ap   = (m[2] || '').toUpperCase();
                if (ap === 'PM' && h !== 12) h += 12;
                if (ap === 'AM' && h === 12) h  = 0;
                if (h < 0 || h > 23) continue;
                if (!cands.has(h)) cands.set(h, r.top + r.height / 2);
            }

            if (cands.size < 4) return null;

            const sorted = [...cands.entries()].sort((a, b) => a[0] - b[0]);

            let bestRun = null;
            for (let i = 0; i < sorted.length - 1; i++) {
                const spacing = sorted[i + 1][1] - sorted[i][1];
                if (spacing < 10 || spacing > 250) continue;

                const run = [sorted[i], sorted[i + 1]];
                for (let j = i + 2; j < sorted.length; j++) {
                    const consecutive  = sorted[j][0] - sorted[j - 1][0] === 1;
                    const evenlySpaced = Math.abs((sorted[j][1] - sorted[j - 1][1]) - spacing) < spacing * 0.2;
                    if (!consecutive || !evenlySpaced) break;
                    run.push(sorted[j]);
                }
                if (run.length >= 4 && (!bestRun || run.length > bestRun.length)) bestRun = run;
            }

            if (!bestRun) return null;

            for (let i = 0; i < bestRun.length - 1; i++) {
                const [h1, y1] = bestRun[i], [h2, y2] = bestRun[i + 1];
                if (h1 <= nowH && nowH < h2) return y1 + ((nowH - h1) / (h2 - h1)) * (y2 - y1);
            }
            return null;
        }

        // ── B3: Parsowanie zakresu czasu z tekstu ───────────────────────────
        function parseTimeRange(text) {
            const re = /(\d{1,2})[:\.](\d{2})\s*(AM|PM)?[\s–—\-]+(\d{1,2})[:\.](\d{2})\s*(AM|PM)?/i;
            const m  = text.match(re);
            if (!m) return null;

            let h1 = +m[1], min1 = +m[2], ap1 = (m[3] || '').toUpperCase();
            let h2 = +m[4], min2 = +m[5], ap2 = (m[6] || '').toUpperCase();
            if (ap1 === 'PM' && h1 !== 12) h1 += 12;
            if (ap1 === 'AM' && h1 === 12) h1  = 0;
            if (ap2 === 'PM' && h2 !== 12) h2 += 12;
            if (ap2 === 'AM' && h2 === 12) h2  = 0;
            if (!ap1 && ap2 === 'PM' && h1 < h2 && h1 < 12) h1 += 12;

            return { start: h1 * 60 + min1, end: h2 * 60 + min2 };
        }

        function extractChipName(chip) {
            const text = chip.textContent || '';

            // Format polski: "Od 08:00 do 09:00, Nazwa zdarzenia, ..."
            const plM = text.match(/Od\s+\d{1,2}:\d{2}\s+do\s+\d{1,2}:\d{2}[,\s]+([^,\n]+)/i);
            if (plM) return plM[1].trim();

            // aria-label: "Nazwa zdarzenia, ..."
            const label     = chip.getAttribute('aria-label') || '';
            const fromLabel = label.split(',')[0].trim();
            if (fromLabel) return fromLabel;

            // Fallback: nagłówek wewnątrz chipu
            const inner = chip.querySelector('[role="heading"], h2, h3, span[class]');
            return inner?.textContent.trim() || null;
        }

        function nowMinutes() {
            const d = new Date();
            return d.getHours() * 60 + d.getMinutes();
        }
    }

    /* ═══════════════════════════════════════════════════════════════════════
       CZĘŚĆ 2 – BASELINKER TICKETS
    ═══════════════════════════════════════════════════════════════════════ */

    function runBaselinkerSide() {
        const KEY_POS = 'gcal_wpos_v2';
        const KEY_PIN = 'gcal_wpin_v2';
        const KEY_MIN = 'gcal_wmin_v2';

        GM_addStyle(`
            #gcal-w {
                position: fixed;
                z-index: 99999;
                min-width: 160px;
                max-width: 240px;
                background: #fff;
                border: 1px solid #dadce0;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(60,64,67,.28);
                font-family: Arial, sans-serif;
                font-size: 12px;
                overflow: hidden;
            }
            #gcal-w-head {
                display: flex;
                align-items: center;
                gap: 4px;
                background: #1a73e8;
                color: #fff;
                padding: 5px 8px;
                cursor: grab;
                user-select: none;
            }
            #gcal-w.pinned #gcal-w-head { cursor: default; }
            #gcal-w-head span.icon { font-size: 12px; flex-shrink: 0; }
            #gcal-w-head-title {
                flex: 1;
                font-size: 11px;
                font-weight: 700;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #gcal-w-head button {
                background: rgba(255,255,255,.18);
                border: none;
                color: #fff;
                cursor: pointer;
                width: 18px;
                height: 18px;
                border-radius: 4px;
                font-size: 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0;
                flex-shrink: 0;
                transition: background .12s;
            }
            #gcal-w-head button:hover { background: rgba(255,255,255,.32); }
            #gcal-w-head button.on    { background: rgba(255,255,255,.38); }
            #gcal-w-body { padding: 7px 9px 8px; }
            #gcal-w.minimized #gcal-w-body { display: none; }
            #gcal-w-section-label {
                font-size: 9px;
                font-weight: 700;
                color: #80868b;
                text-transform: uppercase;
                letter-spacing: .6px;
                margin-bottom: 4px;
            }
            #gcal-w-list { display: flex; flex-direction: column; gap: 3px; }
            .gcal-w-event {
                background: #e8f0fe;
                border-left: 3px solid #1a73e8;
                border-radius: 0 4px 4px 0;
                color: #174ea6;
                font-size: 12px;
                font-weight: 600;
                line-height: 1.3;
                padding: 3px 6px;
                word-break: break-word;
            }
            #gcal-w-empty {
                color: #9aa0a6;
                font-size: 11px;
                font-style: italic;
            }
            #gcal-w-footer {
                margin-top: 5px;
                font-size: 10px;
                color: #bdc1c6;
                display: flex;
                align-items: center;
                gap: 4px;
            }
            #gcal-w-dot {
                width: 6px;
                height: 6px;
                border-radius: 50%;
                flex-shrink: 0;
                background: #dadce0;
            }
            #gcal-w-dot.live {
                background: #34a853;
                animation: gcal-pulse 1.6s ease-in-out infinite;
            }
            @keyframes gcal-pulse {
                0%,100% { opacity: 1; }
                50%      { opacity: .15; }
            }
        `);

        // ── Wczytaj zapisany stan ────────────────────────────────────────────
        const savedPos  = parseJSON(GM_getValue(KEY_POS, null), { x: 24, y: 80, abs: false });
        let isPinned    = GM_getValue(KEY_PIN, '0') === '1';
        let isMinimized = GM_getValue(KEY_MIN, '0') === '1';

        // ── Zbuduj widget ────────────────────────────────────────────────────
        const w = document.createElement('div');
        w.id = 'gcal-w';
        w.innerHTML = `
            <div id="gcal-w-head">
                <span class="icon">📅</span>
                <span id="gcal-w-head-title">Google Calendar</span>
                <button id="gcal-btn-pin" title="Przypnij / odepnij">📌</button>
                <button id="gcal-btn-min" title="Minimalizuj / rozwiń">−</button>
            </div>
            <div id="gcal-w-body">
                <div id="gcal-w-section-label">Aktywne zdarzenia</div>
                <div id="gcal-w-list"></div>
                <div id="gcal-w-empty"></div>
                <div id="gcal-w-footer">
                    <span id="gcal-w-dot"></span>
                    <span id="gcal-w-status"></span>
                </div>
            </div>
        `;
        document.body.appendChild(w);

        // ── Pozycja startowa — zawsze clampuj do viewportu ───────────────────
        if (isPinned && savedPos.abs) {
            w.style.position = 'absolute';
            w.style.left = savedPos.x + 'px';
            w.style.top  = savedPos.y + 'px';
        } else {
            // Zawsze resetuj do viewportu (fixed) przy pierwszym załadowaniu
            isPinned = false;
            const safeX = clamp(savedPos.abs ? 24 : savedPos.x, 4, window.innerWidth  - 244);
            const safeY = clamp(savedPos.abs ? 80 : savedPos.y, 4, window.innerHeight - 44);
            w.style.left = safeX + 'px';
            w.style.top  = safeY + 'px';
        }

        applyPin(isPinned);
        applyMin(isMinimized);

        // ── Przyciski ────────────────────────────────────────────────────────
        document.getElementById('gcal-btn-pin').addEventListener('click', () => {
            const scrollX = window.scrollX || 0;
            const scrollY = window.scrollY || 0;
            const curL    = parseFloat(w.style.left) || 0;
            const curT    = parseFloat(w.style.top)  || 0;

            isPinned = !isPinned;

            if (isPinned) {
                // fixed → absolute: viewport + scroll = pozycja na stronie
                w.style.position = 'absolute';
                w.style.left = (curL + scrollX) + 'px';
                w.style.top  = (curT + scrollY) + 'px';
                w.style.zIndex = '1';
            } else {
                // absolute → fixed: pozycja na stronie − scroll = viewport
                w.style.position = 'fixed';
                w.style.left = (curL - scrollX) + 'px';
                w.style.top  = (curT - scrollY) + 'px';
                w.style.zIndex = '99999';
            }

            applyPin(isPinned);
            GM_setValue(KEY_PIN, isPinned ? '1' : '0');
            GM_setValue(KEY_POS, JSON.stringify({
                x: parseFloat(w.style.left),
                y: parseFloat(w.style.top),
                abs: isPinned,
            }));
        });

        document.getElementById('gcal-btn-min').addEventListener('click', () => {
            isMinimized = !isMinimized;
            GM_setValue(KEY_MIN, isMinimized ? '1' : '0');
            applyMin(isMinimized);
        });

        function applyPin(p) {
            w.classList.toggle('pinned', p);
            w.style.zIndex = p ? '1' : '99999';
            const btn = document.getElementById('gcal-btn-pin');
            btn.classList.toggle('on', p);
            btn.title = p
                ? 'Odepnij od strony (widget unosi się nad widokiem)'
                : 'Przypnij do strony (widget scrolluje razem ze stroną)';
        }

        function applyMin(m) {
            w.classList.toggle('minimized', m);
            const btn = document.getElementById('gcal-btn-min');
            btn.textContent = m ? '+' : '−';
            btn.title = m ? 'Rozwiń' : 'Minimalizuj';
        }

        // ── Przeciąganie z pełnoekranową nakładką ───────────────────────────
        const head = document.getElementById('gcal-w-head');
        let drag    = null;
        let overlay = null;

        head.addEventListener('mousedown', e => {
            if (isPinned || e.target.closest('button')) return;

            overlay = document.createElement('div');
            overlay.style.cssText =
                'position:fixed;inset:0;z-index:2147483646;cursor:grabbing;';
            document.body.appendChild(overlay);

            drag = {
                x0: e.clientX,
                y0: e.clientY,
                l0: parseFloat(w.style.left)  || 0,
                t0: parseFloat(w.style.top)   || 0,
            };
            e.preventDefault();
        });

        window.addEventListener('mousemove', e => {
            if (!drag) return;
            w.style.left = (drag.l0 + e.clientX - drag.x0) + 'px';
            w.style.top  = (drag.t0 + e.clientY - drag.y0) + 'px';
        }, { capture: true });

        window.addEventListener('mouseup', () => {
            if (!drag) return;
            overlay?.remove();
            overlay = null;
            GM_setValue(KEY_POS, JSON.stringify({
                x: parseFloat(w.style.left),
                y: parseFloat(w.style.top),
                abs: false,
            }));
            drag = null;
        }, { capture: true });

        window.addEventListener('resize', () => {
            if (isPinned) return;
            w.style.left = clamp(parseFloat(w.style.left) || 0, 4, window.innerWidth  - 244) + 'px';
            w.style.top  = clamp(parseFloat(w.style.top)  || 0, 4, window.innerHeight - 44)  + 'px';
        });

        // ── Odświeżanie listy zdarzeń ────────────────────────────────────────
        const listEl   = document.getElementById('gcal-w-list');
        const emptyEl  = document.getElementById('gcal-w-empty');
        const statusEl = document.getElementById('gcal-w-status');
        const dotEl    = document.getElementById('gcal-w-dot');

        function refresh() {
            try {
                const events = parseJSON(GM_getValue(KEY_EVENTS, '[]'), []);
                const ts     = Number(GM_getValue(KEY_TIME, 0));
                const age    = ts ? Math.round((Date.now() - ts) / 1000) : null;

                if (events.length > 0) {
                    listEl.innerHTML      = events.map(n => `<div class="gcal-w-event">${esc(n)}</div>`).join('');
                    listEl.style.display  = 'flex';
                    emptyEl.style.display = 'none';
                    dotEl.className       = 'live';
                } else {
                    listEl.innerHTML      = '';
                    listEl.style.display  = 'none';
                    emptyEl.style.display = 'block';
                    emptyEl.textContent   = ts
                        ? 'Brak aktywnych zdarzeń'
                        : 'Otwórz Google Calendar w innej karcie';
                    dotEl.className = '';
                }

                if (age === null) {
                    statusEl.textContent = '';
                } else if (age < 60) {
                    statusEl.textContent = `odświeżono ${age}s temu`;
                } else {
                    statusEl.textContent = `odświeżono ${Math.round(age / 60)} min temu`;
                }
            } catch (e) {
                ERR('refresh() błąd:', e);
            }
        }

        setInterval(refresh, DISPLAY_MS);
        refresh();
    }

    /* ─── Narzędzia ──────────────────────────────────────────────────────── */

    function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

    function parseJSON(str, fallback) {
        try { return (str != null ? JSON.parse(str) : null) ?? fallback; }
        catch { return fallback; }
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

})();
