/*
Nazwa programu: Virtual Server Manager
Producent: Heterodyna Team Software
Wersja softu: v102
Programista: Adrian Podłucki
Tester app/network: Grześ :)
*/

const state = {
  me: null,
  dashboard: null,
  serverRooms: [],
  audit: [],
  reportRows: [],
  networkMap: null,
  mapFilters: { building: '', roomId: '', vlan: '' },
  currentRoomId: null,
  currentRackId: null,
  currentSide: 'front',
  rackFilter: '',
  editingDeviceId: null,
  editingRoomId: null,
  monitoringEvents: [],
  faceplateCatalog: window.getVendorCatalog ? window.getVendorCatalog() : {},
  deviceLiveCache: {},
  devicePathCache: {},
  cableRoutes: [],
  pathTraceCache: {},
  snmpInterfaces: null,
  snmpDeviceId: null,
  snmpLoading: false,
  snmpPollingStatus: null,
  snmpPollingHistory: [],
  globalUplinks: [],
  datacenterRows: [],
  flowRows: [],
  routingRows: [],
  conflictRows: [],
  collectorRows: [],
  applicationRows: [],
  autoDocRows: [],
  collectorPerfRows: [],
  postgresStatus: null,
  postgresMirrorRows: [],
  map3dRows: [],
  map3dMode: 'full',
  dependencyRows: [],
  cableVizRows: [],
  rolesRows: [],
  flowCollectorConfig: null,
  ops: {
    metrics: null,
    backups: [],
    backupConfig: null,
    services: [],
    docker: [],
    dockerInstalled: false,
    alerts: null,
    runtimeLog: '',
    sshProfiles: [],
    tasks: [],
    users: [],
    twoFactor: null,
    terminalSessions: [],
    liveMetrics: [],
    metricsSubscribed: false,
    metricsHistory: [],
    terminalPolicies: null,
    terminalSessionAudit: [],
    terminalTranscripts: [],
    policyEvents: [],
    metricsCenter: null,
    metricsAlerts: [],
    agentsConfig: null,
    agentsStatus: [],
    routesAudit: [],
    terminal: { socket: null, connected: false, mode: 'local', instance: null, fitAddon: null, permissions: null }
  }
};

const views = {
  dashboard: document.getElementById('dashboardView'),
  rooms: document.getElementById('roomsView'),
  rack: document.getElementById('rackView'),
  map: document.getElementById('mapView'),
  report: document.getElementById('reportView'),
  datacenters: document.getElementById('datacentersView'),
  flow: document.getElementById('flowView'),
  collectors: document.getElementById('collectorsView'),
  conflicts: document.getElementById('conflictsView'),
  postgres: document.getElementById('postgresView'),
  roles: document.getElementById('rolesView'),
  map3d: document.getElementById('map3dView'),
  dependencies: document.getElementById('dependenciesView'),
  applications: document.getElementById('applicationsView'),
  autodoc: document.getElementById('autodocView'),
  collectorPerf: document.getElementById('collectorPerfView'),
  cable: document.getElementById('cableView'),
  snmp: document.getElementById('snmpView'),
  ops: document.getElementById('opsView'),
  audit: document.getElementById('auditView'),
};

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401) {
    window.location.href = '/';
    return null;
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || 'Błąd żądania');
    error.payload = data;
    throw error;
  }
  return data;
}

function toast(message, level = 'info') {
  let wrap = document.getElementById('toastStack');
  if (!wrap) { wrap = document.createElement('div'); wrap.id = 'toastStack'; wrap.style.position='fixed'; wrap.style.top='12px'; wrap.style.right='12px'; wrap.style.zIndex='9999'; wrap.style.display='grid'; wrap.style.gap='8px'; document.body.appendChild(wrap); }
  const item = document.createElement('div');
  item.textContent = message;
  item.style.padding='10px 12px'; item.style.borderRadius='12px'; item.style.background = level === 'error' ? '#7f1d1d' : (level === 'success' ? '#14532d' : '#1f2937'); item.style.color='#fff'; item.style.maxWidth='420px'; item.style.boxShadow='0 10px 25px rgba(0,0,0,.25)';
  wrap.appendChild(item); setTimeout(() => item.remove(), 4500);
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadText(content, filename, type='text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  return /[";,\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function downloadCsv(rows, filename, headers) {
  const cols = headers && headers.length ? headers : Object.keys((rows && rows[0]) || {});
  const lines = [cols.join(';')];
  for (const row of rows || []) {
    lines.push(cols.map(col => csvEscape(row[col])).join(';'));
  }
  downloadText(lines.join('\n'), filename, 'text/csv;charset=utf-8');
}


function applyTheme(theme) {
  const normalized = ['dark', 'light', 'nightshift', 'contrast'].includes(theme) ? theme : 'dark';
  state.theme = normalized;
  document.documentElement.setAttribute('data-theme', normalized);
  try { localStorage.setItem('vsm-theme', normalized); } catch (_) {}
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect && themeSelect.value !== normalized) themeSelect.value = normalized;
}

function bindThemePicker() {
  const themeSelect = document.getElementById('themeSelect');
  if (!themeSelect) return;
  themeSelect.value = state.theme || 'dark';
  themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
}

async function init() {
  try {
    applyTheme(state.theme);
    bindThemePicker();
    const meData = await api('/api/me');
    if (!meData?.authenticated) return;
    state.me = meData.user;
    document.getElementById('userBox').textContent = `${state.me.fullName} (${state.me.role})`;
    bindNav();
    bindForms();
    bindTabs();
    await refreshHealth();

    const coreResults = await Promise.allSettled([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap(), loadCableRoutes()]);
    coreResults.filter(item => item.status === 'rejected').forEach(item => console.warn('[INIT][CORE]', item.reason));

    const moduleResults = await Promise.allSettled([loadDatacentersView(), loadFlowTelemetry(), loadCollectorsView(), loadConflictsView(), loadPostgresStatus(), loadRolesView(), loadMap3dView(), loadDependenciesView(), loadApplicationsView(), loadAutoDocsView(), loadCollectorPerfView(), loadCableVisualizationView(), loadOpsView()]);
    moduleResults.filter(item => item.status === 'rejected').forEach(item => console.warn('[INIT][MODULE]', item.reason));

    populateSnmpSelectors();
    const snmpResults = await Promise.allSettled([loadSnmpInterfaces(), loadSnmpPollingStatus(), loadSnmpPollingHistory(), loadGlobalUplinks()]);
    snmpResults.filter(item => item.status === 'rejected').forEach(item => console.warn('[INIT][SNMP]', item.reason));

    startAutoRefresh();
    renderRowConfigEditor(Number(document.getElementById('rowCountInput').value));
    populateVendorSelect('Cisco', 'Catalyst 2960X 24TS-L');
    updateFaceplatePreviewInModal();
  } catch (err) {
    console.error('[INIT][FATAL]', err);
    alert(err.message || 'Błąd inicjalizacji');
  }
}


function bindTabs() {
  document.querySelectorAll('.tab-btn[data-tab-group][data-tab-target]').forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tabGroup, btn.dataset.tabTarget));
  });
}

function activateTab(group, targetId) {
  if (!group || !targetId) return;
  document.querySelectorAll(`.tab-btn[data-tab-group="${group}"]`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tabTarget === targetId);
  });
  document.querySelectorAll(`.tab-panel[data-tab-group="${group}"]`).forEach(panel => {
    panel.classList.toggle('active', panel.id === targetId);
  });
}

function bindNav() {
  document.querySelectorAll('.nav-link').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  document.getElementById('quickAddRoomBtn').addEventListener('click', () => switchView('rooms'));
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    const result = await api('/api/logout', { method: 'POST' });
    if (result && result.logoutUrl) {
      window.location.href = result.logoutUrl;
      return;
    }
    window.location.href = '/';
  });
  document.getElementById('refreshAuditBtn').addEventListener('click', loadAudit);
  document.getElementById('refreshMapBtn')?.addEventListener('click', loadNetworkMap);
  document.getElementById('applyMapFiltersBtn')?.addEventListener('click', () => {
    state.mapFilters.building = document.getElementById('mapBuildingFilter').value;
    state.mapFilters.roomId = document.getElementById('mapRoomFilter').value;
    state.mapFilters.vlan = document.getElementById('mapVlanFilter').value.trim();
    loadNetworkMap();
  });
  document.getElementById('mapBuildingFilter')?.addEventListener('change', () => {
    state.mapFilters.building = document.getElementById('mapBuildingFilter').value;
    state.mapFilters.roomId = '';
    populateMapFilterControls();
  });
  document.getElementById('refreshReportBtn').addEventListener('click', loadReport);
  document.getElementById('refreshSnmpBtn')?.addEventListener('click', () => loadSnmpInterfaces(true, 'auto'));
  document.getElementById('pollSnmpBtn')?.addEventListener('click', () => loadSnmpInterfaces(true, 'snmp'));
  document.getElementById('saveSnmpPollingBtn')?.addEventListener('click', saveSnmpPollingConfig);
  document.getElementById('runSnmpPollingBtn')?.addEventListener('click', runSnmpPollingNow);
  document.getElementById('refreshSnmpHistoryBtn')?.addEventListener('click', loadSnmpPollingHistory);
  document.getElementById('refreshUplinksGlobalBtn')?.addEventListener('click', loadGlobalUplinks);
  document.getElementById('refreshPatchLogicBtn')?.addEventListener('click', renderPatchLogicTable);
  document.getElementById('refreshDatacentersBtn')?.addEventListener('click', loadDatacentersView);
  document.getElementById('refreshFlowBtn')?.addEventListener('click', loadFlowTelemetry);
  document.getElementById('refreshCollectorsBtn')?.addEventListener('click', loadCollectorsView);
  document.getElementById('refreshConflictsBtn')?.addEventListener('click', loadConflictsView);
  document.getElementById('refreshPostgresBtn')?.addEventListener('click', loadPostgresStatus);
  document.getElementById('testPostgresBtn')?.addEventListener('click', testPostgresBridge);
  document.getElementById('pushPostgresBtn')?.addEventListener('click', pushPostgresSyncNow);
  document.getElementById('pullPostgresBtn')?.addEventListener('click', pullPostgresSyncNow);
  document.getElementById('refreshRolesBtn')?.addEventListener('click', loadRolesView);
  document.getElementById('exportRolesJsonBtn')?.addEventListener('click', exportRolesJson);
  document.getElementById('testFlowCollectorBtn')?.addEventListener('click', testFlowCollector);
  document.getElementById('exportFlowJsonBtn')?.addEventListener('click', exportFlowJson);
  document.getElementById('exportPostgresBtn')?.addEventListener('click', exportPostgresSnapshot);
  document.getElementById('refreshMap3dBtn')?.addEventListener('click', loadMap3dView);
  document.getElementById('toggleMap3dModeBtn')?.addEventListener('click', toggleMap3dMode);
  document.getElementById('exportMap3dJsonBtn')?.addEventListener('click', exportMap3dJson);
  document.getElementById('refreshDependenciesBtn')?.addEventListener('click', loadDependenciesView);
  document.getElementById('refreshApplicationsBtn')?.addEventListener('click', loadApplicationsView);
  document.getElementById('exportApplicationsCsvBtn')?.addEventListener('click', exportApplicationsCsv);
  document.getElementById('refreshAutodocBtn')?.addEventListener('click', loadAutoDocsView);
  document.getElementById('exportAutodocJsonBtn')?.addEventListener('click', exportAutodocJson);
  document.getElementById('exportAutodocMdBtn')?.addEventListener('click', exportAutodocMd);
  document.getElementById('refreshCollectorPerfBtn')?.addEventListener('click', loadCollectorPerfView);
  document.getElementById('exportCollectorPerfCsvBtn')?.addEventListener('click', exportCollectorPerfCsv);
  document.getElementById('exportDependenciesCsvBtn')?.addEventListener('click', exportDependenciesCsv);
  document.getElementById('refreshCableVizBtn')?.addEventListener('click', loadCableVisualizationView);
  document.getElementById('exportCableCsvBtn')?.addEventListener('click', exportCableCsv);
  document.getElementById('refreshRoutingBtn')?.addEventListener('click', loadRoutingTable);
  document.getElementById('refreshOpsMetricsBtn')?.addEventListener('click', loadOpsMetrics);
  document.getElementById('runBackupNowBtn')?.addEventListener('click', runBackupNow);
  document.getElementById('backupConfigForm')?.addEventListener('submit', saveBackupConfig);
  document.getElementById('refreshServicesBtn')?.addEventListener('click', loadServicesPanel);
  document.getElementById('saveServicesBtn')?.addEventListener('click', saveServicesConfig);
  document.getElementById('refreshDockerBtn')?.addEventListener('click', loadDockerPanel);
  document.getElementById('alertsForm')?.addEventListener('submit', saveAlertsConfig);
  document.getElementById('testAlertsBtn')?.addEventListener('click', sendAlertsTest);
  document.getElementById('refreshRuntimeLogBtn')?.addEventListener('click', loadRuntimeLog);
  document.getElementById('refreshUsersBtn')?.addEventListener('click', loadUsersPanel);
  document.getElementById('refreshSshBtn')?.addEventListener('click', loadSshPanel);
  document.getElementById('refreshTerminalSessionsBtn')?.addEventListener('click', loadTerminalSessionsPanel);
  document.getElementById('refreshTerminalPoliciesBtn')?.addEventListener('click', loadTerminalPoliciesPanel);
  document.getElementById('saveTerminalPoliciesBtn')?.addEventListener('click', saveTerminalPoliciesPanel);
  document.getElementById('refreshTerminalAuditBtn')?.addEventListener('click', loadTerminalAuditPanel);
  document.getElementById('refreshRoutesAuditBtn')?.addEventListener('click', loadRoutesAuditPanel);
  document.getElementById('saveSshProfilesBtn')?.addEventListener('click', saveSshProfiles);
  document.getElementById('runSshCommandBtn')?.addEventListener('click', runSshCommandFromUi);
  document.getElementById('startLiveTerminalBtn')?.addEventListener('click', startLiveTerminal);
  document.getElementById('stopLiveTerminalBtn')?.addEventListener('click', stopLiveTerminal);
  document.getElementById('refresh2faBtn')?.addEventListener('click', loadTwoFactorStatus);
  document.getElementById('generate2faBtn')?.addEventListener('click', generateTwoFactorSecret);
  document.getElementById('enable2faBtn')?.addEventListener('click', enableTwoFactor);
  document.getElementById('disable2faBtn')?.addEventListener('click', disableTwoFactor);
  document.getElementById('refreshTasksBtn')?.addEventListener('click', loadTasksPanel);
  document.getElementById('saveTasksBtn')?.addEventListener('click', saveTasksConfig);
  document.getElementById('snmpRoomSelect')?.addEventListener('change', onSnmpRoomChange);
  document.getElementById('snmpRackSelect')?.addEventListener('change', onSnmpRackChange);
  document.getElementById('snmpDeviceSelect')?.addEventListener('change', onSnmpDeviceChange);
  document.getElementById('runMonitoringScanBtn')?.addEventListener('click', runMonitoringScanNow);
  document.getElementById('importJsonInput')?.addEventListener('change', importJsonBackup);
  document.getElementById('cableRouteForm')?.addEventListener('submit', onSaveCableRoute);
  document.getElementById('postgresForm')?.addEventListener('submit', savePostgresConfig);
  document.getElementById('rolesForm')?.addEventListener('submit', saveRoleConfig);
  document.getElementById('userCreateForm')?.addEventListener('submit', createUserFromUi);
  document.getElementById('flowCollectorForm')?.addEventListener('submit', saveFlowCollectorConfig);
  document.getElementById('refreshEnterpriseBtn')?.addEventListener('click', loadEnterpriseSuite);
  document.getElementById('saveEnterpriseBtn')?.addEventListener('click', saveEnterpriseSuite);
  document.getElementById('refreshIdentityBtn')?.addEventListener('click', loadIdentityPanel);
  document.getElementById('saveIdentityBtn')?.addEventListener('click', saveIdentityPanel);
  document.getElementById('createTicketBtn')?.addEventListener('click', createTicketFromUi);
  document.getElementById('refreshRemoteBtn')?.addEventListener('click', loadRemotePanel);
  document.getElementById('saveRemoteBtn')?.addEventListener('click', saveRemotePanel);
  document.getElementById('testDbProfileBtn')?.addEventListener('click', testDbProfileFromUi);
  document.getElementById('refreshDiscoveryBtn')?.addEventListener('click', loadDiscoveryBrandingPanel);
  document.getElementById('saveDiscoveryBtn')?.addEventListener('click', saveDiscoveryPanel);
  document.getElementById('runDiscoveryBtn')?.addEventListener('click', runDiscoveryFromUi);
  document.getElementById('refreshMetricsCenterBtn')?.addEventListener('click', loadMetricsCenterPanel);
  document.getElementById('saveMetricsCenterBtn')?.addEventListener('click', saveMetricsCenterPanel);
  document.getElementById('metricsCenterForm')?.addEventListener('submit', saveMetricsCenterPanel);
  document.getElementById('refreshAgentsBtn')?.addEventListener('click', loadAgentsPanel);
  document.getElementById('pollAgentsBtn')?.addEventListener('click', pollAgentsNowFromUi);
  document.getElementById('saveAgentsBtn')?.addEventListener('click', saveAgentsPanel);
  document.getElementById('agentsConfigForm')?.addEventListener('submit', saveAgentsPanel);
  document.getElementById('saveBrandingBtn')?.addEventListener('click', saveBrandingFromUi);
}





function bindForms() {
  document.getElementById('rowCountInput').addEventListener('input', e => renderRowConfigEditor(Number(e.target.value)));
  document.getElementById('roomForm').addEventListener('submit', onSaveRoom);
  document.getElementById('cancelRoomEditBtn').addEventListener('click', resetRoomForm);
  document.getElementById('rackRoomSelect').addEventListener('change', e => {
    state.currentRoomId = Number(e.target.value);
    populateRackSelect();
  });
  document.getElementById('rackSelect').addEventListener('change', e => {
    state.currentRackId = Number(e.target.value);
    renderRack();
    syncSnmpWithRack();
  });
  document.getElementById('toggleRackSideBtn').addEventListener('click', () => {
    state.currentSide = state.currentSide === 'front' ? 'rear' : 'front';
    document.getElementById('toggleRackSideBtn').textContent = state.currentSide === 'front' ? 'Pokaż tył szafy' : 'Pokaż przód szafy';
    renderRack();
  });
  document.getElementById('showAddDeviceBtn').addEventListener('click', () => {
    openDeviceModalForCreate();
  });
  document.getElementById('closeDeviceModalBtn').addEventListener('click', () => document.getElementById('deviceModal').classList.add('hidden'));
  document.getElementById('deviceForm').addEventListener('submit', onAddDevice);
  document.getElementById('deviceVendorSelect').addEventListener('change', e => populateModelSelect(e.target.value));
  document.getElementById('deviceModelSelect').addEventListener('change', updateFaceplatePreviewInModal);
  document.querySelector('#deviceForm select[name="type"]').addEventListener('change', e => autoAdjustModelOptionsByType(e.target.value));
  document.getElementById('portForm').addEventListener('submit', onSavePort);
  document.getElementById('powerForm').addEventListener('submit', onSavePower);
  document.getElementById('connectionForm').addEventListener('submit', onCreateConnection);
  document.getElementById('portDeviceSelect').addEventListener('change', () => {
    populatePortNumbers();
    syncPowerForm();
    syncLeftConnectionForm();
  });
  document.getElementById('portNumberSelect').addEventListener('change', () => { state.selectedPortNumber = Number(document.getElementById('portNumberSelect').value) || null; fillPortFormFromSelection(); loadSelectedDeviceTelemetry(true).finally(() => renderDeviceInspector()); });
  document.getElementById('powerDeviceSelect').addEventListener('change', syncPowerForm);
  document.getElementById('connLeftDeviceSelect').addEventListener('change', syncLeftConnectionForm);
  document.getElementById('connRightRoomSelect').addEventListener('change', populateRightRackSelect);
  document.getElementById('connRightRackSelect').addEventListener('change', populateRightDeviceSelect);
  document.getElementById('connRightDeviceSelect').addEventListener('change', populateRightPortSelect);
  document.getElementById('disconnectPortBtn').addEventListener('click', disconnectSelectedPort);
  document.getElementById('openDeviceInspectorModalBtn').addEventListener('click', openDeviceInspectorModal);
  document.getElementById('closeDeviceInspectorModalBtn').addEventListener('click', () => document.getElementById('deviceInspectorModal').classList.add('hidden'));
  document.getElementById('rackFilterInput').addEventListener('input', e => {
    state.rackFilter = e.target.value.trim().toLowerCase();
    renderRack();
  });
  document.getElementById('globalSearchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      state.rackFilter = e.target.value.trim().toLowerCase();
      document.getElementById('rackFilterInput').value = e.target.value.trim();
      switchView('rack');
      renderRack();
    }
  });
}

function switchView(viewName) {
  const requestedView = viewName;
  if (viewName === 'snmp') viewName = 'rack';
  Object.entries(views).forEach(([name, el]) => { if (el) el.classList.toggle('active', name === viewName); });
  document.querySelectorAll('.nav-link').forEach(btn => btn.classList.toggle('active', btn.dataset.view === requestedView));
  const titles = {
    dashboard: ['Panel główny', 'Podgląd infrastruktury, monitoringu i ostrzeżeń.'],
    rooms: ['Serwerownie', 'Dodawanie pomieszczeń i konfiguracji rzędów.'],
    rack: ['Szafa rack', 'Przód, tył, urządzenia, porty i zasilanie A/B.'],
    map: ['Mapa połączeń 2D', 'Topologia relacji między serwerowniami, szafami i urządzeniami.'],
    report: ['Raport techniczny', 'Tabela inwentaryzacyjna z portami, IP/VLAN i zasilaniem.'],
    datacenters: ['Multi-datacenter', 'Jedna tabela budynków, serwerowni, szaf i zajętości.'],
    flow: ['Flow telemetry', 'Jedna tabela collector-ready dla top talkers i obciążeń.'],
    collectors: ['Kolektory i schedulery', 'Jedna tabela stanu schedulerów, collectorów i warstwy telemetrycznej.'],
    conflicts: ['Konflikty IP / VLAN', 'Jedna tabela duplikatów adresacji i niespójności VLAN / podsieci.'],
    postgres: ['PostgreSQL', 'Bridge PostgreSQL: konfiguracja, test połączenia i snapshot modelu.'],
    roles: ['Role i uprawnienia', 'Jedna tabela użytkowników i zakresów dostępu do widoków, zmian i telemetry.'],
    map3d: ['Mapa 3D', 'Widok 3D-lite budynków, serwerowni i szaf bez naruszania stabilnego rack layoutu.'],
    dependencies: ['Zależności usług', 'Jedna tabela zależności urządzeń i wpływu awarii.'],
    applications: ['Aplikacje', 'Jedna tabela grup aplikacyjnych i zależności usług.'],
    autodoc: ['Auto docs', 'Jedna tabela automatycznej dokumentacji zasobów i eksportów.'],
    collectorPerf: ['Dashboard collectorów', 'Jedna tabela wydajności collectorów i bridge’y telemetrycznych.'],
    cable: ['Trasy kablowe', 'Jedna tabela tras kablowych i segmentów między szafami.'],
    snmp: ['SNMP / interfejsy', 'Jedno główne okno z interfejsami wybranego urządzenia i ich stanem live.'],
    ops: ['Operacje hosta', 'Metryki hosta, backupy, usługi, Docker, webhooki i runtime log.'],
    audit: ['Dziennik zmian', 'Historia operacji wykonanych w systemie.'],
  };
  document.getElementById('pageTitle').textContent = titles[requestedView][0];
  document.getElementById('pageSubtitle').textContent = titles[requestedView][1];
  if (viewName === 'rack') {
    activateTab('rackpage', requestedView === 'snmp' ? 'rack-page-snmp' : (document.querySelector('.tab-panel[data-tab-group="rackpage"].active')?.id || 'rack-page-layout'));
  }
  if (requestedView === 'map3d') loadMap3dView().catch(() => null);
  if (requestedView === 'dependencies') loadDependenciesView().catch(() => null);
  if (requestedView === 'applications') loadApplicationsView().catch(() => null);
  if (requestedView === 'autodoc') loadAutoDocsView().catch(() => null);
  if (requestedView === 'collectorPerf') loadCollectorPerfView().catch(() => null);
  if (requestedView === 'cable') loadCableVisualizationView().catch(() => null);
  if (requestedView === 'postgres') loadPostgresStatus().catch(() => null);
  if (requestedView === 'ops') loadOpsView().catch(() => null);
}


async function refreshHealth() {
  const data = await api('/api/health');
  const box = document.getElementById('healthBox');
  box.textContent = `API: OK · v${data.version}`;
  box.classList.add('ok');
}

async function loadDashboard() {
  state.dashboard = await api('/api/dashboard');
  const stats = state.dashboard.stats;
  const cards = [
    ['Budynki', stats.buildings],
    ['Serwerownie', stats.serverRooms],
    ['Szafy', stats.racks],
    ['Urządzenia', stats.devices],
    ['Porty UP', stats.livePorts],
    ['Porty z relacją', stats.linkedPorts || 0]
  ];
  document.getElementById('statsGrid').innerHTML = cards.map(([label, value]) => `
    <div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>
  `).join('');

  const monitoring = state.dashboard.monitoring || {};
  const roomLab = (state.dashboard.roomsSummary || []).find(room => String(room.roomNumber || '') === 'LAB-DC-01');
  document.getElementById('monitoringScanMeta').textContent = `Ostatni skan: ${monitoring.lastScanAt ? new Date(monitoring.lastScanAt).toLocaleString('pl-PL') : 'brak'} · tryb: ${monitoring.lastScanMode || 'n/a'}`;
  document.getElementById('monitoringSummary').innerHTML = `
    <div class="metric-card"><div class="metric-label">Online</div><div class="metric-value">${monitoring.onlineDevices}</div></div>
    <div class="metric-card"><div class="metric-label">Offline</div><div class="metric-value">${monitoring.offlineDevices}</div></div>
    <div class="metric-card"><div class="metric-label">Bez IP</div><div class="metric-value">${monitoring.unknownDevices}</div></div>
    <div class="metric-card"><div class="metric-label">Śr. latency</div><div class="metric-value">${monitoring.avgLatencyMs} ms</div></div>
    <div class="metric-card"><div class="metric-label">Uplink health</div><div class="metric-value">${monitoring.uplinkHealthPercent}%</div></div>
    <div class="metric-card"><div class="metric-label">Aktywne alerty</div><div class="metric-value">${monitoring.activeCriticalEvents || 0}</div></div>
    <div class="metric-card"><div class="metric-label">Wyciszone</div><div class="metric-value">${monitoring.mutedDevices || 0}</div></div>
  `;
  renderMonitoringHistoryChart(monitoring.historySeries || []);
  renderMonitoringDeviceTable(monitoring.devices || []);
  renderMonitoringEvents(monitoring.events || []);
  const hotRoot = document.getElementById('warningList');
  if (monitoring.busiestInterfaces?.length) {
    hotRoot.insertAdjacentHTML('beforeend', monitoring.busiestInterfaces.slice(0,5).map(p => `<div class="room-item">Top interfejs: ${escapeHtml(p.deviceLabel)} / port ${p.portNumber} — ${p.throughputMbps} Mb/s (${escapeHtml(p.building)} / pom. ${escapeHtml(String(p.roomNumber||''))} / ${escapeHtml(p.rackLabel)})</div>`).join(''));
  }

  document.getElementById('warningList').innerHTML = ([
    roomLab ? `Załadowano testową serwerownię LAB-DC-01: ${roomLab.racks} szaf, ${roomLab.frontDevices} urządzeń front, ${roomLab.rearDevices} urządzeń rear.` : null,
    ...((state.dashboard.warnings || []).length ? state.dashboard.warnings : ['Brak ostrzeżeń projektowych.'])
  ].filter(Boolean)).map(item => `<div class="room-item">${item}</div>`).join('');

  const tableRows = state.dashboard.roomsSummary.map(room => `
    <tr>
      <td>${room.building}</td>
      <td>${room.roomType}</td>
      <td>${room.roomNumber}</td>
      <td>${room.racks}</td>
      <td>${room.frontDevices}</td>
      <td>${room.rearDevices}</td>
      <td><button class="btn btn-secondary btn-small" onclick="openRoomFromDashboard(${room.id})">Otwórz</button></td>
    </tr>
  `).join('');
  document.getElementById('roomsTableWrap').innerHTML = `
    <table class="data-table">
      <thead><tr><th>Budynek</th><th>Typ</th><th>Nr</th><th>Szafy</th><th>Przód</th><th>Tył</th><th>Akcja</th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="7" class="muted">Brak danych</td></tr>'}</tbody>
    </table>
  `;
}

function renderMonitoringHistoryChart(series) {
  const root = document.getElementById('monitoringHistoryChart');
  if (!root) return;
  if (!series.length) { root.innerHTML = '<div class="device-inspector-empty">Brak próbek monitoringu.</div>'; return; }
  const width = 520; const height = 170; const pad = 28;
  const maxLatency = Math.max(10, ...series.map(p => p.latencyAvg || 0));
  const maxOnline = Math.max(1, ...series.map(p => p.onlineCount || 0));
  const x = idx => pad + (idx * ((width - pad * 2) / Math.max(1, series.length - 1)));
  const yLatency = val => height - pad - ((val || 0) / maxLatency) * (height - pad * 2);
  const yOnline = val => height - pad - ((val || 0) / maxOnline) * (height - pad * 2);
  const latencyPath = series.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${x(idx).toFixed(1)} ${yLatency(p.latencyAvg).toFixed(1)}`).join(' ');
  const onlinePath = series.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${x(idx).toFixed(1)} ${yOnline(p.onlineCount).toFixed(1)}`).join(' ');
  const labels = series.map((p, idx) => `<text x="${x(idx)}" y="${height - 8}" class="chart-label">${escapeHtml(p.label)}</text>`).join('');
  root.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="history-chart-svg" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pad}" y1="${height-pad}" x2="${width-pad}" y2="${height-pad}" class="chart-axis"></line>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height-pad}" class="chart-axis"></line>
      <path d="${onlinePath}" class="chart-line online"></path>
      <path d="${latencyPath}" class="chart-line latency"></path>
      ${series.map((p, idx) => `<circle cx="${x(idx)}" cy="${yOnline(p.onlineCount)}" r="3" class="chart-dot online"></circle><circle cx="${x(idx)}" cy="${yLatency(p.latencyAvg)}" r="3" class="chart-dot latency"></circle>`).join('')}
      ${labels}
    </svg>
    <div class="chart-legend">
      <span><i class="legend-swatch online"></i>Online devices</span>
      <span><i class="legend-swatch latency"></i>Śr. latency</span>
    </div>`;
}

function renderMonitoringDeviceTable(devices) {
  const root = document.getElementById('monitoringDeviceTable');
  if (!root) return;
  const visibleDevices = (devices || []).slice(0, 60);
  root.innerHTML = visibleDevices.length ? `
    <table class="data-table compact-table">
      <thead><tr><th>Urządzenie</th><th>IP</th><th>Status</th><th>Ping</th><th>Ruch</th><th>Monitoring</th></tr></thead>
      <tbody>${visibleDevices.map(d => `<tr>
        <td>${escapeHtml(d.label)}<div class="muted small">${escapeHtml(d.vendor)} · ${escapeHtml(d.model)}</div></td>
        <td>${escapeHtml(d.ip || '-')}</td>
        <td><span class="status-badge ${d.monitor.status}">${d.monitor.status}</span>${d.monitor.muted ? '<div class="muted small">wyciszony</div>' : ''}</td>
        <td>${d.monitor.latencyMs ?? '-'}${d.monitor.latencyMs ? ' ms' : ''}</td>
        <td>${d.monitor.throughputMbps || 0} Mb/s</td>
        <td>${d.monitorConfig?.enabled ? 'włączony' : 'wyłączony'}<div class="muted small">${escapeHtml(d.monitorConfig?.protocol || 'icmp')} / ${Number(d.monitorConfig?.intervalSec || 60)}s</div></td>
      </tr>`).join('')}</tbody>
    </table>` : '<div class="device-inspector-empty">Brak urządzeń monitorowanych.</div>';
}


function renderMonitoringEvents(events) {
  const root = document.getElementById('monitoringEventsList');
  if (!root) return;
  const visibleEvents = (events || []).slice(0, 30);
  root.innerHTML = visibleEvents.length ? visibleEvents.map(ev => `
    <div class="audit-item ${ev.severity === 'high' ? 'audit-item-high' : ''} ${ev.acknowledged ? 'audit-item-ack' : ''}">
      <div class="row-between"><div><strong>${escapeHtml(ev.type || 'EVENT')}</strong> · ${escapeHtml(ev.deviceLabel || '')}</div>${ev.acknowledged ? '<span class="tiny-chip">ACK</span>' : `<button type="button" class="btn btn-secondary btn-small" data-ack-event="${ev.id}">ACK</button>`}</div>
      <div class="muted small">${ev.ts ? new Date(ev.ts).toLocaleString('pl-PL') : '-'} · ${escapeHtml(ev.ip || '-')} ${ev.muted ? '· wyciszone' : ''}</div>
      <div>${escapeHtml(ev.message || '')}</div>
      ${ev.acknowledgedAt ? `<div class="muted small">Potwierdzone: ${new Date(ev.acknowledgedAt).toLocaleString('pl-PL')} przez ${escapeHtml(ev.acknowledgedBy || '-')}</div>` : ''}
    </div>`).join('') : '<div class="device-inspector-empty">Brak zdarzeń monitoringu.</div>';
  root.querySelectorAll('[data-ack-event]').forEach(btn => btn.addEventListener('click', () => ackMonitoringEvent(btn.dataset.ackEvent)));
}

async function runMonitoringScanNow() {
  const btn = document.getElementById('runMonitoringScanBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Skanowanie...'; }
  try {
    await api('/api/monitoring/run', { method: 'POST' });
    await Promise.all([loadDashboard(), loadNetworkMap()]);
  } catch (err) {
    alert(err.message || 'Nie udało się wykonać skanu.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Skanuj teraz'; }
  }
}

async function ackMonitoringEvent(eventId) {
  try {
    await api(`/api/monitoring/events/${eventId}/ack`, { method: 'POST' });
    await loadDashboard();
  } catch (err) {
    alert(err.message || 'Nie udało się potwierdzić zdarzenia.');
  }
}

async function saveSelectedDeviceMonitoring(payload) {
  const ref = getCurrentRack();
  const device = getSelectedFrontDevice();
  if (!ref?.room || !ref?.rack || !device) return;
  await api(`/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${device.id}/monitoring`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  await Promise.all([loadServerRooms(), loadDashboard(), loadNetworkMap()]);
  loadSelectedDeviceTelemetry().finally(() => renderDeviceInspector());
  renderRack();
}

async function saveSelectedPortThresholds(payload) {
  const ref = getCurrentRack();
  const device = getSelectedFrontDevice();
  const portNumber = Number(state.selectedPortNumber || 0);
  if (!ref?.room || !ref?.rack || !device || !portNumber) throw new Error('Wybierz urządzenie i port.');
  await api(`/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${device.id}/ports/${portNumber}/thresholds`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  const localPort = (device.ports || []).find(p => Number(p.portNumber) === portNumber);
  if (localPort) {
    localPort.thresholds = {
      ...(localPort.thresholds || {}),
      ...payload
    };
  }
  await loadSelectedDeviceTelemetry(true);
  renderDeviceInspector();
  if (!document.getElementById('deviceInspectorModal').classList.contains('hidden')) renderDeviceInspector(document.getElementById('deviceInspectorModalContent'), true);
}


async function importJsonBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    await api('/api/data/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
    alert('Import zakończony. Aplikacja odświeży dane.');
    await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
  } catch (err) {
    alert(err.message || 'Import JSON nie powiódł się.');
  } finally {
    event.target.value = '';
  }
}

function startAutoRefresh() {
  if (window.__dcimAutoRefresh) clearInterval(window.__dcimAutoRefresh);
  window.__dcimAutoRefresh = setInterval(async () => {
    try {
      await Promise.all([loadDashboard(), loadNetworkMap()]);
    } catch (_) {}
  }, 15000);
}

function populateMapFilterControls() {
  const buildingSelect = document.getElementById('mapBuildingFilter');
  const roomSelect = document.getElementById('mapRoomFilter');
  if (!buildingSelect || !roomSelect) return;
  const buildings = [...new Set(state.serverRooms.map(r => r.building))];
  buildingSelect.innerHTML = `<option value="">Wszystkie budynki</option>${buildings.map(name => `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('')}`;
  buildingSelect.value = state.mapFilters.building || '';
  const rooms = state.serverRooms.filter(room => !state.mapFilters.building || room.building === state.mapFilters.building);
  roomSelect.innerHTML = `<option value="">Wszystkie serwerownie</option>${rooms.map(room => `<option value="${room.id}">${escapeHtml(room.building)} / ${escapeHtml(room.roomNumber)} / ${escapeHtml(room.roomType)}</option>`).join('')}`;
  roomSelect.value = state.mapFilters.roomId || '';
  document.getElementById('mapVlanFilter').value = state.mapFilters.vlan || '';
}

async function loadServerRooms() {
  state.serverRooms = await api('/api/serverrooms');
  renderServerRoomsList();
  populateMapFilterControls();
  const roomSelect = document.getElementById('rackRoomSelect');
  roomSelect.innerHTML = state.serverRooms.map(room => `<option value="${room.id}">${room.building} / ${room.roomType} / ${room.roomNumber}</option>`).join('');
  if (state.serverRooms.length) {
    const preferredRoom = state.serverRooms.find(room => String(room.roomNumber || '') === 'LAB-DC-01');
    if (!state.serverRooms.some(r => r.id === state.currentRoomId)) state.currentRoomId = preferredRoom ? preferredRoom.id : state.serverRooms[0].id;
    roomSelect.value = state.currentRoomId;
    populateRackSelect();
  } else {
    document.getElementById('rackSelect').innerHTML = '';
    document.getElementById('rackCanvas').innerHTML = '<div class="muted">Brak serwerowni.</div>';
  }
  populateSnmpSelectors();
  loadDatacentersView();
  loadFlowTelemetry();
  loadCollectorsView();
  loadConflictsView();
}

function renderServerRoomsList() {
  const root = document.getElementById('serverRoomsList');
  root.innerHTML = '';
  if (!state.serverRooms.length) {
    root.innerHTML = '<div class="room-item">Brak serwerowni w pamięci aplikacji.</div>';
    return;
  }
  const roomLab = state.serverRooms.find(room => String(room.roomNumber || '') === 'LAB-DC-01');
  if (roomLab) {
    const summary = document.createElement('div');
    summary.className = 'room-item';
    summary.innerHTML = `<h4>LAB-DC-01 · dane testowe aktywne</h4><div class="muted">Budynek: ${escapeHtml(roomLab.building)} · Typ: ${escapeHtml(roomLab.roomType)} · Szafy: ${roomLab.racks.length}</div><div class="muted">To jest predefiniowana serwerownia testowa z 16 szafami, patch panelami LAN/światłowód i urządzeniami compute / core / storage.</div>`;
    root.appendChild(summary);
  }
  state.serverRooms.forEach(room => {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.innerHTML = `
      <h4>${room.building} / ${room.roomType} / ${room.roomNumber}</h4>
      <div class="muted">Wymiary: ${room.dimensions.width}m × ${room.dimensions.depth}m × ${room.dimensions.height}m</div>
      <div class="muted">Rzędy: ${room.rowConfigs.length}, Szafy: ${room.racks.length}</div>
      <p class="muted small">${room.note || 'Brak opisu.'}</p>
      <div class="inline-actions">
        <button class="btn btn-secondary btn-small" data-open-room="${room.id}">Otwórz szafy</button>
        <button class="btn btn-secondary btn-small" data-edit-room="${room.id}">Edytuj</button>
        <button class="btn btn-danger btn-small" data-delete-room="${room.id}">Usuń</button>
      </div>`;
    root.appendChild(item);
  });
  root.querySelectorAll('[data-open-room]').forEach(btn => btn.addEventListener('click', () => openRoomFromDashboard(Number(btn.dataset.openRoom))));
  root.querySelectorAll('[data-edit-room]').forEach(btn => btn.addEventListener('click', () => openRoomForEdit(Number(btn.dataset.editRoom))));
  root.querySelectorAll('[data-delete-room]').forEach(btn => btn.addEventListener('click', () => deleteRoom(Number(btn.dataset.deleteRoom))));
}

function renderRowConfigEditor(count) {
  const root = document.getElementById('rowConfigEditor');
  root.innerHTML = '';
  for (let i = 1; i <= count; i++) {
    root.innerHTML += `
      <div class="row-config-item">
        <label><span>Rząd ${i}</span><input value="${i}" disabled></label>
        <label><span>Szafy w rzędzie</span><input type="number" min="1" max="40" value="4" data-row-number="${i}" class="row-rack-count"></label>
      </div>`;
  }
}

async function onSaveRoom(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    roomNumber: fd.get('roomNumber'),
    building: fd.get('building'),
    roomType: fd.get('roomType'),
    dimensions: { width: Number(fd.get('width')), depth: Number(fd.get('depth')), height: Number(fd.get('height')) },
    note: fd.get('note'),
    rowConfigs: [...document.querySelectorAll('.row-rack-count')].map(input => ({ rowNumber: Number(input.dataset.rowNumber), rackCount: Number(input.value) }))
  };
  const roomId = Number(fd.get('roomId') || 0);
  const method = roomId ? 'PUT' : 'POST';
  const url = roomId ? `/api/serverrooms/${roomId}` : '/api/serverrooms';
  await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  resetRoomForm();
  await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
  switchView('dashboard');
}

function openRoomForEdit(roomId) {
  const room = state.serverRooms.find(r => r.id === Number(roomId));
  if (!room) return;
  state.editingRoomId = room.id;
  const form = document.getElementById('roomForm');
  form.elements.roomId.value = String(room.id);
  form.elements.roomNumber.value = room.roomNumber || '';
  form.elements.building.value = room.building || '';
  form.elements.roomType.value = room.roomType || 'Serwerownia główna';
  form.elements.width.value = room.dimensions?.width || 8;
  form.elements.depth.value = room.dimensions?.depth || 5;
  form.elements.height.value = room.dimensions?.height || 3;
  form.elements.note.value = room.note || '';
  document.getElementById('rowCountInput').value = room.rowConfigs?.length || 1;
  renderRowConfigEditor(room.rowConfigs?.length || 1);
  (room.rowConfigs || []).forEach(cfg => {
    const input = document.querySelector(`.row-rack-count[data-row-number="${cfg.rowNumber}"]`);
    if (input) input.value = cfg.rackCount;
  });
  document.getElementById('roomFormTitle').textContent = `Edytuj serwerownię: ${room.building} / ${room.roomNumber}`;
  document.getElementById('cancelRoomEditBtn').classList.remove('hidden');
  switchView('rooms');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetRoomForm() {
  state.editingRoomId = null;
  const form = document.getElementById('roomForm');
  form.reset();
  form.elements.roomId.value = '';
  document.getElementById('rowCountInput').value = 2;
  renderRowConfigEditor(2);
  document.getElementById('roomFormTitle').textContent = 'Dodaj serwerownię';
  document.getElementById('cancelRoomEditBtn').classList.add('hidden');
}

async function deleteRoom(roomId) {
  if (!confirm('Na pewno usunąć serwerownię?')) return;
  await api(`/api/serverrooms/${roomId}`, { method: 'DELETE' });
  await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
}

function openRoomFromDashboard(roomId) {
  state.currentRoomId = roomId;
  switchView('rack');
  document.getElementById('rackRoomSelect').value = String(roomId);
  populateRackSelect();
}
window.openRoomFromDashboard = openRoomFromDashboard;

function populateRackSelect() {
  const room = state.serverRooms.find(r => r.id === Number(state.currentRoomId));
  const rackSelect = document.getElementById('rackSelect');
  rackSelect.innerHTML = (room?.racks || []).map(rack => `<option value="${rack.id}">${rack.label} / Rząd ${rack.rowNumber} / Poz. ${rack.positionInRow}</option>`).join('');
  if (room?.racks?.length) {
    if (!room.racks.some(r => r.id === state.currentRackId)) state.currentRackId = room.racks[0].id;
    rackSelect.value = String(state.currentRackId);
    renderRack();
  } else {
    document.getElementById('rackCanvas').innerHTML = '<div class="muted">Brak szaf w wybranej serwerowni.</div>';
    document.getElementById('deviceList').innerHTML = '';
  }
  populateSnmpSelectors();
  loadDatacentersView();
  loadFlowTelemetry();
  loadCollectorsView();
  loadConflictsView();
}

function getCurrentRack() {
  const room = state.serverRooms.find(r => r.id === Number(state.currentRoomId));
  const rack = room?.racks?.find(r => r.id === Number(state.currentRackId));
  return { room, rack };
}

function filteredDevices(devices) {
  if (!state.rackFilter) return devices;
  return devices.filter(device => JSON.stringify(device).toLowerCase().includes(state.rackFilter));
}

function isSwitchLike(device) {
  return /switch/i.test(String(device?.type || ''));
}

function renderFrontPanel(device, compact = false) {
  if (!isSwitchLike(device)) return '';
  const svg = window.renderSwitchFaceplateSvg ? window.renderSwitchFaceplateSvg(device, compact ? { width: 760, height: 116 } : { width: 860, height: 150 }) : '';
  return `<div class="switch-faceplate ${compact ? 'compact' : ''}">${svg}</div>`;
}

function populateVendorSelect(selectedVendor, selectedModel) {
  const vendorSelect = document.getElementById('deviceVendorSelect');
  if (!vendorSelect) return;
  const vendors = Object.keys(state.faceplateCatalog || {});
  vendorSelect.innerHTML = vendors.map(v => `<option value="${v}">${v}</option>`).join('');
  vendorSelect.value = selectedVendor && vendors.includes(selectedVendor) ? selectedVendor : (vendors[0] || 'Inne / Generic');
  populateModelSelect(vendorSelect.value, selectedModel);
}

function populateModelSelect(vendor, selectedModel) {
  const modelSelect = document.getElementById('deviceModelSelect');
  if (!modelSelect) return;
  const models = state.faceplateCatalog?.[vendor]?.models || ['Generic 24-port'];
  modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
  modelSelect.value = selectedModel && models.includes(selectedModel) ? selectedModel : models[0];
  updateFaceplatePreviewInModal();
}

function autoAdjustModelOptionsByType(type) {
  const vendorSelect = document.getElementById('deviceVendorSelect');
  const modelSelect = document.getElementById('deviceModelSelect');
  if (!vendorSelect || !modelSelect) return;
  const vendor = vendorSelect.value;
  let models = state.faceplateCatalog?.[vendor]?.models || [];
  const filtered = models.filter(m => (/48-port/i.test(type) ? /48/.test(m) : /24-port/i.test(type) ? /24/.test(m) : true));
  models = filtered.length ? filtered : (models.length ? models : ['Generic 24-port']);
  modelSelect.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
  updateFaceplatePreviewInModal();
}

function updateFaceplatePreviewInModal() {
  const box = document.getElementById('deviceFaceplatePreview');
  const form = document.getElementById('deviceForm');
  if (!box || !form) return;
  const type = form.elements.type.value;
  const isSwitch = /switch/i.test(type);
  const portCount = /48/.test(`${type} ${form.elements.model.value}`) ? 48 : /24/.test(`${type} ${form.elements.model.value}`) ? 24 : 0;
  const device = {
    type, vendor: form.elements.vendor.value, model: form.elements.model.value,
    ports: Array.from({ length: portCount }).map((_, i) => ({ portNumber: i + 1, status: i < 2 ? 'up' : 'down', connectedTo: i === 0, cableColor: i === 0 ? '#22c55e' : '#334155' }))
  };
  box.innerHTML = isSwitch ? renderFrontPanel(device) : '<p class="muted small">Dla tego typu urządzenia używany jest widok opisowy zamiast front panelu.</p>';
}


function openDeviceModalForCreate() {
  state.editingDeviceId = null;
  const form = document.getElementById('deviceForm');
  form.reset();
  form.elements.side.value = state.currentSide;
  form.elements.type.value = 'Switch 24-port';
  populateVendorSelect('Cisco', 'Catalyst 2960X 24TS-L');
  form.elements.startU.value = '1';
  form.elements.sizeU.value = '1';
  document.getElementById('deviceModalTitle').textContent = 'Dodaj urządzenie do szafy';
  document.getElementById('deviceSubmitBtn').textContent = 'Dodaj urządzenie';
  document.getElementById('deviceFormError').classList.add('hidden');
  updateFaceplatePreviewInModal();
  document.getElementById('deviceModal').classList.remove('hidden');
}

function openDeviceModalForEdit(deviceId) {
  const ref = getCurrentRack();
  const list = state.currentSide === 'front' ? (ref?.rack?.frontDevices || []) : (ref?.rack?.rearDevices || []);
  const device = list.find(d => d.id === Number(deviceId));
  if (!device) return;
  state.editingDeviceId = device.id;
  const form = document.getElementById('deviceForm');
  form.elements.side.value = state.currentSide;
  form.elements.type.value = device.type;
  form.elements.label.value = device.label;
  populateVendorSelect(device.vendor || 'Inne / Generic', device.model || 'Generic 24-port');
  form.elements.startU.value = device.startU;
  form.elements.sizeU.value = device.sizeU;
  document.getElementById('deviceModalTitle').textContent = 'Edytuj urządzenie';
  document.getElementById('deviceSubmitBtn').textContent = 'Zapisz zmiany';
  document.getElementById('deviceFormError').classList.add('hidden');
  updateFaceplatePreviewInModal();
  document.getElementById('deviceModal').classList.remove('hidden');
}

function renderRack() {
  const ref = getCurrentRack();
  if (!ref?.rack) return;
  const { rack } = ref;
  const rawDevices = state.currentSide === 'front' ? rack.frontDevices : rack.rearDevices;
  const devices = filteredDevices(rawDevices);
  document.getElementById('rackTitle').textContent = `${rack.label} — ${state.currentSide === 'front' ? 'przód' : 'tył'}`;
  const deviceCountBox = document.getElementById('deviceCountBox'); if (deviceCountBox) deviceCountBox.textContent = `${devices.length} urządzeń widocznych`;

  const occupiedUnits = new Set();
  rawDevices.forEach(device => {
    for (let u = Number(device.startU); u < Number(device.startU) + Number(device.sizeU); u++) occupiedUnits.add(u);
  });
  document.getElementById('rackOccupancyBadge').textContent = `${Math.round((occupiedUnits.size / rack.sizeU) * 100)}% zajętości`;

  const canvas = document.getElementById('rackCanvas');
  canvas.innerHTML = '';

  const rackShell = document.createElement('div');
  rackShell.className = 'rack-shell';

  const frame = document.createElement('div');
  frame.className = 'rack-frame';
  const unitHeight = 24;
  const unitGap = 4;
  const rowHeight = unitHeight + unitGap;
  const shellTopPadding = 22;
  const shellLeftOffset = 72;
  const shellRightOffset = 18;

  for (let u = rack.sizeU; u >= 1; u--) {
    const unit = document.createElement('div');
    unit.className = 'rack-unit';
    unit.innerHTML = `<div class="rack-u-label">U${u}</div><div class="rack-slot ${occupiedUnits.has(u) ? 'occupied' : ''}"></div>`;
    frame.appendChild(unit);
  }

  const overlay = document.createElement('div');
  overlay.className = 'rack-overlay';

  rackShell.appendChild(frame);
  rackShell.appendChild(overlay);
  canvas.appendChild(rackShell);

  devices.forEach(device => {
    const el = document.createElement('button');
    const isSwitch = isSwitchLike(device);
    const isCompact = Number(device.sizeU) <= 1;
    el.className = `rack-device ${isSwitch ? 'switch-device' : ''} ${isCompact ? 'rack-device-1u' : ''} ${Number(device.id) === Number(state.selectedDeviceId) ? 'selected-device' : ''}`;
    el.type = 'button';
    const top = shellTopPadding + ((rack.sizeU - (Number(device.startU) + Number(device.sizeU) - 1)) * rowHeight);
    const height = Math.max((Number(device.sizeU) * unitHeight) + ((Number(device.sizeU) - 1) * unitGap), isCompact ? 34 : 56);
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.style.left = `${shellLeftOffset}px`;
    el.style.right = `${shellRightOffset}px`;

    const powerPrimary = device.power?.primary?.sourceLabel || '-';
    const powerBackup = device.power?.backup?.sourceLabel || '-';
    const powerBadge = device.power?.primary?.sourceLabel || device.power?.backup?.sourceLabel
      ? `<span class="tiny-chip">A:${escapeHtml(powerPrimary)} · B:${escapeHtml(powerBackup)}</span>`
      : '';
    const subtitle = `${device.vendor || 'Generic'} · ${device.model || device.type} · ${device.sizeU}U · U${device.startU}`;
    const metaHtml = `
      <div class="rack-device-header">
        <div class="rack-device-copy">
          <strong class="rack-device-title" title="${escapeHtml(device.label)}">${escapeHtml(device.label)}</strong>
          <small class="rack-device-subtitle" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</small>
        </div>
        ${!isCompact ? `<div class="rack-device-miniports">${renderDevicePortsMini(device, isSwitch ? 10 : 8)}</div>` : ''}
      </div>
      ${!isCompact && powerBadge ? `<div class="rack-device-badges">${powerBadge}</div>` : ''}
    `;

    if (isSwitch) {
      el.innerHTML = `
        <div class="rack-device-body">
          ${metaHtml}
          ${isCompact ? '' : renderFrontPanel(device, true)}
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="rack-device-body rack-device-body-simple">
          ${metaHtml}
        </div>
      `;
    }

    el.addEventListener('click', () => focusDevice(device.id));
    overlay.appendChild(el);
  });

  const deviceList = document.getElementById('deviceList');
  if (deviceList) {
  deviceList.innerHTML = '';
  devices.forEach(device => {
    const item = document.createElement('div');
    item.className = `device-item ${Number(device.id) === Number(state.selectedDeviceId) ? 'selected-device-card' : ''}`;
    item.innerHTML = `
      <div class="panel-head-row">
        <h4>${device.label}</h4>
        <div class="inline-actions no-margin">
          <button class="btn btn-secondary btn-small" data-device-edit="${device.id}">Edytuj</button>
          <button class="btn btn-danger btn-small" data-device-delete="${device.id}">Usuń</button>
        </div>
      </div>
      <div class="muted">${device.type} · ${device.sizeU}U · U${device.startU}</div>
      ${device.network?.ip ? `<div class="muted small">IP: ${device.network.ip} · VLAN: ${device.network.vlan || '-'}</div>` : ''}
      ${device.power ? `<div class="muted small">Zasilanie A: ${device.power.primary?.sourceLabel || '-'} / B: ${device.power.backup?.sourceLabel || '-'}</div>` : ''}
      ${renderDevicePorts(device)}
    `;
    deviceList.appendChild(item);
  });
  deviceList.querySelectorAll('[data-device-delete]').forEach(btn => btn.addEventListener('click', () => deleteDevice(Number(btn.dataset.deviceDelete))));
  deviceList.querySelectorAll('[data-device-edit]').forEach(btn => btn.addEventListener('click', () => openDeviceModalForEdit(Number(btn.dataset.deviceEdit))));
  }
  if (!rawDevices.some(device => Number(device.id) === Number(state.selectedDeviceId))) state.selectedDeviceId = Number(rawDevices[0]?.id || 0) || null;
  populatePortDeviceSelect();
  populatePowerDeviceSelect();
  populateLeftConnectionDevices();
  populateRightRoomSelect();
  renderDeviceInspector();
  renderRackWorkspaceTables();
  loadSelectedDeviceTelemetry();
}

function renderDevicePortsMini(device, limit = 12) {
  if (!device.ports?.length) return '<span class="muted small">brak portów</span>';
  return `<div class="device-ports compact">${device.ports.slice(0, limit).map(port => `<span class="port-dot" title="Port ${port.portNumber}${port.target ? ': ' + port.target : ''}" style="background:${port.cableColor || (port.status === 'up' ? '#22c55e' : '#64748b')}"></span>`).join('')}</div>`;
}

function renderDevicePorts(device) {
  if (!device.ports?.length) return '<div class="muted small">Brak portów.</div>';
  return `<div class="device-ports">${device.ports.map(port => `<span class="port-dot ${port.connectedTo ? 'linked' : ''}" title="Port ${port.portNumber}: ${port.target || 'brak opisu'}" style="background:${port.cableColor || (port.status === 'up' ? '#22c55e' : '#64748b')}"></span>`).join('')}</div>`;
}

function getCurrentRackDevices() {
  return getCurrentRack()?.rack?.frontDevices || [];
}

function renderStatusPill(status = 'down') {
  const normalized = String(status || 'down').toLowerCase();
  const pillClass = normalized === 'up' ? 'status-badge up' : 'status-badge down';
  const label = normalized === 'error' ? 'error' : normalized;
  return `<span class="${pillClass}">${escapeHtml(label)}</span>`;
}

function buildPortRows() {
  return getCurrentRackDevices().flatMap(device => (device.ports || []).map(port => ({
    device,
    port,
    speed: port.speed || port.liveSpeed || port.bandwidth || '-',
    poe: port.poe || port.poeState || '—'
  })));
}

function buildConnectionRows() {
  const seen = new Set();
  const rows = [];
  getCurrentRackDevices().forEach(device => {
    (device.ports || []).forEach(port => {
      if (!port.connectedTo) return;
      const ids = [
        `${state.currentRoomId}:${state.currentRackId}:${device.id}:${port.portNumber}`,
        `${port.connectedTo.roomId}:${port.connectedTo.rackId}:${port.connectedTo.deviceId}:${port.connectedTo.portNumber}`
      ].sort();
      const key = ids.join('|');
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ device, port, meta: port.connectionMeta || {}, connectedTo: port.connectedTo });
    });
  });
  return rows;
}

function buildPowerRows() {
  return getCurrentRackDevices().map(device => ({
    device,
    primary: device.power?.primary || {},
    backup: device.power?.backup || {}
  }));
}

function renderPortTable() {
  const body = document.getElementById('portTableBody');
  const badge = document.getElementById('portSummaryBadge');
  if (!body || !badge) return;
  const rows = buildPortRows();
  badge.textContent = `${rows.length} portów`;
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="muted">Brak portów w tej szafie.</td></tr>'; return; }
  body.innerHTML = rows.map(({ device, port, speed, poe }) => `
    <tr class="${Number(device.id) === Number(state.selectedDeviceId) && Number(port.portNumber) === Number(state.selectedPortNumber) ? 'row-active' : ''}" data-port-row="${device.id}:${port.portNumber}">
      <td><strong>${escapeHtml(device.label)}</strong><div class="muted small">${escapeHtml(device.type)} · U${escapeHtml(String(device.startU || '-'))}</div></td>
      <td>Port ${escapeHtml(String(port.portNumber))}</td>
      <td>${renderStatusPill(port.status || 'down')}</td>
      <td>${escapeHtml(port.vlan || '—')}</td>
      <td>${escapeHtml(port.ip || '—')}</td>
      <td>${escapeHtml(String(speed))}</td>
      <td>${escapeHtml(String(poe))}</td>
      <td>${escapeHtml(port.target || 'Brak celu')}</td>
    </tr>`).join('');
}

function renderConnectionTable() {
  const body = document.getElementById('connectionTableBody');
  const badge = document.getElementById('connectionSummaryBadge');
  if (!body || !badge) return;
  const rows = buildConnectionRows();
  badge.textContent = `${rows.length} połączeń`;
  if (!rows.length) { body.innerHTML = '<tr><td colspan="8" class="muted">Brak połączeń dla tej szafy.</td></tr>'; return; }
  body.innerHTML = rows.map(({ device, port, meta, connectedTo }) => `
    <tr class="${Number(device.id) === Number(state.selectedDeviceId) && Number(port.portNumber) === Number(state.selectedPortNumber) ? 'row-active' : ''}" data-connection-row="${device.id}:${port.portNumber}">
      <td><strong>${escapeHtml(device.label)}</strong></td>
      <td>Port ${escapeHtml(String(port.portNumber))}</td>
      <td>${escapeHtml(port.target || 'Brak celu')}</td>
      <td>Port ${escapeHtml(String(connectedTo?.portNumber || '—'))}</td>
      <td>${escapeHtml(meta.medium || '—')}</td>
      <td>${escapeHtml(meta.cableLabel || '—')}<div class="muted small">${escapeHtml(meta.routeName || 'bez trasy')}</div></td>
      <td>${escapeHtml(String(meta.cableLengthM || '—'))}${meta.cableLengthM ? ' m' : ''}</td>
      <td>${renderStatusPill(port.status || 'up')}</td>
    </tr>`).join('');
}

function renderPowerTable() {
  const body = document.getElementById('powerTableBody');
  const badge = document.getElementById('powerSummaryBadge');
  if (!body || !badge) return;
  const rows = buildPowerRows();
  badge.textContent = `${rows.length} urządzeń`;
  if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="muted">Brak urządzeń w tej szafie.</td></tr>'; return; }
  body.innerHTML = rows.map(({ device, primary, backup }) => {
    const redundant = primary.sourceLabel && backup.sourceLabel;
    return `
      <tr class="${Number(device.id) === Number(state.selectedDeviceId) ? 'row-active' : ''}" data-power-row="${device.id}">
        <td><strong>${escapeHtml(device.label)}</strong><div class="muted small">${escapeHtml(device.type)}</div></td>
        <td>${escapeHtml(String(device.sizeU || '-'))}U · U${escapeHtml(String(device.startU || '-'))}</td>
        <td>${escapeHtml(primary.sourceLabel || '—')}</td>
        <td>${escapeHtml(String(primary.outletNumber || '—'))}</td>
        <td>${escapeHtml(backup.sourceLabel || '—')}</td>
        <td>${escapeHtml(String(backup.outletNumber || '—'))}</td>
        <td>${redundant ? '<span class="status-badge up">A/B</span>' : '<span class="status-badge down">single</span>'}</td>
      </tr>`;
  }).join('');
}

function buildTopologyRows() {
  const ref = getCurrentRack();
  const room = ref?.room;
  const rack = ref?.rack;
  if (!room || !rack) return [];
  const seen = new Set();
  const rows = [];
  (rack.frontDevices || []).forEach(device => {
    (device.ports || []).forEach(port => {
      if (!port.connectedTo) return;
      const remoteRoom = state.serverRooms.find(r => Number(r.id) === Number(port.connectedTo.roomId));
      const remoteRack = remoteRoom?.racks?.find(r => Number(r.id) === Number(port.connectedTo.rackId));
      const remoteDevice = remoteRack?.frontDevices?.find(d => Number(d.id) === Number(port.connectedTo.deviceId))
        || remoteRack?.rearDevices?.find(d => Number(d.id) === Number(port.connectedTo.deviceId));
      const pair = [
        [room.id, rack.id, device.id, port.portNumber].join('-'),
        [port.connectedTo.roomId, port.connectedTo.rackId, port.connectedTo.deviceId, port.connectedTo.portNumber].join('-')
      ].sort().join('::');
      if (seen.has(pair)) return;
      seen.add(pair);
      const sameRack = Number(port.connectedTo.roomId) === Number(room.id) && Number(port.connectedTo.rackId) === Number(rack.id);
      const medium = port.connectionMeta?.medium || '';
      rows.push({
        localDeviceId: Number(device.id),
        localDeviceLabel: device.label,
        localPort: Number(port.portNumber),
        remoteLabel: [remoteRoom?.building, remoteRoom?.roomNumber ? `Pom. ${remoteRoom.roomNumber}` : '', remoteRack?.label, remoteDevice?.label].filter(Boolean).join(' / ') || port.target || 'Nieznany cel',
        remotePort: Number(port.connectedTo.portNumber) || '',
        relationType: sameRack ? 'wewnątrz szafy' : (medium === 'uplink' ? 'uplink' : 'między szafami'),
        medium: medium || '-',
        routeName: port.connectionMeta?.routeName || '-',
        cableLengthM: port.connectionMeta?.cableLengthM || '',
        status: port.status || 'down'
      });
    });
  });
  return rows.sort((a, b) => {
    if (a.relationType !== b.relationType) return a.relationType.localeCompare(b.relationType, 'pl');
    if (a.localDeviceLabel !== b.localDeviceLabel) return a.localDeviceLabel.localeCompare(b.localDeviceLabel, 'pl');
    return a.localPort - b.localPort;
  });
}

function renderTopologyTable() {
  const body = document.getElementById('topologyTableBody');
  const badge = document.getElementById('topologySummaryBadge');
  if (!body || !badge) return;
  const rows = buildTopologyRows();
  badge.textContent = `${rows.length} relacji`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">Brak relacji topologicznych dla bieżącej szafy.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td><button type="button" class="btn-link" data-topology-focus-device="${row.localDeviceId}">${escapeHtml(row.localDeviceLabel)}</button></td>
      <td>Port ${row.localPort}</td>
      <td>${escapeHtml(row.remoteLabel)}</td>
      <td>${row.remotePort ? `Port ${row.remotePort}` : '—'}</td>
      <td>${escapeHtml(row.relationType)}</td>
      <td>${escapeHtml(row.medium)}</td>
      <td>${escapeHtml(row.routeName)}</td>
      <td><span class="status-badge ${row.status === 'up' ? 'up' : (row.status === 'error' ? 'down' : 'unknown')}">${escapeHtml(row.status)}</span></td>
    </tr>`).join('');
  body.querySelectorAll('[data-topology-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.topologyFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function buildUplinkRows() {
  return buildTopologyRows().filter(row => row.relationType !== 'wewnątrz szafy' || String(row.medium || '').toLowerCase() === 'uplink');
}

function renderUplinkTable() {
  const body = document.getElementById('uplinksTableBody');
  const badge = document.getElementById('uplinksSummaryBadge');
  if (!body || !badge) return;
  const rows = buildUplinkRows();
  badge.textContent = `${rows.length} uplinków`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">Brak uplinków lub połączeń wychodzących poza bieżącą szafę.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td><button type="button" class="btn-link" data-uplink-focus-device="${row.localDeviceId}">${escapeHtml(row.localDeviceLabel)}</button></td>
      <td>Port ${row.localPort}</td>
      <td>${escapeHtml(row.remoteLabel)}</td>
      <td>${row.remotePort ? `Port ${row.remotePort}` : '—'}</td>
      <td>${escapeHtml(row.medium || '—')}</td>
      <td>${escapeHtml(row.routeName || '—')}</td>
      <td>${escapeHtml(String(row.cableLengthM || '—'))}${row.cableLengthM ? ' m' : ''}</td>
      <td><span class="status-badge ${row.status === 'up' ? 'up' : (row.status === 'error' ? 'down' : 'unknown')}">${escapeHtml(row.status || '-')}</span></td>
    </tr>`).join('');
  body.querySelectorAll('[data-uplink-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.uplinkFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function buildCapacityRows() {
  const ref = getCurrentRack();
  const rack = ref?.rack;
  if (!rack) return [];
  const devices = getCurrentRackDevices();
  const totalU = Number(rack?.sizeU || 42) || 42;
  const usedU = devices.reduce((sum, device) => sum + Math.max(1, Number(device.sizeU) || 1), 0);
  const totalPorts = devices.reduce((sum, device) => sum + ((device.ports || []).length), 0);
  const usedPorts = devices.reduce((sum, device) => sum + ((device.ports || []).filter(port => port.status === 'up' || port.connectedTo || port.target).length), 0);
  const uplinks = buildUplinkRows().length;
  const redundantPower = devices.filter(device => device.power?.primary?.sourceLabel && device.power?.backup?.sourceLabel).length;
  const routes = buildConnectionRows().filter(row => row.meta?.routeName).length;
  return [
    {
      area: 'Przestrzeń U', capacity: `${totalU}U`, used: `${usedU}U`, free: `${Math.max(0, totalU - usedU)}U`,
      status: usedU > totalU ? 'przepełniona' : (usedU / totalU > 0.8 ? 'wysoka' : 'OK'),
      details: `${devices.length} urządzeń frontowych`
    },
    {
      area: 'Porty logiczne', capacity: totalPorts, used: usedPorts, free: Math.max(0, totalPorts - usedPorts),
      status: totalPorts && usedPorts / totalPorts > 0.85 ? 'wysoka' : 'OK',
      details: `${devices.filter(device => (device.ports || []).length).length} urządzeń z portami`
    },
    {
      area: 'Uplinki / relacje', capacity: buildTopologyRows().length, used: uplinks, free: Math.max(0, buildTopologyRows().length - uplinks),
      status: uplinks ? 'OK' : 'brak',
      details: `${routes} tras kablowych z etykietą`
    },
    {
      area: 'Zasilanie A/B', capacity: devices.length, used: redundantPower, free: Math.max(0, devices.length - redundantPower),
      status: redundantPower === devices.length ? 'OK' : (redundantPower ? 'częściowa' : 'brak'),
      details: `${redundantPower}/${devices.length} urządzeń z redundancją`
    }
  ];
}

function renderCapacityTable() {
  const body = document.getElementById('capacityTableBody');
  const badge = document.getElementById('capacitySummaryBadge');
  if (!body || !badge) return;
  const rows = buildCapacityRows();
  badge.textContent = `${rows.length} kategorie`;
  body.innerHTML = rows.map(row => `
    <tr>
      <td><strong>${escapeHtml(String(row.area))}</strong></td>
      <td>${escapeHtml(String(row.capacity))}</td>
      <td>${escapeHtml(String(row.used))}</td>
      <td>${escapeHtml(String(row.free))}</td>
      <td>${renderStatusPill(row.status)}</td>
      <td>${escapeHtml(String(row.details))}</td>
    </tr>`).join('');
}

function buildHeatmapRows() {
  return getCurrentRackDevices()
    .filter(device => (device.ports || []).length)
    .map(device => {
      const ports = device.ports || [];
      const total = ports.length;
      const up = ports.filter(port => port.status === 'up').length;
      const down = ports.filter(port => port.status !== 'up').length;
      const connected = ports.filter(port => port.connectedTo || port.target).length;
      const utilizationPct = total ? Math.round((connected / total) * 100) : 0;
      const errorCount = ports.filter(port => port.status === 'error').length;
      const busiest = ports.find(port => port.connectedTo || port.target) || ports.find(port => port.status === 'up') || ports[0] || null;
      const status = errorCount ? 'błąd' : (utilizationPct > 80 ? 'wysoka' : (up ? 'OK' : 'niska'));
      return { device, total, up, down, utilizationPct, errorCount, busiest, status };
    })
    .sort((a, b) => b.utilizationPct - a.utilizationPct || a.device.label.localeCompare(b.device.label, 'pl'));
}

function renderHeatmapTable() {
  const body = document.getElementById('heatmapTableBody');
  const badge = document.getElementById('heatmapSummaryBadge');
  if (!body || !badge) return;
  const rows = buildHeatmapRows();
  badge.textContent = `${rows.length} urządzeń`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">Brak urządzeń z portami w bieżącej szafie.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td><button type="button" class="btn-link" data-heatmap-focus-device="${row.device.id}">${escapeHtml(row.device.label)}</button><div class="muted small">${escapeHtml(row.device.type || '-')}</div></td>
      <td>${row.total}</td>
      <td>${row.up}</td>
      <td>${row.down}</td>
      <td>${row.utilizationPct}%</td>
      <td>${row.errorCount}</td>
      <td>${row.busiest ? `Port ${row.busiest.portNumber}${row.busiest.target ? ` · ${escapeHtml(row.busiest.target)}` : ''}` : '—'}</td>
      <td>${renderStatusPill(row.status)}</td>
    </tr>`).join('');
  body.querySelectorAll('[data-heatmap-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.heatmapFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function getSnmpSnapshotForDevice(device) {
  const dashboardDevice = (state.dashboard?.monitoring?.devices || []).find(row => row.label === device?.label && (row.ip || '') === (device?.network?.ip || ''));
  const interfaces = (device?.ports || []).map(port => {
    const live = state.snmpInterfaces?.deviceId === device?.id ? (state.snmpInterfaces.interfaces || []).find(row => Number(row.portNumber) === Number(port.portNumber)) : null;
    return {
      operStatus: live?.operStatus || port.status || 'down',
      rxMbps: Number(live?.rxMbps || (port.status === 'up' ? 12 : 0)),
      txMbps: Number(live?.txMbps || (port.status === 'up' ? 8 : 0)),
      crcErrors: Number(live?.crcErrors || (port.status === 'error' ? 2 : 0)),
      drops: Number(live?.drops || 0)
    };
  });
  return {
    monitor: dashboardDevice?.monitor || null,
    interfaces,
    updatedAt: state.dashboard?.monitoring?.lastScanAt || null
  };
}

function buildTrafficRows() {
  return getCurrentRackDevices().map(device => {
    const snap = getSnmpSnapshotForDevice(device);
    const interfaces = snap.interfaces || [];
    const upCount = interfaces.filter(row => row.operStatus === 'up').length;
    const rxTotal = interfaces.reduce((sum, row) => sum + (Number(row.rxMbps) || 0), 0);
    const txTotal = interfaces.reduce((sum, row) => sum + (Number(row.txMbps) || 0), 0);
    const errorTotal = interfaces.reduce((sum, row) => sum + ((Number(row.crcErrors) || 0) + (Number(row.drops) || 0)), 0);
    return {
      device,
      interfaceCount: interfaces.length,
      upCount,
      rxTotal,
      txTotal,
      errorTotal,
      status: snap.monitor?.status || (device.monitoring?.enabled ? 'monitoring' : 'brak'),
      updatedAt: snap.updatedAt || snap.monitor?.updatedAt || null
    };
  }).sort((a, b) => (b.rxTotal + b.txTotal) - (a.rxTotal + a.txTotal));
}

function renderTrafficTable() {
  const body = document.getElementById('trafficTableBody');
  const badge = document.getElementById('trafficSummaryBadge');
  if (!body || !badge) return;
  const rows = buildTrafficRows();
  badge.textContent = `${rows.length} urządzeń`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">Brak danych traffic dla bieżącej szafy.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td><button type="button" class="btn-link" data-traffic-focus-device="${row.device.id}">${escapeHtml(row.device.label)}</button><div class="muted small">${escapeHtml(row.device.type || '-')}</div></td>
      <td>${renderStatusPill(row.status)}</td>
      <td>${row.interfaceCount}</td>
      <td>${row.upCount}</td>
      <td>${row.rxTotal.toFixed(1)} Mb/s</td>
      <td>${row.txTotal.toFixed(1)} Mb/s</td>
      <td>${row.errorTotal}</td>
      <td>${row.updatedAt ? new Date(row.updatedAt).toLocaleString('pl-PL') : '—'}</td>
    </tr>`).join('');
  body.querySelectorAll('[data-traffic-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.trafficFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function buildPortHistoryRows() {
  const currentDevices = getCurrentRackDevices();
  if (!currentDevices.length) return [];
  const currentIds = new Set(currentDevices.map(device => Number(device.id)));
  const rows = (state.audit || []).filter(item => {
    const msg = `${item.action || ''} ${item.message || ''}`.toLowerCase();
    return ['port', 'snmp', 'monitor', 'connection', 'vlan', 'threshold'].some(token => msg.includes(token));
  }).map(item => {
    const message = String(item.message || '');
    const device = currentDevices.find(row => message.includes(row.label));
    const match = message.match(/port\s*(\d+)/i) || message.match(/interfejs\s*(\d+)/i);
    return {
      ts: item.ts,
      deviceId: device?.id || null,
      deviceLabel: device?.label || '—',
      portLabel: match ? `Port ${match[1]}` : '—',
      action: item.action || '—',
      user: item.user || 'system',
      details: message || '—'
    };
  }).filter(row => row.deviceId ? currentIds.has(Number(row.deviceId)) : row.details !== '—').slice(0, 80);
  return rows;
}


function buildTopTalkerRows() {
  const rows = [];
  getCurrentRackDevices().forEach(device => {
    const snap = getSnmpSnapshotForDevice(device);
    (snap.interfaces || []).forEach((iface, idx) => {
      const sum = (Number(iface.rxMbps) || 0) + (Number(iface.txMbps) || 0);
      rows.push({
        device,
        portLabel: `Port ${(iface.portNumber || idx + 1)}` ,
        rx: Number(iface.rxMbps) || 0,
        tx: Number(iface.txMbps) || 0,
        total: sum,
        errors: (Number(iface.crcErrors) || 0) + (Number(iface.drops) || 0),
        updatedAt: snap.updatedAt || snap.monitor?.updatedAt || null
      });
    });
  });
  return rows.sort((a, b) => b.total - a.total).slice(0, 100);
}

function renderTopTalkersTable() {
  const body = document.getElementById('topTalkersTableBody');
  const badge = document.getElementById('topTalkersSummaryBadge');
  if (!body || !badge) return;
  const rows = buildTopTalkerRows();
  badge.textContent = `${rows.length} wpisów`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">Brak danych top talkers dla bieżącej szafy.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td><button type="button" class="btn-link" data-talker-focus-device="${row.device.id}">${escapeHtml(row.device.label)}</button><div class="muted small">${escapeHtml(row.device.type || '-')}</div></td>
      <td>${escapeHtml(row.portLabel)}</td>
      <td>${row.rx.toFixed(1)} Mb/s</td>
      <td>${row.tx.toFixed(1)} Mb/s</td>
      <td>${row.total.toFixed(1)} Mb/s</td>
      <td>${row.errors}</td>
      <td>${row.updatedAt ? new Date(row.updatedAt).toLocaleString('pl-PL') : '—'}</td>
    </tr>`).join('');
  body.querySelectorAll('[data-talker-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.talkerFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function buildSystemEventRows() {
  const devices = getCurrentRackDevices();
  const labels = devices.map(d => d.label.toLowerCase());
  return (state.audit || []).filter(item => {
    const msg = `${item.action || ''} ${item.message || ''}`.toLowerCase();
    return labels.some(label => msg.includes(label)) || ['snmp','monitor','alert','device','port','connection'].some(token => msg.includes(token));
  }).slice(0, 120).map(item => {
    const msg = String(item.message || '—');
    const device = devices.find(d => msg.toLowerCase().includes(String(d.label || '').toLowerCase()));
    const type = item.action || (msg.includes('SNMP') ? 'SNMP' : 'SYSTEM');
    const status = /error|błąd|fail|critical/i.test(msg) ? 'error' : (/warn|warning/i.test(msg) ? 'warn' : 'ok');
    return { ts: item.ts, type, device, message: msg, status };
  });
}

function renderSystemEventsTable() {
  const body = document.getElementById('systemEventsTableBody');
  const badge = document.getElementById('systemEventsSummaryBadge');
  if (!body || !badge) return;
  const rows = buildSystemEventRows();
  badge.textContent = `${rows.length} zdarzeń`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Brak zdarzeń systemowych dla bieżącej szafy.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td>${row.ts ? new Date(row.ts).toLocaleString('pl-PL') : '—'}</td>
      <td>${escapeHtml(row.type)}</td>
      <td>${row.device ? `<button type="button" class="btn-link" data-system-focus-device="${row.device.id}">${escapeHtml(row.device.label)}</button>` : '—'}</td>
      <td>${escapeHtml(row.message)}</td>
      <td>${renderStatusPill(row.status)}</td>
    </tr>`).join('');
  body.querySelectorAll('[data-system-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.systemFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function buildHardwareRows() {
  return getCurrentRackDevices().map(device => ({
    device,
    vendor: device.vendor || 'Generic',
    model: device.model || device.type || '—',
    serial: device.serialNumber || device.serial || `DCIM-${device.id}`,
    firmware: device.firmware || device.softwareVersion || '—',
    status: device.monitoring?.enabled ? 'monitoring' : (device.network?.ip ? 'inventory' : 'offline')
  })).sort((a,b)=>a.device.startU-b.device.startU);
}

function renderHardwareTable() {
  const body = document.getElementById('hardwareTableBody');
  const badge = document.getElementById('hardwareSummaryBadge');
  if (!body || !badge) return;
  const rows = buildHardwareRows();
  badge.textContent = `${rows.length} urządzeń`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">Brak danych hardware dla bieżącej szafy.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td><button type="button" class="btn-link" data-hardware-focus-device="${row.device.id}">${escapeHtml(row.device.label)}</button><div class="muted small">${escapeHtml(row.device.type || '-')} · U${escapeHtml(String(row.device.startU || '-'))}</div></td>
      <td>${escapeHtml(row.vendor)}</td>
      <td>${escapeHtml(row.model)}</td>
      <td>${escapeHtml(row.serial)}</td>
      <td>${escapeHtml(row.firmware)}</td>
      <td>${renderStatusPill(row.status)}</td>
    </tr>`).join('');
  body.querySelectorAll('[data-hardware-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.hardwareFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function renderPortHistoryTable() {
  const body = document.getElementById('portHistoryTableBody');
  const badge = document.getElementById('portHistorySummaryBadge');
  if (!body || !badge) return;
  const rows = buildPortHistoryRows();
  badge.textContent = `${rows.length} zdarzeń`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">Brak historii portów dla bieżącej szafy.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td>${row.ts ? new Date(row.ts).toLocaleString('pl-PL') : '—'}</td>
      <td>${row.deviceId ? `<button type="button" class="btn-link" data-port-history-focus-device="${row.deviceId}">${escapeHtml(row.deviceLabel)}</button>` : escapeHtml(row.deviceLabel)}</td>
      <td>${escapeHtml(row.portLabel)}</td>
      <td>${escapeHtml(row.action)}</td>
      <td>${escapeHtml(row.user)}</td>
      <td>${escapeHtml(row.details)}</td>
    </tr>`).join('');
  body.querySelectorAll('[data-port-history-focus-device]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.portHistoryFocusDevice));
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function renderRackWorkspaceTables() {
  renderPortTable();
  renderConnectionTable();
  renderPowerTable();
  renderTopologyTable();
  renderUplinkTable();
  renderCapacityTable();
  renderHeatmapTable();
  renderTrafficTable();
  renderTopTalkersTable();
  renderSystemEventsTable();
  renderHardwareTable();
  renderPortHistoryTable();
  renderPatchLogicTable();
  loadRoutingTable();
}

function populatePortDeviceSelect() {
  const ref = getCurrentRack();
  const devices = ref?.rack?.frontDevices || [];
  const select = document.getElementById('portDeviceSelect');
  select.innerHTML = devices.map(device => `<option value="${device.id}">${device.label}</option>`).join('');
  if (devices.length) {
    if (!devices.some(d => Number(d.id) === Number(state.selectedDeviceId))) state.selectedDeviceId = Number(devices[0].id);
    select.value = String(state.selectedDeviceId);
  }
  populatePortNumbers();
}

function populatePortNumbers() {
  const ref = getCurrentRack();
  const device = ref?.rack?.frontDevices?.find(d => d.id === Number(document.getElementById('portDeviceSelect').value));
  state.selectedDeviceId = Number(device?.id || state.selectedDeviceId || 0) || null;
  const select = document.getElementById('portNumberSelect');
  select.innerHTML = '';
  if (!device?.ports?.length) {
    select.innerHTML = '<option value="">Brak portów</option>';
    return;
  }
  device.ports.forEach(port => {
    select.innerHTML += `<option value="${port.portNumber}">Port ${port.portNumber}${port.connectedTo ? ' · połączony' : ''}</option>`;
  });
  if (device.ports.some(p => Number(p.portNumber) === Number(state.selectedPortNumber))) select.value = String(state.selectedPortNumber);
  else state.selectedPortNumber = Number(device.ports[0]?.portNumber || 0) || null;
  if (state.selectedPortNumber) select.value = String(state.selectedPortNumber);
  fillPortFormFromSelection();
}

function fillPortFormFromSelection() {
  const ref = getCurrentRack();
  const form = document.getElementById('portForm');
  const device = ref?.rack?.frontDevices?.find(d => d.id === Number(document.getElementById('portDeviceSelect').value));
  state.selectedDeviceId = Number(device?.id || state.selectedDeviceId || 0) || null;
  const port = device?.ports?.find(p => p.portNumber === Number(document.getElementById('portNumberSelect').value));
  state.selectedPortNumber = Number(port?.portNumber || state.selectedPortNumber || 0) || null;
  if (!port) return;
  form.elements.target.value = port.target || '';
  form.elements.ip.value = port.ip || '';
  form.elements.vlan.value = port.vlan || '';
  form.elements.subnet.value = port.subnet || '';
  form.elements.mask.value = port.mask || '';
  form.elements.gateway.value = port.gateway || '';
  form.elements.status.value = port.status || 'down';
  form.elements.cableColor.value = port.cableColor || '#64748b';
}

function focusDevice(deviceId, portNumber = null) {
  if (state.currentSide !== 'front') return;
  state.selectedDeviceId = Number(deviceId) || null;
  if (state.selectedDeviceId) document.getElementById('portDeviceSelect').value = String(state.selectedDeviceId);
  populatePortNumbers();
  if (portNumber) {
    state.selectedPortNumber = Number(portNumber);
    document.getElementById('portNumberSelect').value = String(portNumber);
  }
  fillPortFormFromSelection();
  loadSelectedDeviceTelemetry(true).finally(() => renderDeviceInspector());
  if (state.selectedDeviceId) document.getElementById('powerDeviceSelect').value = String(state.selectedDeviceId);
  syncPowerForm();
  if (state.selectedDeviceId) document.getElementById('connLeftDeviceSelect').value = String(state.selectedDeviceId);
  syncLeftConnectionForm();
  renderDeviceInspector();
  syncSnmpSelectionFromRack();
}


function getSelectedFrontDevice() {
  const ref = getCurrentRack();
  const devices = ref?.rack?.frontDevices || [];
  if (!devices.length) return null;
  let device = devices.find(d => d.id === Number(state.selectedDeviceId));
  if (!device) {
    device = devices[0];
    state.selectedDeviceId = device.id;
  }
  return device;
}

function getSelectedDeviceCacheKey(device = getSelectedFrontDevice()) {
  const ref = getCurrentRack();
  if (!ref?.room || !ref?.rack || !device) return null;
  return `${ref.room.id}:${ref.rack.id}:${device.id}`;
}

async function loadSelectedDeviceTelemetry(force = false) {
  const ref = getCurrentRack();
  const device = getSelectedFrontDevice();
  if (!ref?.room || !ref?.rack || !device) return;
  const key = getSelectedDeviceCacheKey(device);
  if (!key) return;
  if (!force && state.deviceLiveCache[key] && state.devicePathCache[key] && state.pathTraceCache[key]) return;
  try {
    const [live, path, trace] = await Promise.all([
      api(`/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${device.id}/interfaces/live`),
      api(`/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${device.id}/path`),
      state.selectedPortNumber ? api(`/api/path-trace?roomId=${ref.room.id}&rackId=${ref.rack.id}&deviceId=${device.id}&portNumber=${state.selectedPortNumber}`) : Promise.resolve(null)
    ]);
    state.deviceLiveCache[key] = live;
    state.devicePathCache[key] = path;
    state.pathTraceCache[key] = trace;
  } catch (err) {
    console.warn('Telemetry load failed', err);
  }
}

function renderInterfacesSection(device) {
  const key = getSelectedDeviceCacheKey(device);
  const live = key ? state.deviceLiveCache[key] : null;
  if (!device?.ports?.length) return '<div class="device-inspector-empty">To urządzenie nie ma interfejsów do telemetrii.</div>';
  if (!live) return '<div class="device-inspector-empty">Ładowanie telemetrii interfejsów…</div>';
  const busiest = live.summary?.busiest || [];
  const selectedPort = Number(state.selectedPortNumber || 0);
  const selectedRow = (live.interfaces || []).find(row => Number(row.portNumber) === selectedPort) || live.interfaces[0] || null;
  const t = selectedRow?.thresholds || {};
  return `
    <div class="subsection-title" style="margin-top:14px">Live interfejsy</div>
    <div class="inspector-kv">
      <div><strong>Interfejsy</strong>${live.summary?.interfaceCount || 0}</div>
      <div><strong>UP</strong>${live.summary?.upCount || 0}</div>
      <div><strong>RX suma</strong>${live.summary?.totalRxMbps || 0} Mb/s</div>
      <div><strong>TX suma</strong>${live.summary?.totalTxMbps || 0} Mb/s</div>
      <div><strong>Alerty portów</strong>${live.summary?.thresholdBreaches || 0}</div>
    </div>
    <div class="inline-actions" style="margin:10px 0 8px"><button type="button" class="btn btn-secondary btn-small" data-refresh-interfaces="1">Odśwież live</button></div>
    <div class="port-summary-list">${busiest.map(row => `
      <button type="button" class="port-summary-item ${Number(row.portNumber) === selectedPort ? 'active' : ''} ${row.thresholdActive ? 'port-alert' : ''}" data-port-summary="${row.portNumber}">
        <div class="port-summary-line"><strong>${row.name}</strong><span class="port-status-pill ${row.operStatus === 'up' ? 'up' : 'down'}">${row.operStatus}</span></div>
        <div class="muted small">RX ${row.rxMbps} / TX ${row.txMbps} Mb/s · błędy ${Number(row.crcErrors || 0) + Number(row.drops || 0)}</div>
        <div class="muted small">${row.target || 'Brak połączenia'} · VLAN ${row.vlan || '-'}${row.thresholdActive ? ' · próg!' : ''}</div>
      </button>`).join('')}</div>
    <div style="overflow:auto; margin-top:10px">
      <table class="data-table compact-table">
        <thead><tr><th>Port</th><th>Status</th><th>RX</th><th>TX</th><th>Utylizacja</th><th>Błędy</th><th>VLAN</th><th>Progi</th><th>Cel</th></tr></thead>
        <tbody>${live.interfaces.map(row => `
          <tr class="${Number(row.portNumber) === selectedPort ? 'row-active' : ''} ${row.thresholdActive ? 'row-alert' : ''}">
            <td><button type="button" class="btn-link" data-port-summary="${row.portNumber}">${row.name}</button></td>
            <td><span class="status-badge ${row.operStatus}">${row.operStatus}</span></td>
            <td>${row.rxMbps} Mb/s</td>
            <td>${row.txMbps} Mb/s</td>
            <td>${row.utilizationPct}%</td>
            <td>${Number(row.crcErrors || 0) + Number(row.drops || 0)}</td>
            <td>${escapeHtml(row.vlan || '-')}</td>
            <td>${row.thresholdActive ? `<span class="status-badge down">ALARM</span><div class="muted small">${escapeHtml((row.thresholdReasons || []).join(', '))}</div>` : '<span class="muted small">OK</span>'}</td>
            <td>${escapeHtml(row.target || '-')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    ${selectedRow ? `
      <div class="subsection-title" style="margin-top:12px">Progi alarmowe dla ${selectedRow.name}</div>
      <form class="threshold-config-box stack gap-sm">
        <div class="inspector-kv">
          <div><strong>Stan</strong>${selectedRow.thresholdActive ? 'alarm aktywny' : 'brak alarmu'}</div>
          <div><strong>Powód</strong>${escapeHtml((selectedRow.thresholdReasons || []).join(', ') || '—')}</div>
        </div>
        <label><span>RX próg (Mb/s)</span><input name="rxThresholdMbps" type="number" min="0" step="0.1" value="${escapeAttr(t.rxThresholdMbps ?? '')}" placeholder="np. 200"></label>
        <label><span>TX próg (Mb/s)</span><input name="txThresholdMbps" type="number" min="0" step="0.1" value="${escapeAttr(t.txThresholdMbps ?? '')}" placeholder="np. 200"></label>
        <label><span>Próg błędów</span><input name="errorThreshold" type="number" min="0" step="1" value="${escapeAttr(t.errorThreshold ?? '')}" placeholder="np. 3"></label>
        <label><span>Utylizacja (%)</span><input name="utilizationThresholdPct" type="number" min="0" max="100" step="1" value="${escapeAttr(t.utilizationThresholdPct ?? '')}" placeholder="np. 70"></label>
        <div class="inline-actions">
          <button type="button" class="btn btn-primary btn-small" data-threshold-save="1">Zapisz progi</button>
          <button type="button" class="btn btn-secondary btn-small" data-threshold-clear="1">Wyczyść progi</button>
        </div>
        <div class="muted small">Historia portu: ${(selectedRow.history || []).length} próbek.</div>
      </form>` : ''}`;
}

function renderDevicePathSection(device) {
  const key = getSelectedDeviceCacheKey(device);
  const path = key ? state.devicePathCache[key] : null;
  if (!path) return '<div class="device-inspector-empty">Ładowanie ścieżki urządzenia…</div>';
  const uplinks = path.uplinks || [];
  const trace = key ? state.pathTraceCache[key] : null;
  return `
    <div class="subsection-title" style="margin-top:14px">Ścieżka fizyczna i logiczna</div>
    <div class="inspector-kv">
      <div><strong>Budynek</strong>${escapeHtml(path.location?.building || '-')}</div>
      <div><strong>Pomieszczenie</strong>${escapeHtml((path.location?.roomType || '') + ' ' + (path.location?.roomNumber || ''))}</div>
      <div><strong>Szafa</strong>${escapeHtml(path.location?.rack || '-')}</div>
      <div><strong>Pozycja</strong>${escapeHtml(path.location?.rackUnits || '-')}</div>
      <div><strong>Mgmt IP</strong>${escapeHtml(path.logical?.managementIp || '-')}</div>
      <div><strong>VLAN-y</strong>${escapeHtml((path.logical?.vlans || []).join(', ') || '-')}</div>
    </div>
    <div class="muted small" style="margin-top:8px">${(path.hops || []).map(h => escapeHtml(h.label)).join(' → ')}</div>
    <div class="port-summary-list" style="margin-top:10px">${uplinks.length ? uplinks.map(link => `
      <div class="port-summary-item">
        <div class="port-summary-line"><strong>Port ${link.localPort}</strong><span class="port-status-pill up">uplink</span></div>
        <div class="muted small">${escapeHtml(link.targetLabel || '-')}</div>
        <div class="muted small">VLAN ${escapeHtml(link.vlan || '-')} · medium ${escapeHtml(link.medium || '-')}</div>
        <div class="muted small">Kabel ${escapeHtml(link.cableLabel || '-')} · ${escapeHtml(String(link.cableLengthM || '-'))} m · trasa ${escapeHtml(link.routeName || '-')}</div>
      </div>`).join('') : '<div class="device-inspector-empty">Brak aktywnych uplinków dla tego urządzenia.</div>'}</div>
    ${trace?.hops?.length ? `<div class="subsection-title" style="margin-top:12px">End-to-end trace dla wybranego portu</div><div class="muted small">${trace.hops.map(h => escapeHtml(h.label)).join(' → ')}</div>` : '<div class="muted small" style="margin-top:10px">Wybierz port, aby zobaczyć ścieżkę end-to-end.</div>'}`;
}

function renderInteractiveFrontPanel(device, opts = {}) {
  if (!isSwitchLike(device)) return '<div class="device-inspector-empty">Dla tego urządzenia używany jest widok opisowy — brak interaktywnego front panelu.</div>';
  const width = opts.width || 980;
  const height = opts.height || 182;
  const svg = window.renderSwitchFaceplateSvg ? window.renderSwitchFaceplateSvg(device, { width, height }) : '';
  const layout = window.getPortLayout ? window.getPortLayout(device, { width, height }) : [];
  const activePort = Number(opts.activePort || 0);
  const hotspots = layout.map(box => {
    const port = (device.ports || []).find(p => Number(p.portNumber) === Number(box.portNumber)) || {};
    const classes = ['faceplate-port-hotspot'];
    if (Number(box.portNumber) === activePort) classes.push('active');
    if (port.connectedTo || port.target) classes.push('connected');
    const title = `Port ${box.portNumber}${port.target ? ' → ' + port.target : ''}`;
    return `<button type="button" class="${classes.join(' ')}" data-port-hotspot="${box.portNumber}" title="${title}" style="left:${(box.x / width) * 100}%;top:${(box.y / height) * 100}%;width:${(box.width / width) * 100}%;height:${(box.height / height) * 100}%"></button>`;
  }).join('');
  return `<div class="interactive-faceplate"><div class="switch-faceplate">${svg}</div>${hotspots}</div>`;
}

function renderPortSummaryList(device) {
  const ports = device?.ports || [];
  if (!ports.length) return '<div class="device-inspector-empty">To urządzenie nie ma portów do konfiguracji.</div>';
  return `<div class="port-summary-list">${ports.map(port => `
    <button type="button" class="port-summary-item ${Number(port.portNumber) === Number(state.selectedPortNumber || document.getElementById('portNumberSelect')?.value) ? 'active' : ''}" data-port-summary="${port.portNumber}">
      <div class="port-summary-line"><strong>Port ${port.portNumber}</strong><span class="port-status-pill ${port.status === 'up' ? 'up' : 'down'}">${port.status || 'down'}</span></div>
      <div class="muted small">${port.target || 'Brak celu połączenia'}</div>
      <div class="muted small">IP: ${port.ip || '-'} · VLAN: ${port.vlan || '-'}</div>
    </button>`).join('')}</div>`;
}

function bindDeviceInspectorEvents(root = document) {
  root.querySelectorAll('[data-port-hotspot]').forEach(btn => btn.addEventListener('click', () => focusDevice(state.selectedDeviceId, Number(btn.dataset.portHotspot))));
  root.querySelectorAll('[data-port-summary]').forEach(btn => btn.addEventListener('click', () => focusDevice(state.selectedDeviceId, Number(btn.dataset.portSummary))));
  root.querySelectorAll('[data-monitor-save]').forEach(btn => btn.addEventListener('click', async () => {
    const box = btn.closest('.monitoring-config-box');
    const payload = {
      enabled: !!box.querySelector('[name=monitorEnabled]')?.checked,
      protocol: box.querySelector('[name=monitorProtocol]')?.value || 'icmp',
      intervalSec: Number(box.querySelector('[name=monitorIntervalSec]')?.value || 60),
      timeoutMs: Number(box.querySelector('[name=monitorTimeoutMs]')?.value || 1200),
      snmpCommunity: box.querySelector('[name=monitorSnmpCommunity]')?.value || '',
      notes: box.querySelector('[name=monitorNotes]')?.value || ''
    };
    try {
      btn.disabled = true;
      await saveSelectedDeviceMonitoring(payload);
    } catch (err) {
      alert(err.message || 'Nie udało się zapisać monitoringu.');
    } finally {
      btn.disabled = false;
    }
  }));
  root.querySelectorAll('[data-monitor-mute]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await saveSelectedDeviceMonitoring({ muteMinutes: Number(btn.dataset.monitorMute || 0) });
    } catch (err) {
      alert(err.message || 'Nie udało się zmienić wyciszenia.');
    }
  }));
  root.querySelectorAll('[data-refresh-interfaces]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    await loadSelectedDeviceTelemetry(true);
    renderDeviceInspector(root.closest('#deviceInspectorModalContent') ? document.getElementById('deviceInspectorModalContent') : document.getElementById('deviceInspectorBox'), !!root.closest('#deviceInspectorModalContent'));
    if (!root.closest('#deviceInspectorModalContent') && !document.getElementById('deviceInspectorModal').classList.contains('hidden')) renderDeviceInspector(document.getElementById('deviceInspectorModalContent'), true);
    btn.disabled = false;
  }));
  root.querySelectorAll('[data-threshold-save]').forEach(btn => btn.addEventListener('click', async () => {
    const box = btn.closest('.threshold-config-box');
    const payload = {
      rxThresholdMbps: box.querySelector('[name=rxThresholdMbps]')?.value || '',
      txThresholdMbps: box.querySelector('[name=txThresholdMbps]')?.value || '',
      errorThreshold: box.querySelector('[name=errorThreshold]')?.value || '',
      utilizationThresholdPct: box.querySelector('[name=utilizationThresholdPct]')?.value || ''
    };
    try {
      btn.disabled = true;
      await saveSelectedPortThresholds(payload);
    } catch (err) {
      alert(err.message || 'Nie udało się zapisać progów.');
    } finally {
      btn.disabled = false;
    }
  }));
  root.querySelectorAll('[data-threshold-clear]').forEach(btn => btn.addEventListener('click', async () => {
    try {
      btn.disabled = true;
      await saveSelectedPortThresholds({ rxThresholdMbps: '', txThresholdMbps: '', errorThreshold: '', utilizationThresholdPct: '' });
    } catch (err) {
      alert(err.message || 'Nie udało się wyczyścić progów.');
    } finally {
      btn.disabled = false;
    }
  }));
}

function renderDeviceInspector(targetEl = document.getElementById('deviceInspectorBox'), modal = false) {
  if (!targetEl) return;
  const device = getSelectedFrontDevice();
  if (!device) {
    targetEl.innerHTML = '<div class="device-inspector-empty">Brak urządzenia do podglądu. Dodaj urządzenie albo wybierz inną szafę.</div>';
    return;
  }
  const activePort = Number(state.selectedPortNumber || document.getElementById('portNumberSelect')?.value || 0);
  const network = device.network || {};
  const monitor = device.monitoring || {};
  const mutedText = monitor.mutedUntil ? new Date(monitor.mutedUntil).toLocaleString('pl-PL') : 'brak';
  targetEl.innerHTML = `
    <div class="device-inspector-head">
      <div class="device-inspector-meta">
        <h4>${device.label}</h4>
        <div class="muted">${device.vendor || 'Generic'} · ${device.model || device.type} · ${device.type} · ${device.sizeU}U · U${device.startU}</div>
        <div class="model-pill">Widok interaktywny portów ${device.ports?.length ? `(${device.ports.length})` : ''}</div>
      </div>
      <div class="badge">Aktywny port: ${activePort || 'brak'}</div>
    </div>
    <div class="device-inspector-grid">
      <div>${renderInteractiveFrontPanel(device, { activePort, width: modal ? 1080 : 920, height: modal ? 205 : 182 })}</div>
      <div class="inspector-side-card">
        <div class="subsection-title">Szybkie informacje</div>
        <div class="inspector-kv">
          <div><strong>Hostname</strong>${network.hostname || '-'}</div>
          <div><strong>Adres zarządzania</strong>${network.ip || '-'}</div>
          <div><strong>VLAN mgmt</strong>${network.vlan || '-'}</div>
          <div><strong>Zasilanie</strong>A: ${device.power?.primary?.sourceLabel || '-'} / B: ${device.power?.backup?.sourceLabel || '-'}</div>
        </div>
        <div class="subsection-title" style="margin-top:14px">Monitoring</div>
        <div class="monitoring-config-box stack gap-sm">
          <label class="inline-check"><input type="checkbox" name="monitorEnabled" ${monitor.enabled ? 'checked' : ''}> <span>Monitoring aktywny</span></label>
          <label><span>Protokół</span><select name="monitorProtocol"><option value="icmp" ${monitor.protocol === 'icmp' ? 'selected' : ''}>ICMP / ping</option><option value="snmp" ${monitor.protocol === 'snmp' ? 'selected' : ''}>SNMP (ready)</option></select></label>
          <label><span>Interwał (s)</span><input name="monitorIntervalSec" type="number" min="5" value="${Number(monitor.intervalSec || 60)}"></label>
          <label><span>Timeout (ms)</span><input name="monitorTimeoutMs" type="number" min="200" value="${Number(monitor.timeoutMs || 1200)}"></label>
          <label><span>SNMP community</span><input name="monitorSnmpCommunity" value="${escapeAttr(monitor.snmpCommunity || '')}" placeholder="public"></label>
          <label><span>Notatki monitoringu</span><textarea name="monitorNotes" rows="3" placeholder="np. urządzenie na maintenance">${escapeHtml(monitor.notes || '')}</textarea></label>
          <div class="muted small">Wyciszenie alertów do: ${escapeHtml(mutedText)}</div>
          <div class="inline-actions">
            <button type="button" class="btn btn-secondary btn-small" data-monitor-mute="60">Wycisz 1h</button>
            <button type="button" class="btn btn-secondary btn-small" data-monitor-mute="480">Wycisz 8h</button>
            <button type="button" class="btn btn-secondary btn-small" data-monitor-mute="0">Usuń wyciszenie</button>
            <button type="button" class="btn btn-primary btn-small" data-monitor-save="1">Zapisz monitoring</button>
          </div>
        </div>
        <div class="subsection-title" style="margin-top:14px">Porty</div>
        ${renderPortSummaryList(device)}
        ${renderInterfacesSection(device)}
        ${renderDevicePathSection(device)}
      </div>
    </div>`;
  bindDeviceInspectorEvents(targetEl);
}

function openDeviceInspectorModal() {
  const device = getSelectedFrontDevice();
  if (!device) return;
  document.getElementById('deviceInspectorModalTitle').textContent = `${device.label} — pełny widok front panelu`;
  loadSelectedDeviceTelemetry(true).finally(() => renderDeviceInspector(document.getElementById('deviceInspectorModalContent'), true));
  document.getElementById('deviceInspectorModal').classList.remove('hidden');
}

document.addEventListener('change', (e) => {
  if (e.target?.id === 'portDeviceSelect') { state.selectedDeviceId = Number(e.target.value) || null; state.selectedPortNumber = null; populatePortNumbers(); renderRack(); }
  if (e.target?.id === 'powerDeviceSelect' || e.target?.id === 'connLeftDeviceSelect') { state.selectedDeviceId = Number(e.target.value) || state.selectedDeviceId; }
});

function populatePowerDeviceSelect() {
  const ref = getCurrentRack();
  const devices = ref?.rack?.frontDevices || [];
  const select = document.getElementById('powerDeviceSelect');
  select.innerHTML = devices.map(device => `<option value="${device.id}">${device.label}</option>`).join('');
  syncPowerForm();
}

function syncPowerForm() {
  const ref = getCurrentRack();
  const form = document.getElementById('powerForm');
  if (!form) return;
  const device = ref?.rack?.frontDevices?.find(d => d.id === Number(document.getElementById('powerDeviceSelect').value));
  form.elements.primarySourceLabel.value = device?.power?.primary?.sourceLabel || '';
  form.elements.primaryOutletNumber.value = device?.power?.primary?.outletNumber || '';
  form.elements.backupSourceLabel.value = device?.power?.backup?.sourceLabel || '';
  form.elements.backupOutletNumber.value = device?.power?.backup?.outletNumber || '';
}

function populateLeftConnectionDevices() {
  const ref = getCurrentRack();
  const devices = ref?.rack?.frontDevices || [];
  const select = document.getElementById('connLeftDeviceSelect');
  select.innerHTML = devices.map(device => `<option value="${device.id}">${device.label}</option>`).join('');
  syncLeftConnectionForm();
}

function syncLeftConnectionForm() {
  const ref = getCurrentRack();
  const device = ref?.rack?.frontDevices?.find(d => d.id === Number(document.getElementById('connLeftDeviceSelect').value));
  const select = document.getElementById('connLeftPortSelect');
  select.innerHTML = (device?.ports || []).map(port => `<option value="${port.portNumber}">Port ${port.portNumber}</option>`).join('');
  renderConnectionTable();
}

function populateRightRoomSelect() {
  const select = document.getElementById('connRightRoomSelect');
  select.innerHTML = state.serverRooms.map(room => `<option value="${room.id}">${room.building} / ${room.roomType} / ${room.roomNumber}</option>`).join('');
  if (state.currentRoomId) select.value = String(state.currentRoomId);
  populateRightRackSelect();
}

function populateRightRackSelect() {
  const room = state.serverRooms.find(r => r.id === Number(document.getElementById('connRightRoomSelect').value));
  const select = document.getElementById('connRightRackSelect');
  select.innerHTML = (room?.racks || []).map(rack => `<option value="${rack.id}">${rack.label}</option>`).join('');
  if (state.currentRackId && room?.id === state.currentRoomId) select.value = String(state.currentRackId);
  populateRightDeviceSelect();
}

function populateRightDeviceSelect() {
  const room = state.serverRooms.find(r => r.id === Number(document.getElementById('connRightRoomSelect').value));
  const rack = room?.racks?.find(r => r.id === Number(document.getElementById('connRightRackSelect').value));
  const select = document.getElementById('connRightDeviceSelect');
  select.innerHTML = (rack?.frontDevices || []).map(device => `<option value="${device.id}">${device.label}</option>`).join('');
  populateRightPortSelect();
}

function populateRightPortSelect() {
  const room = state.serverRooms.find(r => r.id === Number(document.getElementById('connRightRoomSelect').value));
  const rack = room?.racks?.find(r => r.id === Number(document.getElementById('connRightRackSelect').value));
  const device = rack?.frontDevices?.find(d => d.id === Number(document.getElementById('connRightDeviceSelect').value));
  const select = document.getElementById('connRightPortSelect');
  select.innerHTML = (device?.ports || []).map(port => `<option value="${port.portNumber}">Port ${port.portNumber}</option>`).join('');
  renderConnectionTable();
}

document.addEventListener('change', (e) => {
  if (e.target?.id === 'portDeviceSelect') { state.selectedDeviceId = Number(e.target.value) || null; state.selectedPortNumber = null; populatePortNumbers(); renderRack(); }
  if (e.target?.id === 'powerDeviceSelect' || e.target?.id === 'connLeftDeviceSelect') { state.selectedDeviceId = Number(e.target.value) || state.selectedDeviceId; }
});
document.addEventListener('click', (e) => {
  const portRow = e.target.closest('[data-port-row]');
  if (portRow) {
    const [deviceId, portNumber] = String(portRow.dataset.portRow || '').split(':').map(Number);
    focusDevice(deviceId, portNumber);
    activateTab('rackpage', 'rack-page-port');
    return;
  }
  const connectionRow = e.target.closest('[data-connection-row]');
  if (connectionRow) {
    const [deviceId, portNumber] = String(connectionRow.dataset.connectionRow || '').split(':').map(Number);
    focusDevice(deviceId, portNumber);
    activateTab('rackpage', 'rack-page-connection');
    return;
  }
  const powerRow = e.target.closest('[data-power-row]');
  if (powerRow) {
    const deviceId = Number(powerRow.dataset.powerRow);
    if (deviceId) {
      state.selectedDeviceId = deviceId;
      const ps = document.getElementById('powerDeviceSelect'); if (ps) ps.value = String(deviceId);
      syncPowerForm();
      renderDeviceInspector();
      renderRack();
      activateTab('rackpage', 'rack-page-power');
    }
  }
});

async function onAddDevice(e) {
  e.preventDefault();
  const ref = getCurrentRack();
  if (!ref?.rack) return;
  const fd = new FormData(e.target);
  const type = fd.get('type');
  const body = {
    side: fd.get('side'),
    type,
    label: fd.get('label'),
    vendor: fd.get('vendor'),
    model: fd.get('model'),
    startU: Number(fd.get('startU')),
    sizeU: Number(fd.get('sizeU'))
  };

  if (!state.editingDeviceId) {
    const portCount = /patch panel/i.test(type) ? (/48/i.test(type) ? 48 : 24) : (window.inferPortCount ? window.inferPortCount({ type, model: fd.get('model') }) : (/48-port/i.test(type) ? 48 : (/24-port/i.test(type) ? 24 : 0)));
    body.ports = portCount ? Array.from({ length: portCount }).map((_, i) => ({ portNumber: i + 1, status: 'down', target: '', ip: '', vlan: '', subnet: '', mask: '', gateway: '', cableColor: '#64748b', connectedTo: null })) : [];
  }

  try {
    const method = state.editingDeviceId ? 'PUT' : 'POST';
    const url = state.editingDeviceId
      ? `/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${state.editingDeviceId}`
      : `/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices`;
    await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('deviceModal').classList.add('hidden');
    state.editingDeviceId = null;
    e.target.reset();
    await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
    renderRack();
  } catch (err) {
    const box = document.getElementById('deviceFormError');
    box.textContent = err.message;
    box.classList.remove('hidden');
  }
}

async function deleteDevice(deviceId) {
  if (!confirm('Usunąć urządzenie?')) return;
  const ref = getCurrentRack();
  await api(`/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${deviceId}`, { method: 'DELETE' });
  await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
  renderRack();
}

async function onSavePort(e) {
  e.preventDefault();
  const ref = getCurrentRack();
  const fd = new FormData(e.target);
  const deviceId = Number(document.getElementById('portDeviceSelect').value);
  const portNumber = Number(document.getElementById('portNumberSelect').value);
  const payload = Object.fromEntries(fd.entries());
  try {
    await api(`/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${deviceId}/ports/${portNumber}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
    renderRack();
  } catch (err) {
    alert(err.message);
  }
}

async function disconnectSelectedPort() {
  const ref = getCurrentRack();
  const deviceId = Number(document.getElementById('portDeviceSelect').value);
  const portNumber = Number(document.getElementById('portNumberSelect').value);
  if (!deviceId || !portNumber) return;
  await api('/api/connections', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: ref.room.id, rackId: ref.rack.id, deviceId, portNumber })
  });
  await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
  renderRack();
}

async function onSavePower(e) {
  e.preventDefault();
  const ref = getCurrentRack();
  const deviceId = Number(document.getElementById('powerDeviceSelect').value);
  const payload = Object.fromEntries(new FormData(e.target).entries());
  await api(`/api/serverrooms/${ref.room.id}/racks/${ref.rack.id}/devices/${deviceId}/power`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
  renderRack();
}

async function onCreateConnection(e) {
  e.preventDefault();
  const ref = getCurrentRack();
  const fd = new FormData(e.target);
  const payload = {
    leftRoomId: ref.room.id,
    leftRackId: ref.rack.id,
    leftDeviceId: Number(document.getElementById('connLeftDeviceSelect').value),
    leftPortNumber: Number(document.getElementById('connLeftPortSelect').value),
    rightRoomId: Number(document.getElementById('connRightRoomSelect').value),
    rightRackId: Number(document.getElementById('connRightRackSelect').value),
    rightDeviceId: Number(document.getElementById('connRightDeviceSelect').value),
    rightPortNumber: Number(document.getElementById('connRightPortSelect').value),
    cableColor: fd.get('cableColor'),
    medium: fd.get('medium'),
    cableLabel: fd.get('cableLabel'),
    cableLengthM: fd.get('cableLengthM'),
    routeId: fd.get('routeId')
  };
  await api('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  await Promise.all([loadDashboard(), loadServerRooms(), loadAudit(), loadReport(), loadNetworkMap()]);
  renderRack();
}

async function loadAudit() {
  state.audit = await api('/api/audit');
  document.getElementById('auditList').innerHTML = state.audit.map(item => `
    <div class="audit-item">
      <div class="audit-meta"><strong>${item.action}</strong> · ${new Date(item.ts).toLocaleString('pl-PL')} · ${item.user}</div>
      <div>${item.message}</div>
    </div>
  `).join('');
}


async function loadCableRoutes() {
  state.cableRoutes = await api('/api/cable-routes');
  populateCableRouteSelect();
  renderCableRoutesList();
}

function populateCableRouteSelect() {
  const select = document.getElementById('connRouteSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Brak trasy</option>' + (state.cableRoutes || []).map(route => `<option value="${route.id}">${escapeHtml(route.name)} · ${escapeHtml(route.medium || '-')}</option>`).join('');
}

function renderCableRoutesList() {
  const box = document.getElementById('cableRoutesList');
  if (!box) return;
  box.innerHTML = (state.cableRoutes || []).length ? state.cableRoutes.map(route => `
    <div class="room-item">
      <div>
        <strong>${escapeHtml(route.name)}</strong>
        <div class="muted small">${escapeHtml(route.fromBuilding || '-')} → ${escapeHtml(route.toBuilding || '-')} · ${escapeHtml(route.medium || '-')}</div>
        <div class="muted small">${escapeHtml(route.notes || '')}</div>
      </div>
      <button type="button" class="btn btn-danger btn-small" data-delete-route="${route.id}">Usuń</button>
    </div>`).join('') : '<div class="device-inspector-empty">Brak zdefiniowanych tras kablowych.</div>';
  box.querySelectorAll('[data-delete-route]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Usunąć trasę kablową?')) return;
    await api(`/api/cable-routes/${btn.dataset.deleteRoute}`, { method: 'DELETE' });
    await Promise.all([loadCableRoutes(), loadAudit(), loadNetworkMap(), loadReport()]);
  }));
}

async function onSaveCableRoute(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  await api('/api/cable-routes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  e.target.reset();
  await Promise.all([loadCableRoutes(), loadAudit()]);
}


async function loadSnmpPollingStatus() {
  try {
    state.snmpPollingStatus = await api('/api/snmp/polling-status');
    renderSnmpPollingStatus();
  } catch (err) {
    const badge = document.getElementById('snmpPollingStatusBadge');
    if (badge) badge.textContent = 'scheduler: błąd';
  }
}

function renderSnmpPollingStatus() {
  const cfg = state.snmpPollingStatus || { enabled: false, intervalSec: 300, lastRunAt: null, lastSummary: null };
  const enabled = document.getElementById('snmpPollingEnabled');
  const interval = document.getElementById('snmpPollingIntervalSec');
  const badge = document.getElementById('snmpPollingStatusBadge');
  const meta = document.getElementById('snmpPollingMeta');
  if (enabled) enabled.checked = !!cfg.enabled;
  if (interval) interval.value = String(cfg.intervalSec || 300);
  const runtimeLabel = cfg.running ? 'w trakcie' : (cfg.enabled ? 'włączony' : 'wyłączony');
  if (badge) badge.textContent = `scheduler: ${runtimeLabel}`;
  const s = cfg.lastSummary || {};
  if (meta) meta.textContent = cfg.lastRunAt
    ? `Ostatni cykl: ${new Date(cfg.lastRunAt).toLocaleString('pl-PL')} · urządzenia: ${s.scannedDevices || 0} · OK: ${s.ok || 0} · błędy: ${s.failed || 0} · interfejsy: ${s.totalInterfaces || 0}${cfg.running && cfg.startedAt ? ` · trwa od ${new Date(cfg.startedAt).toLocaleTimeString('pl-PL')}` : ''}${cfg.lastError ? ` · błąd: ${cfg.lastError}` : ''}`
    : (cfg.running ? 'Scheduler działa i wykonuje pierwszy cykl…' : 'Brak wykonanego cyklu pollingowego.');
}

async function saveSnmpPollingConfig() {
  const enabled = !!document.getElementById('snmpPollingEnabled')?.checked;
  const intervalSec = Math.max(60, Number(document.getElementById('snmpPollingIntervalSec')?.value) || 300);
  await api('/api/snmp/polling-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, intervalSec })
  });
  await Promise.all([loadSnmpPollingStatus(), loadSnmpPollingHistory(), loadAudit()]);
}

async function runSnmpPollingNow() {
  const btn = document.getElementById('runSnmpPollingBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uruchamianie…'; }
  try {
    state.snmpPollingStatus = await api('/api/snmp/polling-run', { method: 'POST' });
    renderSnmpPollingStatus();
    await Promise.all([loadSnmpInterfaces(true, 'auto'), loadSnmpPollingHistory(), loadGlobalUplinks(), loadAudit()]);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Uruchom cykl teraz'; }
  }
}

function getAllDevicesForRack(rack) {
  const front = Array.isArray(rack?.frontDevices) ? rack.frontDevices : [];
  const rear = Array.isArray(rack?.rearDevices) ? rack.rearDevices : [];
  const seen = new Set();
  return [...front, ...rear].filter(device => {
    const id = Number(device?.id || 0);
    const key = id > 0 ? `id:${id}` : `${device?.label || ''}|${device?.startU || ''}|${device?.type || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveDeviceByPortRef(serverRooms, ref) {
  const room = (serverRooms || []).find(item => Number(item.id) === Number(ref?.roomId));
  const rack = room?.racks?.find(item => Number(item.id) === Number(ref?.rackId));
  const device = getAllDevicesForRack(rack).find(item => Number(item.id) === Number(ref?.deviceId));
  const port = (device?.ports || []).find(item => Number(item.portNumber) === Number(ref?.portNumber));
  if (!room || !rack || !device || !port) return null;
  return { room, rack, device, port };
}


function populateSnmpSelectors() {
  const roomSelect = document.getElementById('snmpRoomSelect');
  const rackSelect = document.getElementById('snmpRackSelect');
  const deviceSelect = document.getElementById('snmpDeviceSelect');
  if (!roomSelect || !rackSelect || !deviceSelect) return;
  roomSelect.innerHTML = state.serverRooms.map(room => `<option value="${room.id}">${room.building} / ${room.roomType} / ${room.roomNumber}</option>`).join('');
  if (!state.serverRooms.length) {
    rackSelect.innerHTML = '';
    deviceSelect.innerHTML = '';
    renderSnmpTableEmpty('Brak serwerowni do analizy interfejsów.');
    return;
  }
  const targetRoomId = Number(state.currentRoomId || state.serverRooms[0].id);
  if (!state.serverRooms.some(room => Number(room.id) === targetRoomId)) state.currentRoomId = Number(state.serverRooms[0].id);
  roomSelect.value = String(state.currentRoomId);
  const room = state.serverRooms.find(r => Number(r.id) === Number(state.currentRoomId));
  rackSelect.innerHTML = (room?.racks || []).map(rack => `<option value="${rack.id}">${rack.label} / Rząd ${rack.rowNumber} / Poz. ${rack.positionInRow}</option>`).join('');
  if (!(room?.racks || []).some(r => Number(r.id) === Number(state.currentRackId))) state.currentRackId = Number(room?.racks?.[0]?.id || 0) || null;
  if (state.currentRackId) rackSelect.value = String(state.currentRackId);
  const rack = room?.racks?.find(r => Number(r.id) === Number(state.currentRackId));
  const devices = rack?.frontDevices || [];
  deviceSelect.innerHTML = devices.map(device => `<option value="${device.id}">${device.label}</option>`).join('');
  if (!devices.some(d => Number(d.id) === Number(state.snmpDeviceId))) state.snmpDeviceId = Number(state.selectedDeviceId || devices[0]?.id || 0) || null;
  if (state.snmpDeviceId) deviceSelect.value = String(state.snmpDeviceId);
}

function syncSnmpWithRack() {
  populateSnmpSelectors();
  loadSnmpInterfaces();
}

function syncSnmpSelectionFromRack() {
  if (state.selectedDeviceId) state.snmpDeviceId = Number(state.selectedDeviceId);
  const deviceSelect = document.getElementById('snmpDeviceSelect');
  if (deviceSelect && state.snmpDeviceId) deviceSelect.value = String(state.snmpDeviceId);
  if (document.getElementById('snmpView')?.classList.contains('active') || document.getElementById('rack-page-snmp')?.classList.contains('active')) loadSnmpInterfaces();
}

function onSnmpRoomChange(e) {
  state.currentRoomId = Number(e.target.value) || null;
  const room = state.serverRooms.find(r => Number(r.id) === Number(state.currentRoomId));
  state.currentRackId = Number(room?.racks?.[0]?.id || 0) || null;
  populateSnmpSelectors();
  loadSnmpInterfaces();
}

function onSnmpRackChange(e) {
  state.currentRackId = Number(e.target.value) || null;
  populateSnmpSelectors();
  loadSnmpInterfaces();
}

function onSnmpDeviceChange(e) {
  state.snmpDeviceId = Number(e.target.value) || null;
  loadSnmpInterfaces();
}

function setSnmpLoading(loading=false, mode='live') {
  state.snmpLoading = !!loading;
  const refreshBtn = document.getElementById('refreshSnmpBtn');
  const pollBtn = document.getElementById('pollSnmpBtn');
  const badge = document.getElementById('snmpModeBadge');
  if (refreshBtn) { refreshBtn.disabled = !!loading; refreshBtn.textContent = loading && mode !== 'snmp' ? 'Ładowanie…' : 'Odśwież'; }
  if (pollBtn) { pollBtn.disabled = !!loading; pollBtn.textContent = loading && mode === 'snmp' ? 'Pobieranie…' : 'Pobierz SNMP'; }
  if (badge && loading) badge.textContent = mode === 'snmp' ? 'tryb: polling SNMP…' : 'tryb: odświeżanie…';
}

function renderSnmpTableEmpty(message) {
  const summary = document.getElementById('snmpSummary');
  const tableWrap = document.getElementById('snmpTableWrap');
  const meta = document.getElementById('snmpDeviceMeta');
  const badge = document.getElementById('snmpModeBadge');
  if (summary) summary.innerHTML = '';
  if (meta) meta.textContent = '';
  if (badge && !state.snmpLoading) badge.textContent = 'tryb: brak danych';
  if (tableWrap) tableWrap.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><tbody><tr><td class="muted">${message}</td></tr></tbody></table></div>`;
}

async function loadSnmpInterfaces(force = false, mode = 'auto') {
  const ref = getCurrentRack();
  const room = ref?.room;
  const rack = ref?.rack;
  const deviceId = Number(state.snmpDeviceId || state.selectedDeviceId || 0) || null;
  if (!room || !rack || !deviceId) {
    renderSnmpTableEmpty('Wybierz urządzenie, aby zobaczyć interfejsy.');
    return;
  }
  try {
    setSnmpLoading(true, mode);
    const params = new URLSearchParams();
    if (force) params.set('ts', String(Date.now()));
    if (mode && mode !== 'auto') params.set('mode', mode);
    const qs = params.toString();
    state.snmpInterfaces = await api(`/api/serverrooms/${room.id}/racks/${rack.id}/devices/${deviceId}/interfaces/live${qs ? `?${qs}` : ''}`);
    renderSnmpInterfaces();
  } catch (err) {
    renderSnmpTableEmpty(err.message || 'Nie udało się pobrać interfejsów.');
  } finally {
    setSnmpLoading(false, mode);
  }
}

function renderSnmpInterfaces() {
  const summary = document.getElementById('snmpSummary');
  const tableWrap = document.getElementById('snmpTableWrap');
  const meta = document.getElementById('snmpDeviceMeta');
  const payload = state.snmpInterfaces;
  const badge = document.getElementById('snmpModeBadge');
  if (!payload || !summary || !tableWrap || !meta) return;
  if (badge) badge.textContent = `tryb: ${payload.monitor?.modeLabel || payload.monitor?.mode || 'live'}`;
  const monitor = payload.monitor || {};
  const sums = payload.summary || {};
  summary.innerHTML = `
    <div class="metric-card snmp-summary-card"><div class="metric-label">Interfejsy</div><div class="metric-value">${sums.interfaceCount || 0}</div></div>
    <div class="metric-card snmp-summary-card"><div class="metric-label">UP</div><div class="metric-value">${sums.upCount || 0}</div></div>
    <div class="metric-card snmp-summary-card"><div class="metric-label">RX razem</div><div class="metric-value">${sums.totalRxMbps || 0} Mb/s</div></div>
    <div class="metric-card snmp-summary-card"><div class="metric-label">TX razem</div><div class="metric-value">${sums.totalTxMbps || 0} Mb/s</div></div>
    <div class="metric-card snmp-summary-card"><div class="metric-label">Błędy</div><div class="metric-value">${sums.totalErrors || 0}</div></div>
    <div class="metric-card snmp-summary-card"><div class="metric-label">Progi alarmowe</div><div class="metric-value">${sums.thresholdBreaches || 0}</div></div>
  `;
  meta.textContent = `${payload.deviceLabel || 'Urządzenie'} · tryb: ${monitor.modeLabel || monitor.mode || 'derived'} · ping: ${monitor.latencyMs ?? '-'} ms · status: ${monitor.status || '-'}${monitor.reason ? ` · ${monitor.reason}` : ''}`;
  const rows = (payload.interfaces || []).map(row => `
    <tr>
      <td>${row.portNumber}</td>
      <td>${escapeHtml(row.name || '-')}</td>
      <td><span class="status-badge ${row.operStatus || 'unknown'}">${row.operStatus || '-'}</span></td>
      <td>${row.vlan || '-'}</td>
      <td>${row.rxMbps || 0}</td>
      <td>${row.txMbps || 0}</td>
      <td>${row.throughputMbps || 0}</td>
      <td>${row.utilizationPct || 0}%</td>
      <td>${(row.crcErrors || 0) + (row.drops || 0)}</td>
      <td>${escapeHtml(row.target || '-')}</td>
    </tr>
  `).join('');
  tableWrap.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Port</th><th>Nazwa</th><th>Status</th><th>VLAN</th><th>RX Mb/s</th><th>TX Mb/s</th><th>Razem</th><th>Użycie</th><th>Błędy</th><th>Cel</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="10" class="muted">Brak interfejsów.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function buildDatacenterRows() {
  const groups = new Map();
  for (const room of state.serverRooms || []) {
    const key = String(room.building || 'Bez budynku');
    if (!groups.has(key)) groups.set(key, { building: key, rooms: 0, racks: 0, devices: 0, totalU: 0, usedU: 0, uplinks: 0, monitored: 0 });
    const item = groups.get(key);
    item.rooms += 1;
    for (const rack of room.racks || []) {
      item.racks += 1;
      item.totalU += Number(rack.sizeU || 42) || 42;
      const devices = [...(rack.frontDevices || []), ...(rack.rearDevices || [])];
      const dedupe = new Map();
      devices.forEach(device => dedupe.set(Number(device.id) || `${device.label}|${device.startU}`, device));
      for (const device of dedupe.values()) {
        item.devices += 1;
        item.usedU += Math.max(1, Number(device.sizeU || 1));
        if (device.monitoring?.enabled) item.monitored += 1;
        const hasUplink = (device.ports || []).some(port => port.connectedTo && (Number(port.connectedTo.rackId) !== Number(rack.id) || Number(port.connectedTo.roomId) !== Number(room.id) || /uplink/i.test(String(port.target || ''))));
        if (hasUplink) item.uplinks += 1;
      }
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.building.localeCompare(b.building, 'pl'));
}

async function loadDatacentersView() {
  state.datacenterRows = buildDatacenterRows();
  const box = document.getElementById('datacentersTableWrap');
  if (!box) return;
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Budynek</th><th>Serwerownie</th><th>Szafy</th><th>Urządzenia</th><th>U zajęte</th><th>U wolne</th><th>Uplinki</th><th>Monitoring</th></tr>
        </thead>
        <tbody>${state.datacenterRows.map(row => `
          <tr>
            <td>${escapeHtml(row.building)}</td>
            <td>${row.rooms}</td>
            <td>${row.racks}</td>
            <td>${row.devices}</td>
            <td>${row.usedU}U</td>
            <td>${Math.max(0, row.totalU - row.usedU)}U</td>
            <td>${row.uplinks}</td>
            <td>${row.monitored}/${row.devices}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">Brak danych multi-datacenter.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function buildFlowTelemetryRows() {
  const rows = [];
  for (const room of state.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of [...(rack.frontDevices || []), ...(rack.rearDevices || [])]) {
        const ports = device.ports || [];
        if (!ports.length) continue;
        const up = ports.filter(port => String(port.status || '').toLowerCase() === 'up').length;
        const linked = ports.filter(port => port.connectedTo || port.target).length;
        const err = ports.filter(port => String(port.status || '').toLowerCase() === 'error').length;
        const rx = Number((up * 11 + linked * 7 + (device.monitoring?.enabled ? 18 : 0)).toFixed(1));
        const tx = Number((up * 8 + linked * 5 + (device.monitoring?.enabled ? 12 : 0)).toFixed(1));
        rows.push({
          building: room.building || '', roomNumber: room.roomNumber || '', rackLabel: rack.label || '',
          deviceId: device.id, deviceLabel: device.label || '', deviceType: device.type || '',
          interfaces: ports.length, up, rx, tx, errors: err,
          collectorMode: device.monitoring?.enabled ? 'snmp-cache/model' : 'model',
          updatedAt: state.dashboard?.monitoring?.lastScanAt || null
        });
      }
    }
  }
  return rows.sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx)).slice(0, 120);
}

async function loadFlowTelemetry() {
  const payload = await api('/api/flow-config');
  state.flowCollectorConfig = payload?.config || null;
  state.flowRows = buildFlowTelemetryRows();
  const cfg = state.flowCollectorConfig || {};
  const meta = document.getElementById('flowCollectorMeta');
  if (meta) meta.textContent = `Collector: ${cfg.mode || 'netflow'} · ${cfg.host || '0.0.0.0'}:${cfg.port || 2055} · auto-start: ${cfg.enabled ? 'tak' : 'nie'} · ostatni test: ${cfg.lastTestAt ? new Date(cfg.lastTestAt).toLocaleString('pl-PL') : 'brak'}`;
  const summary = document.getElementById('flowSummary');
  if (summary) {
    const rows = state.flowRows || [];
    const totalRx = rows.reduce((sum, row) => sum + Number(row.rx || 0), 0);
    const totalTx = rows.reduce((sum, row) => sum + Number(row.tx || 0), 0);
    const active = rows.filter(row => Number(row.up || 0) > 0).length;
    summary.innerHTML = `
      <div class="metric-card"><div class="metric-label">Urządzenia</div><div class="metric-value">${rows.length}</div></div>
      <div class="metric-card"><div class="metric-label">Aktywne</div><div class="metric-value">${active}</div></div>
      <div class="metric-card"><div class="metric-label">RX razem</div><div class="metric-value">${totalRx.toFixed(1)} Mb/s</div></div>
      <div class="metric-card"><div class="metric-label">TX razem</div><div class="metric-value">${totalTx.toFixed(1)} Mb/s</div></div>
      <div class="metric-card"><div class="metric-label">Tryb</div><div class="metric-value">${escapeHtml((cfg.mode || 'netflow').toUpperCase())}</div></div>
      <div class="metric-card"><div class="metric-label">Collector</div><div class="metric-value">${cfg.enabled ? 'ON' : 'OFF'}</div></div>`;
  }
  document.getElementById('flowCollectorMode').value = cfg.mode || 'netflow';
  document.getElementById('flowCollectorHost').value = cfg.host || '0.0.0.0';
  document.getElementById('flowCollectorPort').value = cfg.port || 2055;
  document.getElementById('flowCollectorEnabled').value = cfg.enabled ? '1' : '0';
  document.getElementById('flowCollectorSampling').value = cfg.sampling || 1000;
  const box = document.getElementById('flowTableWrap');
  if (!box) return;
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Lokalizacja</th><th>Urządzenie</th><th>Interfejsy</th><th>UP</th><th>RX</th><th>TX</th><th>Błędy</th><th>Tryb collectora</th><th>Aktualizacja</th></tr>
        </thead>
        <tbody>${state.flowRows.map(row => `
          <tr>
            <td>${escapeHtml(row.building)} / ${escapeHtml(row.roomNumber)} / ${escapeHtml(row.rackLabel)}</td>
            <td>${escapeHtml(row.deviceLabel)}<div class="muted small">${escapeHtml(row.deviceType)}</div></td>
            <td>${row.interfaces}</td>
            <td>${row.up}</td>
            <td>${row.rx.toFixed(1)} Mb/s</td>
            <td>${row.tx.toFixed(1)} Mb/s</td>
            <td>${row.errors}</td>
            <td>${escapeHtml(cfg.enabled ? `${cfg.mode || 'netflow'}:${cfg.port || 2055}` : row.collectorMode)}</td>
            <td>${row.updatedAt ? new Date(row.updatedAt).toLocaleString('pl-PL') : '—'}</td>
          </tr>`).join('') || '<tr><td colspan="9" class="muted">Brak danych flow telemetry.</td></tr>'}</tbody>
      </table>
    </div>`;
}

async function saveFlowCollectorConfig(event) {
  event?.preventDefault?.();
  const payload = await api('/api/flow-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: document.getElementById('flowCollectorMode').value,
      host: document.getElementById('flowCollectorHost').value.trim(),
      port: Number(document.getElementById('flowCollectorPort').value) || 2055,
      enabled: document.getElementById('flowCollectorEnabled').value === '1',
      sampling: Number(document.getElementById('flowCollectorSampling').value) || 1000
    })
  });
  state.flowCollectorConfig = payload?.config || null;
  await Promise.all([loadFlowTelemetry(), loadCollectorsView(), loadAudit()]);
}

async function testFlowCollector() {
  const result = await api('/api/flow-config/test', { method: 'POST' });
  alert(result.ok ? 'Collector flow telemetry odpowiada poprawnie.' : `Test collectora nieudany: ${result.error || 'błąd'}`);
  await Promise.all([loadFlowTelemetry(), loadCollectorsView(), loadAudit()]);
}

function buildPatchLogicRows() {

  const ref = getCurrentRack();
  const room = ref?.room;
  const rack = ref?.rack;
  if (!room || !rack) return [];
  return getAllDevicesForRack(rack)
    .filter(device => /patch|organizer|pp-/i.test(`${device.label || ''} ${device.type || ''}`))
    .flatMap(device => (device.ports || []).map(port => {
      const conn = port.connectedTo || null;
      const remote = conn ? resolveDeviceByPortRef(state.serverRooms, conn) : null;
      return {
        deviceId: device.id,
        deviceLabel: device.label || '',
        portNumber: port.portNumber,
        target: port.target || remote?.device?.label || 'brak celu',
        remoteLocation: remote ? `${remote.room.building} / ${remote.room.roomNumber} / ${remote.rack.label}` : '—',
        medium: port.connectionMeta?.medium || '-',
        routeName: port.connectionMeta?.routeName || '-',
        status: port.status || 'down'
      };
    }));
}

function renderPatchLogicTable() {
  const box = document.getElementById('patchLogicTableWrap');
  const meta = document.getElementById('patchLogicMeta');
  if (!box) return;
  const rows = buildPatchLogicRows();
  if (meta) meta.textContent = rows.length ? `Relacje logiczne patch paneli / organizerów: ${rows.length}` : 'Brak patch paneli lub organizerów w bieżącej szafie.';
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Patch panel / organizer</th><th>Port</th><th>Cel</th><th>Lokalizacja celu</th><th>Medium</th><th>Trasa</th><th>Status</th></tr>
        </thead>
        <tbody>${rows.map(row => `
          <tr>
            <td><button type="button" class="inline-link" data-patch-focus="${row.deviceId}">${escapeHtml(row.deviceLabel)}</button></td>
            <td>${row.portNumber || '-'}</td>
            <td>${escapeHtml(row.target)}</td>
            <td>${escapeHtml(row.remoteLocation)}</td>
            <td>${escapeHtml(row.medium)}</td>
            <td>${escapeHtml(row.routeName)}</td>
            <td><span class="status-badge ${row.status || 'unknown'}">${escapeHtml(row.status || '-')}</span></td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">Brak danych logicznych patch paneli.</td></tr>'}</tbody>
      </table>
    </div>`;
  box.querySelectorAll('[data-patch-focus]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.patchFocus) || null);
    activateTab('rackpage', 'rack-page-inspector');
  }));
}


function inferSubnet(ip, mask) {
  if (!ip || !mask) return '';
  const ipParts = String(ip).split('.').map(v => Number(v));
  const maskParts = String(mask).split('.').map(v => Number(v));
  if (ipParts.length !== 4 || maskParts.length !== 4 || [...ipParts, ...maskParts].some(v => Number.isNaN(v))) return '';
  const net = ipParts.map((v, i) => v & maskParts[i]).join('.');
  const bits = maskParts.map(v => Number(v).toString(2).replace(/0/g, '').length).reduce((sum, n) => sum + n, 0);
  return `${net}/${bits}`;
}

function classifyRoutingRole(device, port) {
  if (port?.connectedTo && /uplink/i.test(String(port?.target || ''))) return 'uplink';
  if (/router|firewall/i.test(String(device?.type || ''))) return 'gateway';
  if (/switch/i.test(String(device?.type || ''))) return 'switch';
  return 'endpoint';
}

function buildRoutingState(entry) {
  if (!entry) return 'brak danych';
  if (entry.gateway && (entry.subnet || (entry.ip && entry.mask))) return 'gateway OK';
  if ((entry.vlan || entry.subnet) && !entry.gateway) return 'brak gateway';
  if (entry.ip && !entry.mask && !entry.subnet) return 'IP bez maski';
  return 'podstawowy wpis';
}

function buildRoutingRows() {
  const ref = getCurrentRack();
  const room = ref?.room;
  const rack = ref?.rack;
  if (!room || !rack) return [];
  const rows = [];
  for (const device of getAllDevicesForRack(rack)) {
    const deviceNet = device.network || null;
    if (deviceNet?.ip || deviceNet?.vlan || deviceNet?.gateway) {
      rows.push({
        deviceId: device.id,
        deviceLabel: device.label || '',
        source: 'device',
        portNumber: '-',
        ip: deviceNet.ip || '-',
        mask: deviceNet.mask || '-',
        subnet: deviceNet.subnet || inferSubnet(deviceNet.ip, deviceNet.mask) || '-',
        gateway: deviceNet.gateway || '-',
        vlan: deviceNet.vlan || '-',
        role: classifyRoutingRole(device, null),
        target: '-',
        routingState: buildRoutingState(deviceNet)
      });
    }
    for (const port of device.ports || []) {
      if (!(port.ip || port.vlan || port.gateway || port.subnet)) continue;
      rows.push({
        deviceId: device.id,
        deviceLabel: device.label || '',
        source: 'port',
        portNumber: port.portNumber || '-',
        ip: port.ip || '-',
        mask: port.mask || '-',
        subnet: port.subnet || inferSubnet(port.ip, port.mask) || '-',
        gateway: port.gateway || deviceNet?.gateway || '-',
        vlan: port.vlan || deviceNet?.vlan || '-',
        role: classifyRoutingRole(device, port),
        target: port.target || '-',
        routingState: buildRoutingState({ ip: port.ip, subnet: port.subnet, mask: port.mask, gateway: port.gateway || deviceNet?.gateway, vlan: port.vlan || deviceNet?.vlan })
      });
    }
  }
  return rows.sort((a, b) => String(a.deviceLabel).localeCompare(String(b.deviceLabel), 'pl') || String(a.source).localeCompare(String(b.source), 'pl') || Number(a.portNumber || 0) - Number(b.portNumber || 0));
}

function loadRoutingTable() {
  state.routingRows = buildRoutingRows();
  const box = document.getElementById('routingTableWrap');
  const meta = document.getElementById('routingMeta');
  if (!box) return;
  const rows = state.routingRows || [];
  const vlanCount = new Set(rows.map(row => String(row.vlan || '-')).filter(v => v && v !== '-')).size;
  const subnetCount = new Set(rows.map(row => String(row.subnet || '-')).filter(v => v && v !== '-')).size;
  if (meta) meta.textContent = rows.length ? `Wpisy L3/VLAN: ${rows.length} · VLAN: ${vlanCount} · podsieci: ${subnetCount}` : 'Brak adresacji L3/VLAN dla bieżącej szafy.';
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Urządzenie</th><th>Źródło</th><th>Port</th><th>IP</th><th>Maska</th><th>Podsieć</th><th>Gateway</th><th>VLAN</th><th>Rola</th><th>Stan</th></tr>
        </thead>
        <tbody>${rows.map(row => `
          <tr>
            <td><button type="button" class="inline-link" data-routing-focus="${row.deviceId}">${escapeHtml(row.deviceLabel)}</button></td>
            <td>${escapeHtml(row.source)}</td>
            <td>${escapeHtml(String(row.portNumber || '-'))}</td>
            <td>${escapeHtml(row.ip || '-')}</td>
            <td>${escapeHtml(row.mask || '-')}</td>
            <td>${escapeHtml(row.subnet || '-')}</td>
            <td>${escapeHtml(row.gateway || '-')}</td>
            <td>${escapeHtml(row.vlan || '-')}</td>
            <td>${escapeHtml(row.role || '-')}</td>
            <td>${escapeHtml(row.routingState || '-')}</td>
          </tr>`).join('') || '<tr><td colspan="10" class="muted">Brak danych L3/VLAN.</td></tr>'}</tbody>
      </table>
    </div>`;
  box.querySelectorAll('[data-routing-focus]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.routingFocus) || null);
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function collectAddressEntries() {
  const rows = [];
  for (const room of state.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of getAllDevicesForRack(rack)) {
        const deviceNet = device.network || null;
        if (deviceNet?.ip) {
          rows.push({
            kind: 'IP urządzenia',
            key: deviceNet.ip,
            detail: `${deviceNet.vlan || '-'} / ${deviceNet.mask || '-'} / ${deviceNet.gateway || '-'}`,
            scope: `${room.building} / ${room.roomNumber} / ${rack.label} / ${device.label}`,
            roomId: room.id, rackId: rack.id, deviceId: device.id
          });
        }
        for (const port of device.ports || []) {
          if (port.ip) {
            rows.push({
              kind: 'IP portu',
              key: port.ip,
              detail: `port ${port.portNumber} · VLAN ${port.vlan || '-'}`,
              scope: `${room.building} / ${room.roomNumber} / ${rack.label} / ${device.label}`,
              roomId: room.id, rackId: rack.id, deviceId: device.id
            });
          }
        }
      }
    }
  }
  return rows;
}

function buildConflictRows() {
  const rows = [];
  const addressEntries = collectAddressEntries();
  const byIp = new Map();
  addressEntries.forEach(entry => {
    const key = String(entry.key || '').trim();
    if (!key) return;
    if (!byIp.has(key)) byIp.set(key, []);
    byIp.get(key).push(entry);
  });
  for (const [ip, entries] of byIp.entries()) {
    if (entries.length > 1) {
      rows.push({
        type: 'Duplikat IP',
        key: ip,
        status: 'critical',
        locations: entries.map(item => item.scope).join(' | '),
        details: entries.map(item => `${item.kind}: ${item.detail}`).join(' | '),
        focus: entries[0]
      });
    }
  }
  const vlanSubnets = new Map();
  for (const room of state.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of getAllDevicesForRack(rack)) {
        for (const port of device.ports || []) {
          const vlan = String(port.vlan || device.network?.vlan || '').trim();
          const subnet = String(port.subnet || inferSubnet(port.ip, port.mask) || '').trim();
          if (!vlan || !subnet) continue;
          const key = `VLAN ${vlan}`;
          if (!vlanSubnets.has(key)) vlanSubnets.set(key, new Set());
          vlanSubnets.get(key).add(subnet);
        }
      }
    }
  }
  for (const [key, subnets] of vlanSubnets.entries()) {
    if (subnets.size > 1) {
      rows.push({
        type: 'Niespójny VLAN',
        key,
        status: 'warn',
        locations: 'Wiele lokalizacji',
        details: `Podsieci przypisane do ${key}: ${Array.from(subnets).join(', ')}`,
        focus: null
      });
    }
  }
  return rows.sort((a, b) => String(a.type).localeCompare(String(b.type), 'pl') || String(a.key).localeCompare(String(b.key), 'pl'));
}


function fillPostgresForm(status) {
  document.getElementById('postgresHost').value = status?.host || '127.0.0.1';
  document.getElementById('postgresPort').value = status?.port || 5432;
  document.getElementById('postgresDatabase').value = status?.database || 'dcim';
  document.getElementById('postgresUser').value = status?.user || 'dcim';
  document.getElementById('postgresPassword').value = '';
  document.getElementById('postgresSsl').value = status?.ssl ? '1' : '0';
  document.getElementById('postgresEnabled').value = status?.enabled ? '1' : '0';
}

async function loadPostgresStatus() {
  state.postgresStatus = await api('/api/postgres/status');
  fillPostgresForm(state.postgresStatus);
  const meta = document.getElementById('postgresStatusMeta');
  if (meta) meta.textContent = `Bridge: ${state.postgresStatus.enabled ? 'aktywny' : 'wyłączony'} · moduł pg: ${state.postgresStatus.moduleInstalled ? 'zainstalowany' : 'brak'} · live sync: ${state.postgresStatus.liveSyncReady ? 'gotowy' : 'niegotowy'} · ostatni test: ${state.postgresStatus.lastTestAt ? new Date(state.postgresStatus.lastTestAt).toLocaleString('pl-PL') : 'brak'}`;
  const box = document.getElementById('postgresTableWrap');
  if (!box) return;
  const rows = [
    ['Bridge aktywny', state.postgresStatus.enabled ? 'tak' : 'nie'],
    ['Moduł pg', state.postgresStatus.moduleInstalled ? 'tak' : 'nie'],
    ['Live sync gotowy', state.postgresStatus.liveSyncReady ? 'tak' : 'nie'],
    ['Host', state.postgresStatus.host],
    ['Port', state.postgresStatus.port],
    ['Baza', state.postgresStatus.database],
    ['Użytkownik', state.postgresStatus.user],
    ['SSL', state.postgresStatus.ssl ? 'tak' : 'nie'],
    ['Ostatni test', state.postgresStatus.lastTestAt ? new Date(state.postgresStatus.lastTestAt).toLocaleString('pl-PL') : '—'],
    ['Ostatni snapshot', state.postgresStatus.lastSyncAt ? new Date(state.postgresStatus.lastSyncAt).toLocaleString('pl-PL') : '—'],
    ['Ostatni push sync', state.postgresStatus.lastPushAt ? new Date(state.postgresStatus.lastPushAt).toLocaleString('pl-PL') : '—'],
    ['Ostatni pull sync', state.postgresStatus.lastPullAt ? new Date(state.postgresStatus.lastPullAt).toLocaleString('pl-PL') : '—'],
    ['Rekordy push', state.postgresStatus.lastPushCount || 0],
    ['Rekordy mirror', state.postgresStatus.mirrorCount || 0],
    ['Ostatni import', state.postgresStatus.lastImportAt ? new Date(state.postgresStatus.lastImportAt).toLocaleString('pl-PL') : '—'],
    ['Ostatni błąd', state.postgresStatus.lastError || 'brak'],
    ['Szafy objęte snapshotem', state.postgresStatus.rowEstimate || 0]
  ];
  box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Parametr</th><th>Wartość</th></tr></thead><tbody>${rows.map(([k,v])=>`<tr><td>${escapeHtml(String(k))}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}</tbody></table></div>`;
}

async function savePostgresConfig(event) {
  event.preventDefault();
  await api('/api/postgres/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: document.getElementById('postgresEnabled').value === '1',
      host: document.getElementById('postgresHost').value.trim(),
      port: Number(document.getElementById('postgresPort').value || 5432),
      database: document.getElementById('postgresDatabase').value.trim(),
      user: document.getElementById('postgresUser').value.trim(),
      password: document.getElementById('postgresPassword').value,
      ssl: document.getElementById('postgresSsl').value === '1'
    })
  });
  await Promise.all([loadPostgresStatus(), loadAudit()]);
}

async function testPostgresBridge() {
  const result = await api('/api/postgres/test', { method: 'POST' });
  alert(result.ok ? 'Bridge PostgreSQL działa poprawnie.' : `Test bridge PostgreSQL zakończył się błędem: ${result.error}`);
  await Promise.all([loadPostgresStatus(), loadAudit()]);
}

async function exportPostgresSnapshot() {
  const result = await api('/api/postgres/export-snapshot', { method: 'POST' });
  downloadJson(result, `postgres-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await Promise.all([loadPostgresStatus(), loadAudit()]);
}


async function pushPostgresSyncNow() {
  const result = await api('/api/postgres/push-sync', { method: 'POST' });
  alert(result.ok ? `Push sync PostgreSQL zakończony (${result.result?.rows || 0} rekordów).` : `Push sync PostgreSQL nieudany: ${result.error}`);
  await Promise.all([loadPostgresStatus(), loadAudit()]);
}

async function pullPostgresSyncNow() {
  const result = await api('/api/postgres/pull-sync', { method: 'POST' });
  if (result.ok && Array.isArray(result.rows)) state.postgresMirrorRows = result.rows;
  alert(result.ok ? `Pull sync PostgreSQL zakończony (${result.result?.rows || 0} rekordów).` : `Pull sync PostgreSQL nieudany: ${result.error}`);
  await Promise.all([loadPostgresStatus(), loadAudit()]);
}

async function loadRolesView() {
  const payload = await api('/api/roles');
  state.rolesRows = payload?.rows || [];
  const box = document.getElementById('rolesTableWrap');
  const meta = document.getElementById('rolesMeta');
  const userSelect = document.getElementById('rolesUserId');
  if (userSelect) userSelect.innerHTML = state.rolesRows.map(row => `<option value="${row.id}">${escapeHtml(row.fullName)} (${escapeHtml(row.username)})</option>`).join('');
  if (state.rolesRows.length) {
    const first = state.rolesRows[0];
    document.getElementById('rolesUserId').value = String(first.id);
    document.getElementById('rolesUserRole').value = first.role || 'viewer';
    document.getElementById('rolesCanWrite').value = first.permissions?.write ? '1' : '0';
    document.getElementById('rolesCanAdmin').value = first.permissions?.admin ? '1' : '0';
    document.getElementById('rolesCanTelemetry').value = first.permissions?.telemetry ? '1' : '0';
    document.getElementById('rolesUserScope').value = first.scope || 'global';
  }
  if (meta) meta.textContent = state.rolesRows.length ? `Użytkownicy: ${state.rolesRows.length} · RBAC podstawowe + granularne per widok.` : 'Brak użytkowników.';
  await loadUsersPanel();
  if (!box) return;
  renderRolesGranularMatrix();
  box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Użytkownik</th><th>Rola</th><th>Zmiany</th><th>Ustawienia</th><th>Telemetry</th><th>Zakres</th><th>Widoki granularne</th></tr></thead><tbody>${state.rolesRows.map(row => `<tr><td>${escapeHtml(row.fullName)}<div class="muted small">${escapeHtml(row.username)}</div></td><td>${escapeHtml(row.role)}</td><td>${row.permissions?.write ? 'tak' : 'nie'}</td><td>${row.permissions?.admin ? 'tak' : 'nie'}</td><td>${row.permissions?.telemetry ? 'tak' : 'nie'}</td><td>${escapeHtml(row.scope || 'global')}</td><td>${Number(row.viewPermissionsCount || 0)} / ${getRoleViewPermissionKeys().length}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Brak ról i uprawnień.</td></tr>'}</tbody></table></div>`;
  const roleSelect = document.getElementById('rolesUserId');
  if (roleSelect) roleSelect.onchange = onRoleUserChange;
}

function onRoleUserChange() {
  const id = Number(document.getElementById('rolesUserId').value) || null;
  const row = (state.rolesRows || []).find(item => Number(item.id) === id);
  if (!row) return;
  document.getElementById('rolesUserRole').value = row.role || 'viewer';
  document.getElementById('rolesCanWrite').value = row.permissions?.write ? '1' : '0';
  document.getElementById('rolesCanAdmin').value = row.permissions?.admin ? '1' : '0';
  document.getElementById('rolesCanTelemetry').value = row.permissions?.telemetry ? '1' : '0';
  document.getElementById('rolesUserScope').value = row.scope || 'global';
  renderRolesGranularMatrix();
  const roleSelect = document.getElementById('rolesUserId');
  if (roleSelect) roleSelect.onchange = onRoleUserChange;
}

async function saveRoleConfig(event) {
  event?.preventDefault?.();
  const userId = Number(document.getElementById('rolesUserId').value) || null;
  if (!userId) return;
  await api(`/api/roles/${userId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: document.getElementById('rolesUserRole').value,
      scope: document.getElementById('rolesUserScope').value || 'global',
      permissions: {
        write: document.getElementById('rolesCanWrite').value === '1',
        admin: document.getElementById('rolesCanAdmin').value === '1',
        telemetry: document.getElementById('rolesCanTelemetry').value === '1'
      },
      viewPermissions: collectRoleViewPermissions()
    })
  });
  await Promise.all([loadRolesView(), loadAudit()]);
}


function getRoleViewPermissionKeys() {
  return [
    ['rack', 'Szafa rack'],
    ['map', 'Mapa 2D'],
    ['report', 'Raport'],
    ['flow', 'Flow'],
    ['collectors', 'Kolektory'],
    ['postgres', 'PostgreSQL'],
    ['roles', 'Role'],
    ['map3d', 'Mapa 3D'],
    ['dependencies', 'Zależności'],
    ['cable', 'Trasy kablowe'],
    ['audit', 'Audyt'],
  ];
}

function renderRolesGranularMatrix() {
  const wrap = document.getElementById('rolesGranularWrap');
  if (!wrap) return;
  const userId = Number(document.getElementById('rolesUserId')?.value || 0) || null;
  const row = (state.rolesRows || []).find(item => Number(item.id) === userId) || (state.rolesRows || [])[0] || null;
  const current = row?.viewPermissions || {};
  const rows = getRoleViewPermissionKeys();
  wrap.innerHTML = `
    <div class="panel-card panel-card-embedded">
      <div class="panel-title">Uprawnienia granularne per widok</div>
      <div class="table-scroll top-gap">
        <table class="data-table compact-table">
          <thead><tr><th>Widok</th><th>Dostęp</th></tr></thead>
          <tbody>${rows.map(([key, label]) => `
            <tr>
              <td>${escapeHtml(label)}</td>
              <td><label class="inline-toggle"><input type="checkbox" data-role-view-key="${key}" ${current[key] !== false ? 'checked' : ''}> <span>${current[key] !== false ? 'włączony' : 'wyłączony'}</span></label></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
  wrap.querySelectorAll('[data-role-view-key]').forEach(input => input.addEventListener('change', () => {
    const span = input.parentElement?.querySelector('span');
    if (span) span.textContent = input.checked ? 'włączony' : 'wyłączony';
  }));
}

function collectRoleViewPermissions() {
  const entries = {};
  document.querySelectorAll('[data-role-view-key]').forEach(input => {
    entries[input.dataset.roleViewKey] = !!input.checked;
  });
  return entries;
}

async function exportRolesJson() {
  downloadJson({ exportedAt: new Date().toISOString(), rows: state.rolesRows || [] }, `roles-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

async function exportMap3dJson() {
  downloadJson({ exportedAt: new Date().toISOString(), rooms: state.map3dRows || [] }, `map3d-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

async function exportDependenciesCsv() {
  const rows = (state.dependencyRows || []).map(row => ({ service: row.service, dependsOn: row.dependsOn, localPort: row.localPort, remotePort: row.remotePort, medium: row.medium, impact: row.impact }));
  downloadCsv(rows, `dependencies-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, ['service','dependsOn','localPort','remotePort','medium','impact']);
}

async function exportCableCsv() {
  const rows = (state.cableVizRows || []).map(row => ({ routeName: row.routeName, from: row.from, to: row.to, medium: row.medium, segments: row.segments, status: row.status, note: row.note }));
  downloadCsv(rows, `cable-routes-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, ['routeName','from','to','medium','segments','status','note']);
}

async function exportFlowJson() {
  downloadJson({ exportedAt: new Date().toISOString(), collector: state.flowCollectorConfig || null, rows: state.flowRows || [] }, `flow-telemetry-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

function getMap3dActiveRoom() {
  const rooms = state.map3dRows || [];
  if (!rooms.length) return null;
  if (typeof state.map3dActiveRoomId !== 'number') state.map3dActiveRoomId = Number(rooms[0].roomId || 0) || null;
  let room = rooms.find(item => Number(item.roomId) === Number(state.map3dActiveRoomId));
  if (!room) {
    room = rooms[0];
    state.map3dActiveRoomId = Number(room.roomId || 0) || null;
  }
  return room;
}


function ensureMap3dCamera() {
  if (!state.map3dCamera) {
    state.map3dCamera = { x: 0, z: -120, y: 56, yaw: 0, pitch: 0, dragging: false, lastX: 0, lastY: 0, fov: 760 };
  }
  return state.map3dCamera;
}

function getMap3dLayout(room) {
  const racks = [...(room?.racks || [])].sort((a, b) => {
    const byRow = Number(a.rowNumber || 0) - Number(b.rowNumber || 0);
    if (byRow) return byRow;
    return Number(a.positionInRow || 0) - Number(b.positionInRow || 0);
  });
  const rowIds = [...new Set(racks.map(r => Number(r.rowNumber || 1)).filter(Boolean))].sort((a, b) => a - b);
  const leftRowId = rowIds[0] || 1;
  const rightRowId = rowIds[1] || leftRowId + 1;
  const leftRow = racks.filter(r => Number(r.rowNumber || leftRowId) === leftRowId);
  const rightRow = racks.filter(r => Number(r.rowNumber || rightRowId) === rightRowId);
  const fallback = racks.filter(r => !leftRow.includes(r) && !rightRow.includes(r));
  while (fallback.length) {
    if (leftRow.length <= rightRow.length) leftRow.push(fallback.shift());
    else rightRow.push(fallback.shift());
  }
  const laneHalf = 150;
  const rackOffset = 255;
  const startZ = 240;
  const spacing = 235;
  const items = [];
  leftRow.forEach((rack, idx) => {
    items.push({
      rack,
      side: 'left',
      pairIndex: idx,
      x: -rackOffset,
      z: startZ + idx * spacing,
      width: 84,
      depth: 156,
      height: 248,
    });
  });
  rightRow.forEach((rack, idx) => {
    items.push({
      rack,
      side: 'right',
      pairIndex: idx,
      x: rackOffset,
      z: startZ + idx * spacing,
      width: 84,
      depth: 156,
      height: 248,
    });
  });
  items.sort((a, b) => a.z - b.z || a.x - b.x);
  const corridorLength = Math.max(1900, startZ + Math.max(leftRow.length, rightRow.length, 1) * spacing + 520);
  return { racks, items, corridorLength, laneHalf, rackOffset, startZ, spacing, roomWidth: 1120, roomHeight: 340 };
}

function clampMap3dCamera(room) {
  const cam = ensureMap3dCamera();
  const layout = getMap3dLayout(room);
  cam.x = Math.max(-150, Math.min(150, Number(cam.x || 0)));
  cam.z = Math.max(-240, Math.min(layout.corridorLength - 180, Number(cam.z || -120)));
  cam.y = Math.max(40, Math.min(84, Number(cam.y || 56)));
  cam.yaw = Math.max(-0.85, Math.min(0.85, Number(cam.yaw || 0)));
  cam.pitch = Math.max(-0.2, Math.min(0.2, Number(cam.pitch || 0)));
  return layout;
}

function buildMap3dSceneMarkup(room) {
  const layout = getMap3dLayout(room);
  const selectedRackId = Number(state.currentRackId || state.map3dFocusRackId || 0) || null;
  const roomsOptions = (state.map3dRows || []).map(item => `<option value="${item.roomId}" ${Number(item.roomId) === Number(room.roomId) ? 'selected' : ''}>${escapeHtml(item.building)} / ${escapeHtml(String(item.roomNumber))} · ${escapeHtml(item.roomType || 'serwerownia')}</option>`).join('');
  const focusPlaceholder = !selectedRackId ? '<div class="device-inspector-empty">Podejdź do szafy albo kliknij ją w widoku 3D, aby zobaczyć urządzenia i otworzyć klasyczny widok rack.</div>' : '';
  return `
    <div class="map3d-immersive-shell map3d-fps-shell">
      <div class="map3d-toolbar-secondary">
        <label class="map3d-room-picker"><span>Aktywna serwerownia</span><select id="map3dRoomPicker">${roomsOptions}</select></label>
        <div class="map3d-legend">Sterowanie: <strong>W/A/S/D</strong> chodzenie, <strong>mysz</strong> rozglądanie, <strong>Q/E</strong> obrót, <strong>Shift</strong> szybciej, <strong>Enter</strong> otwórz szafę.</div>
      </div>
      <div class="map3d-main-grid">
        <div class="map3d-viewport map3d-fps-viewport" id="map3dViewport">
          <canvas id="map3dCanvas" width="1280" height="720" aria-label="Widok 3D serwerowni"></canvas>
          <div class="map3d-crosshair"></div>
          <div class="map3d-hud">
            <div class="map3d-hud-badge">${escapeHtml(room.building)} / ${escapeHtml(String(room.roomNumber))} · ${escapeHtml(room.roomType || 'serwerownia')}</div>
            <div class="map3d-hud-meta">Racks: ${layout.racks.length} · urządzenia: ${layout.racks.reduce((sum, rack) => sum + (rack.devices || []).length, 0)}</div>
            <div class="map3d-hud-tip" id="map3dHudTip">Idź korytarzem i kliknij wybraną szafę, żeby ją zaznaczyć.</div>
          </div>
        </div>
        <div class="map3d-sidebar-card">
          <div class="panel-title">Inspektor 3D</div>
          <div class="muted">To jest chodzony widok korytarza. Podejdź do szafy i kliknij albo wciśnij Enter, aby przejść do sprzętu.</div>
          <div class="map3d-mini-stats">
            <div class="metric-card"><div class="metric-label">Szafy</div><div class="metric-value">${layout.racks.length}</div></div>
            <div class="metric-card"><div class="metric-label">Urządzenia</div><div class="metric-value">${layout.racks.reduce((sum, rack) => sum + (rack.devices || []).length, 0)}</div></div>
          </div>
          <div id="map3dFocusInfo" class="map3d-focus-box">${focusPlaceholder}</div>
          <div class="map3d-rack-list">${layout.racks.map(rack => `<button type="button" class="map3d-rack-list-item ${selectedRackId && Number(rack.rackId) === Number(selectedRackId) ? 'active' : ''}" data-map3d-rack-list="${rack.rackId}"><span>${escapeHtml(rack.label || 'Rack')}</span><span class="muted">Rząd ${Number(rack.rowNumber || 1)} · poz. ${Number(rack.positionInRow || 1)}</span></button>`).join('')}</div>
          <div class="toolbar-inline top-gap"><button type="button" class="btn btn-primary btn-small" id="map3dOpenRackBtn">Otwórz wybraną szafę</button><button type="button" class="btn btn-secondary btn-small" id="map3dCenterBtn">Start kamery</button></div>
        </div>
      </div>
    </div>`;
}

function getMap3dProjectedRackRects(room) {
  const canvas = document.getElementById('map3dCanvas');
  if (!canvas || !room) return [];
  const cam = ensureMap3dCamera();
  const layout = getMap3dLayout(room);
  const width = canvas.clientWidth || canvas.width || 1280;
  const height = canvas.clientHeight || canvas.height || 720;
  const cx = width / 2;
  const horizonY = height * 0.44 + cam.pitch * 180;
  const cos = Math.cos(cam.yaw);
  const sin = Math.sin(cam.yaw);
  const rects = [];
  for (const item of layout.items) {
    const dx = item.x - cam.x;
    const dz = item.z - cam.z;
    const rx = dx * cos - dz * sin;
    const rz = dx * sin + dz * cos;
    if (rz < 80) continue;
    const scale = cam.fov / rz;
    const baseX = cx + rx * scale;
    const rackW = item.width * scale;
    const rackH = item.height * scale;
    const baseY = horizonY + (cam.y * 1.55) + 64 * scale;
    rects.push({ rackId: Number(item.rack.rackId || 0), x: baseX - rackW / 2, y: baseY - rackH, w: rackW, h: rackH, z: rz, centerX: baseX, centerY: baseY - rackH / 2 });
  }
  return rects.sort((a, b) => b.z - a.z);
}

function drawMap3dScene() {
  const room = getMap3dActiveRoom();
  const canvas = document.getElementById('map3dCanvas');
  if (!room || !canvas) return;
  const layout = clampMap3dCamera(room);
  const cam = ensureMap3dCamera();
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(960, Math.round(rect.width || 1280));
  const height = Math.max(580, Math.round(rect.height || 720));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const horizonY = height * 0.43 + cam.pitch * 180;
  const vanishX = width / 2 - cam.yaw * 250;
  const floorTopHalf = 118;
  const floorBottomHalf = width * 0.33;
  const ceilTopHalf = width * 0.36;
  const ceilBottomHalf = 132;
  const bottomY = height;
  const topY = 0;
  const backWallTop = 86;
  const backWallBottom = horizonY + 16;

  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#020816');
  bg.addColorStop(0.36, '#06152d');
  bg.addColorStop(1, '#020814');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const floorGrad = ctx.createLinearGradient(0, horizonY, 0, bottomY);
  floorGrad.addColorStop(0, '#0d2341');
  floorGrad.addColorStop(0.55, '#07152a');
  floorGrad.addColorStop(1, '#030913');
  ctx.beginPath();
  ctx.moveTo(vanishX - floorTopHalf, horizonY);
  ctx.lineTo(vanishX + floorTopHalf, horizonY);
  ctx.lineTo(width / 2 + floorBottomHalf, bottomY);
  ctx.lineTo(width / 2 - floorBottomHalf, bottomY);
  ctx.closePath();
  ctx.fillStyle = floorGrad;
  ctx.fill();

  const ceilingGrad = ctx.createLinearGradient(0, topY, 0, horizonY);
  ceilingGrad.addColorStop(0, '#061226');
  ceilingGrad.addColorStop(1, '#081b34');
  ctx.beginPath();
  ctx.moveTo(width / 2 - ceilTopHalf, topY);
  ctx.lineTo(width / 2 + ceilTopHalf, topY);
  ctx.lineTo(vanishX + ceilBottomHalf, horizonY);
  ctx.lineTo(vanishX - ceilBottomHalf, horizonY);
  ctx.closePath();
  ctx.fillStyle = ceilingGrad;
  ctx.fill();

  const leftWallGrad = ctx.createLinearGradient(0, 0, width * 0.28, height);
  leftWallGrad.addColorStop(0, '#091a31');
  leftWallGrad.addColorStop(1, '#030a16');
  ctx.beginPath();
  ctx.moveTo(0, topY);
  ctx.lineTo(width / 2 - ceilTopHalf, topY);
  ctx.lineTo(vanishX - ceilBottomHalf, horizonY);
  ctx.lineTo(width / 2 - floorBottomHalf, bottomY);
  ctx.lineTo(0, bottomY);
  ctx.closePath();
  ctx.fillStyle = leftWallGrad;
  ctx.fill();

  const rightWallGrad = ctx.createLinearGradient(width, 0, width * 0.72, height);
  rightWallGrad.addColorStop(0, '#091a31');
  rightWallGrad.addColorStop(1, '#030a16');
  ctx.beginPath();
  ctx.moveTo(width, topY);
  ctx.lineTo(width / 2 + ceilTopHalf, topY);
  ctx.lineTo(vanishX + ceilBottomHalf, horizonY);
  ctx.lineTo(width / 2 + floorBottomHalf, bottomY);
  ctx.lineTo(width, bottomY);
  ctx.closePath();
  ctx.fillStyle = rightWallGrad;
  ctx.fill();

  const backWallGrad = ctx.createLinearGradient(0, backWallTop, 0, backWallBottom);
  backWallGrad.addColorStop(0, '#11263f');
  backWallGrad.addColorStop(1, '#081223');
  const backWallW = 230;
  ctx.fillStyle = backWallGrad;
  ctx.fillRect(vanishX - backWallW / 2, backWallTop, backWallW, backWallBottom - backWallTop);

  const doorW = 94;
  const doorH = 154;
  const doorX = vanishX - doorW / 2;
  const doorY = backWallBottom - doorH;
  const doorGrad = ctx.createLinearGradient(doorX, doorY, doorX + doorW, doorY + doorH);
  doorGrad.addColorStop(0, '#07111e');
  doorGrad.addColorStop(1, '#0d1e34');
  ctx.fillStyle = doorGrad;
  ctx.fillRect(doorX, doorY, doorW, doorH);
  ctx.strokeStyle = 'rgba(120,190,255,0.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(doorX + 1, doorY + 1, doorW - 2, doorH - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(doorX + doorW - 14, doorY + doorH * 0.5, 4, 10);

  const stripGlow = (x1, y1, x2, y2, w, color, alpha) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  };

  stripGlow(vanishX - ceilBottomHalf + 8, horizonY + 2, width / 2 - floorBottomHalf + 18, bottomY - 6, 3, '#5fd5ff', 0.9);
  stripGlow(vanishX + ceilBottomHalf - 8, horizonY + 2, width / 2 + floorBottomHalf - 18, bottomY - 6, 3, '#5fd5ff', 0.9);
  stripGlow(vanishX - 128, horizonY + 3, vanishX + 128, horizonY + 3, 4, '#71ddff', 0.85);

  for (let i = 0; i < 6; i += 1) {
    const t = i / 5;
    const y = 30 + t * (horizonY - 70);
    const half = ceilTopHalf - (ceilTopHalf - 42) * (t * 0.9);
    const segW = 14 + (1 - t) * 10;
    stripGlow(width / 2 - half, y, width / 2 - half + segW, y + 48, 6, '#c8f4ff', 0.95);
    stripGlow(width / 2 + half - segW, y, width / 2 + half, y + 48, 6, '#c8f4ff', 0.95);
  }

  ctx.strokeStyle = 'rgba(78,168,255,0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i += 1) {
    const t = i / 11;
    const y = horizonY + Math.pow(t, 1.42) * (bottomY - horizonY);
    const half = floorTopHalf + (floorBottomHalf - floorTopHalf) * Math.pow(t, 0.88);
    ctx.beginPath();
    ctx.moveTo(vanishX - half, y);
    ctx.lineTo(vanishX + half, y);
    ctx.stroke();
  }
  for (let i = -4; i <= 4; i += 1) {
    const endX = width / 2 + i * 86;
    ctx.beginPath();
    ctx.moveTo(vanishX, horizonY);
    ctx.lineTo(endX, bottomY);
    ctx.stroke();
  }

  const projected = getMap3dProjectedRackRects(room);
  state.map3dProjectedRects = projected;
  const selectedRackId = Number(state.map3dFocusRackId || state.currentRackId || 0) || null;
  projected.forEach(rectInfo => {
    const rack = layout.racks.find(item => Number(item.rackId) === rectInfo.rackId);
    if (!rack) return;
    const x = rectInfo.x;
    const y = rectInfo.y;
    const w = rectInfo.w;
    const h = rectInfo.h;
    const sideDepth = Math.max(8, w * 0.18);
    const topDepth = Math.max(6, h * 0.045);
    const isLeft = x + w / 2 < width / 2;
    const frontW = Math.max(10, w * 0.18);
    const bodyW = Math.max(18, w - frontW);
    const bodyX = isLeft ? x : x + frontW;
    const frontX = isLeft ? x + bodyW : x;
    const active = selectedRackId === rectInfo.rackId;

    ctx.fillStyle = active ? '#142b46' : '#10253d';
    ctx.fillRect(bodyX, y, bodyW, h);

    ctx.fillStyle = active ? '#203f67' : '#1b3554';
    ctx.fillRect(frontX, y, frontW, h);

    ctx.fillStyle = isLeft ? 'rgba(72,102,136,0.55)' : 'rgba(58,86,118,0.55)';
    ctx.beginPath();
    ctx.moveTo(bodyX, y);
    ctx.lineTo(bodyX + bodyW, y);
    ctx.lineTo(bodyX + bodyW + (isLeft ? 1 : -1) * sideDepth, y - topDepth);
    ctx.lineTo(bodyX + (isLeft ? 1 : -1) * sideDepth, y - topDepth);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(164,196,226,0.18)';
    ctx.fillRect(frontX + frontW * 0.16, y + h * 0.06, frontW * 0.68, h * 0.84);

    const unitCount = Math.max(8, Math.min(18, Math.round(h / 16)));
    for (let u = 0; u < unitCount; u += 1) {
      const uy = y + h * 0.08 + u * (h * 0.78 / unitCount);
      ctx.fillStyle = u % 2 === 0 ? 'rgba(85,104,128,0.78)' : 'rgba(56,73,96,0.82)';
      ctx.fillRect(bodyX + bodyW * 0.08, uy, bodyW * 0.84, Math.max(2, h * 0.022));
      if (u % 2 === 0) {
        ctx.fillStyle = active ? 'rgba(104,208,255,0.95)' : 'rgba(79,186,245,0.8)';
        ctx.fillRect(bodyX + bodyW * 0.88, uy + 1, Math.max(2, bodyW * 0.04), Math.max(2, h * 0.012));
      }
    }

    ctx.fillStyle = 'rgba(6,10,18,0.9)';
    ctx.beginPath();
    ctx.ellipse(bodyX + bodyW * 0.5, y + h + 12, bodyW * 0.62, Math.max(8, h * 0.055), 0, 0, Math.PI * 2);
    ctx.fill();

    if (active) {
      ctx.save();
      ctx.strokeStyle = 'rgba(92,205,255,0.95)';
      ctx.lineWidth = Math.max(2, w * 0.028);
      ctx.shadowColor = '#66d9ff';
      ctx.shadowBlur = 18;
      ctx.strokeRect(bodyX - 4, y - 4, bodyW + frontW + 8, h + 8);
      ctx.restore();
    }

    const labelText = rack.label || `Szafa ${rectInfo.rackId}`;
    const labelW = Math.min(130, Math.max(54, bodyW + frontW * 0.5));
    const labelH = Math.max(18, h * 0.1);
    const labelX = isLeft ? frontX + 4 : bodyX + 4;
    const labelY = y + h - labelH - 6;
    ctx.fillStyle = 'rgba(7,12,22,0.88)';
    ctx.fillRect(labelX, labelY, labelW, labelH);
    ctx.fillStyle = '#eef7ff';
    ctx.font = `600 ${Math.max(10, Math.min(14, bodyW * 0.16))}px system-ui`;
    ctx.fillText(labelText.slice(0, 16), labelX + 8, labelY + labelH * 0.68);
  });

  const nearest = getNearestMap3dRack(room);
  const hudTip = document.getElementById('map3dHudTip');
  if (hudTip) {
    hudTip.textContent = nearest ? `Najbliżej: ${nearest.label || 'szafa'} · Enter otwiera widok sprzętu.` : 'Idź korytarzem i kliknij wybraną szafę, żeby ją zaznaczyć.';
  }
}

function getNearestMap3dRack(room) {
  const cam = ensureMap3dCamera();
  const layout = getMap3dLayout(room);
  let best = null;
  for (const item of layout.items) {
    const dx = item.x - cam.x;
    const dz = item.z - cam.z;
    const dist = Math.hypot(dx, dz);
    if (!best || dist < best.distance) best = { ...item.rack, distance: dist };
  }
  return best && best.distance < 220 ? best : null;
}

function focusMap3dRack(rackId) {
  const room = getMap3dActiveRoom();
  if (!room) return;
  const layout = getMap3dLayout(room);
  const item = layout.items.find(entry => Number(entry.rack.rackId) === Number(rackId));
  if (!item) return;
  state.map3dFocusRackId = Number(item.rack.rackId || 0) || null;
  state.currentRoomId = Number(room.roomId || 0) || null;
  state.currentRackId = Number(item.rack.rackId || 0) || null;
  const cam = ensureMap3dCamera();
  cam.z = item.z - 120;
  cam.x = item.side === 'left' ? -64 : 64;
  cam.yaw = item.side === 'left' ? -0.18 : 0.18;
  drawMap3dScene();
  document.querySelectorAll('.map3d-rack-list-item').forEach(node => node.classList.toggle('active', Number(node.dataset.map3dRackList) === Number(item.rack.rackId)));
  updateMap3dFocusPanel();
}

function openFocusedMap3dRack() {
  if (!state.currentRoomId || !state.currentRackId) {
    const room = getMap3dActiveRoom();
    const nearest = room ? getNearestMap3dRack(room) : null;
    if (nearest) focusMap3dRack(nearest.rackId);
  }
  if (!state.currentRoomId || !state.currentRackId) {
    toast('Najpierw wybierz lub podejdź do szafy w widoku 3D.', 'info');
    return;
  }
  renderRack();
  switchView('rack');
  activateTab('rackpage', 'rack-page-layout');
}

function updateMap3dFocusPanel() {
  const room = getMap3dActiveRoom();
  const box = document.getElementById('map3dFocusInfo');
  if (!room || !box) return;
  const selectedId = Number(state.map3dFocusRackId || state.currentRackId || 0) || null;
  const rack = (room.racks || []).find(item => Number(item.rackId) === selectedId) || getNearestMap3dRack(room);
  if (!rack) {
    box.innerHTML = '<div class="device-inspector-empty">Podejdź do szafy, żeby zobaczyć jej urządzenia i przejść dalej.</div>';
    return;
  }
  if (!selectedId && rack.rackId) {
    state.currentRoomId = Number(room.roomId || 0) || null;
    state.currentRackId = Number(rack.rackId || 0) || null;
  }
  box.innerHTML = `
    <div class="panel-title">${escapeHtml(rack.label || 'Rack')}</div>
    <div class="muted">Rząd ${Number(rack.rowNumber || 1)} · pozycja ${Number(rack.positionInRow || 1)} · zajętość ${Number(rack.utilizationPct || 0)}%</div>
    <div class="map3d-device-list">${(rack.devices || []).map(device => `<div class="map3d-device-row"><strong>${escapeHtml(device.label || device.type || 'urządzenie')}</strong><span>${escapeHtml(device.type || 'sprzęt')} · ${Number(device.sizeU || 1)}U</span></div>`).join('') || '<div class="device-inspector-empty">Brak urządzeń w tej szafie.</div>'}</div>`;
  document.querySelectorAll('.map3d-rack-list-item').forEach(node => node.classList.toggle('active', Number(node.dataset.map3dRackList) === Number(rack.rackId)));
}

function renderMap3dScene() {
  const room = getMap3dActiveRoom();
  const box = document.getElementById('map3dWrap');
  if (!box) return;
  if (!room) {
    box.innerHTML = '<div class="device-inspector-empty">Brak danych 3D do renderu. Dodaj serwerownię, rzędy i szafy lub odśwież widok.</div>';
    return;
  }
  box.innerHTML = buildMap3dSceneMarkup(room);
  bindMap3dSceneControls();
  drawMap3dScene();
  updateMap3dFocusPanel();
}

function bindMap3dSceneControls() {
  const viewport = document.getElementById('map3dViewport');
  const canvas = document.getElementById('map3dCanvas');
  const picker = document.getElementById('map3dRoomPicker');
  const centerBtn = document.getElementById('map3dCenterBtn');
  const openBtn = document.getElementById('map3dOpenRackBtn');
  if (picker && !picker.dataset.bound) {
    picker.dataset.bound = '1';
    picker.addEventListener('change', () => {
      state.map3dActiveRoomId = Number(picker.value || 0) || null;
      state.map3dFocusRackId = null;
      state.currentRackId = null;
      const cam = ensureMap3dCamera();
      cam.x = 0; cam.z = -120; cam.y = 56; cam.yaw = 0; cam.pitch = 0;
      renderMap3dScene();
    });
  }
  if (openBtn && !openBtn.dataset.bound) {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', openFocusedMap3dRack);
  }
  if (centerBtn && !centerBtn.dataset.bound) {
    centerBtn.dataset.bound = '1';
    centerBtn.addEventListener('click', () => {
      const cam = ensureMap3dCamera();
      cam.x = 0; cam.z = -120; cam.y = 56; cam.yaw = 0; cam.pitch = 0;
      state.map3dFocusRackId = null;
      drawMap3dScene();
      updateMap3dFocusPanel();
      viewport?.focus();
    });
  }
  document.querySelectorAll('[data-map3d-rack-list]').forEach(node => {
    if (node.dataset.boundMap3d) return;
    node.dataset.boundMap3d = '1';
    node.addEventListener('click', () => focusMap3dRack(Number(node.dataset.map3dRackList || 0)));
    node.addEventListener('dblclick', () => {
      focusMap3dRack(Number(node.dataset.map3dRackList || 0));
      openFocusedMap3dRack();
    });
  });
  if (canvas && !canvas.dataset.bound) {
    canvas.dataset.bound = '1';
    canvas.addEventListener('click', event => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = [...(state.map3dProjectedRects || [])].reverse().find(item => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
      if (hit) focusMap3dRack(hit.rackId);
      viewport?.focus();
    });
    canvas.addEventListener('dblclick', event => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hit = [...(state.map3dProjectedRects || [])].reverse().find(item => x >= item.x && x <= item.x + item.w && y >= item.y && y <= item.y + item.h);
      if (hit) {
        focusMap3dRack(hit.rackId);
        openFocusedMap3dRack();
      }
    });
  }
  if (viewport && !viewport.dataset.bound) {
    viewport.dataset.bound = '1';
    viewport.tabIndex = 0;
    viewport.addEventListener('pointerdown', event => {
      const cam = ensureMap3dCamera();
      cam.dragging = true;
      cam.lastX = event.clientX;
      cam.lastY = event.clientY;
      viewport.setPointerCapture?.(event.pointerId);
      viewport.focus();
    });
    viewport.addEventListener('pointermove', event => {
      const cam = ensureMap3dCamera();
      if (!cam.dragging) return;
      cam.yaw += (event.clientX - cam.lastX) * 0.0048;
      cam.pitch += (event.clientY - cam.lastY) * 0.0018;
      cam.lastX = event.clientX;
      cam.lastY = event.clientY;
      drawMap3dScene();
      updateMap3dFocusPanel();
    });
    const stopDrag = event => {
      const cam = ensureMap3dCamera();
      cam.dragging = false;
      if (event?.pointerId != null) viewport.releasePointerCapture?.(event.pointerId);
    };
    viewport.addEventListener('pointerup', stopDrag);
    viewport.addEventListener('pointerleave', stopDrag);
    viewport.addEventListener('wheel', event => {
      event.preventDefault();
      const cam = ensureMap3dCamera();
      const step = event.deltaY > 0 ? 42 : -42;
      cam.z += Math.cos(cam.yaw) * step;
      cam.x += Math.sin(cam.yaw) * step;
      drawMap3dScene();
      updateMap3dFocusPanel();
    }, { passive: false });
    viewport.addEventListener('keydown', event => {
      const cam = ensureMap3dCamera();
      const speed = event.shiftKey ? 34 : 18;
      const strafe = event.shiftKey ? 22 : 12;
      let handled = true;
      if (event.code === 'KeyW') {
        cam.z += Math.cos(cam.yaw) * speed;
        cam.x += Math.sin(cam.yaw) * speed;
      } else if (event.code === 'KeyS') {
        cam.z -= Math.cos(cam.yaw) * speed;
        cam.x -= Math.sin(cam.yaw) * speed;
      } else if (event.code === 'KeyA') {
        cam.x -= Math.cos(cam.yaw) * strafe;
        cam.z += Math.sin(cam.yaw) * strafe;
      } else if (event.code === 'KeyD') {
        cam.x += Math.cos(cam.yaw) * strafe;
        cam.z -= Math.sin(cam.yaw) * strafe;
      } else if (event.code === 'KeyQ') {
        cam.yaw -= 0.08;
      } else if (event.code === 'KeyE') {
        cam.yaw += 0.08;
      } else if (event.code === 'Enter') {
        openFocusedMap3dRack();
      } else {
        handled = false;
      }
      if (handled) {
        event.preventDefault();
        drawMap3dScene();
        updateMap3dFocusPanel();
      }
    });
  }
}

async function loadMap3dView() {
  const payload = await api('/api/map3d');
  state.map3dRows = payload?.rooms || [];
  const room = getMap3dActiveRoom();
  const meta = document.getElementById('map3dMeta');
  const stats = document.getElementById('map3dStats');
  if (meta) meta.textContent = room ? `Tryb 3D-korytarza aktywny. Serwerownie: ${state.map3dRows.length}. Wybrana: ${room.building} / ${room.roomNumber}.` : 'Brak danych 3D.';
  if (stats) {
    const rooms = state.map3dRows || [];
    const rackCount = rooms.reduce((sum, item) => sum + (item.racks || []).length, 0);
    const deviceCount = rooms.reduce((sum, item) => sum + (item.racks || []).reduce((inner, rack) => inner + (rack.devices || []).length, 0), 0);
    const usedU = rooms.reduce((sum, item) => sum + (item.racks || []).reduce((inner, rack) => inner + Number(rack.usedU || 0), 0), 0);
    stats.innerHTML = `
      <div class="metric-card"><div class="metric-label">Serwerownie</div><div class="metric-value">${rooms.length}</div></div>
      <div class="metric-card"><div class="metric-label">Szafy</div><div class="metric-value">${rackCount}</div></div>
      <div class="metric-card"><div class="metric-label">Urządzenia</div><div class="metric-value">${deviceCount}</div></div>
      <div class="metric-card"><div class="metric-label">ZU</div><div class="metric-value">${usedU}</div></div>`;
  }
  renderMap3dScene();
}

function toggleMap3dMode() {
  state.map3dMode = state.map3dMode === 'full' ? 'lite' : 'full';
  const btn = document.getElementById('toggleMap3dModeBtn');
  if (btn) btn.textContent = state.map3dMode === 'full' ? 'Tryb lite' : 'Tryb full';
  loadMap3dView();
}
async function loadDependenciesView() {
  const payload = await api('/api/dependencies');
  state.dependencyRows = payload?.rows || [];
  const box = document.getElementById('dependenciesTableWrap');
  const meta = document.getElementById('dependenciesMeta');
  const stats = document.getElementById('dependenciesStats');
  if (meta) meta.textContent = state.dependencyRows.length ? `Relacje zależności: ${state.dependencyRows.length}` : 'Brak zależności usług.';
  if (stats) {
    const high = (state.dependencyRows || []).filter(row => row.impact === 'wysoki').length;
    const mediums = (state.dependencyRows || []).filter(row => row.impact !== 'wysoki').length;
    const media = new Set((state.dependencyRows || []).map(row => row.medium).filter(Boolean)).size;
    stats.innerHTML = `
      <div class="metric-card"><div class="metric-label">Relacje</div><div class="metric-value">${state.dependencyRows.length}</div></div>
      <div class="metric-card"><div class="metric-label">Wpływ wysoki</div><div class="metric-value">${high}</div></div>
      <div class="metric-card"><div class="metric-label">Wpływ średni</div><div class="metric-value">${mediums}</div></div>
      <div class="metric-card"><div class="metric-label">Media</div><div class="metric-value">${media}</div></div>`;
  }
  if (!box) return;
  box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Usługa / urządzenie</th><th>Zależy od</th><th>Port lokalny</th><th>Port zdalny</th><th>Medium</th><th>Wpływ</th></tr></thead><tbody>${state.dependencyRows.map(row => `<tr><td><button type="button" class="inline-link" data-dependency-focus="${row.roomId}:${row.rackId}:${row.deviceId}">${escapeHtml(row.service)}</button></td><td>${escapeHtml(row.dependsOn)}</td><td>${escapeHtml(String(row.localPort))}</td><td>${escapeHtml(String(row.remotePort))}</td><td>${escapeHtml(row.medium)}</td><td><span class="status-badge ${row.impact === 'wysoki' ? 'down' : 'warn'}">${escapeHtml(row.impact)}</span></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Brak zależności usług.</td></tr>'}</tbody></table></div>`;
  box.querySelectorAll('[data-dependency-focus]').forEach(btn => btn.addEventListener('click', () => {
    const [roomId, rackId, deviceId] = String(btn.dataset.dependencyFocus || '').split(':').map(v => Number(v) || null);
    if (roomId) state.currentRoomId = roomId;
    if (rackId) state.currentRackId = rackId;
    renderRack();
    focusDevice(deviceId);
    switchView('rack');
    activateTab('rackpage', 'rack-page-inspector');
  }));
}



function buildApplicationRows() {
  const groups = new Map();
  for (const room of state.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of getAllDevicesForRack(rack)) {
        const type = String(device.type || '').toLowerCase();
        let app = 'Infrastructure';
        if (/switch|router|firewall/.test(type)) app = 'Network Core';
        else if (/patch|organizer/.test(`${device.label || ''} ${device.type || ''}`.toLowerCase())) app = 'Cabling';
        else if (/server|vm|compute/.test(type)) app = 'Compute';
        const key = app;
        if (!groups.has(key)) groups.set(key, { app, components: 0, dependencies: 0, criticalLinks: 0, rooms: new Set(), racks: new Set(), devices: [] });
        const g = groups.get(key);
        g.components += 1;
        g.dependencies += (device.ports || []).filter(port => port.connectedTo).length;
        g.criticalLinks += (device.ports || []).filter(port => /uplink/i.test(String(port.target || ''))).length;
        g.rooms.add(`${room.building} / ${room.roomNumber}`);
        g.racks.add(rack.label || '—');
        g.devices.push(device.label || '—');
      }
    }
  }
  return Array.from(groups.values()).map(g => ({ app: g.app, components: g.components, dependencies: g.dependencies, criticalLinks: g.criticalLinks, rooms: g.rooms.size, racks: g.racks.size, devices: g.devices.slice(0,4).join(', ') })).sort((a,b)=>a.app.localeCompare(b.app,'pl'));
}

async function loadApplicationsView() {
  state.applicationRows = buildApplicationRows();
  const meta = document.getElementById('applicationsMeta');
  const stats = document.getElementById('applicationsStats');
  const box = document.getElementById('applicationsTableWrap');
  if (meta) meta.textContent = state.applicationRows.length ? `Grupy aplikacyjne: ${state.applicationRows.length}` : 'Brak grup aplikacyjnych.';
  if (stats) {
    const rows = state.applicationRows || [];
    const deps = rows.reduce((s,r)=>s+Number(r.dependencies||0),0);
    const crit = rows.reduce((s,r)=>s+Number(r.criticalLinks||0),0);
    stats.innerHTML = `
      <div class="metric-card"><div class="metric-label">Grupy</div><div class="metric-value">${rows.length}</div></div>
      <div class="metric-card"><div class="metric-label">Komponenty</div><div class="metric-value">${rows.reduce((s,r)=>s+Number(r.components||0),0)}</div></div>
      <div class="metric-card"><div class="metric-label">Relacje</div><div class="metric-value">${deps}</div></div>
      <div class="metric-card"><div class="metric-label">Krytyczne linki</div><div class="metric-value">${crit}</div></div>`;
  }
  if (!box) return;
  box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Grupa aplikacyjna</th><th>Komponenty</th><th>Relacje</th><th>Krytyczne linki</th><th>Serwerownie</th><th>Szafy</th><th>Przykładowe urządzenia</th></tr></thead><tbody>${(state.applicationRows||[]).map(row => `<tr><td>${escapeHtml(row.app)}</td><td>${row.components}</td><td>${row.dependencies}</td><td>${row.criticalLinks}</td><td>${row.rooms}</td><td>${row.racks}</td><td>${escapeHtml(row.devices)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Brak danych grup aplikacyjnych.</td></tr>'}</tbody></table></div>`;
}

async function exportApplicationsCsv() {
  downloadCsv((state.applicationRows||[]), `applications-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, ['app','components','dependencies','criticalLinks','rooms','racks','devices']);
}

function buildAutoDocRows() {
  const rooms = state.serverRooms || [];
  const racks = rooms.flatMap(room => room.racks || []);
  const devices = racks.flatMap(rack => getAllDevicesForRack(rack));
  const ports = devices.flatMap(device => device.ports || []);
  return [
    { category: 'Budynki / serwerownie', object: 'Lokalizacje', count: rooms.length, details: rooms.map(r => `${r.building} / ${r.roomNumber}`).join(' | ') || '—' },
    { category: 'Szafy', object: 'Racki', count: racks.length, details: racks.map(r => r.label).join(' | ') || '—' },
    { category: 'Urządzenia', object: 'Inventory', count: devices.length, details: devices.slice(0,8).map(d => d.label).join(', ') || '—' },
    { category: 'Porty', object: 'Interfejsy', count: ports.length, details: `${ports.filter(p => p.connectedTo).length} połączeń logicznych` },
    { category: 'Trasy kablowe', object: 'Routes', count: (state.cableVizRows || []).length, details: (state.cableVizRows || []).map(r => r.routeName).join(', ') || '—' },
    { category: 'Monitoring', object: 'Collectors', count: (state.collectorPerfRows || []).length, details: (state.collectorPerfRows || []).map(r => r.collector).join(', ') || '—' }
  ];
}

async function loadAutoDocsView() {
  state.autoDocRows = buildAutoDocRows();
  const meta = document.getElementById('autodocMeta');
  const stats = document.getElementById('autodocStats');
  const box = document.getElementById('autodocTableWrap');
  if (meta) meta.textContent = `Wiersze dokumentacji: ${state.autoDocRows.length}`;
  if (stats) {
    const rows = state.autoDocRows || [];
    stats.innerHTML = `
      <div class="metric-card"><div class="metric-label">Sekcje</div><div class="metric-value">${rows.length}</div></div>
      <div class="metric-card"><div class="metric-label">Urządzenia</div><div class="metric-value">${rows.find(r=>r.category==='Urządzenia')?.count || 0}</div></div>
      <div class="metric-card"><div class="metric-label">Porty</div><div class="metric-value">${rows.find(r=>r.category==='Porty')?.count || 0}</div></div>
      <div class="metric-card"><div class="metric-label">Trasy</div><div class="metric-value">${rows.find(r=>r.category==='Trasy kablowe')?.count || 0}</div></div>`;
  }
  if (!box) return;
  box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Kategoria</th><th>Obiekt</th><th>Liczba</th><th>Szczegóły</th></tr></thead><tbody>${(state.autoDocRows||[]).map(row => `<tr><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.object)}</td><td>${row.count}</td><td>${escapeHtml(row.details)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function exportAutodocJson() {
  downloadJson({ exportedAt: new Date().toISOString(), rows: state.autoDocRows || [] }, `autodoc-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

async function exportAutodocMd() {
  const lines = ['# Auto docs', '', `Wygenerowano: ${new Date().toLocaleString('pl-PL')}`, ''];
  for (const row of state.autoDocRows || []) {
    lines.push(`## ${row.category}`);
    lines.push(`- Obiekt: ${row.object}`);
    lines.push(`- Liczba: ${row.count}`);
    lines.push(`- Szczegóły: ${row.details}`);
    lines.push('');
  }
  downloadText(lines.join('\n'), `autodoc-${new Date().toISOString().replace(/[:.]/g, '-')}.md`, 'text/markdown;charset=utf-8');
}

function buildCollectorPerfRows() {
  const monitoring = state.dashboard?.monitoring || {};
  const snmp = state.snmpPollingStatus || {};
  const flow = state.flowCollectorConfig || {};
  const pg = state.postgresStatus || {};
  return [
    { collector: 'Ping worker', status: monitoring.lastScanAt ? 'ready' : 'idle', mode: 'icmp', throughput: `${monitoring.onlineDevices || 0}/${(monitoring.onlineDevices || 0) + (monitoring.offlineDevices || 0)} online`, lastRun: monitoring.lastScanAt || null, errors: monitoring.offlineDevices || 0 },
    { collector: 'SNMP scheduler', status: snmp.running ? 'running' : (snmp.enabled ? 'ready' : 'idle'), mode: 'snmp', throughput: `${snmp.lastSummary?.totalInterfaces || 0} interfejsów`, lastRun: snmp.lastRunAt || snmp.lastFinishedAt || null, errors: snmp.lastSummary?.failed || 0 },
    { collector: 'Flow telemetry', status: flow.enabled ? 'ready' : 'idle', mode: flow.mode || 'netflow', throughput: `${(state.flowRows || []).length} urządzeń`, lastRun: (state.flowRows || [])[0]?.updatedAt || null, errors: 0 },
    { collector: 'PostgreSQL bridge', status: pg.liveSyncReady ? 'ready' : 'idle', mode: pg.localBridge ? 'local-bridge' : 'postgres', throughput: `${pg.mirrorCount || 0} rekordów mirror`, lastRun: pg.lastPushAt || pg.lastSyncAt || null, errors: pg.lastError ? 1 : 0 }
  ];
}

async function loadCollectorPerfView() {
  state.collectorPerfRows = buildCollectorPerfRows();
  const meta = document.getElementById('collectorPerfMeta');
  const stats = document.getElementById('collectorPerfStats');
  const box = document.getElementById('collectorPerfTableWrap');
  if (meta) meta.textContent = `Collectory: ${state.collectorPerfRows.length}`;
  if (stats) {
    const rows = state.collectorPerfRows || [];
    const ready = rows.filter(r => ['ready','running'].includes(r.status)).length;
    const errors = rows.reduce((s,r)=>s+Number(r.errors||0),0);
    stats.innerHTML = `
      <div class="metric-card"><div class="metric-label">Collectory</div><div class="metric-value">${rows.length}</div></div>
      <div class="metric-card"><div class="metric-label">Gotowe</div><div class="metric-value">${ready}</div></div>
      <div class="metric-card"><div class="metric-label">Błędy</div><div class="metric-value">${errors}</div></div>
      <div class="metric-card"><div class="metric-label">Aktywne tryby</div><div class="metric-value">${new Set(rows.map(r => r.mode)).size}</div></div>`;
  }
  if (!box) return;
  box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Collector</th><th>Status</th><th>Tryb</th><th>Przepustowość</th><th>Ostatni bieg</th><th>Błędy</th></tr></thead><tbody>${(state.collectorPerfRows||[]).map(row => `<tr><td>${escapeHtml(row.collector)}</td><td><span class="status-badge ${['ready','running'].includes(row.status) ? 'up' : 'warn'}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.mode)}</td><td>${escapeHtml(row.throughput)}</td><td>${row.lastRun ? new Date(row.lastRun).toLocaleString('pl-PL') : '—'}</td><td>${row.errors}</td></tr>`).join('')}</tbody></table></div>`;
}

async function exportCollectorPerfCsv() {
  downloadCsv((state.collectorPerfRows||[]), `collector-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, ['collector','status','mode','throughput','lastRun','errors']);
}
async function loadCableVisualizationView() {
  const payload = await api('/api/cable-visualization');
  state.cableVizRows = payload?.rows || [];
  const box = document.getElementById('cableVizTableWrap');
  const meta = document.getElementById('cableVizMeta');
  const stats = document.getElementById('cableVizStats');
  if (meta) meta.textContent = state.cableVizRows.length ? `Trasy kablowe: ${state.cableVizRows.length}` : 'Brak tras kablowych.';
  if (stats) {
    const segments = (state.cableVizRows || []).reduce((sum, row) => sum + Number(row.segments || 0), 0);
    const media = new Set((state.cableVizRows || []).map(row => row.medium).filter(Boolean)).size;
    const active = (state.cableVizRows || []).filter(row => /aktywn/i.test(String(row.status || ''))).length;
    stats.innerHTML = `
      <div class="metric-card"><div class="metric-label">Trasy</div><div class="metric-value">${state.cableVizRows.length}</div></div>
      <div class="metric-card"><div class="metric-label">Segmenty</div><div class="metric-value">${segments}</div></div>
      <div class="metric-card"><div class="metric-label">Media</div><div class="metric-value">${media}</div></div>
      <div class="metric-card"><div class="metric-label">Aktywne</div><div class="metric-value">${active}</div></div>`;
  }
  if (!box) return;
  box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Trasa</th><th>Start</th><th>Koniec</th><th>Medium</th><th>Segmenty</th><th>Status</th><th>Notatka</th></tr></thead><tbody>${state.cableVizRows.map(row => `<tr><td>${escapeHtml(row.routeName)}</td><td>${escapeHtml(row.from)}</td><td>${escapeHtml(row.to)}</td><td>${escapeHtml(row.medium)}</td><td>${escapeHtml(String(row.segments || 0))}</td><td><span class="status-badge up">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.note || '-')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Brak tras kablowych.</td></tr>'}</tbody></table></div>`;
}

async function loadConflictsView() {
  state.conflictRows = buildConflictRows();
  const box = document.getElementById('conflictsTableWrap');
  if (!box) return;
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Typ</th><th>Klucz</th><th>Status</th><th>Lokalizacje</th><th>Szczegóły</th></tr>
        </thead>
        <tbody>${state.conflictRows.map(row => `
          <tr class="${row.status === 'critical' ? 'row-warning' : ''}">
            <td>${escapeHtml(row.type)}</td>
            <td>${escapeHtml(row.key)}</td>
            <td><span class="status-badge ${row.status === 'critical' ? 'down' : 'warn'}">${escapeHtml(row.status)}</span></td>
            <td>${row.focus ? `<button type="button" class="inline-link" data-conflict-focus="${row.focus.roomId}:${row.focus.rackId}:${row.focus.deviceId}">${escapeHtml(row.locations)}</button>` : escapeHtml(row.locations)}</td>
            <td>${escapeHtml(row.details)}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">Brak wykrytych konfliktów IP/VLAN.</td></tr>'}</tbody>
      </table>
    </div>`;
  box.querySelectorAll('[data-conflict-focus]').forEach(btn => btn.addEventListener('click', () => {
    const [roomId, rackId, deviceId] = String(btn.dataset.conflictFocus || '').split(':').map(v => Number(v) || null);
    if (roomId) state.currentRoomId = roomId;
    if (rackId) state.currentRackId = rackId;
    renderRack();
    focusDevice(deviceId);
    switchView('rack');
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

function buildCollectorRows() {
  const monitoring = state.dashboard?.monitoring || {};
  const snmp = state.snmpPollingStatus || {};
  const flowRows = state.flowRows || [];
  return [
    {
      collector: 'Monitoring ping',
      scope: 'cała aplikacja',
      status: monitoring.lastScanAt ? 'ready' : 'idle',
      source: 'worker ping',
      lastRunAt: monitoring.lastScanAt || null,
      details: `online: ${monitoring.onlineDevices || 0}, offline: ${monitoring.offlineDevices || 0}, avg latency: ${monitoring.avgLatencyMs || 0} ms`
    },
    {
      collector: 'SNMP scheduler',
      scope: 'urządzenia SNMP',
      status: snmp.running ? 'running' : (snmp.enabled ? 'ready' : 'idle'),
      source: 'net-snmp / cache',
      lastRunAt: snmp.lastRunAt || snmp.lastFinishedAt || null,
      details: `interwał: ${snmp.intervalSec || 300}s · OK: ${snmp.lastSummary?.ok || 0} · błędy: ${snmp.lastSummary?.failed || 0} · interfejsy: ${snmp.lastSummary?.totalInterfaces || 0}`
    },
    {
      collector: 'Flow telemetry',
      scope: 'collector-ready',
      status: flowRows.length ? 'ready' : 'idle',
      source: 'model + SNMP cache',
      lastRunAt: monitoring.lastScanAt || null,
      details: `urządzenia: ${flowRows.length} · top talker: ${flowRows[0]?.deviceLabel || '-'}`
    },
    {
      collector: 'Eksport / import',
      scope: 'backup lokalny',
      status: 'ready',
      source: 'JSON',
      lastRunAt: null,
      details: 'Dostępne przez panel główny / eksport JSON'
    }
  ];
}

async function loadCollectorsView() {
  if (!state.flowRows?.length) state.flowRows = buildFlowTelemetryRows();
  state.collectorRows = buildCollectorRows();
  const box = document.getElementById('collectorsTableWrap');
  if (!box) return;
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Kolektor / scheduler</th><th>Zakres</th><th>Status</th><th>Źródło</th><th>Ostatni bieg</th><th>Szczegóły</th></tr>
        </thead>
        <tbody>${state.collectorRows.map(row => `
          <tr>
            <td>${escapeHtml(row.collector)}</td>
            <td>${escapeHtml(row.scope)}</td>
            <td><span class="status-badge ${row.status === 'running' ? 'up' : row.status === 'ready' ? 'up' : 'warn'}">${escapeHtml(row.status)}</span></td>
            <td>${escapeHtml(row.source)}</td>
            <td>${row.lastRunAt ? new Date(row.lastRunAt).toLocaleString('pl-PL') : '—'}</td>
            <td>${escapeHtml(row.details)}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">Brak danych collectorów.</td></tr>'}</tbody>
      </table>
    </div>`;
}

async function loadSnmpPollingHistory() {
  try {
    const ref = getCurrentRack();
    const params = new URLSearchParams();
    if (ref?.room?.id) params.set('roomId', String(ref.room.id));
    if (ref?.rack?.id) params.set('rackId', String(ref.rack.id));
    const payload = await api(`/api/snmp/polling-history?${params.toString()}`);
    state.snmpPollingHistory = payload?.rows || [];
    if (payload?.status) state.snmpPollingStatus = payload.status;
    renderSnmpPollingHistory();
    renderSnmpPollingStatus();
  } catch (err) {
    const box = document.getElementById('snmpHistoryTableWrap');
    if (box) box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><tbody><tr><td class="muted">${escapeHtml(err.message || 'Nie udało się pobrać historii pollingu.')}</td></tr></tbody></table></div>`;
  }
}

function renderSnmpPollingHistory() {
  const box = document.getElementById('snmpHistoryTableWrap');
  const meta = document.getElementById('snmpHistoryMeta');
  if (!box) return;
  const rows = state.snmpPollingHistory || [];
  if (meta) meta.textContent = rows.length ? `Wiersze: ${rows.length} · ostatnia próba: ${new Date(rows[0].ts).toLocaleString('pl-PL')}` : 'Brak historii pollingów dla bieżącej szafy.';
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Czas</th><th>Urządzenie</th><th>Typ</th><th>Status</th><th>Tryb</th><th>Interfejsy</th><th>Powód / wynik</th></tr>
        </thead>
        <tbody>${rows.map(row => `
          <tr class="${row.ok ? '' : 'row-warning'}" data-snmp-history-device="${row.deviceId}">
            <td>${new Date(row.ts).toLocaleString('pl-PL')}</td>
            <td>${escapeHtml(row.building || '-') } / ${escapeHtml(row.roomNumber || '-')} / ${escapeHtml(row.rackLabel || '-')} / <button type="button" class="inline-link" data-snmp-history-focus="${row.deviceId}">${escapeHtml(row.deviceLabel || '-')}</button></td>
            <td>${escapeHtml(row.deviceType || '-')}</td>
            <td><span class="status-badge ${row.ok ? 'up' : 'down'}">${row.ok ? 'OK' : 'Błąd'}</span></td>
            <td>${escapeHtml(row.mode || '-')}</td>
            <td>${row.interfaceCount || 0}</td>
            <td>${escapeHtml(row.reason || '-')}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">Brak wpisów.</td></tr>'}</tbody>
      </table>
    </div>`;
  box.querySelectorAll('[data-snmp-history-focus]').forEach(btn => btn.addEventListener('click', () => {
    focusDevice(Number(btn.dataset.snmpHistoryFocus) || null);
    activateTab('rackpage', 'rack-page-inspector');
  }));
}

async function loadGlobalUplinks() {
  try {
    const payload = await api('/api/uplinks/global');
    state.globalUplinks = payload?.rows || [];
    renderGlobalUplinksTable(payload?.history || []);
  } catch (err) {
    const box = document.getElementById('uplinksGlobalTableWrap');
    if (box) box.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><tbody><tr><td class="muted">${escapeHtml(err.message || 'Nie udało się pobrać uplinków globalnych.')}</td></tr></tbody></table></div>`;
  }
}

function renderGlobalUplinksTable(history = []) {
  const box = document.getElementById('uplinksGlobalTableWrap');
  const meta = document.getElementById('uplinksGlobalMeta');
  if (!box) return;
  const rows = state.globalUplinks || [];
  const active = rows.filter(row => row.status === 'up').length;
  if (meta) {
    const latest = history?.[0];
    meta.textContent = `Uplinki: ${rows.length} · aktywne: ${active}${latest?.ts ? ` · snapshot: ${new Date(latest.ts).toLocaleString('pl-PL')}` : ''}`;
  }
  box.innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Źródło</th><th>Port</th><th>Cel</th><th>Port</th><th>Medium</th><th>VLAN</th><th>Trasa</th><th>Status</th></tr>
        </thead>
        <tbody>${rows.map(row => `
          <tr>
            <td>${escapeHtml(row.sourceBuilding || '-')} / ${escapeHtml(row.sourceRoom || '-')} / ${escapeHtml(row.sourceRack || '-')} / <button type="button" class="inline-link" data-uplink-focus="${row.sourceRoomId}:${row.sourceRackId}:${row.sourceDeviceId}">${escapeHtml(row.sourceDevice || '-')}</button></td>
            <td>${row.sourcePort || '-'}</td>
            <td>${escapeHtml(row.targetBuilding || '-')} / ${escapeHtml(row.targetRoom || '-')} / ${escapeHtml(row.targetRack || '-')} / <button type="button" class="inline-link" data-uplink-focus="${row.targetRoomId}:${row.targetRackId}:${row.targetDeviceId}">${escapeHtml(row.targetDevice || '-')}</button></td>
            <td>${row.targetPort || '-'}</td>
            <td>${escapeHtml(row.medium || '-')}</td>
            <td>${escapeHtml(row.vlan || '-')}</td>
            <td>${escapeHtml(row.routeName || row.cableLabel || '-')}</td>
            <td><span class="status-badge ${row.status || 'unknown'}">${escapeHtml(row.status || '-')}</span></td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">Brak uplinków globalnych.</td></tr>'}</tbody>
      </table>
    </div>`;
  box.querySelectorAll('[data-uplink-focus]').forEach(btn => btn.addEventListener('click', () => {
    const [roomId, rackId, deviceId] = String(btn.dataset.uplinkFocus || '').split(':').map(v => Number(v) || null);
    if (roomId) state.currentRoomId = roomId;
    if (rackId) state.currentRackId = rackId;
    focusDevice(deviceId);
    renderRack();
    activateTab('rackpage', 'rack-page-inspector');
  }));
}


async function loadReport() {
  state.reportRows = await api('/api/report/technical');
  const rows = state.reportRows.map(row => `
    <tr>
      <td>${row.building}</td>
      <td>${row.roomType}</td>
      <td>${row.roomNumber}</td>
      <td>${row.rack}</td>
      <td>${row.position}</td>
      <td>${row.device}</td>
      <td>${row.deviceType}</td>
      <td>${row.port}</td>
      <td>${row.ip || '-'}</td>
      <td>${row.vlan || '-'}</td>
      <td>${row.target || '-'}</td>
      <td>${row.powerA || '-'}</td>
      <td>${row.powerB || '-'}</td>
      <td><span class="status-badge ${row.monitorStatus || 'unknown'}">${row.monitorStatus || '-'}</span></td>
      <td>${row.mutedUntil ? new Date(row.mutedUntil).toLocaleString('pl-PL') : '-'}</td>
    </tr>
  `).join('');
  document.getElementById('reportTableWrap').innerHTML = `
    <div class="table-scroll">
      <table class="data-table compact-table">
        <thead>
          <tr><th>Budynek</th><th>Typ</th><th>Pom.</th><th>Szafa</th><th>Pozycja</th><th>Urządzenie</th><th>Typ urządzenia</th><th>Port</th><th>IP</th><th>VLAN</th><th>Cel połączenia</th><th>Zasilanie A</th><th>Zasilanie B</th><th>Monitoring</th><th>Wyciszenie do</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="15" class="muted">Brak danych raportowych.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}


async function loadNetworkMap() {
  const params = new URLSearchParams();
  if (state.mapFilters.building) params.set('building', state.mapFilters.building);
  if (state.mapFilters.roomId) params.set('roomId', state.mapFilters.roomId);
  if (state.mapFilters.vlan) params.set('vlan', state.mapFilters.vlan);
  state.networkMap = await api(`/api/network-map${params.toString() ? '?' + params.toString() : ''}`);
  renderNetworkMap();
}

function renderNetworkMap() {
  const canvas = document.getElementById('networkMapCanvas');
  const legend = document.getElementById('mapLegend');
  const pathList = document.getElementById('mapPathList');
  if (!canvas || !state.networkMap) return;
  const { nodes = [], edges = [] } = state.networkMap;
  legend.innerHTML = [
    '<span class="map-legend-item">Serwerownia</span>',
    '<span class="map-legend-item">Szafa</span>',
    '<span class="map-legend-item">Urządzenie</span>',
    '<span class="map-legend-item">Zielona ramka = switch</span>',
    '<span class="map-legend-item">Zielona kropka = online</span>',
    '<span class="map-legend-item">Czerwona kropka = offline</span>',
    '<span class="map-legend-item">Kolorowa linia = połączenie port-port</span>'
  ].join('');

  const roomNodes = nodes.filter(n => n.kind === 'room');
  const rackNodes = nodes.filter(n => n.kind === 'rack');
  const devNodes = nodes.filter(n => n.kind === 'device' || n.kind === 'switch');
  const roomOrder = roomNodes.map((n, i) => ({ ...n, x: 90 + i * 340, y: 72, width: 240, height: 72 }));
  const roomPos = Object.fromEntries(roomOrder.map(n => [n.id, n]));
  const racksByRoom = {};
  rackNodes.forEach(r => { (racksByRoom[r.roomId] ||= []).push(r); });
  const rackPos = {};
  Object.entries(racksByRoom).forEach(([roomId, list]) => {
    list.sort((a,b) => (a.rackId||0) - (b.rackId||0));
    list.forEach((rack, idx) => {
      const room = roomOrder.find(x => Number(x.roomId) === Number(roomId));
      rackPos[rack.id] = { ...rack, x: room.x + (idx % 2) * 148, y: 190 + Math.floor(idx / 2) * 106, width: 126, height: 62 };
    });
  });
  const devsByRack = {};
  devNodes.forEach(d => { (devsByRack[`${d.roomId}-${d.rackId}`] ||= []).push(d); });
  const devPos = {};
  Object.entries(devsByRack).forEach(([key, list]) => {
    const sample = list[0];
    const rack = rackPos[`rack-${sample.roomId}-${sample.rackId}`];
    list.sort((a,b) => (a.deviceId||0) - (b.deviceId||0));
    list.forEach((dev, idx) => {
      devPos[dev.id] = { ...dev, x: rack.x - 6 + (idx % 2) * 140, y: rack.y + 96 + Math.floor(idx / 2) * 88, width: 132, height: 56 };
    });
  });
  const positions = { ...roomPos, ...rackPos, ...devPos };

  const linkEdges = edges.filter(e => e.kind === 'link');
  const supportEdges = edges.filter(e => e.kind !== 'link');
  const maxY = Math.max(680, ...Object.values(positions).map(p => (p.y || 0) + (p.height || 0) + 30));
  const maxX = Math.max(1180, ...Object.values(positions).map(p => (p.x || 0) + (p.width || 0) + 50));

  const rect = (node, css, subtitle=true) => `
    <g class="map-node" data-map-node="${node.id}">
      <rect class="${css}" x="${node.x}" y="${node.y}" rx="14" ry="14" width="${node.width}" height="${node.height}"></rect>
      <text class="map-node-label" x="${node.x + 14}" y="${node.y + 26}">${escapeHtml(node.label)}</text>
      ${subtitle ? `<text class="map-node-subtitle" x="${node.x + 14}" y="${node.y + 45}">${escapeHtml(node.subtitle || '')}</text>` : ''}
      ${node.monitor ? `<circle class="map-status-dot ${node.monitor.online ? 'online' : 'offline'}" cx="${node.x + node.width - 16}" cy="${node.y + 16}" r="6"></circle><text class="map-status-text" x="${node.x + 14}" y="${node.y + node.height - 10}">${node.monitor.online ? 'online' : 'offline'}${node.monitor.latencyMs ? ' · ' + node.monitor.latencyMs + ' ms' : ''}</text>` : ''}
    </g>`;

  const supportSvg = supportEdges.map(edge => {
    const from = positions[edge.from], to = positions[edge.to];
    if (!from || !to) return '';
    const x1 = from.x + from.width / 2, y1 = from.y + from.height;
    const x2 = to.x + to.width / 2, y2 = to.y;
    return `<line class="map-edge-${edge.kind}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;
  }).join('');

  const linkSvg = linkEdges.map((edge, idx) => {
    const from = positions[edge.from], to = positions[edge.to];
    if (!from || !to) return '';
    const x1 = from.x + from.width, y1 = from.y + (idx % 3) * 8 + 18;
    const x2 = to.x, y2 = to.y + (idx % 3) * 8 + 18;
    const midX = (x1 + x2) / 2;
    const c1x = midX, c1y = x1 < x2 ? y1 - 50 : y1 + 50;
    const c2x = midX, c2y = x1 < x2 ? y2 + 50 : y2 - 50;
    const textX = midX; const textY = (y1 + y2) / 2 - 8;
    return `<path class="map-edge-link" d="M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}" stroke="${edge.color || '#22c55e'}"></path><text class="map-edge-link-label" x="${textX}" y="${textY}">${escapeHtml(edge.label || '')}</text>`;
  }).join('');

  const nodesSvg = [
    ...roomOrder.map(node => rect(node, 'map-node-room')),
    ...Object.values(rackPos).map(node => rect(node, 'map-node-rack')),
    ...Object.values(devPos).map(node => rect(node, node.kind === 'switch' ? 'map-node-switch' : 'map-node-device'))
  ].join('');

  canvas.innerHTML = `<svg class="network-map-svg" viewBox="0 0 ${maxX} ${maxY}" xmlns="http://www.w3.org/2000/svg">${supportSvg}${linkSvg}${nodesSvg}</svg>`;
  pathList.innerHTML = linkEdges.length ? linkEdges.map(edge => `<div class="map-path-item"><strong>${escapeHtml(edge.label || 'Połączenie')}</strong><div class="muted small">${escapeHtml(getNodeLabel(edge.from, positions))} → ${escapeHtml(getNodeLabel(edge.to, positions))}</div><div class="muted small">VLAN: ${escapeHtml(edge.vlan || '-')} · Medium: ${escapeHtml(edge.medium || '-')} · Trasa: ${escapeHtml(edge.routeName || '-')} · Długość: ${escapeHtml(String(edge.cableLengthM || '-'))} m</div><div class="muted small">Kolor: <span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${edge.color || '#22c55e'};vertical-align:middle"></span> ${edge.color || '#22c55e'}</div></div>`).join('') : '<div class="device-inspector-empty">Brak połączeń port-port do pokazania na mapie.</div>';;
}

function getNodeLabel(id, positions) {
  return positions?.[id]?.label || id;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) { return escapeHtml(value); }

init();

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
  if (!value) return 'brak';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('pl-PL');
}

function formatBytes(bytes) {
  const num = Number(bytes || 0);
  if (!num) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = num;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) { size /= 1024; idx += 1; }
  return `${size.toFixed(size >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatUptime(seconds) {
  const total = Number(seconds || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

async function loadOpsView() {
  await Promise.all([loadOpsMetrics(), loadBackupsPanel(), loadServicesPanel(), loadDockerPanel(), loadAlertsPanel(), loadRuntimeLog(), loadSshPanel(), loadTerminalSessionsPanel(), loadTerminalPoliciesPanel(), loadTerminalAuditPanel(), loadRoutesAuditPanel(), loadTasksPanel(), loadTwoFactorStatus(), loadTranscriptsPanel(), loadMetricsCenterPanel(), loadAgentsPanel(), loadEnterpriseSuite(), loadIdentityPanel(), loadRemotePanel(), loadDiscoveryBrandingPanel()]);
  ensureTerminalSocket();
  subscribeMetricsStream();
  if (typeof io === 'undefined') {
    const meta = document.getElementById('opsMetricsStreamMeta');
    if (meta) meta.textContent = 'Realtime wyłączony: paczka działa bez socket.io. Dane testowe i API REST pozostają aktywne.';
  }
}


function pushMetricsHistory(packet) {
  const summary = packet?.summary || {};
  state.ops.metricsHistory = Array.isArray(state.ops.metricsHistory) ? state.ops.metricsHistory : [];
  state.ops.metricsHistory.push({
    ts: packet?.ts || new Date().toISOString(),
    cpu: Number(summary.cpu || 0),
    memory: summary.memoryUsedPercent == null ? null : Number(summary.memoryUsedPercent),
    disk: summary.diskUsedPercent == null ? null : Number(summary.diskUsedPercent)
  });
  state.ops.metricsHistory = state.ops.metricsHistory.slice(-30);
}

function renderMiniMetricCharts() {
  const wrap = document.getElementById('opsMetricsCharts');
  if (!wrap) return;
  const rows = Array.isArray(state.ops.metricsHistory) ? state.ops.metricsHistory : [];
  const defs = [
    { key: 'cpu', label: 'CPU / load', suffix: '', max: 100 },
    { key: 'memory', label: 'RAM %', suffix: '%', max: 100 },
    { key: 'disk', label: 'Dysk %', suffix: '%', max: 100 }
  ];
  wrap.innerHTML = defs.map(def => {
    const vals = rows.map(row => Number(row[def.key] ?? 0));
    const max = Math.max(def.max, ...vals, 1);
    const points = vals.map((val, idx) => {
      const x = vals.length <= 1 ? 0 : (idx / (vals.length - 1)) * 100;
      const y = 70 - ((Number(val || 0) / max) * 70);
      return `${x},${Math.max(0, Math.min(70, y)).toFixed(1)}`;
    }).join(' ');
    const last = vals.length ? vals[vals.length - 1] : 0;
    return `<div class="metric-chart-card"><div class="metric-chart-title">${def.label}</div><svg viewBox="0 0 100 80" preserveAspectRatio="none" class="metric-chart-svg"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${points}"></polyline></svg><div class="metric-chart-value">${Number(last || 0).toFixed(1)}${def.suffix}</div></div>`;
  }).join('');
}

async function loadTerminalPoliciesPanel() {
  const meta = document.getElementById('terminalPoliciesMeta');
  const wrap = document.getElementById('terminalPoliciesGrid');
  const hostWrap = document.getElementById('terminalPerHostPoliciesWrap');
  if (!meta || !wrap) return;
  try {
    const data = await api('/api/terminal/policies');
    state.ops.terminalPolicies = data;
    const terminalPolicy = data.terminalPolicy || {};
    const commandPolicy = data.commandPolicy || {};
    const roles = ['viewer','operator','admin'];
    wrap.innerHTML = roles.map(role => {
      const perms = terminalPolicy[role] || [];
      const cmd = commandPolicy[role] || {};
      return `<div class="policy-card" data-role="${role}"><h4>${role}</h4><div class="policy-checklist"><label><input type="checkbox" data-policy="local" ${perms.includes('local') ? 'checked' : ''}> lokalny</label><label><input type="checkbox" data-policy="ssh" ${perms.includes('ssh') ? 'checked' : ''}> ssh</label><label><input type="checkbox" data-policy="sessions" ${perms.includes('sessions') ? 'checked' : ''}> sesje</label><label><input type="checkbox" data-policy="killAny" ${perms.includes('killAny') ? 'checked' : ''}> killAny</label></div><label><span>Dozwolone komendy (wzorzec na linię; obsługa regex:, * i ?)</span><textarea class="mono-input js-policy-allow">${escapeHtml((cmd.allowedCommands || []).join('\n'))}</textarea></label><label class="top-gap"><span>Blokowane komendy</span><textarea class="mono-input js-policy-deny">${escapeHtml((cmd.deniedCommands || []).join('\n'))}</textarea></label><label class="top-gap"><span>Dozwolone hosty</span><textarea class="mono-input js-policy-hosts">${escapeHtml((cmd.allowedHosts || []).join('\n'))}</textarea></label></div>`;
    }).join('');
    renderTerminalHostPolicyRows(Array.isArray(data.perHostPolicies) ? data.perHostPolicies : []);
    meta.textContent = 'GUI polityk terminala aktywne. Wzorce komend: regex:^sudo\\s+systemctl, docker*, rm ?';
  } catch (error) {
    meta.textContent = `Polityki terminala: ${error.message}`;
    wrap.innerHTML = '<div class="muted">Brak dostępu albo błąd odczytu polityk.</div>';
    if (hostWrap) hostWrap.innerHTML = '';
  }
}

function renderTerminalHostPolicyRows(rows) {
  const hostWrap = document.getElementById('terminalPerHostPoliciesWrap');
  if (!hostWrap) return;
  const list = Array.isArray(rows) ? rows : [];
  hostWrap.innerHTML = `<div class="stack-list">${list.map((row, idx) => `<div class="policy-card js-host-policy-row" data-id="${escapeAttr(row.id || idx + 1)}"><div class="panel-head-row"><strong>Host policy #${idx + 1}</strong><button type="button" class="btn btn-secondary btn-small js-remove-host-policy">Usuń</button></div><div class="ops-form top-gap"><label><span>Nazwa</span><input type="text" class="js-hp-name" value="${escapeAttr(row.name || '')}"></label><label><span>Host / wzorzec</span><input type="text" class="js-hp-pattern" value="${escapeAttr(row.hostPattern || '')}" placeholder="10.0.* lub regex:^prod-"></label><label><span>Role</span><div class="policy-checklist"><label><input type="checkbox" class="js-hp-role" value="viewer" ${(row.roles || []).includes('viewer') ? 'checked' : ''}> viewer</label><label><input type="checkbox" class="js-hp-role" value="operator" ${(row.roles || []).includes('operator') ? 'checked' : ''}> operator</label><label><input type="checkbox" class="js-hp-role" value="admin" ${(row.roles || []).includes('admin') ? 'checked' : ''}> admin</label></div></label></div><label class="top-gap"><span>Dozwolone komendy</span><textarea class="mono-input js-hp-allow">${escapeHtml((row.allowedCommands || []).join('\n'))}</textarea></label><label class="top-gap"><span>Blokowane komendy</span><textarea class="mono-input js-hp-deny">${escapeHtml((row.deniedCommands || []).join('\n'))}</textarea></label></div>`).join('')}</div>`;
  hostWrap.querySelectorAll('.js-remove-host-policy').forEach(btn => btn.addEventListener('click', () => {
    btn.closest('.js-host-policy-row')?.remove();
  }));
}

function collectTerminalHostPoliciesFromGui() {
  return Array.from(document.querySelectorAll('.js-host-policy-row')).map((row, idx) => ({
    id: Number(row.dataset.id || idx + 1),
    name: row.querySelector('.js-hp-name')?.value?.trim() || `Host policy ${idx + 1}`,
    hostPattern: row.querySelector('.js-hp-pattern')?.value?.trim() || '',
    roles: Array.from(row.querySelectorAll('.js-hp-role:checked')).map(el => el.value),
    allowedCommands: String(row.querySelector('.js-hp-allow')?.value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean),
    deniedCommands: String(row.querySelector('.js-hp-deny')?.value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean)
  })).filter(row => row.hostPattern);
}

async function saveTerminalPoliciesPanel() {
  const wrap = document.getElementById('terminalPoliciesGrid');
  if (!wrap) return;
  const roles = ['viewer','operator','admin'];
  const terminalPolicy = {};
  const commandPolicy = {};
  roles.forEach(role => {
    const card = wrap.querySelector(`[data-role="${role}"]`);
    if (!card) return;
    terminalPolicy[role] = Array.from(card.querySelectorAll('input[type="checkbox"][data-policy]:checked')).map(el => el.dataset.policy);
    commandPolicy[role] = {
      allowedCommands: String(card.querySelector('.js-policy-allow')?.value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean),
      deniedCommands: String(card.querySelector('.js-policy-deny')?.value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean),
      allowedHosts: String(card.querySelector('.js-policy-hosts')?.value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean)
    };
  });
  const perHostPolicies = collectTerminalHostPoliciesFromGui();
  await api('/api/terminal/policies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ terminalPolicy, commandPolicy, perHostPolicies }) });
  toast('Zapisano polityki terminala.', 'success');
  await loadTerminalPoliciesPanel();
}

async function loadTerminalAuditPanel() {
  const meta = document.getElementById('terminalAuditMeta');
  const wrap = document.getElementById('terminalAuditTableWrap');
  if (!meta || !wrap) return;
  try {
    const data = await api('/api/terminal/session-audit');
    state.ops.terminalSessionAudit = Array.isArray(data.rows) ? data.rows : [];
    meta.textContent = `Zdarzeń audytu sesji: ${state.ops.terminalSessionAudit.length}`;
    wrap.innerHTML = state.ops.terminalSessionAudit.length ? `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Czas</th><th>Użytkownik</th><th>Rola</th><th>Akcja</th><th>Szczegóły</th></tr></thead><tbody>${state.ops.terminalSessionAudit.map(row => `<tr><td>${formatDateTime(row.ts)}</td><td>${escapeHtml(row.user || 'system')}</td><td>${escapeHtml(row.role || 'viewer')}</td><td>${escapeHtml(row.action || 'n/a')}</td><td><div class="muted small">${escapeHtml(JSON.stringify(row.meta || {}))}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">Brak zdarzeń audytu sesji.</div>';
  } catch (error) {
    meta.textContent = `Audyt sesji: ${error.message}`;
    wrap.innerHTML = '<div class="muted">Brak dostępu do audytu sesji.</div>';
  }
}

async function loadRoutesAuditPanel() {
  const meta = document.getElementById('routesAuditMeta');
  const wrap = document.getElementById('routesAuditTableWrap');
  if (!meta || !wrap) return;
  try {
    const data = await api('/api/system/routes');
    state.ops.routesAudit = Array.isArray(data.rows) ? data.rows : [];
    const summary = data.summary || {};
    meta.textContent = `Endpointów: ${summary.total || 0} · auth: ${summary.auth || 0} · admin: ${summary.admin || 0}`;
    wrap.innerHTML = state.ops.routesAudit.length ? `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Metody</th><th>Ścieżka</th><th>Middleware</th><th>Auth</th><th>Admin</th></tr></thead><tbody>${state.ops.routesAudit.map(row => `<tr><td>${escapeHtml((row.methods || []).join(', '))}</td><td>${escapeHtml(row.path || '')}</td><td><div class="muted small">${escapeHtml((row.middlewares || []).join(', '))}</div></td><td>${row.auth ? 'tak' : 'nie'}</td><td>${row.admin ? 'tak' : 'nie'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">Brak endpointów do pokazania.</div>';
  } catch (error) {
    meta.textContent = `Audyt endpointów: ${error.message}`;
    wrap.innerHTML = '<div class="muted">Brak dostępu do audytu endpointów.</div>';
  }
}

async function loadOpsMetrics() {
  const data = await api('/api/system/metrics');
  state.ops.metrics = data.metrics;
  pushMetricsHistory({ metrics: data.metrics, summary: { cpu: Number((data.metrics?.loadAvg || [0])[0] || 0), memoryUsedPercent: data.metrics?.memory?.totalBytes ? Number((((data.metrics?.memory?.usedBytes || 0) / data.metrics.memory.totalBytes) * 100).toFixed(1)) : null, diskUsedPercent: data.metrics?.disk?.usedPercent == null ? null : Number(data.metrics.disk.usedPercent) } });
  renderMiniMetricCharts();
  const metrics = data.metrics || {};
  const grid = document.getElementById('opsMetricsGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div class="stat-card"><div class="stat-label">Host</div><div class="stat-value stat-value-small">${escapeHtml(metrics.hostname || 'n/a')}</div></div>
    <div class="stat-card"><div class="stat-label">CPU</div><div class="stat-value stat-value-small">${escapeHtml(String(metrics.cpuCount || 0))} rdzeni</div></div>
    <div class="stat-card"><div class="stat-label">RAM</div><div class="stat-value stat-value-small">${formatBytes(metrics.memory?.usedBytes)} / ${formatBytes(metrics.memory?.totalBytes)}</div></div>
    <div class="stat-card"><div class="stat-label">Dysk</div><div class="stat-value stat-value-small">${metrics.disk?.usedPercent == null ? 'n/a' : `${metrics.disk.usedPercent}%`}</div></div>
    <div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value stat-value-small">${formatUptime(metrics.uptimeSec)}</div></div>
    <div class="stat-card"><div class="stat-label">Node.js</div><div class="stat-value stat-value-small">${escapeHtml(metrics.nodeVersion || 'n/a')}</div></div>
  `;
  document.getElementById('opsMetricsMeta').textContent = `Platforma: ${metrics.platform || 'n/a'} ${metrics.release || ''} ${metrics.arch || ''} · Load avg: ${(metrics.loadAvg || []).map(v => Number(v || 0).toFixed(2)).join(' / ')} · Odczyt: ${formatDateTime(metrics.ts)}`;
  const liveBox = document.getElementById('opsMetricsLiveBox');
  if (liveBox && !liveBox.textContent.trim()) liveBox.textContent = 'Czekam na pierwszy pakiet metryk live…';
}


async function loadBackupsPanel() {
  const data = await api('/api/backups');
  state.ops.backups = Array.isArray(data.rows) ? data.rows : [];
  state.ops.backupConfig = data.config || {};
  const cfg = state.ops.backupConfig;
  const enabledInput = document.getElementById('backupEnabledInput');
  const intervalInput = document.getElementById('backupIntervalInput');
  const retentionInput = document.getElementById('backupRetentionInput');
  if (enabledInput) enabledInput.checked = !!cfg.enabled;
  if (intervalInput) intervalInput.value = Number(cfg.intervalMin || 360);
  if (retentionInput) retentionInput.value = Number(cfg.retentionCount || 10);
  document.getElementById('backupMeta').textContent = `Ostatni backup: ${formatDateTime(cfg.lastRunAt)} · Powód: ${cfg.lastReason || 'brak'} · Ostatni plik: ${cfg.lastFile || 'brak'} ${cfg.lastError ? `· Błąd: ${cfg.lastError}` : ''}`;
  const wrap = document.getElementById('backupTableWrap');
  if (!wrap) return;
  wrap.innerHTML = state.ops.backups.length ? `
    <table class="data-table">
      <thead><tr><th>Plik</th><th>Data</th><th>Rozmiar</th><th>Akcja</th></tr></thead>
      <tbody>
        ${state.ops.backups.map(row => `
          <tr>
            <td>${escapeHtml(row.name)}</td>
            <td>${formatDateTime(row.modifiedAt)}</td>
            <td>${formatBytes(row.sizeBytes)}</td>
            <td><button type="button" class="btn btn-secondary btn-small js-restore-backup" data-file="${escapeHtml(row.name)}">Przywróć</button></td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<div class="muted">Brak backupów.</div>';
  wrap.querySelectorAll('.js-restore-backup').forEach(btn => btn.addEventListener('click', () => restoreBackup(btn.dataset.file)));
}

async function saveBackupConfig(event) {
  event?.preventDefault();
  await api('/api/backups/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: document.getElementById('backupEnabledInput').checked,
      intervalMin: Number(document.getElementById('backupIntervalInput').value || 360),
      retentionCount: Number(document.getElementById('backupRetentionInput').value || 10)
    })
  });
  await loadBackupsPanel();
  alert('Zapisano konfigurację backupów.');
}

async function runBackupNow() {
  await api('/api/backups/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await loadBackupsPanel();
  await loadRuntimeLog();
  alert('Backup został wykonany.');
}

async function restoreBackup(fileName) {
  if (!confirm(`Przywrócić backup ${fileName}?`)) return;
  await api('/api/backups/restore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName })
  });
  await Promise.all([loadBackupsPanel(), loadDashboard(), loadServerRooms(), loadAudit(), loadRuntimeLog()]);
  alert(`Przywrócono backup ${fileName}.`);
}

function normalizeServicesForEditor(rows) {
  return (rows || []).map(row => ({
    id: row.id,
    name: row.name,
    serviceName: row.serviceName,
    platform: row.platform,
    mode: row.mode,
    processCommand: row.processCommand || '',
    workingDir: row.workingDir || '',
    notes: row.notes || ''
  }));
}

async function loadServicesPanel() {
  const data = await api('/api/services');
  state.ops.services = Array.isArray(data.rows) ? data.rows : [];
  const editor = document.getElementById('servicesConfigInput');
  if (editor && !editor.dataset.userEdited) editor.value = JSON.stringify(normalizeServicesForEditor(state.ops.services), null, 2);
  const wrap = document.getElementById('servicesTableWrap');
  document.getElementById('servicesMeta').textContent = `Pozycji: ${state.ops.services.length} · Platforma hosta: ${navigator.platform || 'n/a'}`;
  if (!wrap) return;
  wrap.innerHTML = state.ops.services.length ? `
    <table class="data-table">
      <thead><tr><th>Nazwa</th><th>Tryb</th><th>Platforma</th><th>Status</th><th>Szczegóły</th><th>Akcje</th></tr></thead>
      <tbody>
        ${state.ops.services.map(row => `
          <tr>
            <td>${escapeHtml(row.name || row.serviceName || '')}<div class="muted small">${escapeHtml(row.serviceName || '')}</div></td>
            <td>${escapeHtml(row.mode || '')}</td>
            <td>${escapeHtml(row.platform || '')}</td>
            <td><span class="status-pill status-${escapeHtml(String(row.status || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-'))}">${escapeHtml(row.status || 'unknown')}</span></td>
            <td><div class="table-details">${escapeHtml(row.details || '').replace(/\n/g, '<br>')}</div></td>
            <td>
              <div class="inline-actions">
                <button type="button" class="btn btn-secondary btn-small js-service-action" data-id="${row.id}" data-action="status">Status</button>
                <button type="button" class="btn btn-secondary btn-small js-service-action" data-id="${row.id}" data-action="start">Start</button>
                <button type="button" class="btn btn-secondary btn-small js-service-action" data-id="${row.id}" data-action="stop">Stop</button>
                <button type="button" class="btn btn-secondary btn-small js-service-action" data-id="${row.id}" data-action="restart">Restart</button>
              </div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<div class="muted">Brak skonfigurowanych usług. Dodaj je w JSON-ie powyżej.</div>';
  wrap.querySelectorAll('.js-service-action').forEach(btn => btn.addEventListener('click', () => runServiceActionFromUi(btn.dataset.id, btn.dataset.action)));
  editor?.addEventListener('input', () => { editor.dataset.userEdited = '1'; }, { once: true });
}

async function saveServicesConfig() {
  const editor = document.getElementById('servicesConfigInput');
  let services;
  try {
    services = JSON.parse(editor.value || '[]');
    if (!Array.isArray(services)) throw new Error('JSON musi być tablicą obiektów.');
  } catch (error) {
    alert(`Błąd JSON usług: ${error.message}`);
    return;
  }
  await api('/api/services/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ services })
  });
  editor.dataset.userEdited = '';
  await Promise.all([loadServicesPanel(), loadRuntimeLog()]);
  alert('Zapisano konfigurację usług.');
}

async function runServiceActionFromUi(id, action) {
  await api(`/api/services/${id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
  await Promise.all([loadServicesPanel(), loadRuntimeLog(), loadAudit()]);
}

async function loadDockerPanel() {
  const data = await api('/api/docker/containers');
  state.ops.docker = Array.isArray(data.rows) ? data.rows : [];
  state.ops.dockerInstalled = !!data.installed;
  const wrap = document.getElementById('dockerTableWrap');
  document.getElementById('dockerMeta').textContent = data.installed ? `Docker CLI dostępne · Kontenerów: ${state.ops.docker.length}` : `Docker niedostępny: ${data.error || 'brak odpowiedzi CLI'}`;
  if (!wrap) return;
  if (!data.installed) {
    wrap.innerHTML = '<div class="muted">Docker CLI nie został wykryty na tym hoście albo nie jest w PATH.</div>';
    return;
  }
  wrap.innerHTML = state.ops.docker.length ? `
    <table class="data-table">
      <thead><tr><th>Nazwa</th><th>Image</th><th>Status</th><th>Porty</th><th>Akcje</th></tr></thead>
      <tbody>
        ${state.ops.docker.map(row => `
          <tr>
            <td>${escapeHtml(row.name)}<div class="muted small">${escapeHtml(row.id)}</div></td>
            <td>${escapeHtml(row.image)}</td>
            <td>${escapeHtml(row.status || row.state || '')}</td>
            <td>${escapeHtml(row.ports || '')}</td>
            <td>
              <div class="inline-actions">
                <button type="button" class="btn btn-secondary btn-small js-docker-action" data-id="${escapeHtml(row.id)}" data-action="start">Start</button>
                <button type="button" class="btn btn-secondary btn-small js-docker-action" data-id="${escapeHtml(row.id)}" data-action="stop">Stop</button>
                <button type="button" class="btn btn-secondary btn-small js-docker-action" data-id="${escapeHtml(row.id)}" data-action="restart">Restart</button>
              </div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>` : '<div class="muted">Brak kontenerów Docker.</div>';
  wrap.querySelectorAll('.js-docker-action').forEach(btn => btn.addEventListener('click', () => runDockerActionFromUi(btn.dataset.id, btn.dataset.action)));
}

async function runDockerActionFromUi(id, action) {
  await api(`/api/docker/containers/${id}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  });
  await Promise.all([loadDockerPanel(), loadRuntimeLog(), loadAudit()]);
}

async function loadAlertsPanel() {
  const data = await api('/api/alerts/config');
  state.ops.alerts = data.config || {};
  document.getElementById('alertsEnabledInput').checked = !!state.ops.alerts.enabled;
  document.getElementById('alertsWebhookInput').value = state.ops.alerts.webhookUrl || '';
  document.getElementById('alertsMeta').textContent = `Ostatni test: ${formatDateTime(state.ops.alerts.lastTestAt)}${state.ops.alerts.lastError ? ` · Błąd: ${state.ops.alerts.lastError}` : ''}`;
}

async function saveAlertsConfig(event) {
  event?.preventDefault();
  await api('/api/alerts/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: document.getElementById('alertsEnabledInput').checked,
      webhookUrl: document.getElementById('alertsWebhookInput').value.trim()
    })
  });
  await Promise.all([loadAlertsPanel(), loadRuntimeLog()]);
  alert('Zapisano konfigurację alertów.');
}

async function sendAlertsTest() {
  await api('/api/alerts/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await Promise.all([loadAlertsPanel(), loadRuntimeLog(), loadAudit()]);
  alert('Wysłano test webhooka.');
}

async function loadRuntimeLog() {
  const lines = Math.max(10, Math.min(2000, Number(document.getElementById('runtimeLinesInput')?.value || 200)));
  const data = await api(`/api/logs/runtime?lines=${lines}`);
  state.ops.runtimeLog = data.content || '';
  const box = document.getElementById('runtimeLogBox');
  if (box) box.textContent = state.ops.runtimeLog || 'Brak wpisów.';
}


function normalizeSshProfilesForEditor(rows) {
  return (rows || []).map(row => ({
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    keyPath: row.keyPath || '',
    strictHostKeyChecking: !!row.strictHostKeyChecking,
    allowedRoles: Array.isArray(row.allowedRoles) ? row.allowedRoles : ['operator','admin'],
    notes: row.notes || ''
  }));
}


async function loadUsersPanel() {
  const wrap = document.getElementById('usersTableWrap');
  const meta = document.getElementById('usersMeta');
  try {
    const data = await api('/api/users');
    state.ops.users = Array.isArray(data.rows) ? data.rows : [];
    if (meta) meta.textContent = `Liczba kont: ${state.ops.users.length}`;
    if (wrap) {
      wrap.innerHTML = state.ops.users.length ? `
        <div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Login</th><th>Imię i nazwisko</th><th>Rola</th><th>Status</th><th>Hasło</th><th>Akcje</th></tr></thead><tbody>
        ${state.ops.users.map(row => `
          <tr>
            <td>${escapeHtml(row.username)}</td>
            <td>${escapeHtml(row.fullName || '')}</td>
            <td>${escapeHtml(row.role || '')}</td>
            <td>${row.disabled ? '⛔ wyłączony' : '✅ aktywny'}</td>
            <td>${row.lastPasswordChangeAt ? formatDateTime(row.lastPasswordChangeAt) : 'brak'}</td>
            <td><div class="inline-actions"><button type="button" class="btn btn-secondary btn-small js-user-reset" data-id="${row.id}">Reset hasła</button>${String(state.me?.id) !== String(row.id) ? `<button type="button" class="btn btn-secondary btn-small js-user-delete" data-id="${row.id}">Usuń</button>` : ''}</div></td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">Brak użytkowników.</div>';
      wrap.querySelectorAll('.js-user-reset').forEach(btn => btn.addEventListener('click', () => resetUserPasswordFromUi(btn.dataset.id)));
      wrap.querySelectorAll('.js-user-delete').forEach(btn => btn.addEventListener('click', () => deleteUserFromUi(btn.dataset.id)));
    }
  } catch (error) {
    if (meta) meta.textContent = `Użytkownicy lokalni są widoczni tylko dla administratora. ${error.message || ''}`;
    if (wrap) wrap.innerHTML = '<div class="muted">Brak dostępu do listy użytkowników.</div>';
  }
}

async function createUserFromUi(event) {
  event?.preventDefault?.();
  const payload = {
    username: document.getElementById('newUserUsername')?.value?.trim(),
    fullName: document.getElementById('newUserFullName')?.value?.trim(),
    password: document.getElementById('newUserPassword')?.value || '',
    role: document.getElementById('newUserRole')?.value || 'viewer'
  };
  await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  document.getElementById('userCreateForm')?.reset();
  await Promise.all([loadUsersPanel(), loadRolesView(), loadAudit()]);
  alert('Dodano użytkownika.');
}

async function resetUserPasswordFromUi(id) {
  const password = prompt('Podaj nowe hasło (minimum 6 znaków):');
  if (!password) return;
  await api(`/api/users/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  await Promise.all([loadUsersPanel(), loadAudit()]);
  alert('Hasło zostało zmienione.');
}

async function deleteUserFromUi(id) {
  if (!confirm('Usunąć wskazanego użytkownika?')) return;
  await api(`/api/users/${id}`, { method: 'DELETE' });
  await Promise.all([loadUsersPanel(), loadRolesView(), loadAudit()]);
}

async function loadSshPanel() {
  const data = await api('/api/ssh/profiles');
  state.ops.sshProfiles = Array.isArray(data.rows) ? data.rows : [];
  const editor = document.getElementById('sshProfilesInput');
  if (editor && !editor.dataset.userEdited) editor.value = JSON.stringify(normalizeSshProfilesForEditor(state.ops.sshProfiles), null, 2);
  editor?.addEventListener('input', () => { editor.dataset.userEdited = '1'; }, { once: true });
  const select = document.getElementById('sshProfileSelect');
  if (select) {
    select.innerHTML = state.ops.sshProfiles.map(row => `<option value="${row.id}">${escapeHtml(row.name)} (${escapeHtml(row.username)}@${escapeHtml(row.host)})</option>`).join('') || '<option value="">brak profili</option>';
  }
  document.getElementById('sshMeta').textContent = `Profili: ${state.ops.sshProfiles.length} · Ostatni run: ${formatDateTime(data.lastRunAt)}${data.lastError ? ` · Błąd: ${data.lastError}` : ''}`;
  const permsMeta = document.getElementById('terminalPermissionsMeta');
  if (permsMeta) {
    const perms = data.terminalPermissions || {};
    permsMeta.textContent = `Role terminala: viewer = brak, operator = ${perms.ssh ? 'SSH+' : ''}${perms.local ? 'lokalny' : 'bez lokalnego'}, admin = pełny dostęp + sesje. Profile mogą dodatkowo ograniczać role przez allowedRoles.`;
  }
}


async function saveSshProfiles() {
  const editor = document.getElementById('sshProfilesInput');
  let profiles;
  try {
    profiles = JSON.parse(editor.value || '[]');
    if (!Array.isArray(profiles)) throw new Error('JSON musi być tablicą.');
  } catch (error) {
    alert(`Błąd JSON profili SSH: ${error.message}`);
    return;
  }
  await api('/api/ssh/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles }) });
  editor.dataset.userEdited = '';
  await Promise.all([loadSshPanel(), loadAudit()]);
  alert('Zapisano profile SSH.');
}

async function runSshCommandFromUi() {
  const profileId = document.getElementById('sshProfileSelect')?.value;
  const command = document.getElementById('sshCommandInput')?.value?.trim() || 'hostname';
  const data = await api('/api/ssh/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, command }) });
  const result = data.result || {};
  document.getElementById('sshOutputBox').textContent = `# ${result.profileName || profileId}
$ ${result.command || command}

${result.stdout || ''}${result.stderr ? `
[stderr]
${result.stderr}` : ''}`.trim();
  await Promise.all([loadSshPanel(), loadAudit(), loadRuntimeLog()]);
}

function normalizeTasksForEditor(rows) {
  return (rows || []).map(row => ({
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    intervalMin: row.intervalMin,
    type: row.type,
    command: row.command || '',
    serviceId: row.serviceId || '',
    serviceAction: row.serviceAction || 'restart',
    dockerContainerId: row.dockerContainerId || '',
    dockerAction: row.dockerAction || 'restart',
    sshProfileId: row.sshProfileId || '',
    sshCommand: row.sshCommand || ''
  }));
}

async function loadTasksPanel() {
  const data = await api('/api/tasks');
  state.ops.tasks = Array.isArray(data.rows) ? data.rows : [];
  const editor = document.getElementById('tasksConfigInput');
  if (editor && !editor.dataset.userEdited) editor.value = JSON.stringify(normalizeTasksForEditor(state.ops.tasks), null, 2);
  editor?.addEventListener('input', () => { editor.dataset.userEdited = '1'; }, { once: true });
  const wrap = document.getElementById('tasksTableWrap');
  document.getElementById('tasksMeta').textContent = `Zadań: ${state.ops.tasks.length} · Ostatni tick: ${formatDateTime(data.lastTickAt)}${data.lastError ? ` · Błąd: ${data.lastError}` : ''}`;
  if (!wrap) return;
  wrap.innerHTML = state.ops.tasks.length ? `
    <div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Nazwa</th><th>Typ</th><th>Interwał</th><th>Status</th><th>Ostatni run</th><th>Akcja</th></tr></thead><tbody>
      ${state.ops.tasks.map(row => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${escapeHtml(row.type)}</td>
          <td>${row.intervalMin} min</td>
          <td>${row.enabled ? '✅ on' : '⏸️ off'}${row.lastStatus ? `<div class="muted small">${escapeHtml(row.lastStatus)}${row.lastError ? ` · ${escapeHtml(row.lastError)}` : ''}</div>` : ''}</td>
          <td>${formatDateTime(row.lastRunAt)}</td>
          <td><button type="button" class="btn btn-secondary btn-small js-task-run" data-id="${row.id}">Uruchom teraz</button></td>
        </tr>`).join('')}
    </tbody></table></div>` : '<div class="muted">Brak zadań harmonogramu.</div>';
  wrap.querySelectorAll('.js-task-run').forEach(btn => btn.addEventListener('click', () => runTaskFromUi(btn.dataset.id)));
}

async function saveTasksConfig() {
  const editor = document.getElementById('tasksConfigInput');
  let tasks;
  try {
    tasks = JSON.parse(editor.value || '[]');
    if (!Array.isArray(tasks)) throw new Error('JSON musi być tablicą.');
  } catch (error) {
    alert(`Błąd JSON zadań: ${error.message}`);
    return;
  }
  await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks }) });
  editor.dataset.userEdited = '';
  await Promise.all([loadTasksPanel(), loadAudit()]);
  alert('Zapisano harmonogram zadań.');
}

async function runTaskFromUi(id) {
  await api(`/api/tasks/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await Promise.all([loadTasksPanel(), loadRuntimeLog(), loadAudit(), loadBackupsPanel(), loadServicesPanel(), loadDockerPanel()]);
}


function ensureTerminalFrontend() {
  const box = terminalBoxEl();
  if (!box) return null;
  if (state.ops.terminal.instance) return state.ops.terminal.instance;
  const TerminalCtor = window.Terminal;
  if (!TerminalCtor) return null;
  const term = new TerminalCtor({ scrollback: 3000, cols: 120, rows: 30, theme: { background: '#0b1220', foreground: '#e5e7eb' } });
  term.open(box);
  const FitCtor = window.FitAddon?.FitAddon;
  if (FitCtor) {
    const fitAddon = new FitCtor();
    if (typeof fitAddon.activate === 'function') fitAddon.activate(term);
    state.ops.terminal.fitAddon = fitAddon;
    if (typeof fitAddon.fit === 'function') setTimeout(() => fitAddon.fit(), 10);
  }
  if (typeof term.onData === 'function') term.onData(data => sendTerminalInput(data));
  state.ops.terminal.instance = term;
  return term;
}

function terminalBoxEl() {
  return document.getElementById('liveTerminalBox');
}

function terminalLineInputEl() {
  return document.getElementById('terminalLineInput');
}

function terminalStatusBadgeEl() {
  return document.getElementById('terminalStatusBadge');
}

function terminalSessionMetaEl() {
  return document.getElementById('terminalSessionMeta');
}

function setTerminalBadge(label, kind = 'neutral') {
  const el = terminalStatusBadgeEl();
  if (!el) return;
  el.className = `status-chip status-chip-${kind}`;
  el.textContent = label;
}

function getTerminalGridSize() {
  const box = terminalBoxEl();
  if (!box) return { cols: 120, rows: 30 };
  const style = window.getComputedStyle(box);
  const width = box.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
  const height = box.clientHeight - parseFloat(style.paddingTop || 0) - parseFloat(style.paddingBottom || 0);
  const cols = Math.max(60, Math.floor(width / 8.4));
  const rows = Math.max(18, Math.floor(height / 19));
  return { cols, rows };
}

function updateTerminalSessionMeta(extra = '') {
  const el = terminalSessionMetaEl();
  if (!el) return;
  const dims = getTerminalGridSize();
  const mode = state.ops.terminal.mode === 'ssh' ? 'SSH' : 'lokalny';
  el.textContent = `Tryb: ${mode} · ${dims.cols}x${dims.rows}${extra ? ` · ${extra}` : ''}`;
}

function appendTerminalOutput(text) {
  const term = ensureTerminalFrontend();
  if (term && typeof term.write === 'function') { term.write(String(text || '')); return; }
  const box = terminalBoxEl();
  if (!box) return;
  box.textContent += String(text || '');
  box.scrollTop = box.scrollHeight;
}

function clearTerminalOutput(message = '') {
  const term = ensureTerminalFrontend();
  if (term && typeof term.clear === 'function') { term.clear(); if (message) term.write(message); return; }
  const box = terminalBoxEl();
  if (!box) return;
  box.textContent = message || '';
}

function ensureTerminalSocket() {
  if (state.ops.terminal.socket) return state.ops.terminal.socket;
  if (typeof io === 'undefined') {
    state.ops.terminal.connected = false;
    setTerminalBadge('⚪ offline', 'neutral');
    setMetricsStreamBadge('⚪ stream off', 'neutral');
    updateTerminalSessionMeta('tryb bez realtime');
    return null;
  }
  const socket = io({ path: '/socket.io' });
  state.ops.terminal.socket = socket;
  socket.on('connect', () => {
    state.ops.terminal.connected = true;
    setTerminalBadge('🟢 online', 'live');
    updateTerminalSessionMeta('połączono');
    appendTerminalOutput('\n[połączono z terminalem]\n');
    requestTerminalResize();
  });
  socket.on('disconnect', () => {
    state.ops.terminal.connected = false;
    state.ops.metricsSubscribed = false;
    setTerminalBadge('⚪ offline', 'neutral');
    setMetricsStreamBadge('⚪ stream off', 'neutral');
    updateTerminalSessionMeta('rozłączono');
    appendTerminalOutput('\n[terminal rozłączony]\n');
  });
  socket.on('metrics:data', data => { renderLiveMetricsPacket(data); pushMetricsHistory(data); renderMiniMetricCharts(); setMetricsStreamBadge('🟢 stream on', 'live'); loadMetricsCenterPanel().catch(() => {}); });
  socket.on('metrics:alert', row => { toast(`⚠️ Alert metryk: ${row.source || 'local'} / ${row.metric} = ${row.value}`, 'error'); loadMetricsCenterPanel().catch(() => {}); });
  socket.on('policy:block', row => { toast(`⛔ Polityka: ${(row.command || '').slice(0, 80)} — ${row.reason || 'zablokowano'}`, 'error'); });
  socket.on('agents:update', payload => { renderAgentsStatusRows(payload.rows || []); loadAgentsPanel().catch(() => {}); });
  socket.on('noc:alert', row => { toast(`🚨 NOC: ${row.message || (row.agentName || row.agentId || 'agent')}`, row.severity === 'info' ? 'success' : 'error'); loadAgentsPanel().catch(() => {}); });
  socket.on('terminal:sessions', data => renderTerminalSessionsTable(data.rows || [], data.permissions || null));
  socket.on('terminal:data', data => appendTerminalOutput(data));
  socket.on('terminal:ready', data => {
    state.ops.terminal.permissions = data.permissions || null;
    setTerminalBadge('🟢 live', 'live');
    updateTerminalSessionMeta(`sesja: ${data.mode}`);
    appendTerminalOutput(`\n[start: ${data.mode}]\n`);
    requestTerminalResize();
    loadTerminalSessionsPanel().catch(() => null);
  });
  socket.on('terminal:exit', data => {
    setTerminalBadge('⚠️ zakończono', 'warn');
    updateTerminalSessionMeta(`exit=${data.exitCode ?? 'n/a'}`);
    appendTerminalOutput(`\n[zakończono: code=${data.exitCode ?? 'n/a'} signal=${data.signal ?? 'n/a'}]\n`);
  });
  socket.on('terminal:error', payload => {
    setTerminalBadge('🔴 błąd', 'error');
    updateTerminalSessionMeta('błąd sesji');
    appendTerminalOutput(`\n[błąd terminala] ${payload?.error || 'Nieznany błąd'}\n`);
  });
  return socket;
}

function setMetricsStreamBadge(label, kind = 'neutral') {
  const el = document.getElementById('opsMetricsStreamBadge');
  if (!el) return;
  el.className = `status-chip status-chip-${kind}`;
  el.textContent = label;
}

function renderLiveMetricsPacket(packet) {
  state.ops.liveMetrics.push(packet);
  if (state.ops.liveMetrics.length > 20) state.ops.liveMetrics = state.ops.liveMetrics.slice(-20);
  const meta = document.getElementById('opsMetricsStreamMeta');
  const box = document.getElementById('opsMetricsLiveBox');
  const m = packet?.metrics || {};
  if (meta) meta.textContent = `WebSocket stream aktywny · pakiet: ${formatDateTime(packet?.ts)} · CPU load1: ${Number(packet?.summary?.cpu || 0).toFixed(2)} · RAM: ${packet?.summary?.memoryUsedPercent ?? 'n/a'}% · Dysk: ${packet?.summary?.diskUsedPercent ?? 'n/a'}%`;
  if (box) {
    box.textContent = state.ops.liveMetrics.map(row => `${formatDateTime(row.ts)} | load1=${Number(row?.summary?.cpu || 0).toFixed(2)} | ram=${row?.summary?.memoryUsedPercent ?? 'n/a'}% | disk=${row?.summary?.diskUsedPercent ?? 'n/a'}% | uptime=${formatUptime(row?.summary?.uptimeSec || 0)}`).join('\n');
  }
  if (m && Object.keys(m).length) {
    state.ops.metrics = m;
  pushMetricsHistory(packet);
  renderMiniMetricCharts();
    const grid = document.getElementById('opsMetricsGrid');
    if (grid) {
      grid.innerHTML = `
        <div class="stat-card"><div class="stat-label">Host</div><div class="stat-value stat-value-small">${escapeHtml(m.hostname || 'n/a')}</div></div>
        <div class="stat-card"><div class="stat-label">CPU</div><div class="stat-value stat-value-small">${escapeHtml(String(m.cpuCount || 0))} rdzeni</div></div>
        <div class="stat-card"><div class="stat-label">RAM</div><div class="stat-value stat-value-small">${formatBytes(m.memory?.usedBytes)} / ${formatBytes(m.memory?.totalBytes)}</div></div>
        <div class="stat-card"><div class="stat-label">Dysk</div><div class="stat-value stat-value-small">${m.disk?.usedPercent == null ? 'n/a' : `${m.disk.usedPercent}%`}</div></div>
        <div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value stat-value-small">${formatUptime(m.uptimeSec)}</div></div>
        <div class="stat-card"><div class="stat-label">Node.js</div><div class="stat-value stat-value-small">${escapeHtml(m.nodeVersion || 'n/a')}</div></div>`;
    }
  }
}

function subscribeMetricsStream() {
  const socket = ensureTerminalSocket();
  if (!socket || state.ops.metricsSubscribed) return;
  socket.emit('metrics:subscribe');
  state.ops.metricsSubscribed = true;
  setMetricsStreamBadge('🟢 stream on', 'live');
}

async function loadTerminalSessionsPanel() {
  try {
    const data = await api('/api/terminal/sessions');
    renderTerminalSessionsTable(data.rows || [], data.permissions || null);
  } catch (error) {
    const meta = document.getElementById('terminalSessionsMeta');
    const wrap = document.getElementById('terminalSessionsTableWrap');
    if (meta) meta.textContent = `Sesje terminalowe: ${error.message}`;
    if (wrap) wrap.innerHTML = '<div class="muted">Brak dostępu do panelu sesji terminalowych dla tej roli.</div>';
  }
}

function renderTerminalSessionsTable(rows, permissions = null) {
  state.ops.terminalSessions = Array.isArray(rows) ? rows : [];
  const meta = document.getElementById('terminalSessionsMeta');
  const wrap = document.getElementById('terminalSessionsTableWrap');
  if (meta) meta.textContent = `Sesji: ${state.ops.terminalSessions.length} · uprawnienia: ${permissions?.killAny ? 'admin / killAny' : (permissions?.sessions ? 'własne sesje' : 'brak')}`;
  if (!wrap) return;
  wrap.innerHTML = state.ops.terminalSessions.length ? `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Użytkownik</th><th>Tryb</th><th>Host</th><th>Start</th><th>Aktywność</th><th>Rozmiar</th><th>Blokady</th><th>Akcja</th></tr></thead><tbody>${state.ops.terminalSessions.map(row => `<tr><td>${escapeHtml(row.username)} ${state.me?.user?.username === row.username ? '<span class="terminal-sessions-self">(ty)</span>' : ''}<div class="muted small">rola: ${escapeHtml(row.role || 'viewer')}</div></td><td>${escapeHtml(row.mode || 'n/a')}</td><td>${escapeHtml(row.hostLabel || row.profileName || 'lokalny')}</td><td>${formatDateTime(row.startedAt)}</td><td>${formatDateTime(row.lastActivityAt)}</td><td>${Number(row.cols || 0)}x${Number(row.rows || 0)}</td><td>${Number(row.blockedCommands || 0)}</td><td><button type="button" class="btn btn-secondary btn-small js-terminal-kill" data-id="${row.id}">Zakończ</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">Brak aktywnych sesji terminalowych.</div>';
  wrap.querySelectorAll('.js-terminal-kill').forEach(btn => btn.addEventListener('click', () => killTerminalSession(btn.dataset.id)));
}

async function killTerminalSession(id) {
  await api(`/api/terminal/sessions/${id}/kill`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await loadTerminalSessionsPanel();
}

function requestTerminalResize() {
  const dims = getTerminalGridSize();
  const fitAddon = state.ops.terminal.fitAddon;
  if (fitAddon && typeof fitAddon.fit === 'function') fitAddon.fit();
  const socket = state.ops.terminal.socket;
  if (!socket || !state.ops.terminal.connected) {
    updateTerminalSessionMeta();
    return;
  }
  socket.emit('terminal:resize', dims);
  updateTerminalSessionMeta();
}

async function startLiveTerminal() {
  ensureTerminalFrontend();
  clearTerminalOutput('');
  const socket = ensureTerminalSocket();
  const profileId = document.getElementById('sshProfileSelect')?.value || '';
  const mode = document.getElementById('terminalModeSelect')?.value || 'local';
  state.ops.terminal.mode = mode;
  const dims = getTerminalGridSize();
  setTerminalBadge('🟡 start…', 'warn');
  updateTerminalSessionMeta('uruchamianie');
  if (!socket) {
    setTerminalBadge('⚪ offline', 'neutral');
    updateTerminalSessionMeta('socket.io niedostępne');
    appendTerminalOutput('\n[terminal live jest wyłączony: brak klienta socket.io w tej paczce]\n');
    return;
  }
  socket.emit('terminal:create', { profileId: mode === 'ssh' ? profileId : '', cols: dims.cols, rows: dims.rows });
  setTimeout(() => terminalBoxEl()?.focus(), 50);
}

function stopLiveTerminal() {
  const socket = ensureTerminalSocket();
  if (!socket) return;
  socket.emit('terminal:kill', { id: state.ops.terminal.socket?.id || '' });
  setTerminalBadge('⚪ offline', 'neutral');
  updateTerminalSessionMeta('zatrzymano');
}

function sendTerminalInput(text) {
  const socket = ensureTerminalSocket();
  if (!state.ops.terminal.connected || !text) return;
  if (!socket) return;
  socket.emit('terminal:input', text);
}

async function copyTerminalOutput() {
  const term = ensureTerminalFrontend();
  const box = terminalBoxEl();
  if (!box) return;
  const text = term && typeof term.getPlainText === 'function' ? term.getPlainText() : (box.textContent || '');
  try {
    await navigator.clipboard.writeText(text);
    toast('Skopiowano terminal do schowka.', 'success');
  } catch (_) {
    alert('Nie udało się skopiować terminala do schowka.');
  }
}

async function pasteIntoTerminal() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    sendTerminalInput(text);
    terminalBoxEl()?.focus();
  } catch (_) {
    alert('Przeglądarka zablokowała odczyt schowka.');
  }
}

function sendTerminalLine() {
  const input = terminalLineInputEl();
  const value = input?.value || '';
  if (!value.trim()) return;
  sendTerminalInput(value + '\r');
  if (input) input.value = '';
  terminalBoxEl()?.focus();
}

function handleTerminalKeydown(event) {
  const box = terminalBoxEl();
  if (!box || document.activeElement !== box) return;
  if (!state.ops.terminal.connected) return;
  if (event.ctrlKey && event.key.toLowerCase() === 'v') {
    event.preventDefault();
    pasteIntoTerminal();
  }
}

const liveTerminalBox = document.getElementById('liveTerminalBox');
ensureTerminalFrontend();
liveTerminalBox?.addEventListener('keydown', handleTerminalKeydown);
liveTerminalBox?.addEventListener('click', () => terminalBoxEl()?.focus());
liveTerminalBox?.addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!text) return;
  event.preventDefault();
  sendTerminalInput(text);
});
document.getElementById('clearTerminalBtn')?.addEventListener('click', () => clearTerminalOutput(''));
document.getElementById('copyTerminalBtn')?.addEventListener('click', copyTerminalOutput);
document.getElementById('pasteTerminalBtn')?.addEventListener('click', pasteIntoTerminal);
document.getElementById('sendTerminalLineBtn')?.addEventListener('click', sendTerminalLine);
terminalLineInputEl()?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendTerminalLine();
  }
});
window.addEventListener('resize', () => requestTerminalResize());
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => requestTerminalResize());
  if (liveTerminalBox) ro.observe(liveTerminalBox);
}
updateTerminalSessionMeta();
setTerminalBadge('⚪ offline', 'neutral');
setMetricsStreamBadge('⚪ stream off', 'neutral');


async function loadTranscriptsPanel() {
  const meta = document.getElementById('transcriptsMeta');
  const wrap = document.getElementById('transcriptsTableWrap');
  const preview = document.getElementById('transcriptPreviewBox');
  if (!meta || !wrap || !preview) return;
  try {
    const data = await api('/api/terminal/session-transcripts');
    state.ops.terminalTranscripts = Array.isArray(data.rows) ? data.rows : [];
    meta.textContent = `Transcriptów: ${state.ops.terminalTranscripts.length}`;
    wrap.innerHTML = state.ops.terminalTranscripts.length ? `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Użytkownik</th><th>Host</th><th>Start</th><th>Koniec</th><th>Format</th><th>Rozmiar</th><th>Akcja</th></tr></thead><tbody>${state.ops.terminalTranscripts.map(row => `<tr><td>${escapeHtml(row.user || '')}</td><td>${escapeHtml(row.hostLabel || row.mode || '')}</td><td>${formatDateTime(row.startedAt)}</td><td>${formatDateTime(row.endedAt)}</td><td>${escapeHtml(row.format || 'log')}</td><td>${formatBytes(row.bytes || 0)}</td><td><button type="button" class="btn btn-secondary btn-small js-open-transcript" data-id="${row.id}">Podgląd</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">Brak transcriptów.</div>';
    wrap.querySelectorAll('.js-open-transcript').forEach(btn => btn.addEventListener('click', async () => {
      const data = await api(`/api/terminal/session-transcripts/${btn.dataset.id}`);
      const events = Array.isArray(data.events) ? data.events : [];
      preview.textContent = events.length ? events.map(ev => `${ev.ts || ''} [${ev.stream || 'raw'}] ${ev.event ? ev.event + ' ' : ''}${typeof ev.data === 'string' ? ev.data : ev.data == null ? '' : JSON.stringify(ev.data)}${ev.meta ? ' ' + JSON.stringify(ev.meta) : ''}`).join('\n') : (data.content || 'Brak danych');
    }));
  } catch (error) {
    meta.textContent = `Transcripty: ${error.message}`;
    wrap.innerHTML = '<div class="muted">Brak dostępu do transcriptów.</div>';
  }
}

function renderAgentsStatusRows(rows) {
  const wrap = document.getElementById('agentsTableWrap');
  if (!wrap) return;
  state.ops.agentsStatus = Array.isArray(rows) ? rows : [];
  wrap.innerHTML = state.ops.agentsStatus.length ? `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>Nazwa</th><th>URL</th><th>Host</th><th>Status</th><th>Tryb</th><th>CPU</th><th>RAM</th><th>Dysk</th><th>SLA 24h</th></tr></thead><tbody>${state.ops.agentsStatus.map(row => `<tr><td>${escapeHtml(row.name || '')}</td><td>${escapeHtml(row.baseUrl || '')}</td><td>${escapeHtml(row.hostname || '')}</td><td>${row.ok ? '✅ ok' : `⚠️ ${escapeHtml(row.error || 'błąd')}`}</td><td>${escapeHtml(row.lastMode || 'poll')}</td><td>${escapeHtml(String(row.summary?.cpu ?? 'n/a'))}</td><td>${escapeHtml(String(row.summary?.memoryUsedPercent ?? 'n/a'))}</td><td>${escapeHtml(String(row.summary?.diskUsedPercent ?? 'n/a'))}</td><td>${escapeHtml(String(row.sla?.uptime24h ?? 'n/a'))}%</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">Brak danych agentów.</div>';
}

function renderAgentsGui(rows, config) {
  const wrap = document.getElementById('agentsGuiWrap');
  if (!wrap) return;
  const agents = Array.isArray(rows) ? rows : [];
  wrap.innerHTML = `<div class="panel-card panel-card-nested"><div class="panel-head-row"><div><strong>GUI agentów</strong><div class="muted small">Dodawanie / edycja hostów bez ręcznego JSON.</div></div><button type="button" class="btn btn-secondary btn-small" id="addAgentRowBtn">Dodaj agenta</button></div><div class="stack-list top-gap" id="agentsGuiRows">${agents.map((row, idx) => `<div class="policy-card js-agent-row" data-id="${escapeAttr(row.id || idx + 1)}"><div class="panel-head-row"><strong>Agent #${idx + 1}</strong><button type="button" class="btn btn-secondary btn-small js-remove-agent-row">Usuń</button></div><div class="ops-form top-gap"><label><span>ID</span><input type="number" class="js-agent-id" value="${escapeAttr(row.id || idx + 1)}"></label><label><span>Nazwa</span><input type="text" class="js-agent-name" value="${escapeAttr(row.name || '')}"></label><label><span>URL</span><input type="text" class="js-agent-url" value="${escapeAttr(row.baseUrl || '')}" placeholder="http://10.0.0.20:3080"></label><label class="span-2"><span>Token</span><input type="text" class="js-agent-token" value="${escapeAttr(row.token || '')}"></label></div></div>`).join('')}</div></div>`;
  document.getElementById('addAgentRowBtn')?.addEventListener('click', () => {
    const current = collectAgentsFromGui();
    current.push({ id: Date.now(), name: '', baseUrl: '', token: '' });
    renderAgentsGui(current, config);
  });
  wrap.querySelectorAll('.js-remove-agent-row').forEach(btn => btn.addEventListener('click', () => btn.closest('.js-agent-row')?.remove()));
}

function collectAgentsFromGui() {
  return Array.from(document.querySelectorAll('.js-agent-row')).map((row, idx) => ({
    id: Number(row.querySelector('.js-agent-id')?.value || idx + 1),
    name: row.querySelector('.js-agent-name')?.value?.trim() || `Agent ${idx + 1}`,
    baseUrl: row.querySelector('.js-agent-url')?.value?.trim() || '',
    token: row.querySelector('.js-agent-token')?.value?.trim() || ''
  })).filter(row => row.baseUrl || row.name);
}

function renderAgentThresholdsGui(config, rows) {
  const wrap = document.getElementById('agentsThresholdsWrap');
  if (!wrap) return;
  const thresholds = config?.thresholds || {};
  const base = thresholds.default || { cpu: 85, memory: 85, disk: 90 };
  wrap.innerHTML = `<div class="panel-card panel-card-nested"><div class="panel-head-row"><div><strong>Alerty NOC per agent</strong><div class="muted small">Progi CPU / RAM / dysk, push mode i retencja historii.</div></div></div><div class="ops-form top-gap"><label><span>Push mode</span><input id="agentsPushEnabledInput" type="checkbox" ${config?.pushEnabled ? 'checked' : ''}></label><label><span>Retencja historii</span><input id="agentsHistoryRetentionInput" type="number" min="60" step="60" value="${escapeAttr(config?.historyRetentionPoints || 720)}"></label><label><span>Domyślny CPU %</span><input id="agentsDefaultCpuInput" type="number" min="1" max="999" value="${escapeAttr(base.cpu || 85)}"></label><label><span>Domyślny RAM %</span><input id="agentsDefaultMemoryInput" type="number" min="1" max="100" value="${escapeAttr(base.memory || 85)}"></label><label><span>Domyślny dysk %</span><input id="agentsDefaultDiskInput" type="number" min="1" max="100" value="${escapeAttr(base.disk || 90)}"></label></div><div class="table-scroll top-gap"><table class="data-table compact-table"><thead><tr><th>Agent</th><th>allowSsh</th><th>allowTerminal</th><th>allowNetwork</th><th>CPU</th><th>RAM</th><th>Dysk</th><th>Notatka</th></tr></thead><tbody>${(rows || []).map(row => { const policy = config?.perHostPolicies?.[String(row.id)] || {}; const custom = thresholds[String(row.id)] || {}; return `<tr data-agent-id="${escapeAttr(row.id)}"><td>${escapeHtml(row.name || `Agent ${row.id}`)}</td><td><input type="checkbox" class="js-agent-policy-ssh" ${policy.allowSsh ? 'checked' : ''}></td><td><input type="checkbox" class="js-agent-policy-terminal" ${policy.allowTerminal ? 'checked' : ''}></td><td><input type="checkbox" class="js-agent-policy-network" ${policy.allowNetwork !== false ? 'checked' : ''}></td><td><input type="number" class="js-agent-th-cpu" value="${escapeAttr(custom.cpu ?? '')}" placeholder="domyślny"></td><td><input type="number" class="js-agent-th-memory" value="${escapeAttr(custom.memory ?? '')}" placeholder="domyślny"></td><td><input type="number" class="js-agent-th-disk" value="${escapeAttr(custom.disk ?? '')}" placeholder="domyślny"></td><td><input type="text" class="js-agent-policy-notes" value="${escapeAttr(policy.notes || '')}"></td></tr>`; }).join('')}</tbody></table></div></div>`;
}

function collectAgentPoliciesFromGui() {
  const perHostPolicies = {};
  const thresholds = { default: { cpu: Number(document.getElementById('agentsDefaultCpuInput')?.value || 85), memory: Number(document.getElementById('agentsDefaultMemoryInput')?.value || 85), disk: Number(document.getElementById('agentsDefaultDiskInput')?.value || 90) } };
  document.querySelectorAll('#agentsThresholdsWrap tr[data-agent-id]').forEach(tr => {
    const id = String(tr.dataset.agentId || '');
    perHostPolicies[id] = {
      allowSsh: !!tr.querySelector('.js-agent-policy-ssh')?.checked,
      allowTerminal: !!tr.querySelector('.js-agent-policy-terminal')?.checked,
      allowNetwork: !!tr.querySelector('.js-agent-policy-network')?.checked,
      notes: tr.querySelector('.js-agent-policy-notes')?.value?.trim() || ''
    };
    const cpu = tr.querySelector('.js-agent-th-cpu')?.value?.trim();
    const memory = tr.querySelector('.js-agent-th-memory')?.value?.trim();
    const disk = tr.querySelector('.js-agent-th-disk')?.value?.trim();
    if (cpu || memory || disk) thresholds[id] = { ...(cpu ? { cpu: Number(cpu) } : {}), ...(memory ? { memory: Number(memory) } : {}), ...(disk ? { disk: Number(disk) } : {}) };
  });
  return { perHostPolicies, thresholds, pushEnabled: !!document.getElementById('agentsPushEnabledInput')?.checked, historyRetentionPoints: Number(document.getElementById('agentsHistoryRetentionInput')?.value || 720) };
}

function renderAgentDashboard(rows, alerts) {
  const wrap = document.getElementById('agentsDashboardWrap');
  const alertsWrap = document.getElementById('agentsAlertsWrap');
  if (wrap) wrap.innerHTML = (rows || []).length ? `<div class="stack-list">${rows.map(row => { const history = Array.isArray(row.history) ? row.history : []; const defs = [{ key: 'cpu', label: 'CPU' }, { key: 'memory', label: 'RAM %' }, { key: 'disk', label: 'Dysk %' }, { key: 'ok', label: 'Dostępność' }]; return `<div class="panel-card panel-card-nested"><div class="panel-head-row"><div><strong>${escapeHtml(row.name || row.hostname || `Agent ${row.id}`)}</strong><div class="muted small">SLA total: ${escapeHtml(String(row.sla?.uptimeTotal ?? 'n/a'))}% · SLA 24h: ${escapeHtml(String(row.sla?.uptime24h ?? 'n/a'))}% · host: ${escapeHtml(row.hostname || '')}</div></div><span class="status-chip ${row.ok ? 'status-chip-ok' : 'status-chip-danger'}">${row.ok ? '🟢 online' : '🔴 down'}</span></div><div class="metrics-charts top-gap">${defs.map(def => { const vals = history.map(h => def.key === 'ok' ? (h.ok ? 100 : 0) : Number(h[def.key] ?? 0)); const max = Math.max(100, ...vals, 1); const points = vals.map((val, idx) => `${vals.length <= 1 ? 0 : (idx / (vals.length - 1)) * 100},${70 - ((Number(val || 0) / max) * 70)}`).join(' '); const last = vals.length ? vals[vals.length - 1] : 0; return `<div class="metric-chart-card"><div class="metric-chart-title">${def.label}</div><svg viewBox="0 0 100 80" preserveAspectRatio="none" class="metric-chart-svg"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${points}"></polyline></svg><div class="metric-chart-value">${def.key === 'ok' ? `${Number(last).toFixed(0)}%` : Number(last).toFixed(1)}</div></div>`; }).join('')}</div></div>`; }).join('')}</div>` : '<div class="muted">Brak historycznych danych agentów.</div>';
  if (alertsWrap) alertsWrap.innerHTML = (alerts || []).length ? `<div class="panel-card panel-card-nested"><div class="panel-head-row"><strong>Alerty NOC</strong></div><div class="table-scroll top-gap"><table class="data-table compact-table"><thead><tr><th>Czas</th><th>Agent</th><th>Typ</th><th>Treść</th></tr></thead><tbody>${alerts.slice(0, 50).map(row => `<tr><td>${formatDateTime(row.ts)}</td><td>${escapeHtml(row.agentName || row.hostname || row.agentId || '')}</td><td>${escapeHtml(row.kind || '')}</td><td>${escapeHtml(row.message || '')}</td></tr>`).join('')}</tbody></table></div></div>` : '<div class="muted">Brak alertów NOC.</div>';
}


function renderMetricsCenterCharts(series) {
  const wrap = document.getElementById('metricsCenterCharts');
  if (!wrap) return;
  const defs = [
    { key: 'cpu', label: 'CPU %' },
    { key: 'memory', label: 'RAM %' },
    { key: 'disk', label: 'Dysk %' },
    { key: 'latency', label: 'Latency ms' },
    { key: 'online', label: 'Online %' }
  ];
  const rows = Array.isArray(series?.local) ? series.local : [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">Brak historii metryk.</div>';
    return;
  }
  wrap.innerHTML = defs.map(def => {
    const vals = rows.map(row => Number(row?.[def.key] ?? 0));
    const max = Math.max(100, ...vals, 1);
    const points = vals.map((val, idx) => `${vals.length <= 1 ? 0 : (idx / (vals.length - 1)) * 100},${70 - ((Number(val || 0) / max) * 70)}`).join(' ');
    const last = vals.length ? vals[vals.length - 1] : 0;
    return `<div class="metric-chart-card"><div class="metric-chart-title">${def.label}</div><svg viewBox="0 0 100 80" preserveAspectRatio="none" class="metric-chart-svg"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${points}"></polyline></svg><div class="metric-chart-value">${Number(last).toFixed(def.key === 'latency' ? 0 : 1)}</div></div>`;
  }).join('');
}

function renderMetricsCenterAlerts(rows) {
  const wrap = document.getElementById('metricsAlertsWrap');
  if (!wrap) return;
  const alerts = Array.isArray(rows) ? rows : [];
  wrap.innerHTML = alerts.length
    ? `<div class="panel-card panel-card-nested"><div class="panel-head-row"><strong>Alerty metryk</strong></div><div class="table-scroll top-gap"><table class="data-table compact-table"><thead><tr><th>Czas</th><th>Źródło</th><th>Metryka</th><th>Wartość</th><th>Prog</th></tr></thead><tbody>${alerts.slice(0, 50).map(row => `<tr><td>${formatDateTime(row.ts)}</td><td>${escapeHtml(row.source || 'local')}</td><td>${escapeHtml(row.metric || '')}</td><td>${escapeHtml(String(row.value ?? ''))}</td><td>${escapeHtml(String(row.threshold ?? ''))}</td></tr>`).join('')}</tbody></table></div></div>`
    : '<div class="muted">Brak alertów metryk.</div>';
}


async function generateTwoFactorSecret() {
  const data = await api('/api/2fa/setup', { method: 'POST' });
  const secretInput = document.getElementById('twoFactorSecretInput');
  const otpInput = document.getElementById('twoFactorOtpAuthInput');
  const recoveryBox = document.getElementById('twoFactorRecoveryBox');
  const meta = document.getElementById('twoFactorMeta');
  if (secretInput) secretInput.value = data.manualEntryKey || data.secret || '';
  if (otpInput) otpInput.value = data.otpauthUrl || '';
  if (recoveryBox) recoveryBox.textContent = 'Najpierw wpisz kod z aplikacji TOTP i kliknij „Włącz 2FA”.';
  if (meta) meta.textContent = 'Sekret 2FA został wygenerowany. Zeskanuj URL w aplikacji TOTP albo przepisz klucz ręcznie.';
  toast('Wygenerowano sekret 2FA.', 'success');
}

async function enableTwoFactor() {
  const token = String(document.getElementById('twoFactorTokenInput')?.value || '').trim();
  if (!token) {
    toast('Wpisz kod z aplikacji TOTP.', 'error');
    return;
  }
  const data = await api('/api/2fa/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  const recoveryBox = document.getElementById('twoFactorRecoveryBox');
  if (recoveryBox) recoveryBox.textContent = Array.isArray(data.recoveryCodes) && data.recoveryCodes.length
    ? data.recoveryCodes.join('\n')
    : 'Brak kodów recovery.';
  const tokenInput = document.getElementById('twoFactorTokenInput');
  if (tokenInput) tokenInput.value = '';
  await loadTwoFactorStatus();
  toast('2FA zostało włączone.', 'success');
}

async function disableTwoFactor() {
  const password = String(document.getElementById('twoFactorDisablePasswordInput')?.value || '');
  if (!password) {
    toast('Podaj hasło, aby wyłączyć 2FA.', 'error');
    return;
  }
  await api('/api/2fa/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const secretInput = document.getElementById('twoFactorSecretInput');
  const otpInput = document.getElementById('twoFactorOtpAuthInput');
  const recoveryBox = document.getElementById('twoFactorRecoveryBox');
  const passwordInput = document.getElementById('twoFactorDisablePasswordInput');
  const tokenInput = document.getElementById('twoFactorTokenInput');
  if (secretInput) secretInput.value = '';
  if (otpInput) otpInput.value = '';
  if (recoveryBox) recoveryBox.textContent = '2FA wyłączone. Kody recovery zostały usunięte.';
  if (passwordInput) passwordInput.value = '';
  if (tokenInput) tokenInput.value = '';
  await loadTwoFactorStatus();
  toast('2FA zostało wyłączone.', 'success');
}

async function loadMetricsCenterPanel() {
  const meta = document.getElementById('metricsCenterMeta');
  if (!meta) return;
  try {
    const [configData, historyData] = await Promise.all([api('/api/metrics/config'), api('/api/metrics/history')]);
    const config = configData?.config || {};
    document.getElementById('metricsRetentionInput').value = config.retentionPoints || 480;
    document.getElementById('metricsSampleIntervalInput').value = config.sampleIntervalSec || 15;
    document.getElementById('metricsCpuThresholdInput').value = config.thresholds?.cpu || 85;
    document.getElementById('metricsMemoryThresholdInput').value = config.thresholds?.memory || 85;
    document.getElementById('metricsDiskThresholdInput').value = config.thresholds?.disk || 90;
    const series = historyData?.series || {};
    const localRows = Array.isArray(series.local) ? series.local : [];
    meta.textContent = `Próbek: ${localRows.length} · retencja: ${config.retentionPoints || 0} · interwał: ${config.sampleIntervalSec || 0}s`;
    renderMetricsCenterCharts(series);
    renderMetricsCenterAlerts(historyData?.alerts || []);
  } catch (error) {
    meta.textContent = `Centrum metryk: ${error.message}`;
    renderMetricsCenterCharts({});
    renderMetricsCenterAlerts([]);
  }
}

async function saveMetricsCenterPanel(event) {
  event?.preventDefault?.();
  await api('/api/metrics/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      retentionPoints: Number(document.getElementById('metricsRetentionInput')?.value || 480),
      sampleIntervalSec: Number(document.getElementById('metricsSampleIntervalInput')?.value || 15),
      thresholds: {
        cpu: Number(document.getElementById('metricsCpuThresholdInput')?.value || 85),
        memory: Number(document.getElementById('metricsMemoryThresholdInput')?.value || 85),
        disk: Number(document.getElementById('metricsDiskThresholdInput')?.value || 90)
      }
    })
  });
  toast('Zapisano ustawienia centrum metryk.', 'success');
  await loadMetricsCenterPanel();
}

async function loadTwoFactorStatus() {
  const meta = document.getElementById('twoFactorMeta');
  const secretInput = document.getElementById('twoFactorSecretInput');
  const otpInput = document.getElementById('twoFactorOtpAuthInput');
  const recoveryBox = document.getElementById('twoFactorRecoveryBox');
  if (!meta || !secretInput || !otpInput || !recoveryBox) return;
  try {
    const data = await api('/api/2fa/status');
    secretInput.value = '';
    otpInput.value = '';
    recoveryBox.textContent = data.enabled
      ? `2FA aktywne dla ${data.username}. Pozostałe kody recovery: ${data.recoveryCodesLeft}.`
      : '2FA jest wyłączone. Kliknij „Generuj sekret”, aby rozpocząć konfigurację.';
    meta.textContent = data.enabled
      ? `2FA aktywne od ${formatDateTime(data.enabledAt)} · recovery: ${data.recoveryCodesLeft}`
      : '2FA wyłączone';
  } catch (error) {
    meta.textContent = `2FA: ${error.message}`;
  }
}

async function loadAgentsPanel() {
  const meta = document.getElementById('agentsMeta');
  const wrap = document.getElementById('agentsTableWrap');
  if (!meta || !wrap) return;
  try {
    const data = await api('/api/agents/config');
    const dash = await api('/api/agents/dashboard');
    state.ops.agentsConfig = data.config || null;
    state.ops.agentsStatus = Array.isArray(dash.rows) ? dash.rows : (Array.isArray(data.cache) ? data.cache : []);
    document.getElementById('agentsEnabledInput').checked = !!data.config?.enabled;
    document.getElementById('agentsPollIntervalInput').value = data.config?.pollIntervalSec || 30;
    document.getElementById('agentsSharedTokenInput').value = data.config?.sharedToken || 'vsm-agent-token';
    document.getElementById('agentsConfigInput').value = JSON.stringify(data.rows || [], null, 2);
    document.getElementById('agentsPoliciesInput').value = JSON.stringify(data.config?.perHostPolicies || {}, null, 2);
    meta.textContent = `Agentów: ${(data.rows || []).length} · cache: ${state.ops.agentsStatus.length} · alertów NOC: ${(dash.alerts || []).length}`;
    renderAgentsGui(data.rows || [], data.config || {});
    renderAgentThresholdsGui(data.config || {}, data.rows || []);
    renderAgentDashboard(dash.rows || [], dash.alerts || []);
    renderAgentsStatusRows(state.ops.agentsStatus);
  } catch (error) {
    meta.textContent = `Agenci: ${error.message}`;
    wrap.innerHTML = '<div class="muted">Brak dostępu do panelu agentów.</div>';
  }
}

async function saveAgentsPanel(event) {
  event?.preventDefault?.();
  let agents = collectAgentsFromGui();
  if (!agents.length) {
    try { agents = JSON.parse(document.getElementById('agentsConfigInput')?.value || '[]'); } catch (_) { throw new Error('Błędny JSON agentów.'); }
  }
  const gui = collectAgentPoliciesFromGui();
  document.getElementById('agentsConfigInput').value = JSON.stringify(agents, null, 2);
  document.getElementById('agentsPoliciesInput').value = JSON.stringify(gui.perHostPolicies, null, 2);
  await api('/api/agents/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: document.getElementById('agentsEnabledInput')?.checked, pollIntervalSec: Number(document.getElementById('agentsPollIntervalInput')?.value || 30), sharedToken: document.getElementById('agentsSharedTokenInput')?.value || 'vsm-agent-token', agents, perHostPolicies: gui.perHostPolicies, thresholds: gui.thresholds, pushEnabled: gui.pushEnabled, historyRetentionPoints: gui.historyRetentionPoints }) });
  toast('Zapisano agentów i polityki NOC.', 'success');
  await loadAgentsPanel();
}

async function pollAgentsNowFromUi() {
  await api('/api/agents/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  toast('Odświeżono agentów.', 'success');
  await loadAgentsPanel();
}




function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

async function loadEnterpriseSuite() {
  try {
    const [orgs, rbac] = await Promise.all([api('/api/organizations'), api('/api/enterprise-rbac')]);
    document.getElementById('organizationsInput').value = prettyJson(orgs.rows || []);
    document.getElementById('enterpriseRolesInput').value = prettyJson(rbac.roles || []);
    document.getElementById('enterpriseAssignmentsInput').value = prettyJson({ assignments: rbac.assignments || [], users: (rbac.users || []).map(user => ({ id: user.id, username: user.username, organizationIds: user.organizationIds || [1] })) });
    document.getElementById('enterpriseMeta').textContent = `Organizacje: ${(orgs.rows || []).length} · role enterprise: ${(rbac.roles || []).length} · przypisania: ${(rbac.assignments || []).length}`;
  } catch (error) {
    document.getElementById('enterpriseMeta').textContent = `Enterprise: ${error.message}`;
  }
}

async function saveEnterpriseSuite() {
  try {
    const rows = JSON.parse(document.getElementById('organizationsInput').value || '[]');
    const rbac = JSON.parse(document.getElementById('enterpriseAssignmentsInput').value || '{}');
    const roles = JSON.parse(document.getElementById('enterpriseRolesInput').value || '[]');
    await api('/api/organizations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    await api('/api/enterprise-rbac', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles, assignments: rbac.assignments || [], users: rbac.users || [] }) });
    toast('Zapisano organizacje i enterprise RBAC.', 'success');
    await loadEnterpriseSuite();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderTicketsTable(rows) {
  const wrap = document.getElementById('ticketsTableWrap');
  if (!wrap) return;
  wrap.innerHTML = `<div class="table-scroll"><table class="data-table compact-table"><thead><tr><th>ID</th><th>Typ</th><th>Target</th><th>Status</th><th>User</th><th>Org</th><th>Akcje</th></tr></thead><tbody>${(rows || []).map(row => `<tr><td>#${row.id}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.requestedBy || '')}</td><td>${row.orgId || '—'}</td><td><div class="toolbar-inline"><button type="button" class="btn btn-secondary btn-small js-ticket-action" data-id="${row.id}" data-action="approve">Approve</button><button type="button" class="btn btn-secondary btn-small js-ticket-action" data-id="${row.id}" data-action="deny">Deny</button></div></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Brak ticketów.</td></tr>'}</tbody></table></div>`;
  wrap.querySelectorAll('.js-ticket-action').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await api(`/api/tickets/${btn.dataset.id}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: btn.dataset.action, note: '' }) });
      toast(`Ticket #${btn.dataset.id}: ${btn.dataset.action}`, 'success');
      await loadIdentityPanel();
    } catch (error) {
      toast(error.message, 'error');
    }
  }));
}


function parseLdapFilterTemplatesInput(value) {
  return String(value || '').split(/\r?\n/).map((line, idx) => {
    const raw = line.trim();
    if (!raw) return null;
    const parts = raw.split('::');
    return { id: idx + 1, name: (parts[0] || `Template ${idx + 1}`).trim(), template: (parts.slice(1).join('::') || parts[0] || '').trim(), enabled: true };
  }).filter(Boolean);
}

function renderLdapFilterTemplatesInput(rows) {
  return (rows || []).map(row => `${row.name || 'Template'}::${row.template || ''}`).join('\n');
}

function syncIdentityGuiFromConfig(identity) {
  const ldap = identity?.providers?.ldap || {};
  const oidc = identity?.providers?.oidc || {};
  const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
  setVal('ldapUrlInput', ldap.url || '');
  setVal('ldapBaseDnInput', ldap.baseDn || '');
  setVal('ldapSearchAttributeInput', ldap.searchAttribute || 'uid');
  setVal('ldapSearchFilterTemplateInput', ldap.searchFilterTemplate || '');
  setVal('ldapFilterTemplatesInput', renderLdapFilterTemplatesInput(ldap.filterTemplates || []));
  setVal('oidcIssuerInput', oidc.issuer || '');
  setVal('oidcClientIdInput', oidc.clientId || '');
  setVal('oidcRedirectUriInput', oidc.redirectUri || '');
}

function applyIdentityGuiToConfig(payload) {
  payload = payload && typeof payload === 'object' ? payload : {};
  payload.providers = payload.providers && typeof payload.providers === 'object' ? payload.providers : {};
  payload.providers.ldap = payload.providers.ldap && typeof payload.providers.ldap === 'object' ? payload.providers.ldap : {};
  payload.providers.oidc = payload.providers.oidc && typeof payload.providers.oidc === 'object' ? payload.providers.oidc : {};
  payload.providers.ldap.url = document.getElementById('ldapUrlInput')?.value?.trim() || payload.providers.ldap.url || '';
  payload.providers.ldap.baseDn = document.getElementById('ldapBaseDnInput')?.value?.trim() || payload.providers.ldap.baseDn || '';
  payload.providers.ldap.searchAttribute = document.getElementById('ldapSearchAttributeInput')?.value?.trim() || payload.providers.ldap.searchAttribute || 'uid';
  payload.providers.ldap.searchFilterTemplate = document.getElementById('ldapSearchFilterTemplateInput')?.value?.trim() || payload.providers.ldap.searchFilterTemplate || '';
  payload.providers.ldap.filterTemplates = parseLdapFilterTemplatesInput(document.getElementById('ldapFilterTemplatesInput')?.value || '');
  payload.providers.oidc.issuer = document.getElementById('oidcIssuerInput')?.value?.trim() || payload.providers.oidc.issuer || '';
  payload.providers.oidc.clientId = document.getElementById('oidcClientIdInput')?.value?.trim() || payload.providers.oidc.clientId || '';
  payload.providers.oidc.redirectUri = document.getElementById('oidcRedirectUriInput')?.value?.trim() || payload.providers.oidc.redirectUri || '';
  return payload;
}

function syncRemoteGatewayGui(gateway) {
  const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ''; };
  setVal('gatewayGuacamoleInput', gateway?.guacamoleUrl || '');
  setVal('gatewayNoVncInput', gateway?.noVncUrl || '');
  setVal('gatewayWebRdpInput', gateway?.webRdpUrl || '');
  setVal('gatewayLaunchModeInput', gateway?.launchMode || 'iframe');
  const cb = document.getElementById('gatewayOpenInNewWindowInput'); if (cb) cb.checked = !!gateway?.openInNewWindow;
}

function collectRemoteGatewayGui() {
  return {
    guacamoleUrl: document.getElementById('gatewayGuacamoleInput')?.value?.trim() || '',
    noVncUrl: document.getElementById('gatewayNoVncInput')?.value?.trim() || '',
    webRdpUrl: document.getElementById('gatewayWebRdpInput')?.value?.trim() || '',
    launchMode: document.getElementById('gatewayLaunchModeInput')?.value?.trim() || 'iframe',
    openInNewWindow: !!document.getElementById('gatewayOpenInNewWindowInput')?.checked
  };
}

async function loadIdentityPanel() {
  try {
    const [identity, tickets] = await Promise.all([api('/api/identity/config'), api('/api/tickets')]);
    document.getElementById('identityConfigInput').value = prettyJson(identity.identity || {});
    syncIdentityGuiFromConfig(identity.identity || {});
    document.getElementById('identityMeta').textContent = `Identity mode: ${identity.mode || 'config-foundation'} · mapowania grup: ${(identity.identity?.groupMappings || []).length} · LDAP: ${identity.identity?.providers?.ldap?.searchUseBind ? 'search+bind' : 'simple bind'} · templatek LDAP: ${(identity.identity?.providers?.ldap?.filterTemplates || []).length} · OIDC refresh: ${identity.identity?.providers?.oidc?.useRefreshTokens ? 'on' : 'off'}`;
    document.getElementById('ticketsMeta').textContent = `Tickety: ${(tickets.rows || []).length} · approval dla: ${(tickets.policy || []).join(', ') || '—'}`;
    renderTicketsTable(tickets.rows || []);
  } catch (error) {
    document.getElementById('identityMeta').textContent = `Identity: ${error.message}`;
  }
}

async function saveIdentityPanel() {
  try {
    let payload = JSON.parse(document.getElementById('identityConfigInput').value || '{}');
    payload = applyIdentityGuiToConfig(payload);
    document.getElementById('identityConfigInput').value = prettyJson(payload);
    await api('/api/identity/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    toast('Zapisano identity center.', 'success');
    await loadIdentityPanel();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function createTicketFromUi() {
  try {
    await api('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: document.getElementById('ticketTypeInput').value.trim(), target: document.getElementById('ticketTargetInput').value.trim(), orgId: Number(document.getElementById('ticketOrgIdInput').value || 1), justification: document.getElementById('ticketJustificationInput').value.trim() }) });
    toast('Utworzono ticket dostępu.', 'success');
    await loadIdentityPanel();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadRemotePanel() {
  try {
    const data = await api('/api/remote-access');
    document.getElementById('remoteProfilesInput').value = prettyJson(data.profiles || []);
    document.getElementById('dbProfilesInput').value = prettyJson(data.databaseProfiles || []);
    document.getElementById('k8sProfilesInput').value = prettyJson(data.k8sProfiles || []);
    syncRemoteGatewayGui(data.gateway || {});
    document.getElementById('remoteMeta').textContent = `Remote profiles: ${(data.profiles || []).length} · DB: ${(data.databaseProfiles || []).length} · K8s: ${(data.k8sProfiles || []).length} · gateway GUI: ${(data.gateway?.guacamoleUrl || data.gateway?.noVncUrl || data.gateway?.webRdpUrl) ? 'on' : 'off'}`;
  } catch (error) {
    document.getElementById('remoteMeta').textContent = `Remote access: ${error.message}`;
  }
}

async function saveRemotePanel() {
  try {
    const profiles = JSON.parse(document.getElementById('remoteProfilesInput').value || '[]');
    const databaseProfiles = JSON.parse(document.getElementById('dbProfilesInput').value || '[]');
    const k8sProfiles = JSON.parse(document.getElementById('k8sProfilesInput').value || '[]');
    await api('/api/remote-access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profiles, databaseProfiles, k8sProfiles, gateway: collectRemoteGatewayGui() }) });
    toast('Zapisano profile remote access / DB / K8s.', 'success');
    await loadRemotePanel();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function testDbProfileFromUi() {
  try {
    const rows = JSON.parse(document.getElementById('dbProfilesInput').value || '[]');
    const row = rows[0];
    if (!row) throw new Error('Dodaj przynajmniej jeden profil bazy.');
    const result = await api('/api/db-profiles/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row) });
    toast(result.ok ? `DB OK: ${result.engine || 'profile'}` : (result.error || 'Test zakończony bez sukcesu'), result.ok ? 'success' : 'warning');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadDiscoveryBrandingPanel() {
  try {
    const [branding, discovery] = await Promise.all([api('/api/branding'), api('/api/discovery/config')]);
    document.getElementById('brandingNameInput').value = branding.settings?.brandName || '';
    document.getElementById('brandingThemeInput').value = branding.settings?.globalTheme || '';
    document.getElementById('brandingAccentInput').value = branding.settings?.accentColor || '';
    document.getElementById('brandingLogoInput').value = branding.settings?.logoText || '';
    document.getElementById('brandingCssInput').value = branding.settings?.customCss || '';
    document.getElementById('discoveryConfigInput').value = prettyJson(discovery.discovery || {});
    document.getElementById('discoveryMeta').textContent = `Discovery assets: ${discovery.summary?.totalAssets || 0} · rooms: ${discovery.summary?.roomCount || 0} · agents: ${discovery.summary?.agentCount || 0}`;
  } catch (error) {
    document.getElementById('discoveryMeta').textContent = `Discovery: ${error.message}`;
  }
}

async function saveBrandingFromUi() {
  try {
    await api('/api/branding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandName: document.getElementById('brandingNameInput').value.trim(), globalTheme: document.getElementById('brandingThemeInput').value.trim(), accentColor: document.getElementById('brandingAccentInput').value.trim(), logoText: document.getElementById('brandingLogoInput').value.trim(), customCss: document.getElementById('brandingCssInput').value }) });
    toast('Zapisano branding i theme.', 'success');
    await loadDiscoveryBrandingPanel();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function saveDiscoveryPanel() {
  try {
    const payload = JSON.parse(document.getElementById('discoveryConfigInput').value || '{}');
    await api('/api/discovery/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    toast('Zapisano discovery / asset sync.', 'success');
    await loadDiscoveryBrandingPanel();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function runDiscoveryFromUi() {
  try {
    const result = await api('/api/discovery/run', { method: 'POST' });
    toast(`Discovery OK · assets: ${result.summary?.totalAssets || 0}`, 'success');
    await loadDiscoveryBrandingPanel();
  } catch (error) {
    toast(error.message, 'error');
  }
}
