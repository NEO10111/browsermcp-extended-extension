/**
 * popup.js — Vanilla controller for the unified dev-tool popup
 */

'use strict';

const POLL_INTERVAL_MS = 1500;
const LOG_MAX_ENTRIES = 30;

const state = {
  wsConnected: false,
  activeTab: null,
  allTabs: [],
  logEntries: [],
  logOpen: false,
  dropdownOpen: false,
};

const $ = (id) => document.getElementById(id);

const statusDot          = $('statusDot');
const statusText         = $('statusText');
const tabFavicon         = $('tabFavicon');
const tabFaviconPh       = $('tabFaviconPlaceholder');
const tabDomain          = $('tabDomain');
const tabTitle           = $('tabTitle');
const tabIdEl            = $('tabId');
const btnSwitchTab       = $('btnSwitchTab');
const tabDropdown        = $('tabDropdown');
const sectionLog         = $('sectionLog');
const logHeader          = $('logHeader');
const logBadge           = $('logBadge');
const logStream          = $('logStream');
const logEmpty           = $('logEmpty');
const btnClearLog        = $('btnClearLog');
const inputPort          = $('inputPort');
const inputTimeout       = $('inputTimeout');
const btnApply           = $('btnApply');
const saveLabel          = $('saveLabel');
const powerSwitch = $('powerSwitch');
let toggling = false;
let polling = false;

async function init() {
  $('version').textContent = chrome.runtime.getManifest().version;
  tabFavicon.addEventListener('error', () => { tabFavicon.hidden = true; tabFaviconPh.style.display = ''; });
  await loadSettings();
  await refreshActiveTab();
  await pollWsStatus();
  await refreshLog();

  setInterval(pollWsStatus, POLL_INTERVAL_MS);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  bindEvents();
  chrome.tabs.onActivated.addListener(refreshActiveTab);
  chrome.tabs.onUpdated.addListener((id, change) => { if (id === state.activeTab?.id && (change.title || change.url || change.favIconUrl)) refreshActiveTab(); });
}

function feedback(message, error = false) {
  $('feedback').hidden = false;
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
}

async function pollWsStatus() {
  if (polling || toggling) return;
  polling = true;
  try {
    const response = await sendToBackground({ type: 'getWsStatus' });
    if (!toggling) renderStatus(response);
  } catch {
    powerSwitch.disabled = true;
    statusText.textContent = 'Status unavailable';
    statusDot.className = 'status-indicator';
    $('statusDescription').textContent = 'Cannot reach the extension. Reopen this panel.';
  } finally { polling = false; }
}

function renderStatus(response) {
  powerSwitch.disabled = !response.initialized;
  powerSwitch.setAttribute('aria-checked', String(response.enabled));
  $('powerLabel').textContent = response.enabled ? 'On' : 'Off';
  const status = !response.initialized ? 'loading' : !response.enabled ? 'disabled' : response.connected ? 'connected' : response.connecting ? 'connecting' : 'waiting';
  const labels = {
    loading: ['Loading…', 'Loading your preferences.'],
    disabled: ['Automation disabled', 'MCP commands are paused.'],
    connected: ['Connected', 'Ready for MCP commands.'],
    connecting: ['Connecting', 'Local MCP server…'],
    waiting: ['Waiting for server', 'Reconnecting automatically.'],
  };
  statusDot.className = `status-indicator ${status}`;
  statusText.textContent = labels[status][0];
  $('statusDescription').textContent = labels[status][1];
}

async function togglePower() {
  if (toggling) return;
  toggling = true;
  powerSwitch.disabled = true;
  try {
    await sendToBackground({ type: 'setEnabled', enabled: powerSwitch.getAttribute('aria-checked') !== 'true' });
    $('feedback').hidden = true;
  } catch (error) { feedback(error.message, true); }
  finally { toggling = false; await pollWsStatus(); }
}

async function refreshActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0] ?? (await chrome.tabs.query({ active: true }))[0];
    if (tab) {
      state.activeTab = tab;
      renderActiveTab(tab);
    }
  } catch (e) {
    console.error('[BrowserMCP] Error onglet actif :', e);
  }
}

function renderActiveTab(tab) {
  try {
    const u = new URL(tab.url || '');
    tabDomain.textContent = u.hostname || tab.url || '—';
  } catch {
    tabDomain.textContent = tab.url || '—';
  }

  tabTitle.textContent = tab.title || '(untitled)';
  tabIdEl.textContent = `#${tab.id}`;

  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    tabFavicon.src = tab.favIconUrl;
    tabFavicon.hidden = false;
    tabFaviconPh.style.display = 'none';
  } else {
    tabFavicon.hidden = true;
    tabFaviconPh.style.display = '';
  }
}

async function toggleDropdown() {
  if (state.dropdownOpen) {
    closeDropdown();
    return;
  }

  try {
    state.allTabs = await chrome.tabs.query({});
  } catch {
    state.allTabs = [];
  }

  renderDropdown();
  tabDropdown.classList.add('open');
  state.dropdownOpen = true;
  btnSwitchTab.setAttribute('aria-expanded', 'true');
}

function closeDropdown() {
  tabDropdown.classList.remove('open');
  state.dropdownOpen = false;
  btnSwitchTab.setAttribute('aria-expanded', 'false');
}

function renderDropdown() {
  tabDropdown.innerHTML = '';
  state.allTabs.forEach((tab) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `tab-entry${tab.active ? ' active' : ''}`;

    if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
      const img = document.createElement('img');
      img.className = 'favicon-img';
      img.src = tab.favIconUrl;
      img.onerror = () => { img.style.display = 'none'; };
      item.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'tab-entry-icon';
      ph.appendChild(tabFaviconPh.querySelector('svg').cloneNode(true));
      item.appendChild(ph);
    }

    const title = document.createElement('span');
    title.className = 'tab-entry-title';
    title.textContent = tab.title || tab.url || '(untitled)';
    item.appendChild(title);

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      switchToTab(tab.id);
    });
    tabDropdown.appendChild(item);
  });
}

async function switchToTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    closeDropdown();
    await refreshActiveTab();
  } catch (e) {
    feedback('Cannot open this tab.', true);
  }
}

async function refreshLog() {
  try {
    const response = await sendToBackground({ type: 'getActionLog' });
    state.logEntries = response?.log ?? [];
    renderLog();
  } catch {}
}

function handleRuntimeMessage(message) {
  if (message?.type === 'mcpLog') {
    addLogEntry(message.entry);
  }
}

function addLogEntry(entry) {
  state.logEntries.unshift(entry);
  if (state.logEntries.length > LOG_MAX_ENTRIES) {
    state.logEntries.length = LOG_MAX_ENTRIES;
  }
  renderLog();
}

function renderLog() {
  logBadge.textContent = state.logEntries.length;

  if (state.logEntries.length === 0) {
    logEmpty.style.display = '';
    Array.from(logStream.querySelectorAll('.stream-item')).forEach(el => el.remove());
    return;
  }

  logEmpty.style.display = 'none';
  Array.from(logStream.querySelectorAll('.stream-item')).forEach(el => el.remove());

  state.logEntries.forEach((entry) => {
    const row = createLogEntry(entry);
    logStream.appendChild(row);
  });
}

function createLogEntry(entry) {
  const row = document.createElement('div');
  row.className = 'stream-item';

  const d = new Date(entry.timestamp);
  const hms = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');

  const time = document.createElement('span');
  time.className = 'stream-time';
  time.textContent = hms;

  const tool = document.createElement('span');
  tool.className = 'stream-tool';
  tool.textContent = entry.tool;
  tool.title = entry.tool;

  const status = document.createElement(entry.success ? 'span' : 'button');
  status.className = `stream-status ${entry.success ? 'ok' : 'fail'}`;
  if (entry.success) {
    status.textContent = `${entry.duration}ms`;
  } else {
    status.type = 'button';
    status.textContent = 'Error';
    status.setAttribute('aria-expanded', 'false');
    const detail = document.createElement('p');
    detail.className = 'error-detail';
    detail.hidden = true;
    detail.textContent = entry.error || 'Unknown error';
    status.addEventListener('click', () => { detail.hidden = !detail.hidden; status.setAttribute('aria-expanded', String(!detail.hidden)); });
    row.appendChild(detail);
    status.title = entry.error ?? 'Unknown error';
  }

  row.prepend(time, tool, status);
  return row;
}

function toggleLog() {
  state.logOpen = !state.logOpen;
  sectionLog.classList.toggle('open', state.logOpen);
  logHeader.setAttribute('aria-expanded', String(state.logOpen));
}

async function clearLog() {
  try {
    await sendToBackground({ type: 'clearLog' });
    await refreshLog();
  } catch (error) { feedback(error.message, true); }
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(['wsPort', 'wsTimeout', 'wsPortMigratedV2']);
    if (stored.wsPort && (stored.wsPort !== 9876 || stored.wsPortMigratedV2)) inputPort.value = stored.wsPort;
    if (stored.wsTimeout) inputTimeout.value = Math.round(stored.wsTimeout / 1000);
  } catch {}
}

async function applySettings(event) {
  event.preventDefault();
  if (!$('settingsForm').reportValidity()) return;
  btnApply.disabled = true;
  try {
    await sendToBackground({ type: 'applySettings', port: Number(inputPort.value), timeout: Number(inputTimeout.value) * 1000 });
    feedback('Settings saved.');
    await pollWsStatus();
  } catch (error) { feedback(error.message, true); }
  finally { btnApply.disabled = false; }
}

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.ok === false) throw new Error(response?.error || 'Cannot reach the extension.');
  return response;
}

function bindEvents() {
  btnSwitchTab.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  document.addEventListener('click', (e) => {
    if (state.dropdownOpen && !tabDropdown.contains(e.target)) {
      closeDropdown();
    }
  });

  logHeader.addEventListener('click', toggleLog);
  btnClearLog.addEventListener('click', (e) => {
    e.stopPropagation();
    clearLog();
  });

  $('settingsForm').addEventListener('submit', applySettings);
  powerSwitch.addEventListener('click', togglePower);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.dropdownOpen) { closeDropdown(); btnSwitchTab.focus(); } });
}

document.addEventListener('DOMContentLoaded', init);
