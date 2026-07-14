/**
 * Connection Rotator Extension for SillyTavern
 *
 * Rotates between Connection Manager profiles per message using a
 * weighted schedule. Example:
 *   Profile A : 5 messages
 *   Profile B : 5 messages
 *   Profile C : 1 message
 *
 * Hooks GENERATION_STARTED (which is awaited by the core) and switches
 * the active connection profile via the /profile slash command before
 * the API request is built.
 *
 * Requires the built-in "connection-manager" extension to be enabled.
 */

import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    chat_metadata,
    online_status,
    main_api,
} from '../../../../script.js';
import { waitUntilCondition } from '../../../utils.js';
import { t } from '../../../i18n.js';

const MODULE_NAME = 'third-party/ST-Connection-Rotator';
const SETTINGS_KEY = 'connectionRotator';

/**
 * Rotation modes.
 * @readonly
 * @enum {string}
 */
const ROTATION_MODE = {
    /** Each entry runs for `weight` consecutive messages, in order, then loops. */
    ORDERED: 'ordered',
    /** Each message picks a profile at random, with probability proportional to `weight`. */
    WEIGHTED: 'weighted',
};

const defaultSettings = {
    enabled: false,
    perChat: false,
    includeSwipes: true,  // whether swipes advance the rotation counter
    mode: ROTATION_MODE.ORDERED,
    entries: [],          // { id, profileId, profileName, weight }
    globalCounter: 0,     // used when perChat === false
};

/** @type {Record<string, any>} */
const settings = extension_settings;

// ─── Settings ────────────────────────────────────────────────────────────────

function loadSettings() {
    if (!settings[SETTINGS_KEY]) {
        settings[SETTINGS_KEY] = structuredClone(defaultSettings);
    }
    settings[SETTINGS_KEY] = { ...structuredClone(defaultSettings), ...settings[SETTINGS_KEY] };
    if (!Array.isArray(settings[SETTINGS_KEY].entries)) {
        settings[SETTINGS_KEY].entries = [];
    }
}

function saveSettings() {
    saveSettingsDebounced();
}

/** @returns {{enabled:boolean, perChat:boolean, includeSwipes:boolean, mode:string, entries:Array, globalCounter:number}} */
function cfg() {
    return settings[SETTINGS_KEY];
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// ─── Profile discovery ───────────────────────────────────────────────────────

/**
 * Return the list of connection-manager profiles as {id, name}.
 * @returns {{id:string, name:string}[]}
 */
function getProfiles() {
    const profiles = settings?.connectionManager?.profiles;
    return Array.isArray(profiles)
        ? profiles.map(p => ({ id: p.id, name: p.name })).filter(p => p.id && p.name)
        : [];
}

// ─── Counter (global or per-chat) ────────────────────────────────────────────

function getCounter() {
    if (cfg().perChat) {
        return Number(chat_metadata?.connectionRotatorCounter ?? 0);
    }
    return cfg().globalCounter;
}

function setCounter(value) {
    const v = Math.max(0, Number(value) || 0);
    if (cfg().perChat) {
        chat_metadata.connectionRotatorCounter = v;
        // chat_metadata is persisted by the core on chat save
    } else {
        cfg().globalCounter = v;
        saveSettings();
    }
}

function incrementCounter() {
    setCounter(getCounter() + 1);
}

// ─── Schedule logic ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} RotatorEntry
 * @property {string} id
 * @property {string} profileId
 * @property {string} profileName
 * @property {number} weight
 */

/**
 * Expand entries into a flat schedule of profile IDs (ordered mode).
 *   [{A,5},{B,5},{C,1}] -> [idA,idA,idA,idA,idA,idB,idB,idB,idB,idB,idC]
 * @param {RotatorEntry[]} entries
 * @returns {string[]}
 */
function buildSchedule(entries) {
    const schedule = [];
    for (const entry of entries) {
        const w = Math.max(1, Math.floor(Number(entry.weight) || 1));
        for (let i = 0; i < w; i++) {
            schedule.push(entry.profileId);
        }
    }
    return schedule;
}

/**
 * Pick a profile ID for the given index using the active rotation mode.
 *
 * - Ordered: index into the expanded schedule with modulo.
 * - Weighted: random pick proportional to weight.
 *
 * @param {number} index
 * @returns {string} profile ID, or '' if no entries
 */
function profileIdForIndex(index) {
    const entries = cfg().entries.filter(e => e.profileId);
    if (entries.length === 0) return '';

    if (cfg().mode === ROTATION_MODE.WEIGHTED) {
        return weightedPick(entries);
    }

    const schedule = buildSchedule(entries);
    if (schedule.length === 0) return '';
    return schedule[index % schedule.length];
}

/**
 * Weighted random pick. Each call draws a fresh random number so the
 * selection is truly stochastic rather than a deterministic sequence.
 *
 * @param {RotatorEntry[]} entries
 * @returns {string}
 */
function weightedPick(entries) {
    const weighted = entries.map(e => ({
        id: e.profileId,
        w: Math.max(0, Number(e.weight) || 0),
    }));
    const total = weighted.reduce((sum, e) => sum + e.w, 0);
    if (total <= 0) {
        // All weights zero — fall back to uniform random pick.
        return entries[Math.floor(Math.random() * entries.length)].profileId;
    }

    const target = Math.random() * total;
    let acc = 0;
    for (const e of weighted) {
        acc += e.w;
        if (target < acc) return e.id;
    }
    return weighted[weighted.length - 1].id;
}

// Pre-rolled cache so the status display and the actual generation use the same pick.
// In weighted mode, profileIdForIndex draws a fresh random number each call, so without
// caching the display and the real selection are independent rolls and never agree.
// rollNextProfileId() is called at the top of updateStatus(), which is the single
// convergence point for every mutation that could change the next pick (weight edits,
// entry add/delete, mode change, counter advance, chat change).
let _nextProfileIdCache = null;

function rollNextProfileId() {
    _nextProfileIdCache = profileIdForIndex(getCounter());
}

/**
 * The profile ID that will be used for the *next* message.
 * Returns the pre-rolled cached value so successive calls (display vs. actual switch)
 * always agree. The cache is refreshed by updateStatus() after every state change.
 * @returns {string}
 */
function nextProfileId() {
    if (_nextProfileIdCache === null) rollNextProfileId();
    return _nextProfileIdCache;
}

/**
 * Resolve a profile ID to its display name.
 * @param {string} profileId
 * @returns {string}
 */
function profileNameById(profileId) {
    if (!profileId) return '';
    const profile = settings?.connectionManager?.profiles?.find(p => p.id === profileId);
    return profile?.name ?? '';
}

/**
 * Return the currently selected connection-manager profile ID, or ''.
 * @returns {string}
 */
function getCurrentProfileId() {
    return settings?.connectionManager?.selectedProfile ?? '';
}

// Maps main_api values to their connect button IDs, matching RA_autoconnect in RossAscends-mods.js.
const CONNECT_BUTTONS = {
    kobold: '#api_button',
    novel: '#api_button_novel',
    textgenerationwebui: '#api_button_textgenerationwebui',
    openai: '#api_button_openai',
};

// ─── Profile switching ───────────────────────────────────────────────────────

/**
 * Switch the active connection profile by setting the connection-manager
 * <select> value directly and dispatching a `change` event.
 *
 * We bypass the /profile slash command because its findProfileByName()
 * falls back to Fuse fuzzy matching, which can pick the wrong profile when
 * several profiles share a name prefix (e.g. "Arli-AI Mistral-Medium" vs
 * "Arli-AI Mistral-Medium Thinking (Event Tracking)").
 *
 * The select's change handler does an exact ID lookup, applies the profile,
 * and emits CONNECTION_PROFILE_LOADED — which we await.
 *
 * CONNECTION_PROFILE_LOADED fires as soon as the connection-manager finishes
 * running its slash commands, but the backend may still be reconnecting, so
 * `online_status` can briefly be 'no_connection'. If we let generation proceed
 * in that window, the core bails out early (script.js: `!hasBackendConnection`)
 * and silently returns *before* clearing the prompt box — the connection rotates
 * but the message is never sent. So we also wait for the API to come back online,
 * mirroring what SillyTavern's own /api command does.
 *
 * @param {string} profileId
 * @returns {Promise<boolean>} true if switched (or already active), false on failure
 */
async function switchProfile(profileId) {
    if (!profileId) return false;
    if (profileId === getCurrentProfileId()) return true;

    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('connection_profiles'));
    if (!select) {
        console.error('Connection Rotator: #connection_profiles select not found');
        return false;
    }

    const option = Array.from(select.options).find(o => o.value === profileId);
    if (!option) {
        console.error(`Connection Rotator: profile ID "${profileId}" not in select`);
        return false;
    }

    const loadedPromise = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
        eventSource.once(event_types.CONNECTION_PROFILE_LOADED, () => {
            clearTimeout(timer);
            resolve();
        });
    }));

    select.value = profileId;
    select.dispatchEvent(new Event('change'));

    // Wait for the connection-manager to finish applying the profile.
    try {
        await loadedPromise;

        // The profile is selected, but the backend may still be reconnecting.
        // For same-API rotations (most common case: two profiles sharing the same
        // API type/source), the profile's slash commands never trigger a connect
        // button click, so if ST wasn't connected yet (e.g. auto-connect is off),
        // online_status stays 'no_connection' indefinitely. Actively click the
        // button ourselves — the same thing RA_autoconnect does — so the rotator
        // works regardless of the auto-connect setting.
        if (online_status === 'no_connection') {
            const btn = CONNECT_BUTTONS[main_api];
            if (btn) $(btn).trigger('click');
        }

        try {
            await waitUntilCondition(() => online_status !== 'no_connection', 5_000, 100);
        } catch {
            console.warn('Connection Rotator: backend still offline after profile switch; proceeding anyway');
        }

        return true;
    } catch (error) {
        console.error(`Connection Rotator: failed to switch to profile ID "${profileId}"`, error);
        /** @type {any} */ (window).toastr?.error?.(
            t`Connection Rotator: failed to switch to "${profileNameById(profileId)}"`,
        );
        return false;
    }
}

// ─── Core hook ───────────────────────────────────────────────────────────────

/**
 * GENERATION_STARTED handler. Fires before the API request is built and is
 * awaited by the core, so the profile switch completes first.
 *
 * @param {string} type Generation type ('normal', 'swipe', 'regenerate', 'continue', 'impersonate', 'quiet', ...)
 * @param {object} details
 * @param {boolean} dryRun
 */
async function onGenerationStarted(type, details, dryRun) {
    if (!cfg().enabled) return;
    // Skip dry runs (e.g. prompt previews) so we don't burn a rotation slot.
    if (dryRun) return;

    // Swipes regenerate an existing message rather than producing a new one.
    // When includeSwipes is off, ignore them entirely — no switch, no advance.
    if (type === 'swipe' && !cfg().includeSwipes) return;

    const target = nextProfileId();
    if (!target) return;

    const switched = await switchProfile(target);

    // Always advance the counter for non-swipe generations so a broken/deleted
    // profile entry doesn't block the rotation indefinitely.
    if (type !== 'swipe') {
        incrementCounter();
    }

    if (!switched) {
        /** @type {any} */ (window).toastr?.warning?.(
            t`Connection Rotator: skipped profile "${profileNameById(target)}" (switch failed) — check your rotation entries`,
        );
    }

    updateStatus();
}

// ─── UI ──────────────────────────────────────────────────────────────────────

function renderList() {
    const container = document.getElementById('rotator_list');
    if (!container) return;

    const entries = cfg().entries;
    container.innerHTML = '';

    if (entries.length === 0) {
        container.innerHTML = '<div class="rotator-empty">No entries yet. Click "Add" to define a rotation.</div>';
        return;
    }

    const profileNames = getProfiles();

    entries.forEach((entry, index) => {
        container.appendChild(createRow(entry, index, profileNames));
    });
}

/**
 * @param {RotatorEntry} entry
 * @param {number} index
 * @param {{id:string, name:string}[]} profiles
 * @returns {HTMLElement}
 */
function createRow(entry, index, profiles) {
    const row = document.createElement('div');
    row.className = 'rotator-row';
    row.dataset.id = entry.id;

    // Order badge
    const order = document.createElement('span');
    order.className = 'rotator-order';
    order.textContent = String(index + 1);

    // Profile dropdown — option value is the profile ID (unique),
    // text is the profile name (may be non-unique).
    const select = document.createElement('select');
    select.className = 'rotator-profile text_pole';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— select profile —';
    select.appendChild(placeholder);
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === entry.profileId) opt.selected = true;
        select.appendChild(opt);
    }
    select.addEventListener('change', () => {
        entry.profileId = select.value;
        entry.profileName = select.selectedOptions[0]?.textContent ?? '';
        saveSettings();
        updateStatus();
    });

    // Weight input — semantics depend on the active mode:
    //   ordered:  number of consecutive messages for this profile (min 1)
    //   weighted: relative probability weight (min 0)
    const isWeighted = cfg().mode === ROTATION_MODE.WEIGHTED;
    const weight = document.createElement('input');
    weight.className = 'rotator-weight text_pole';
    weight.type = 'number';
    weight.min = isWeighted ? '0' : '1';
    weight.title = isWeighted
        ? 'Relative probability weight (higher = picked more often)'
        : 'Number of consecutive messages for this profile';
    weight.value = String(entry.weight ?? 1);
    weight.addEventListener('change', () => {
        const min = isWeighted ? 0 : 1;
        entry.weight = Math.max(min, Math.floor(Number(weight.value) || min));
        weight.value = String(entry.weight);
        saveSettings();
        updateStatus();
    });

    // Weight label — reflects the active mode
    const weightLabel = document.createElement('span');
    weightLabel.className = 'rotator-weight-label';
    weightLabel.textContent = isWeighted ? 'weight' : 'msgs';

    // Move up / down / delete
    const actions = document.createElement('div');
    actions.className = 'rotator-row-actions';

    const upBtn = document.createElement('div');
    upBtn.className = 'menu_button menu_button_icon small';
    upBtn.title = 'Move up';
    upBtn.innerHTML = '<i class="fa-solid fa-arrow-up"></i>';
    upBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moveEntry(entry.id, -1);
    });

    const downBtn = document.createElement('div');
    downBtn.className = 'menu_button menu_button_icon small';
    downBtn.title = 'Move down';
    downBtn.innerHTML = '<i class="fa-solid fa-arrow-down"></i>';
    downBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moveEntry(entry.id, 1);
    });

    const deleteBtn = document.createElement('div');
    deleteBtn.className = 'menu_button menu_button_icon small';
    deleteBtn.title = 'Remove entry';
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const list = cfg().entries;
        const idx = list.findIndex(x => x.id === entry.id);
        if (idx !== -1) list.splice(idx, 1);
        saveSettings();
        renderList();
        updateStatus();
    });

    actions.append(upBtn, downBtn, deleteBtn);
    row.append(order, select, weight, weightLabel, actions);
    return row;
}

function moveEntry(id, delta) {
    const list = cfg().entries;
    const idx = list.findIndex(x => x.id === id);
    if (idx === -1) return;
    const newIdx = idx + delta;
    if (newIdx < 0 || newIdx >= list.length) return;
    [list[idx], list[newIdx]] = [list[newIdx], list[idx]];
    saveSettings();
    renderList();
    updateStatus();
}

function addEntry() {
    cfg().entries.push({
        id: generateId(),
        profileId: '',
        profileName: '',
        weight: 1,
    });
    saveSettings();
    renderList();
    updateStatus();
}

function resetCounter() {
    setCounter(0);
    updateStatus();
    /** @type {any} */ (window).toastr?.info?.(t`Connection Rotator: counter reset to 0`);
}

function updateStatus() {
    rollNextProfileId();
    const nextEl = document.getElementById('rotator_next_profile');
    const counterEl = document.getElementById('rotator_counter');
    if (nextEl) nextEl.textContent = profileNameById(nextProfileId()) || '—';
    if (counterEl) counterEl.textContent = String(getCounter());
}

function syncControls() {
    const enabled = /** @type {HTMLInputElement|null} */ (document.getElementById('rotator_enabled'));
    const perChat = /** @type {HTMLInputElement|null} */ (document.getElementById('rotator_per_chat'));
    const includeSwipes = /** @type {HTMLInputElement|null} */ (document.getElementById('rotator_include_swipes'));
    const mode = /** @type {HTMLSelectElement|null} */ (document.getElementById('rotator_mode'));
    if (enabled) enabled.checked = !!cfg().enabled;
    if (perChat) perChat.checked = !!cfg().perChat;
    if (includeSwipes) includeSwipes.checked = !!cfg().includeSwipes;
    if (mode) mode.value = cfg().mode || ROTATION_MODE.ORDERED;
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function setupListeners() {
    $('#rotator_add').off('click').on('click', addEntry);
    $('#rotator_reset').off('click').on('click', resetCounter);

    $('#rotator_enabled').off('change').on('change', (e) => {
        cfg().enabled = /** @type {HTMLInputElement} */ (e.target).checked;
        saveSettings();
        updateStatus();
    });

    $('#rotator_per_chat').off('change').on('change', (e) => {
        cfg().perChat = /** @type {HTMLInputElement} */ (e.target).checked;
        saveSettings();
        updateStatus();
    });

    $('#rotator_include_swipes').off('change').on('change', (e) => {
        cfg().includeSwipes = /** @type {HTMLInputElement} */ (e.target).checked;
        saveSettings();
    });

    $('#rotator_mode').off('change').on('change', (e) => {
        cfg().mode = /** @type {HTMLSelectElement} */ (e.target).value;
        saveSettings();
        // Re-render rows so weight labels/min values reflect the new mode.
        renderList();
        updateStatus();
    });

    // Re-render the profile dropdowns when connection-manager profiles change
    eventSource.removeListener(event_types.CONNECTION_PROFILE_CREATED, renderList);
    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, renderList);
    eventSource.removeListener(event_types.CONNECTION_PROFILE_DELETED, renderList);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, renderList);
    eventSource.removeListener(event_types.CONNECTION_PROFILE_UPDATED, renderList);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, renderList);

    // Refresh status when chat changes (per-chat counter context switches)
    eventSource.removeListener(event_types.CHAT_CHANGED, updateStatus);
    eventSource.on(event_types.CHAT_CHANGED, updateStatus);

    // The core hook
    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function init() {
    loadSettings();

    const settingsHtml = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#extensions_settings2').append(settingsHtml);

    setupListeners();
    syncControls();
    renderList();
    updateStatus();

    const enabled = cfg().enabled ? 'enabled' : 'disabled';
    console.log(`Connection Rotator: ${enabled}, ${cfg().entries.length} entries, counter=${getCounter()}`);
}

export function clean() {
    eventSource.removeListener(event_types.CONNECTION_PROFILE_CREATED, renderList);
    eventSource.removeListener(event_types.CONNECTION_PROFILE_DELETED, renderList);
    eventSource.removeListener(event_types.CONNECTION_PROFILE_UPDATED, renderList);
    eventSource.removeListener(event_types.CHAT_CHANGED, updateStatus);
    eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
}
