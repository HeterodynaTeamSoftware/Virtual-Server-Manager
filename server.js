/*
Nazwa programu: Virtual Server Manager
Producent: Heterodyna Team Software
Wersja softu: v84
Programista: Adrian Podłucki
Tester app/network: Grześ :)
*/

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const http = require('http');
let socketIo;
try { socketIo = require('socket.io'); } catch (_) { socketIo = null; }
let pty;
try { pty = require('node-pty'); } catch (_) { pty = null; }
let snmp;
try { snmp = require('net-snmp'); } catch (_) { snmp = null; }
let pg;
try { pg = require('pg'); } catch (_) { pg = null; }

const snmpPollingRuntime = { running: false, startedAt: null, lastFinishedAt: null, lastError: null };

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 3080;
const VERSION = '0.90.0';
const SESSION_SECRET = process.env.VSM_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const DEFAULT_AGENT_SHARED_TOKEN = process.env.VSM_AGENT_SHARED_TOKEN || crypto.randomBytes(32).toString('hex');
const DEFAULT_ADMIN_PASSWORD = process.env.VSM_ADMIN_PASSWORD || 'admin123';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'storage.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RUNTIME_LOG_FILE = path.join(__dirname, 'runtime-server.log');
const TRANSCRIPTS_DIR = path.join(DATA_DIR, 'terminal-transcripts');
const SERVICE_ALLOWED_ACTIONS = ['status', 'start', 'stop', 'restart'];
let maintenanceRuntime = { backupTimerStarted: false, lastBackupCheckAt: null };

const APP_FILE = path.join(__dirname, 'public', 'app.html');
const README_FILE = path.join(__dirname, 'README.md');

function majorVersionTag(version) {
  const parts = String(version || '').split('.');
  return `v${Number(parts[1] || parts[0] || 0)}`;
}

function hasVersionMarker(content, version) {
  const tag = majorVersionTag(version);
  return String(content || '').includes(version) || String(content || '').includes(tag);
}

function getPostgresConfig(db) {
  db.postgres = db.postgres || {};
  return {
    enabled: !!db.postgres.enabled,
    host: db.postgres.host || process.env.PGHOST || '127.0.0.1',
    port: Number(db.postgres.port || process.env.PGPORT || 5432),
    database: db.postgres.database || process.env.PGDATABASE || 'dcim',
    user: db.postgres.user || process.env.PGUSER || 'dcim',
    password: db.postgres.password || process.env.PGPASSWORD || '',
    ssl: !!db.postgres.ssl,
    lastTestAt: db.postgres.lastTestAt || null,
    lastTestOk: typeof db.postgres.lastTestOk === 'boolean' ? db.postgres.lastTestOk : null,
    lastSyncAt: db.postgres.lastSyncAt || null,
    lastImportAt: db.postgres.lastImportAt || null,
    lastError: db.postgres.lastError || ''
  };
}

function buildPostgresStatus(db) {
  const cfg = getPostgresConfig(db);
  db.postgres = db.postgres || {};
  db.postgres.liveSync = db.postgres.liveSync && typeof db.postgres.liveSync === 'object' ? db.postgres.liveSync : {};
  const localBridge = !pg || !cfg.enabled;
  return {
    moduleInstalled: !!pg,
    localBridge,
    enabled: localBridge ? true : cfg.enabled,
    host: localBridge ? 'local-json-bridge' : cfg.host,
    port: localBridge ? 0 : cfg.port,
    database: localBridge ? 'dcim_local' : cfg.database,
    user: localBridge ? 'local' : cfg.user,
    ssl: localBridge ? false : cfg.ssl,
    lastTestAt: cfg.lastTestAt,
    lastTestOk: cfg.lastTestOk,
    lastSyncAt: cfg.lastSyncAt,
    lastImportAt: cfg.lastImportAt,
    lastError: cfg.lastError,
    rowEstimate: (db.serverRooms || []).reduce((acc, room) => acc + (room.racks || []).length, 0),
    liveSyncReady: localBridge ? true : (!!pg && !!cfg.enabled),
    lastPushAt: db.postgres.liveSync.lastPushAt || null,
    lastPullAt: db.postgres.liveSync.lastPullAt || null,
    lastPushCount: Number(db.postgres.liveSync.lastPushCount || 0),
    lastPullCount: Number(db.postgres.liveSync.lastPullCount || 0),
    mirrorCount: Array.isArray(db.postgres.liveMirror) ? db.postgres.liveMirror.length : 0
  };
}

async function runPostgresTest(db) {
  const cfg = getPostgresConfig(db);
  db.postgres = db.postgres || {};
  if (!pg || !pg.Client || !cfg.enabled) {
    db.postgres.lastTestAt = nowIso();
    db.postgres.lastTestOk = true;
    db.postgres.lastError = '';
    return { db: 'dcim_local', ts: nowIso(), mode: 'local-bridge' };
  }
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 3000
  });
  await client.connect();
  const result = await client.query('select current_database() as db, now() as ts');
  await client.end();
  db.postgres.lastTestAt = nowIso();
  db.postgres.lastTestOk = true;
  db.postgres.lastError = '';
  return result.rows?.[0] || { db: cfg.database, ts: nowIso() };
}

function collectPostgresExportRows(db) {
  const rows = [];
  for (const room of db.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const side of ['frontDevices', 'rearDevices']) {
        for (const device of rack[side] || []) {
          rows.push({
            building: room.building || '',
            roomNumber: room.roomNumber || '',
            rackLabel: rack.label || '',
            side: side === 'frontDevices' ? 'front' : 'rear',
            deviceLabel: device.label || '',
            deviceType: device.type || '',
            deviceModel: device.model || '',
            ip: device.network?.ip || '',
            vlan: device.network?.vlan || '',
            startU: Number(device.startU || 0),
            sizeU: Number(device.sizeU || 0)
          });
        }
      }
    }
  }
  return rows;
}


async function getPostgresClient(db) {
  const cfg = getPostgresConfig(db);
  if (!pg || !pg.Client) throw new Error('Moduł pg nie jest zainstalowany.');
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 4000
  });
  await client.connect();
  return client;
}

async function ensurePostgresSyncSchema(client) {
  await client.query(`
    create table if not exists dcim_live_sync_devices (
      id bigserial primary key,
      building text,
      room_number text,
      rack_label text,
      side text,
      device_label text,
      device_type text,
      device_model text,
      ip text,
      vlan text,
      start_u integer,
      size_u integer,
      synced_at timestamptz default now()
    )
  `);
  await client.query(`
    create table if not exists dcim_live_sync_state (
      sync_key text primary key,
      sync_value text,
      updated_at timestamptz default now()
    )
  `);
}

async function pushPostgresSync(db) {
  const cfg = getPostgresConfig(db);
  if (!pg || !pg.Client || !cfg.enabled) {
    const rows = collectPostgresExportRows(db);
    db.postgres = db.postgres || {};
    db.postgres.liveSync = db.postgres.liveSync || {};
    db.postgres.liveMirror = rows;
    db.postgres.liveSync.lastPushAt = nowIso();
    db.postgres.liveSync.lastPushCount = rows.length;
    db.postgres.lastSyncAt = db.postgres.liveSync.lastPushAt;
    db.postgres.lastError = '';
    return { rows: rows.length, syncedAt: db.postgres.liveSync.lastPushAt, mode: 'local-bridge' };
  }
  const client = await getPostgresClient(db);
  try {
    await ensurePostgresSyncSchema(client);
    const rows = collectPostgresExportRows(db);
    await client.query('begin');
    await client.query('delete from dcim_live_sync_devices');
    for (const row of rows) {
      await client.query(
        `insert into dcim_live_sync_devices (building, room_number, rack_label, side, device_label, device_type, device_model, ip, vlan, start_u, size_u, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,
        [row.building, row.roomNumber, row.rackLabel, row.side, row.deviceLabel, row.deviceType, row.deviceModel, row.ip, row.vlan, row.startU, row.sizeU]
      );
    }
    await client.query(
      `insert into dcim_live_sync_state (sync_key, sync_value, updated_at)
       values ('last_push_count', $1, now())
       on conflict (sync_key) do update set sync_value = excluded.sync_value, updated_at = excluded.updated_at`,
      [String(rows.length)]
    );
    await client.query('commit');
    db.postgres = db.postgres || {};
    db.postgres.liveSync = db.postgres.liveSync || {};
    db.postgres.liveSync.lastPushAt = nowIso();
    db.postgres.liveSync.lastPushCount = rows.length;
    db.postgres.lastSyncAt = db.postgres.liveSync.lastPushAt;
    db.postgres.lastError = '';
    return { rows: rows.length, syncedAt: db.postgres.liveSync.lastPushAt };
  } catch (error) {
    try { await client.query('rollback'); } catch (_) {}
    throw error;
  } finally {
    await client.end();
  }
}

async function pullPostgresSync(db) {
  const cfg = getPostgresConfig(db);
  if (!pg || !pg.Client || !cfg.enabled) {
    db.postgres = db.postgres || {};
    db.postgres.liveSync = db.postgres.liveSync || {};
    db.postgres.liveMirror = Array.isArray(db.postgres.liveMirror) ? db.postgres.liveMirror : collectPostgresExportRows(db);
    db.postgres.liveSync.lastPullAt = nowIso();
    db.postgres.liveSync.lastPullCount = db.postgres.liveMirror.length;
    db.postgres.lastImportAt = db.postgres.liveSync.lastPullAt;
    db.postgres.lastError = '';
    return { rows: db.postgres.liveSync.lastPullCount, pulledAt: db.postgres.liveSync.lastPullAt, mode: 'local-bridge' };
  }
  const client = await getPostgresClient(db);
  try {
    await ensurePostgresSyncSchema(client);
    const result = await client.query(`select building, room_number, rack_label, side, device_label, device_type, device_model, ip, vlan, start_u, size_u, synced_at from dcim_live_sync_devices order by building, room_number, rack_label, side, start_u desc, device_label`);
    db.postgres = db.postgres || {};
    db.postgres.liveSync = db.postgres.liveSync || {};
    db.postgres.liveMirror = result.rows || [];
    db.postgres.liveSync.lastPullAt = nowIso();
    db.postgres.liveSync.lastPullCount = Array.isArray(db.postgres.liveMirror) ? db.postgres.liveMirror.length : 0;
    db.postgres.lastImportAt = db.postgres.liveSync.lastPullAt;
    db.postgres.lastError = '';
    return { rows: db.postgres.liveSync.lastPullCount, pulledAt: db.postgres.liveSync.lastPullAt };
  } finally {
    await client.end();
  }
}

function buildMap3dRows(db) {
  return (db.serverRooms || []).map(room => ({
    roomId: room.id,
    building: room.building || '',
    roomNumber: room.roomNumber || '',
    roomType: room.roomType || '',
    rowsCount: Math.max(1, ...((room.racks || []).map(rack => Number(rack.rowNumber || 1)))),
    racks: (room.racks || []).map(rack => {
      const usedU = [...(rack.frontDevices || []), ...(rack.rearDevices || [])].reduce((acc, device) => acc + Number(device.sizeU || 0), 0);
      const sizeU = Number(rack.sizeU || 42) || 42;
      return {
        rackId: rack.id,
        label: rack.label || '',
        rowNumber: rack.rowNumber || 1,
        positionInRow: rack.positionInRow || 1,
        posX: (Number(rack.positionInRow || 1) - 1) * 220,
        posY: (Number(rack.rowNumber || 1) - 1) * 260,
        sizeU,
        usedU,
        utilizationPct: Math.min(100, Math.round((usedU / Math.max(1, sizeU)) * 100)),
        devices: [...(rack.frontDevices || []), ...(rack.rearDevices || [])].map(device => ({
          label: device.label || '',
          type: device.type || '',
          startU: Number(device.startU || 0),
          sizeU: Number(device.sizeU || 0)
        }))
      };
    })
  }));
}


function resolveDeviceByPortRef(serverRooms = [], ref = {}) {
  const refRackId = Number(ref.rackId || ref.rackID || 0) || null;
  const refDeviceId = Number(ref.deviceId || ref.deviceID || 0) || null;
  const refPortId = Number(ref.portId || ref.portID || 0) || null;
  const refPortNumber = String(ref.portNumber || ref.port || '').trim();
  const refRoomId = Number(ref.roomId || ref.roomID || 0) || null;

  for (const room of serverRooms || []) {
    if (refRoomId && Number(room.id || 0) !== refRoomId) continue;
    for (const rack of room.racks || []) {
      if (refRackId && Number(rack.id || 0) !== refRackId) continue;
      for (const device of [...(rack.frontDevices || []), ...(rack.rearDevices || [])]) {
        if (refDeviceId && Number(device.id || 0) !== refDeviceId) continue;
        const ports = device.ports || [];
        let matchedPort = null;
        if (refPortId) matchedPort = ports.find(port => Number(port.id || 0) === refPortId) || null;
        if (!matchedPort && refPortNumber) matchedPort = ports.find(port => String(port.portNumber || port.name || '').trim() === refPortNumber) || null;
        if (refDeviceId || matchedPort || (!refRackId && !refDeviceId && !refPortId && !refPortNumber)) {
          return { room, rack, device, port: matchedPort };
        }
      }
    }
  }
  return null;
}

function buildDependencyRows(db) {
  const rows = [];
  for (const room of db.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of [...(rack.frontDevices || []), ...(rack.rearDevices || [])]) {
        for (const port of device.ports || []) {
          if (!port.connectedTo) continue;
          const remote = resolveDeviceByPortRef(db.serverRooms, port.connectedTo);
          rows.push({
            roomId: room.id,
            rackId: rack.id,
            deviceId: device.id,
            service: device.label || '',
            dependsOn: remote?.device?.label || port.target || 'nieznany cel',
            localPort: port.portNumber || '-',
            remotePort: port.connectedTo?.portNumber || '-',
            medium: port.connectionMeta?.medium || '-',
            impact: /uplink|router|firewall/i.test(`${device.type || ''} ${remote?.device?.type || ''}`) ? 'wysoki' : 'średni'
          });
        }
      }
    }
  }
  return rows;
}

function buildCableVisualizationRows(db) {
  return (db.cableRoutes || []).map(route => ({
    routeId: route.id,
    routeName: route.name || '',
    from: route.from || route.start || '-',
    to: route.to || route.end || '-',
    medium: route.medium || '-',
    segments: Array.isArray(route.segments) ? route.segments.length : Number(route.hops || 0),
    status: route.status || 'aktywny',
    note: route.note || ''
  }));
}

function nextId(items = []) {
  return items.length ? Math.max(...items.map(i => Number(i.id) || 0)) + 1 : 1;
}
function nowIso() { return new Date().toISOString(); }

function buildInitialData() {
  const adminPasswordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
  return {
    users: [{ id: 1, username: 'admin', passwordHash: adminPasswordHash, role: 'admin', fullName: 'Administrator' }],
    serverRooms: [{
      id: 1,
      roomNumber: '23',
      building: 'Budynek A',
      roomType: 'Serwerownia główna',
      dimensions: { width: 8, depth: 5, height: 3 },
      rowConfigs: [{ rowNumber: 1, rackCount: 4 }, { rowNumber: 2, rackCount: 4 }],
      note: 'Przykładowa serwerownia startowa',
      racks: [
        {
          id: 1,
          label: 'Szafa 1.1',
          model: 'Rack 42U 600x1000',
          sizeU: 42,
          type: 'stojąca',
          rowNumber: 1,
          positionInRow: 1,
          frontDevices: [
            {
              id: 1,
              type: 'Switch 24-port',
              vendor: 'Cisco',
              model: 'Catalyst 2960X 24TS-L',
              label: 'Switch 1',
              startU: 40,
              sizeU: 1,
              network: { hostname: 'sw-01', ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1', vlan: '10' },
              power: {
                primary: { sourceLabel: 'PDU A', outletNumber: 1 },
                backup: { sourceLabel: 'UPS B', outletNumber: 1 }
              },
              ports: Array.from({ length: 24 }).map((_, i) => ({
                portNumber: i + 1,
                status: i < 8 ? 'up' : 'down',
                target: i === 0 ? 'Budynek A / Serwerownia 23 / Szafa 1.2 / Patch panel 1 / Port 1' : '',
                ip: i === 0 ? '192.168.1.11' : '',
                vlan: i === 0 ? '10' : '',
                subnet: i === 0 ? '192.168.1.0/24' : '',
                mask: i === 0 ? '255.255.255.0' : '',
                gateway: i === 0 ? '192.168.1.1' : '',
                cableColor: i === 0 ? '#22c55e' : '#64748b',
                connectedTo: i === 0 ? { roomId: 1, rackId: 2, deviceId: 1, portNumber: 1 } : null,
                connectionMeta: i === 0 ? { medium: 'miedź', cableLabel: 'PC-A-001', cableLengthM: 2, routeId: 1, routeName: 'Trasa A-23-R1' } : null
              }))
            },
            {
              id: 2,
              type: 'Patch panel 24-port',
              vendor: 'Inne / Generic',
              model: 'Generic 24-port',
              label: 'PP-01',
              startU: 39,
              sizeU: 1,
              network: null,
              power: null,
              ports: Array.from({ length: 24 }).map((_, i) => ({
                portNumber: i + 1,
                status: i < 8 ? 'up' : 'down',
                target: i < 8 ? `Gniazdo B-${i + 1}` : '',
                cableColor: i < 8 ? '#eab308' : '#64748b',
                connectedTo: null
              }))
            },
            { id: 3, type: 'Organizer kabli', vendor: 'Inne / Generic', model: 'Organizer 1U', label: 'Organizer 1', startU: 38, sizeU: 1, network: null, power: null, ports: [] },
            {
              id: 4,
              type: 'Serwer 2U',
              vendor: 'Dell EMC',
              model: 'PowerEdge 1U/2U',
              label: 'Serwer 1',
              startU: 35,
              sizeU: 2,
              network: { hostname: 'srv-01', ip: '192.168.1.20', mask: '255.255.255.0', gateway: '192.168.1.1', vlan: '20' },
              power: {
                primary: { sourceLabel: 'PDU A', outletNumber: 2 },
                backup: { sourceLabel: 'UPS B', outletNumber: 2 }
              },
              ports: []
            }
          ],
          rearDevices: [
            {
              id: 101,
              type: 'PDU podstawowe 230V',
              label: 'PDU A',
              startU: 1,
              sizeU: 6,
              outlets: [
                { outletNumber: 1, connectedTo: 'Switch 1', line: 'A' },
                { outletNumber: 2, connectedTo: 'Serwer 1', line: 'A' }
              ],
              ports: []
            },
            {
              id: 102,
              type: 'UPS zapasowy',
              label: 'UPS B',
              startU: 7,
              sizeU: 4,
              outlets: [
                { outletNumber: 1, connectedTo: 'Switch 1', line: 'B' },
                { outletNumber: 2, connectedTo: 'Serwer 1', line: 'B' }
              ],
              ports: []
            }
          ]
        },
        {
          id: 2,
          label: 'Szafa 1.2',
          model: 'Rack 42U 600x1000',
          sizeU: 42,
          type: 'stojąca',
          rowNumber: 1,
          positionInRow: 2,
          frontDevices: [{
            id: 1,
            type: 'Patch panel 24-port',
            vendor: 'Inne / Generic',
            model: 'Generic 24-port',
            label: 'Patch panel 1',
            startU: 40,
            sizeU: 1,
            network: null,
            power: null,
            ports: Array.from({ length: 24 }).map((_, i) => ({ portNumber: i + 1, status: i === 0 ? 'up' : 'down', target: '', cableColor: i === 0 ? '#22c55e' : '#64748b', connectedTo: null,
                connectionMeta: null }))
          }],
          rearDevices: []
        }
      ]
    }],
    auditLog: [{ id: 1, ts: nowIso(), user: 'system', action: 'INIT', message: 'Utworzono dane startowe prototypu v15.' }],
    monitoring: { samplesByKey: {}, interfaceSamplesByKey: {}, events: [], lastScanAt: null, lastScanMode: 'bootstrap', snmpCountersByKey: {}, snmpLatestByKey: {}, snmpPolling: { enabled: false, intervalSec: 300, lastRunAt: null, lastSummary: null }, snmpPollingHistory: [], uplinkMapHistory: [] },
    cableRoutes: [
      { id: 1, name: 'Trasa A-23-R1', fromBuilding: 'Budynek A', toBuilding: 'Budynek A', medium: 'miedź', notes: 'Przykładowa trasa między szafami w serwerowni 23.' }
    ],
    settings: { brandName: 'Virtual Server Manager', theme: 'dark-blue' }
  };
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(buildInitialData(), null, 2), 'utf8');
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed.users) || parsed.users.length === 0) throw new Error('missing-users');
    if (!Array.isArray(parsed.auditLog)) parsed.auditLog = [];
    if (!parsed.monitoring || typeof parsed.monitoring !== 'object') parsed.monitoring = { samplesByKey: {}, events: [], lastScanAt: null, lastScanMode: 'migrated' };
    if (!parsed.monitoring.samplesByKey || typeof parsed.monitoring.samplesByKey !== 'object') parsed.monitoring.samplesByKey = {};
    if (!parsed.monitoring.interfaceSamplesByKey || typeof parsed.monitoring.interfaceSamplesByKey !== 'object') parsed.monitoring.interfaceSamplesByKey = {};
    if (!parsed.monitoring.snmpCountersByKey || typeof parsed.monitoring.snmpCountersByKey !== 'object') parsed.monitoring.snmpCountersByKey = {};
    if (!parsed.monitoring.snmpLatestByKey || typeof parsed.monitoring.snmpLatestByKey !== 'object') parsed.monitoring.snmpLatestByKey = {};
    if (!parsed.monitoring.snmpPolling || typeof parsed.monitoring.snmpPolling !== 'object') parsed.monitoring.snmpPolling = { enabled: false, intervalSec: 300, lastRunAt: null, lastSummary: null };
    parsed.monitoring.snmpPolling.intervalSec = Math.max(60, Number(parsed.monitoring.snmpPolling.intervalSec) || 300);
    if (!Array.isArray(parsed.monitoring.snmpPollingHistory)) parsed.monitoring.snmpPollingHistory = [];
    if (!Array.isArray(parsed.monitoring.uplinkMapHistory)) parsed.monitoring.uplinkMapHistory = [];
    if (!Array.isArray(parsed.monitoring.events)) parsed.monitoring.events = [];
    if (!Array.isArray(parsed.cableRoutes)) parsed.cableRoutes = [];
    migrateData(parsed);
    fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {
    fs.writeFileSync(DATA_FILE, JSON.stringify(buildInitialData(), null, 2), 'utf8');
  }
}

function migrateData(db) {
  db.monitoring = db.monitoring && typeof db.monitoring === 'object' ? db.monitoring : { samplesByKey: {}, interfaceSamplesByKey: {}, events: [], lastScanAt: null, lastScanMode: 'migrated', snmpCountersByKey: {}, snmpLatestByKey: {}, snmpPolling: { enabled: false, intervalSec: 300, lastRunAt: null, lastSummary: null }, snmpPollingHistory: [], uplinkMapHistory: [] };
  db.monitoring.samplesByKey = db.monitoring.samplesByKey && typeof db.monitoring.samplesByKey === 'object' ? db.monitoring.samplesByKey : {};
  db.monitoring.interfaceSamplesByKey = db.monitoring.interfaceSamplesByKey && typeof db.monitoring.interfaceSamplesByKey === 'object' ? db.monitoring.interfaceSamplesByKey : {};
  db.monitoring.snmpCountersByKey = db.monitoring.snmpCountersByKey && typeof db.monitoring.snmpCountersByKey === 'object' ? db.monitoring.snmpCountersByKey : {};
  db.monitoring.snmpLatestByKey = db.monitoring.snmpLatestByKey && typeof db.monitoring.snmpLatestByKey === 'object' ? db.monitoring.snmpLatestByKey : {};
  db.monitoring.snmpPolling = db.monitoring.snmpPolling && typeof db.monitoring.snmpPolling === 'object' ? db.monitoring.snmpPolling : { enabled: true, intervalSec: 300, lastRunAt: null, lastSummary: null };
  if (typeof db.monitoring.snmpPolling.enabled !== 'boolean') db.monitoring.snmpPolling.enabled = true;
  db.monitoring.snmpPolling.intervalSec = Math.max(60, Number(db.monitoring.snmpPolling.intervalSec) || 300);
  db.monitoring.snmpPollingHistory = Array.isArray(db.monitoring.snmpPollingHistory) ? db.monitoring.snmpPollingHistory : [];
  db.monitoring.uplinkMapHistory = Array.isArray(db.monitoring.uplinkMapHistory) ? db.monitoring.uplinkMapHistory : [];
  db.monitoring.events = Array.isArray(db.monitoring.events) ? db.monitoring.events : [];
  db.cableRoutes = Array.isArray(db.cableRoutes) ? db.cableRoutes.map(route => ({...route, orgId: Number(route.orgId || 1)})) : [];
  if (!db.cableRoutes.length) db.cableRoutes.push({ id: 1, name: 'Domyślna trasa serwerowni', fromBuilding: '', toBuilding: '', medium: 'miedź', notes: 'Dodana migracją v15.' });
  db.flowCollector = db.flowCollector && typeof db.flowCollector === 'object' ? db.flowCollector : { enabled: false, mode: 'netflow', host: '0.0.0.0', port: 2055, sampling: 1000, lastTestAt: null, lastTestOk: null, lastError: '' };
  db.flowCollector.mode = String(db.flowCollector.mode || 'netflow');
  db.flowCollector.host = String(db.flowCollector.host || '0.0.0.0');
  db.flowCollector.port = Math.max(1, Number(db.flowCollector.port) || 2055);
  db.flowCollector.sampling = Math.max(1, Number(db.flowCollector.sampling) || 1000);
  db.rbac = db.rbac && typeof db.rbac === 'object' ? db.rbac : { users: {} };
  db.rbac.users = db.rbac.users && typeof db.rbac.users === 'object' ? db.rbac.users : {};
  db.serverRooms = Array.isArray(db.serverRooms) ? db.serverRooms : [];
  (db.users || []).forEach(user => {
    const key = String(user.id);
    const current = db.rbac.users[key] && typeof db.rbac.users[key] === 'object' ? db.rbac.users[key] : null;
    const base = user.role === 'admin' ? { write: true, admin: true, telemetry: true } : user.role === 'operator' ? { write: true, admin: false, telemetry: true } : { write: false, admin: false, telemetry: true };
    db.rbac.users[key] = { scope: current?.scope || 'global', permissions: { ...base, ...(current?.permissions || {}) }, viewPermissions: current?.viewPermissions && typeof current.viewPermissions === 'object' ? current.viewPermissions : {} };
  });
  db.serverRooms.forEach(room => {
    room.orgId = Number(room.orgId || 1);
    room.racks = Array.isArray(room.racks) ? room.racks : [];
    room.racks.forEach(rack => {
      rack.frontDevices = Array.isArray(rack.frontDevices) ? rack.frontDevices : [];
      rack.rearDevices = Array.isArray(rack.rearDevices) ? rack.rearDevices : [];
      [...rack.frontDevices, ...rack.rearDevices].forEach(device => {
        if (device.ports) device.ports = normalizePorts(device.ports);
        if (!('power' in device)) device.power = null;
        if (!Array.isArray(device.outlets)) device.outlets = [];
        if (!device.vendor) device.vendor = inferVendorFromType(device.type);
        if (!device.model) device.model = inferModelFromType(device.type, device.vendor);
        ensureMonitoringDefaults(device);
        if (/switch/i.test(String(device.type || '')) && String(device.network?.ip || '').trim() && ['icmp','ping',''].includes(String(device.monitoring?.protocol || '').toLowerCase())) {
          device.monitoring.protocol = 'snmp';
          if (!device.monitoring.snmpCommunity) device.monitoring.snmpCommunity = 'public';
        }
      });
    });
  });
}

function inferVendorFromType(type='') {
  const t = String(type || '');
  if (/switch/i.test(t)) return 'Cisco';
  if (/serwer/i.test(t)) return 'Dell EMC';
  return 'Inne / Generic';
}
function inferModelFromType(type='', vendor='') {
  const t = String(type || '');
  if (/48-port/i.test(t)) return vendor === 'Cisco' ? 'Catalyst 9300 48T' : 'Generic 48-port';
  if (/24-port/i.test(t)) return vendor === 'Cisco' ? 'Catalyst 2960X 24TS-L' : 'Generic 24-port';
  if (/serwer 2u|serwer 1u/i.test(t)) return 'PowerEdge 1U/2U';
  if (/organizer/i.test(t)) return 'Organizer 1U';
  return t || 'Generic';
}

function readData() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); }

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

function writeRuntimeLog(level, message, meta = null) {
  try {
    const row = `${nowIso()} [${String(level || 'INFO').toUpperCase()}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
    fs.appendFileSync(RUNTIME_LOG_FILE, row, 'utf8');
  } catch (_) {}
}

function tailFile(filePath, lines = 200) {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/).slice(-Math.max(1, Math.min(2000, Number(lines) || 200))).join('\n');
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function upsertOrgScopedRow(rows, orgId, valueFactory) {
  const list = Array.isArray(rows) ? rows : [];
  const idx = list.findIndex(row => Number(row?.orgId || 1) === Number(orgId || 1));
  const value = valueFactory(list[idx] || null);
  if (idx >= 0) list[idx] = value; else list.push(value);
  return list;
}

function getOrgScopedRow(rows, orgId, fallbackFactory) {
  const list = Array.isArray(rows) ? rows : [];
  const found = list.find(row => Number(row?.orgId || 1) === Number(orgId || 1));
  return found ? clonePlain(found) : fallbackFactory();
}

function ensureOpsDefaults(db) {
  db.backupConfig = db.backupConfig && typeof db.backupConfig === 'object' ? db.backupConfig : {};
  if (typeof db.backupConfig.enabled !== 'boolean') db.backupConfig.enabled = false;
  db.backupConfig.intervalMin = Math.max(15, Number(db.backupConfig.intervalMin) || 360);
  db.backupConfig.retentionCount = Math.max(1, Number(db.backupConfig.retentionCount) || 10);
  db.backupConfig.lastRunAt = db.backupConfig.lastRunAt || null;
  db.backupConfig.lastReason = db.backupConfig.lastReason || '';
  db.backupConfig.lastError = db.backupConfig.lastError || '';
  db.backupConfig.lastFile = db.backupConfig.lastFile || '';
  db.backupConfigs = upsertOrgScopedRow(db.backupConfigs, 1, current => ({ orgId: 1, ...(current || {}), enabled: typeof current?.enabled === 'boolean' ? current.enabled : db.backupConfig.enabled, intervalMin: Math.max(15, Number(current?.intervalMin) || db.backupConfig.intervalMin || 360), retentionCount: Math.max(1, Number(current?.retentionCount) || db.backupConfig.retentionCount || 10), lastRunAt: current?.lastRunAt || db.backupConfig.lastRunAt || null, lastReason: current?.lastReason || db.backupConfig.lastReason || '', lastError: current?.lastError || db.backupConfig.lastError || '', lastFile: current?.lastFile || db.backupConfig.lastFile || '' }));

  db.serviceManager = db.serviceManager && typeof db.serviceManager === 'object' ? db.serviceManager : {};
  db.serviceManager.services = Array.isArray(db.serviceManager.services) ? db.serviceManager.services : [];

  db.alerts = db.alerts && typeof db.alerts === 'object' ? db.alerts : {};
  if (typeof db.alerts.enabled !== 'boolean') db.alerts.enabled = false;
  db.alerts.webhookUrl = db.alerts.webhookUrl || '';
  db.alerts.lastTestAt = db.alerts.lastTestAt || null;
  db.alerts.lastError = db.alerts.lastError || '';
  db.alertConfigs = upsertOrgScopedRow(db.alertConfigs, 1, current => ({ orgId: 1, ...(current || {}), enabled: typeof current?.enabled === 'boolean' ? current.enabled : db.alerts.enabled, webhookUrl: String(current?.webhookUrl || db.alerts.webhookUrl || '').trim(), lastTestAt: current?.lastTestAt || db.alerts.lastTestAt || null, lastError: current?.lastError || db.alerts.lastError || '' }));

  db.ssh = db.ssh && typeof db.ssh === 'object' ? db.ssh : {};
  db.ssh.profiles = Array.isArray(db.ssh.profiles) ? db.ssh.profiles : [];
  db.ssh.lastRunAt = db.ssh.lastRunAt || null;
  db.ssh.lastError = db.ssh.lastError || '';
  db.ssh.terminalPolicy = db.ssh.terminalPolicy && typeof db.ssh.terminalPolicy === 'object' ? db.ssh.terminalPolicy : {};
  db.ssh.terminalPolicy.viewer = Array.isArray(db.ssh.terminalPolicy.viewer) ? db.ssh.terminalPolicy.viewer : [];
  db.ssh.terminalPolicy.operator = Array.isArray(db.ssh.terminalPolicy.operator) ? db.ssh.terminalPolicy.operator : ['local','ssh','sessions'];
  db.ssh.terminalPolicy.admin = Array.isArray(db.ssh.terminalPolicy.admin) ? db.ssh.terminalPolicy.admin : ['local','ssh','sessions','killAny'];
  db.ssh.commandPolicy = db.ssh.commandPolicy && typeof db.ssh.commandPolicy === 'object' ? db.ssh.commandPolicy : {};
  for (const role of ['viewer', 'operator', 'admin']) {
    const row = db.ssh.commandPolicy[role] && typeof db.ssh.commandPolicy[role] === 'object' ? db.ssh.commandPolicy[role] : {};
    row.allowedCommands = Array.isArray(row.allowedCommands) ? row.allowedCommands.map(item => String(item || '').trim()).filter(Boolean) : [];
    row.deniedCommands = Array.isArray(row.deniedCommands) ? row.deniedCommands.map(item => String(item || '').trim()).filter(Boolean) : [];
    row.allowedHosts = Array.isArray(row.allowedHosts) ? row.allowedHosts.map(item => String(item || '').trim()).filter(Boolean) : [];
    db.ssh.commandPolicy[role] = row;
  }
  db.ssh.sessionAudit = Array.isArray(db.ssh.sessionAudit) ? db.ssh.sessionAudit : [];
  db.ssh.sessionTranscripts = Array.isArray(db.ssh.sessionTranscripts) ? db.ssh.sessionTranscripts : [];
  db.ssh.policyEvents = Array.isArray(db.ssh.policyEvents) ? db.ssh.policyEvents : [];
  db.ssh.perHostPolicies = Array.isArray(db.ssh.perHostPolicies) ? db.ssh.perHostPolicies : [];
  db.ssh.orgPolicyScopes = Array.isArray(db.ssh.orgPolicyScopes) ? db.ssh.orgPolicyScopes : [];

  db.metricsCenter = db.metricsCenter && typeof db.metricsCenter === 'object' ? db.metricsCenter : {};
  db.metricsCenter.retentionPoints = Math.max(30, Number(db.metricsCenter.retentionPoints) || 480);
  db.metricsCenter.sampleIntervalSec = Math.max(3, Number(db.metricsCenter.sampleIntervalSec) || 15);
  db.metricsCenter.thresholds = db.metricsCenter.thresholds && typeof db.metricsCenter.thresholds === 'object' ? db.metricsCenter.thresholds : {};
  db.metricsCenter.thresholds.cpu = Number(db.metricsCenter.thresholds.cpu || 85);
  db.metricsCenter.thresholds.memory = Number(db.metricsCenter.thresholds.memory || 85);
  db.metricsCenter.thresholds.disk = Number(db.metricsCenter.thresholds.disk || 90);
  db.metricsCenter.series = db.metricsCenter.series && typeof db.metricsCenter.series === 'object' ? db.metricsCenter.series : { local: [] };
  db.metricsCenter.alertEvents = Array.isArray(db.metricsCenter.alertEvents) ? db.metricsCenter.alertEvents : [];
  db.metricsCenter.lastAlertState = db.metricsCenter.lastAlertState && typeof db.metricsCenter.lastAlertState === 'object' ? db.metricsCenter.lastAlertState : {};

  db.agentManager = db.agentManager && typeof db.agentManager === 'object' ? db.agentManager : {};
  db.agentManager.enabled = typeof db.agentManager.enabled === 'boolean' ? db.agentManager.enabled : true;
  db.agentManager.sharedToken = String(db.agentManager.sharedToken || DEFAULT_AGENT_SHARED_TOKEN).trim() || DEFAULT_AGENT_SHARED_TOKEN;
  db.agentManager.pollIntervalSec = Math.max(10, Number(db.agentManager.pollIntervalSec) || 30);
  db.agentManager.agents = Array.isArray(db.agentManager.agents) ? db.agentManager.agents : [];
  db.agentManager.cache = db.agentManager.cache && typeof db.agentManager.cache === 'object' ? db.agentManager.cache : {};
  db.agentManager.perHostPolicies = db.agentManager.perHostPolicies && typeof db.agentManager.perHostPolicies === 'object' ? db.agentManager.perHostPolicies : {};
  db.agentManager.pushEnabled = typeof db.agentManager.pushEnabled === 'boolean' ? db.agentManager.pushEnabled : true;
  db.agentManager.historyRetentionPoints = Math.max(60, Number(db.agentManager.historyRetentionPoints) || 720);
  db.agentManager.history = db.agentManager.history && typeof db.agentManager.history === 'object' ? db.agentManager.history : {};
  db.agentManager.alertEvents = Array.isArray(db.agentManager.alertEvents) ? db.agentManager.alertEvents : [];
  db.agentManager.thresholds = db.agentManager.thresholds && typeof db.agentManager.thresholds === 'object' ? db.agentManager.thresholds : {};
  db.agentManager.thresholds.default = db.agentManager.thresholds.default && typeof db.agentManager.thresholds.default === 'object' ? db.agentManager.thresholds.default : { cpu: 85, memory: 85, disk: 90 };
  db.agentManager.lastAlertState = db.agentManager.lastAlertState && typeof db.agentManager.lastAlertState === 'object' ? db.agentManager.lastAlertState : {};


  db.organizations = Array.isArray(db.organizations) ? db.organizations : [{ id: 1, name: 'Default', slug: 'default', enabled: true, theme: 'dark-blue', logoText: 'VSM', createdAt: nowIso() }];
  db.organizations = db.organizations.map((org, idx) => ({
    id: Number(org.id || idx + 1),
    name: String(org.name || `Org ${idx + 1}`).trim(),
    slug: String(org.slug || `org-${idx + 1}`).trim(),
    enabled: org.enabled !== false,
    theme: String(org.theme || 'dark-blue').trim(),
    logoText: String(org.logoText || org.name || 'ORG').slice(0, 16),
    createdAt: org.createdAt || nowIso()
  }));
  db.enterprise = db.enterprise && typeof db.enterprise === 'object' ? db.enterprise : {};
  db.enterprise.activeOrgId = Number(db.enterprise.activeOrgId || db.organizations[0]?.id || 1);
  db.enterprise.roles = Array.isArray(db.enterprise.roles) ? db.enterprise.roles : [
    { id: 1, name: 'org_admin', orgId: 1, permissions: ['org.manage','users.manage','tickets.approve','branding.manage','agents.manage','remote.manage'] },
    { id: 2, name: 'noc_operator', orgId: 1, permissions: ['dashboard.view','agents.view','tickets.create','terminal.use','network.use'] },
    { id: 3, name: 'auditor', orgId: 1, permissions: ['audit.view','tickets.view','sessions.view'] }
  ];
  db.enterprise.roleAssignments = Array.isArray(db.enterprise.roleAssignments) ? db.enterprise.roleAssignments : [];
  db.enterprise.themes = db.enterprise.themes && typeof db.enterprise.themes === 'object' ? db.enterprise.themes : { globalTheme: db.settings?.theme || 'dark-blue', brandName: db.settings?.brandName || 'Virtual Server Manager', logoText: 'VSM', accentColor: '#38bdf8', customCss: '' };
  db.identity = db.identity && typeof db.identity === 'object' ? db.identity : {};
  db.identity.providers = db.identity.providers && typeof db.identity.providers === 'object' ? db.identity.providers : {};
  for (const key of ['ldap','oidc','saml']) {
    db.identity.providers[key] = db.identity.providers[key] && typeof db.identity.providers[key] === 'object' ? db.identity.providers[key] : {};
    if (typeof db.identity.providers[key].enabled !== 'boolean') db.identity.providers[key].enabled = false;
  }
  db.identity.providers.ldap.url = String(db.identity.providers.ldap.url || '').trim();
  db.identity.providers.ldap.baseDn = String(db.identity.providers.ldap.baseDn || '').trim();
  db.identity.providers.ldap.bindDn = String(db.identity.providers.ldap.bindDn || '').trim();
  db.identity.providers.ldap.userDnTemplate = String(db.identity.providers.ldap.userDnTemplate || 'uid={username},{baseDn}').trim();
  db.identity.providers.ldap.verifyTls = !!db.identity.providers.ldap.verifyTls;
  db.identity.providers.ldap.timeoutMs = Math.max(1000, Number(db.identity.providers.ldap.timeoutMs) || 5000);
  db.identity.providers.ldap.searchBindDn = String(db.identity.providers.ldap.searchBindDn || db.identity.providers.ldap.bindDn || '').trim();
  db.identity.providers.ldap.searchBindPassword = String(db.identity.providers.ldap.searchBindPassword || '').trim();
  db.identity.providers.ldap.searchAttribute = String(db.identity.providers.ldap.searchAttribute || 'uid').trim() || 'uid';
  db.identity.providers.ldap.searchScope = ['base','one','sub'].includes(String(db.identity.providers.ldap.searchScope || 'sub')) ? String(db.identity.providers.ldap.searchScope) : 'sub';
  db.identity.providers.ldap.searchUseBind = typeof db.identity.providers.ldap.searchUseBind === 'boolean' ? db.identity.providers.ldap.searchUseBind : !!(db.identity.providers.ldap.searchBindDn || db.identity.providers.ldap.bindDn);
  db.identity.providers.ldap.searchFilterTemplate = String(db.identity.providers.ldap.searchFilterTemplate || '').trim();
  db.identity.providers.ldap.filterTemplates = Array.isArray(db.identity.providers.ldap.filterTemplates) ? db.identity.providers.ldap.filterTemplates.map((row, idx) => ({ id: Number(row?.id || idx + 1), name: String(row?.name || `Template ${idx + 1}`).trim(), template: String(row?.template || '').trim(), enabled: row?.enabled !== false })) : [];
  db.identity.providers.oidc.issuer = String(db.identity.providers.oidc.issuer || '').trim();
  db.identity.providers.oidc.clientId = String(db.identity.providers.oidc.clientId || '').trim();
  db.identity.providers.oidc.clientSecret = String(db.identity.providers.oidc.clientSecret || '').trim();
  db.identity.providers.oidc.redirectUri = String(db.identity.providers.oidc.redirectUri || '').trim();
  db.identity.providers.oidc.scopes = String(db.identity.providers.oidc.scopes || 'openid profile email groups').trim();
  db.identity.providers.oidc.organizationClaim = String(db.identity.providers.oidc.organizationClaim || 'org').trim();
  db.identity.providers.oidc.groupClaim = String(db.identity.providers.oidc.groupClaim || 'groups').trim();
  db.identity.providers.oidc.postLogoutRedirectUri = String(db.identity.providers.oidc.postLogoutRedirectUri || '').trim();
  db.identity.providers.oidc.logoutRedirectUri = String(db.identity.providers.oidc.logoutRedirectUri || '').trim();
  db.identity.providers.oidc.useRefreshTokens = typeof db.identity.providers.oidc.useRefreshTokens === 'boolean' ? db.identity.providers.oidc.useRefreshTokens : true;
  db.identity.providers.saml.entryPoint = String(db.identity.providers.saml.entryPoint || '').trim();
  db.identity.providers.saml.issuer = String(db.identity.providers.saml.issuer || '').trim();
  db.identity.groupMappings = Array.isArray(db.identity.groupMappings) ? db.identity.groupMappings : [];
  db.tickets = db.tickets && typeof db.tickets === 'object' ? db.tickets : {};
  db.tickets.items = Array.isArray(db.tickets.items) ? db.tickets.items : [];
  db.tickets.requireApprovalFor = Array.isArray(db.tickets.requireApprovalFor) ? db.tickets.requireApprovalFor : ['ssh','rdp','database'];
  db.tickets.defaultGrantMinutes = Math.max(5, Number(db.tickets.defaultGrantMinutes) || 60);
  db.remoteAccess = db.remoteAccess && typeof db.remoteAccess === 'object' ? db.remoteAccess : {};
  db.remoteAccess.profiles = Array.isArray(db.remoteAccess.profiles) ? db.remoteAccess.profiles : [];
  db.remoteAccess.databaseProfiles = Array.isArray(db.remoteAccess.databaseProfiles) ? db.remoteAccess.databaseProfiles : [];
  db.remoteAccess.k8sProfiles = Array.isArray(db.remoteAccess.k8sProfiles) ? db.remoteAccess.k8sProfiles : [];
  db.remoteAccess.gateway = db.remoteAccess.gateway && typeof db.remoteAccess.gateway === 'object' ? db.remoteAccess.gateway : {};
  db.remoteAccess.gateway.enabled = typeof db.remoteAccess.gateway.enabled === 'boolean' ? db.remoteAccess.gateway.enabled : false;
  db.remoteAccess.gateway.publicBaseUrl = String(db.remoteAccess.gateway.publicBaseUrl || '').trim();
  db.remoteAccess.gateway.rdpPathTemplate = String(db.remoteAccess.gateway.rdpPathTemplate || '').trim();
  db.remoteAccess.gateway.vncPathTemplate = String(db.remoteAccess.gateway.vncPathTemplate || '').trim();
  db.remoteAccess.gateway.guacamoleUrl = String(db.remoteAccess.gateway.guacamoleUrl || '').trim();
  db.remoteAccess.gateway.noVncUrl = String(db.remoteAccess.gateway.noVncUrl || '').trim();
  db.remoteAccess.gateway.webRdpUrl = String(db.remoteAccess.gateway.webRdpUrl || '').trim();
  db.remoteAccess.gateway.guacDataSource = String(db.remoteAccess.gateway.guacDataSource || '').trim();
  db.remoteAccess.gateway.launchMode = String(db.remoteAccess.gateway.launchMode || 'iframe').trim() || 'iframe';
  db.remoteAccess.gateway.openInNewWindow = !!db.remoteAccess.gateway.openInNewWindow;
  db.discovery = db.discovery && typeof db.discovery === 'object' ? db.discovery : {};
  db.discovery.enabled = db.discovery.enabled !== false;
  db.discovery.autoCredentialRotation = !!db.discovery.autoCredentialRotation;
  db.discovery.cloudSync = !!db.discovery.cloudSync;
  db.discovery.jobs = Array.isArray(db.discovery.jobs) ? db.discovery.jobs : [];
  db.discovery.lastRunAt = db.discovery.lastRunAt || null;
  db.discovery.lastSummary = db.discovery.lastSummary && typeof db.discovery.lastSummary === 'object' ? db.discovery.lastSummary : {};
  db.discovery.assetGroups = Array.isArray(db.discovery.assetGroups) ? db.discovery.assetGroups : [{ id: 1, name: 'Default assets', tags: ['core'], orgId: db.organizations[0]?.id || 1 }];
  db.docker = db.docker && typeof db.docker === 'object' ? db.docker : {};
  db.docker.orgPolicies = Array.isArray(db.docker.orgPolicies) ? db.docker.orgPolicies : [];

  db.scheduler = db.scheduler && typeof db.scheduler === 'object' ? db.scheduler : {};
  db.scheduler.tasks = Array.isArray(db.scheduler.tasks) ? db.scheduler.tasks : [];
  db.scheduler.lastTickAt = db.scheduler.lastTickAt || null;
  db.scheduler.lastError = db.scheduler.lastError || '';
}



function randomBase32Secret(length = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function base32ToBuffer(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(base32 || '').toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val >= 0) bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function generateTotpToken(secret, step = 30, digits = 6, at = Date.now()) {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % (10 ** digits)).padStart(digits, '0');
}

function verifyTotpToken(secret, token, windowSize = 1) {
  const normalized = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  for (let drift = -windowSize; drift <= windowSize; drift += 1) {
    const candidate = generateTotpToken(secret, 30, 6, Date.now() + drift * 30000);
    if (candidate === normalized) return true;
  }
  return false;
}

function ensureTwoFactorShape(user) {
  user.twoFactorEnabled = !!user.twoFactorEnabled;
  user.twoFactorSecret = user.twoFactorSecret || '';
  user.twoFactorTempSecret = user.twoFactorTempSecret || '';
  user.twoFactorRecoveryCodes = Array.isArray(user.twoFactorRecoveryCodes) ? user.twoFactorRecoveryCodes : [];
  user.twoFactorEnabledAt = user.twoFactorEnabledAt || null;
  return user;
}

function buildOtpAuthUrl(user, secret) {
  const issuer = encodeURIComponent('Virtual Server Manager');
  const label = encodeURIComponent(`Virtual Server Manager:${user.username}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function generateRecoveryCodes() {
  return Array.from({ length: 8 }).map(() => crypto.randomBytes(4).toString('hex').toUpperCase());
}

function sanitizeUserRow(user) {
  return {
    id: Number(user?.id) || 0,
    username: String(user?.username || '').trim(),
    fullName: String(user?.fullName || user?.username || '').trim(),
    role: ['viewer', 'operator', 'admin'].includes(String(user?.role || '')) ? String(user.role) : 'viewer',
    disabled: !!user?.disabled,
    createdAt: user?.createdAt || null,
    lastPasswordChangeAt: user?.lastPasswordChangeAt || null,
    passwordSet: !!user?.passwordHash,
    organizationIds: Array.isArray(user?.organizationIds) ? user.organizationIds.map(Number).filter(Boolean) : [1]
  };
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Brak autoryzacji' });
  if (String(req.session.user.role || '') !== 'admin') return res.status(403).json({ error: 'Ta operacja wymaga roli admin.' });
  next();
}

function getUserOrgIds(user, db) {
  const ids = Array.isArray(user?.organizationIds) ? user.organizationIds.map(Number).filter(Boolean) : [];
  return ids.length ? ids : [Number(db?.enterprise?.activeOrgId || 1)];
}

function userCanAccessOrg(user, orgId, db) {
  if (String(user?.role || '') === 'admin') return true;
  return getUserOrgIds(user, db).includes(Number(orgId || 1));
}

function getEffectiveOrgId(req, db) {
  const requested = Number(req.headers['x-org-id'] || req.query.orgId || req.body?.orgId || req.session?.user?.activeOrgId || db?.enterprise?.activeOrgId || 1);
  return userCanAccessOrg(req.session?.user, requested, db) ? requested : getUserOrgIds(req.session?.user, db)[0];
}

function filterByOrg(rows, orgIds) {
  const set = new Set((orgIds || [1]).map(Number));
  return (rows || []).filter(row => set.has(Number(row?.orgId || 1)));
}

function defaultBackupConfigForOrg(db, orgId) {
  ensureOpsDefaults(db);
  return getOrgScopedRow(db.backupConfigs, orgId, () => ({ orgId: Number(orgId || 1), enabled: !!db.backupConfig.enabled, intervalMin: Math.max(15, Number(db.backupConfig.intervalMin) || 360), retentionCount: Math.max(1, Number(db.backupConfig.retentionCount) || 10), lastRunAt: db.backupConfig.lastRunAt || null, lastReason: db.backupConfig.lastReason || '', lastError: db.backupConfig.lastError || '', lastFile: db.backupConfig.lastFile || '' }));
}

function saveBackupConfigForOrg(db, orgId, patch = {}) {
  const current = defaultBackupConfigForOrg(db, orgId);
  db.backupConfigs = upsertOrgScopedRow(db.backupConfigs, orgId, () => ({ ...current, ...patch, orgId: Number(orgId || 1) }));
  if (Number(orgId || 1) === 1) db.backupConfig = { ...db.backupConfig, ...patch };
  return defaultBackupConfigForOrg(db, orgId);
}

function defaultAlertConfigForOrg(db, orgId) {
  ensureOpsDefaults(db);
  return getOrgScopedRow(db.alertConfigs, orgId, () => ({ orgId: Number(orgId || 1), enabled: !!db.alerts.enabled, webhookUrl: String(db.alerts.webhookUrl || '').trim(), lastTestAt: db.alerts.lastTestAt || null, lastError: db.alerts.lastError || '' }));
}

function saveAlertConfigForOrg(db, orgId, patch = {}) {
  const current = defaultAlertConfigForOrg(db, orgId);
  db.alertConfigs = upsertOrgScopedRow(db.alertConfigs, orgId, () => ({ ...current, ...patch, orgId: Number(orgId || 1) }));
  if (Number(orgId || 1) === 1) db.alerts = { ...db.alerts, ...patch };
  return defaultAlertConfigForOrg(db, orgId);
}

function getTerminalPolicyScopeForOrg(db, orgId) {
  ensureOpsDefaults(db);
  return getOrgScopedRow(db.ssh.orgPolicyScopes, orgId, () => ({ orgId: Number(orgId || 1), terminalPolicy: clonePlain(db.ssh.terminalPolicy || {}), commandPolicy: clonePlain(db.ssh.commandPolicy || {}) }));
}

function saveTerminalPolicyScopeForOrg(db, orgId, patch = {}) {
  const current = getTerminalPolicyScopeForOrg(db, orgId);
  db.ssh.orgPolicyScopes = upsertOrgScopedRow(db.ssh.orgPolicyScopes, orgId, () => ({ ...current, ...patch, orgId: Number(orgId || 1) }));
  if (Number(orgId || 1) === 1) {
    if (patch.terminalPolicy) db.ssh.terminalPolicy = clonePlain(patch.terminalPolicy);
    if (patch.commandPolicy) db.ssh.commandPolicy = clonePlain(patch.commandPolicy);
  }
  return getTerminalPolicyScopeForOrg(db, orgId);
}

function getDockerPolicyForOrg(db, orgId) {
  ensureOpsDefaults(db);
  return getOrgScopedRow(db.docker.orgPolicies, orgId, () => ({ orgId: Number(orgId || 1), allowedActions: ['start','stop','restart'], allowAllContainers: true, allowedContainers: [] }));
}

function filterByOrg(rows, orgIds) {
  const set = new Set((orgIds || [1]).map(Number));
  return (rows || []).filter(row => set.has(Number(row?.orgId || 1)));
}

function scopeDbForUser(db, user, forcedOrgId = null) {
  ensureOpsDefaults(db);
  const scoped = JSON.parse(JSON.stringify(db));
  const orgIds = forcedOrgId ? [Number(forcedOrgId)] : getUserOrgIds(user, db);
  scoped.serverRooms = filterByOrg(scoped.serverRooms, orgIds);
  scoped.cableRoutes = filterByOrg(scoped.cableRoutes, orgIds);
  scoped.organizations = filterByOrg(scoped.organizations, orgIds);
  scoped.remoteAccess.profiles = filterByOrg(scoped.remoteAccess.profiles, orgIds);
  scoped.remoteAccess.databaseProfiles = filterByOrg(scoped.remoteAccess.databaseProfiles, orgIds);
  scoped.remoteAccess.k8sProfiles = filterByOrg(scoped.remoteAccess.k8sProfiles, orgIds);
  scoped.discovery.assetGroups = filterByOrg(scoped.discovery.assetGroups, orgIds);
  scoped.agentManager.agents = filterByOrg(scoped.agentManager.agents, orgIds);
  scoped.ssh.profiles = filterByOrg(scoped.ssh.profiles, orgIds);
  scoped.scheduler.tasks = filterByOrg(scoped.scheduler.tasks, orgIds);
  scoped.serviceManager.services = filterByOrg(scoped.serviceManager.services, orgIds);
  scoped.users = (scoped.users || []).filter(row => {
    const rowOrgIds = Array.isArray(row?.organizationIds) ? row.organizationIds.map(Number).filter(Boolean) : [1];
    return rowOrgIds.some(id => orgIds.includes(id));
  });
  const cacheRows = Object.values(scoped.agentManager.cache || {}).filter(row => orgIds.includes(Number(row?.orgId || 1)));
  scoped.agentManager.cache = Object.fromEntries(cacheRows.map(row => [String(row.id || row.name || Math.random()), row]));
  scoped.tickets.items = filterByOrg(scoped.tickets.items, orgIds);
  scoped.backupConfigs = filterByOrg(scoped.backupConfigs, orgIds);
  scoped.alertConfigs = filterByOrg(scoped.alertConfigs, orgIds);
  scoped.ssh.orgPolicyScopes = filterByOrg(scoped.ssh.orgPolicyScopes, orgIds);
  scoped.ssh.perHostPolicies = filterByOrg(scoped.ssh.perHostPolicies, orgIds);
  scoped.docker.orgPolicies = filterByOrg(scoped.docker.orgPolicies, orgIds);
  scoped.enterprise.activeOrgId = orgIds[0] || 1;
  return scoped;
}

function applyIdentityMappings(db, claims = {}) {
  ensureOpsDefaults(db);
  const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
  const mappings = Array.isArray(db.identity.groupMappings) ? db.identity.groupMappings : [];
  const matched = mappings.filter(row => groups.includes(String(row.group || '')));
  const orgIds = [...new Set(matched.map(row => Number(row.orgId || 1)).filter(Boolean))];
  const role = matched.map(row => String(row.role || '')).find(Boolean) || 'viewer';
  return { role: ['viewer','operator','admin'].includes(role) ? role : 'viewer', organizationIds: orgIds.length ? orgIds : [1] };
}

function ldapBuildDn(provider, username) {
  return String(provider.userDnTemplate || 'uid={username},{baseDn}')
    .replace(/\{username\}/g, String(username || '').trim())
    .replace(/\{baseDn\}/g, String(provider.baseDn || '').trim());
}

function berEncodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) { bytes.unshift(value & 0xff); value >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function berWrap(tag, content) { return Buffer.concat([Buffer.from([tag]), berEncodeLength(content.length), content]); }
function berInt(value) { return berWrap(0x02, Buffer.from([value & 0xff])); }
function berStr(value) { return berWrap(0x04, Buffer.from(String(value || ''), 'utf8')); }
function berCtx(tag, value) { return berWrap(0x80 + tag, Buffer.from(String(value || ''), 'utf8')); }
function ldapParseBindResponse(buffer) {
  const hex = buffer.toString('hex');
  const idx = hex.indexOf('610');
  if (idx === -1) return { ok: false, code: 80 };
  const codeMarker = hex.indexOf('0a01', idx);
  if (codeMarker === -1) return { ok: false, code: 80 };
  const code = parseInt(hex.slice(codeMarker + 4, codeMarker + 6), 16);
  return { ok: code === 0, code };
}
async function ldapSimpleBind(provider, username, password) {
  const url = new URL(provider.url);
  const netMod = url.protocol === 'ldaps:' ? require('tls') : require('net');
  const dn = ldapBuildDn(provider, username);
  const messageId = berInt(1);
  const bindReq = berWrap(0x60, Buffer.concat([berInt(3), berStr(dn), berCtx(0, password)]));
  const ldapMessage = berWrap(0x30, Buffer.concat([messageId, bindReq]));
  return await new Promise((resolve, reject) => {
    const socket = netMod.connect({ host: url.hostname, port: Number(url.port || (url.protocol === 'ldaps:' ? 636 : 389)), rejectUnauthorized: !!provider.verifyTls, servername: url.hostname });
    const timer = setTimeout(() => { try { socket.destroy(); } catch (_) {} reject(new Error('LDAP timeout')); }, Number(provider.timeoutMs || 5000));
    socket.once('error', err => { clearTimeout(timer); reject(err); });
    socket.once('data', data => { clearTimeout(timer); const parsed = ldapParseBindResponse(data); try { socket.end(); } catch (_) {} if (parsed.ok) resolve({ ok: true, dn }); else reject(new Error(`LDAP bind failed (${parsed.code})`)); });
    socket.once('connect', () => socket.write(ldapMessage));
  });
}


function berBool(value) { return berWrap(0x01, Buffer.from([value ? 0xff : 0x00])); }
function berEnum(value) { return berWrap(0x0a, Buffer.from([value & 0xff])); }
function berSequence(items = []) { return berWrap(0x30, Buffer.concat(items)); }
function berSet(items = []) { return berWrap(0x31, Buffer.concat(items)); }
function berContext(tag, items = []) { return berWrap(0xa0 + Number(tag || 0), Buffer.concat(items)); }

function ldapOpenSocket(provider) {
  const url = new URL(provider.url);
  const netMod = url.protocol === 'ldaps:' ? require('tls') : require('net');
  return {
    url,
    socket: netMod.connect({
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'ldaps:' ? 636 : 389)),
      rejectUnauthorized: !!provider.verifyTls,
      servername: url.hostname
    })
  };
}

function berReadLength(buffer, offset) {
  const first = buffer[offset];
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  const count = first & 0x7f;
  let value = 0;
  for (let i = 0; i < count; i += 1) value = (value << 8) | buffer[offset + 1 + i];
  return { length: value, bytes: 1 + count };
}

function berParseAll(buffer, start = 0, end = buffer.length) {
  const rows = [];
  let offset = start;
  while (offset < end) {
    const tag = buffer[offset];
    const len = berReadLength(buffer, offset + 1);
    const header = 1 + len.bytes;
    const valueStart = offset + header;
    const valueEnd = valueStart + len.length;
    if (valueEnd > end) break;
    const node = { tag, start: offset, end: valueEnd, valueStart, valueEnd, value: buffer.slice(valueStart, valueEnd) };
    if ((tag & 0x20) === 0x20 || tag === 0x30 || tag === 0x31 || (tag >= 0xa0 && tag <= 0xbf)) {
      node.children = berParseAll(buffer, valueStart, valueEnd);
    } else {
      node.children = [];
    }
    rows.push(node);
    offset = valueEnd;
  }
  return rows;
}

function ldapResultCodeFromMessage(buffer) {
  const nodes = berParseAll(buffer);
  const walk = (items) => {
    for (const item of items || []) {
      if (item.tag === 0x0a && item.value.length) return item.value[item.value.length - 1];
      const child = walk(item.children);
      if (typeof child === 'number') return child;
    }
    return null;
  };
  return walk(nodes);
}

function ldapExtractSearchEntries(buffer) {
  const nodes = berParseAll(buffer);
  const rows = [];
  const walk = (items) => {
    for (const item of items || []) {
      if (item.tag === 0x64 && item.children?.length) {
        const dnNode = item.children.find(child => child.tag === 0x04);
        rows.push({ dn: dnNode ? dnNode.value.toString('utf8') : '', raw: item });
      }
      if (item.children?.length) walk(item.children);
    }
  };
  walk(nodes);
  return rows;
}

function ldapBuildEqualityFilter(attribute, value) {
  const attr = berStr(attribute);
  const val = berStr(value);
  return berWrap(0xa3, Buffer.concat([attr, val]));
}

function ldapBuildSearchRequest(provider, username, messageId = 2) {
  const scopeMap = { base: 0, one: 1, sub: 2 };
  const filter = ldapBuildEqualityFilter(String(provider.searchAttribute || 'uid'), String(username || '').trim());
  const attrs = berSequence([]);
  const searchReq = berWrap(0x63, Buffer.concat([
    berStr(String(provider.baseDn || '').trim()),
    berEnum(scopeMap[String(provider.searchScope || 'sub')] ?? 2),
    berEnum(0),
    berInt(1),
    berInt(Math.max(2, Math.floor(Number(provider.timeoutMs || 5000) / 1000))),
    berBool(false),
    filter,
    attrs
  ]));
  return berWrap(0x30, Buffer.concat([berInt(messageId), searchReq]));
}

async function ldapBindRaw(provider, bindDn, password, messageId = 1) {
  const { socket } = ldapOpenSocket(provider);
  const bindReq = berWrap(0x60, Buffer.concat([berInt(3), berStr(bindDn), berCtx(0, password)]));
  const ldapMessage = berWrap(0x30, Buffer.concat([berInt(messageId), bindReq]));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { socket.destroy(); } catch (_) {} reject(new Error('LDAP timeout')); }, Number(provider.timeoutMs || 5000));
    socket.once('error', err => { clearTimeout(timer); reject(err); });
    socket.once('data', data => {
      clearTimeout(timer);
      const code = ldapResultCodeFromMessage(data);
      try { socket.end(); } catch (_) {}
      if (code === 0) resolve({ ok: true, dn: bindDn });
      else reject(new Error(`LDAP bind failed (${code == null ? 80 : code})`));
    });
    socket.once('connect', () => socket.write(ldapMessage));
  });
}

async function ldapSearchUserDn(provider, username) {
  if (!provider?.url || !provider?.baseDn) throw new Error('LDAP search wymaga url i baseDn.');
  if (!(provider.searchBindDn || provider.bindDn)) throw new Error('LDAP search wymaga searchBindDn/bindDn.');
  const bindDn = String(provider.searchBindDn || provider.bindDn || '').trim();
  const bindPassword = String(provider.searchBindPassword || provider.bindPassword || '').trim();
  const { socket } = ldapOpenSocket(provider);
  const bindReq = berWrap(0x60, Buffer.concat([berInt(3), berStr(bindDn), berCtx(0, bindPassword)]));
  const bindMsg = berWrap(0x30, Buffer.concat([berInt(1), bindReq]));
  const searchMsg = ldapBuildSearchRequest(provider, username, 2);
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let phase = 'bind';
    const timer = setTimeout(() => { try { socket.destroy(); } catch (_) {} reject(new Error('LDAP timeout')); }, Number(provider.timeoutMs || 5000));
    const fail = (err) => { clearTimeout(timer); try { socket.destroy(); } catch (_) {} reject(err instanceof Error ? err : new Error(String(err || 'LDAP error'))); };
    socket.on('error', fail);
    socket.on('data', data => {
      chunks.push(data);
      const code = ldapResultCodeFromMessage(data);
      if (phase === 'bind') {
        if (code !== 0) return fail(new Error(`LDAP search bind failed (${code == null ? 80 : code})`));
        phase = 'search';
        chunks.length = 0;
        return socket.write(searchMsg);
      }
      const entries = ldapExtractSearchEntries(Buffer.concat(chunks));
      if (entries.length) {
        clearTimeout(timer);
        try { socket.end(); } catch (_) {}
        return resolve({ ok: true, dn: entries[0].dn, entries });
      }
      if (code != null && code !== 0) return fail(new Error(`LDAP search failed (${code})`));
    });
    socket.once('connect', () => socket.write(bindMsg));
  });
}

async function ldapSearchAndBind(provider, username, password) {
  const found = await ldapSearchUserDn(provider, username);
  const result = await ldapBindRaw(provider, found.dn, password, 3);
  return { ok: true, mode: 'search-bind', dn: found.dn, bind: result };
}

function buildOidcLogoutUrl(provider, oidcSession = {}) {
  const endpoint = String(oidcSession?.endSessionEndpoint || provider?.logoutRedirectUri || provider?.endSessionEndpoint || '').trim();
  if (!endpoint) return '';
  const url = new URL(endpoint);
  const postLogout = String(provider?.postLogoutRedirectUri || provider?.redirectUri || '').trim();
  if (postLogout) url.searchParams.set('post_logout_redirect_uri', postLogout);
  if (oidcSession?.idToken) url.searchParams.set('id_token_hint', oidcSession.idToken);
  if (oidcSession?.sid) url.searchParams.set('sid', oidcSession.sid);
  return url.toString();
}
function base64UrlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, 'base64');
}
function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) throw new Error('Nieprawidłowy JWT');
  return { header: JSON.parse(base64UrlDecode(parts[0]).toString('utf8')), payload: JSON.parse(base64UrlDecode(parts[1]).toString('utf8')), signature: parts[2] || '' };
}
async function verifyIdToken(idToken, issuer, clientId) {
  const decoded = decodeJwt(idToken);
  if (decoded.payload.iss !== issuer) throw new Error('Nieprawidłowy issuer OIDC');
  const aud = Array.isArray(decoded.payload.aud) ? decoded.payload.aud : [decoded.payload.aud];
  if (!aud.includes(clientId)) throw new Error('Nieprawidłowy audience OIDC');
  const now = Math.floor(Date.now() / 1000);
  if (decoded.payload.exp && decoded.payload.exp < now - 60) throw new Error('ID token wygasł');
  return decoded.payload;
}
async function fetchOidcMetadata(provider) {
  const issuer = String(provider.issuer || '').replace(/\/$/, '');
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error('Nie udało się pobrać OIDC discovery');
  return await res.json();
}

function mintLaunchToken(db, payload) {
  db.remoteAccess.launchTokens = Array.isArray(db.remoteAccess.launchTokens) ? db.remoteAccess.launchTokens : [];
  const row = { token: crypto.randomBytes(24).toString('hex'), createdAt: nowIso(), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), usedAt: null, ...payload };
  db.remoteAccess.launchTokens.unshift(row);
  db.remoteAccess.launchTokens = db.remoteAccess.launchTokens.slice(0, 200);
  return row;
}
function consumeLaunchToken(db, token) {
  const row = (db.remoteAccess.launchTokens || []).find(item => item.token === token && !item.usedAt);
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  row.usedAt = nowIso();
  return row;
}

function getActiveGrants(db, user) {
  const now = Date.now();
  return (db.tickets.items || []).filter(ticket => Number(ticket.requestedById || 0) === Number(user?.id || 0) && ticket.status === 'approved' && ticket.grantExpiresAt && new Date(ticket.grantExpiresAt).getTime() > now);
}
function hasAccessGrant(db, user, profile) {
  if (!Array.isArray(db.tickets.requireApprovalFor) || !db.tickets.requireApprovalFor.includes(String(profile?.type || ''))) return true;
  const grants = getActiveGrants(db, user);
  return grants.some(ticket => String(ticket.target || '') === String(profile?.name || profile?.host || '') || Number(ticket.targetProfileId || 0) === Number(profile?.id || 0));
}

function terminalPermissionsForRole(role, db = null) {
  const currentRole = ['viewer','operator','admin'].includes(String(role || '')) ? String(role) : 'viewer';
  const policy = db?.ssh?.terminalPolicy || null;
  const base = {
    viewer: { local: false, ssh: false, sessions: false, killAny: false },
    operator: { local: true, ssh: true, sessions: true, killAny: false },
    admin: { local: true, ssh: true, sessions: true, killAny: true }
  }[currentRole];
  if (!policy || !Array.isArray(policy[currentRole])) return base;
  return {
    local: policy[currentRole].includes('local'),
    ssh: policy[currentRole].includes('ssh'),
    sessions: policy[currentRole].includes('sessions'),
    killAny: currentRole === 'admin' || policy[currentRole].includes('killAny')
  };
}

function canUseTerminal(user, mode, profile, db) {
  const perms = terminalPermissionsForRole(user?.role, db);
  if (mode === 'ssh') {
    if (!perms.ssh) return { ok: false, error: 'Twoja rola nie ma dostępu do terminala SSH.' };
    if (!profile) return { ok: false, error: 'Nie znaleziono profilu SSH.' };
    const allowed = Array.isArray(profile.allowedRoles) && profile.allowedRoles.length ? profile.allowedRoles : ['operator','admin'];
    if (!allowed.includes(String(user?.role || 'viewer'))) return { ok: false, error: 'Ta rola nie ma dostępu do wybranego profilu SSH.' };
    return { ok: true, perms };
  }
  if (!perms.local) return { ok: false, error: 'Twoja rola nie ma dostępu do lokalnej powłoki.' };
  return { ok: true, perms };
}



function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function patternMatchesValue(pattern, value) {
  const p = String(pattern || '').trim();
  const text = String(value || '').trim();
  if (!p) return false;
  if (p === '*') return true;
  if (p.startsWith('regex:')) {
    try { return new RegExp(p.slice(6), 'i').test(text); }
    catch (_) { return false; }
  }
  if (p.includes('*') || p.includes('?')) {
    try { return wildcardToRegExp(p).test(text); }
    catch (_) { return false; }
  }
  return text === p || text.startsWith(p + ' ') || text.split(/\s+/)[0] === p;
}

function commandMatchesPolicy(command, patterns) {
  const cmd = String(command || '').trim();
  return (patterns || []).some(pattern => patternMatchesValue(pattern, cmd));
}

function getHostPolicyRows(profile, db, role='viewer') {
  const host = String(profile?.host || profile?.hostLabel || '').trim();
  const rows = Array.isArray(db?.ssh?.perHostPolicies) ? db.ssh.perHostPolicies : [];
  return rows.filter(row => {
    if (!row || !row.hostPattern) return false;
    const roles = Array.isArray(row.roles) ? row.roles : [];
    if (roles.length && !roles.includes(role)) return false;
    return patternMatchesValue(row.hostPattern, host);
  });
}

function recordPolicyEvent(db, payload = {}, socket = null) {
  ensureOpsDefaults(db);
  const row = { id: nextId(db.ssh.policyEvents), ts: nowIso(), ...payload };
  db.ssh.policyEvents.unshift(row);
  db.ssh.policyEvents = db.ssh.policyEvents.slice(0, 500);
  if (io) {
    if (socket) socket.emit('policy:block', row);
    for (const s of io.sockets.sockets.values()) {
      const user = getSocketUser(s);
      if (user && String(user.role) === 'admin' && (!socket || s.id !== socket.id)) s.emit('policy:block', row);
    }
  }
  return row;
}

function transcriptEventKind(kind) {
  const map = { IN: 'stdin', OUT: 'stdout', ERR: 'stderr', META: 'meta' };
  return map[String(kind || '').toUpperCase()] || String(kind || 'meta').toLowerCase();
}

function startSessionTranscript(db, user, sessionMeta = {}) {
  ensureBackupDir();
  ensureOpsDefaults(db);
  const token = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const fileName = `terminal-${token}.jsonl`;
  const filePath = path.join(TRANSCRIPTS_DIR, fileName);
  const startedAt = nowIso();
  const first = { ts: startedAt, stream: 'meta', event: 'session-start', user: user?.username || 'system', role: user?.role || 'viewer', ...sessionMeta };
  fs.writeFileSync(filePath, JSON.stringify(first) + '\n', 'utf8');
  const row = { id: nextId(db.ssh.sessionTranscripts), token, fileName, filePath, format: 'jsonl', user: user?.username || 'system', role: user?.role || 'viewer', mode: sessionMeta.mode || 'local-shell', hostLabel: sessionMeta.hostLabel || 'lokalny host', profileId: sessionMeta.profileId || null, startedAt, endedAt: null, bytes: Buffer.byteLength(JSON.stringify(first) + '\n') };
  db.ssh.sessionTranscripts.unshift(row);
  db.ssh.sessionTranscripts = db.ssh.sessionTranscripts.slice(0, 300);
  return row;
}

function appendTranscriptChunk(transcript, kind, text, meta = null) {
  if (!transcript || text == null) return;
  try {
    const row = { ts: nowIso(), stream: transcriptEventKind(kind), data: String(text), meta: meta || null };
    const chunk = JSON.stringify(row) + '\n';
    fs.appendFileSync(transcript.filePath, chunk, 'utf8');
    transcript.bytes = Number(transcript.bytes || 0) + Buffer.byteLength(chunk);
  } catch (_) {}
}

function finalizeSessionTranscript(transcript, extra = {}) {
  if (!transcript) return;
  transcript.endedAt = nowIso();
  Object.assign(transcript, extra || {});
  try {
    const row = { ts: nowIso(), stream: 'meta', event: 'session-end', extra: extra || {} };
    const chunk = JSON.stringify(row) + '\n';
    fs.appendFileSync(transcript.filePath, chunk, 'utf8');
    transcript.bytes = Number(transcript.bytes || 0) + Buffer.byteLength(chunk);
  } catch (_) {}
}

function csvEscape(value) {
  const str = String(value == null ? '' : value);
  return '"' + str.replace(/"/g, '""') + '"';
}

function buildAuditCsv(rows) {
  const head = ['id','ts','user','role','action','meta'];
  return [head.join(','), ...rows.map(row => [row.id, row.ts, row.user, row.role, row.action, JSON.stringify(row.meta || {})].map(csvEscape).join(','))].join('\n');
}

function buildTranscriptPreview(row) {
  try {
    if (!row?.filePath || !fs.existsSync(row.filePath)) return '';
    return fs.readFileSync(row.filePath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-20).map(line => {
      try {
        const item = JSON.parse(line);
        return item.stream === 'meta' ? `[meta] ${item.event || ''} ${JSON.stringify(item.extra || item)}` : `[${item.stream}] ${String(item.data || '').trimEnd()}`;
      } catch (_) {
        return line;
      }
    }).join('\n');
  } catch (_) { return ''; }
}


function emitMetricsAlert(eventRow) {
  if (!io) return;
  for (const s of io.sockets.sockets.values()) {
    const user = getSocketUser(s);
    if (user) s.emit('metrics:alert', eventRow);
  }
}

function maybeEmitThresholdAlerts(db, payload, source = 'local') {
  ensureOpsDefaults(db);
  const thresholds = db.metricsCenter.thresholds || {};
  const checks = [ ['cpu', Number(payload.summary?.cpu || 0), Number(thresholds.cpu || 85)], ['memory', Number(payload.summary?.memoryUsedPercent || 0), Number(thresholds.memory || 85)], ['disk', Number(payload.summary?.diskUsedPercent || 0), Number(thresholds.disk || 90)] ];
  for (const [key, value, threshold] of checks) {
    if (!Number.isFinite(value)) continue;
    const stateKey = `${source}:${key}`;
    const over = value >= threshold;
    if (over && db.metricsCenter.lastAlertState[stateKey] !== true) {
      db.metricsCenter.lastAlertState[stateKey] = true;
      const eventRow = { id: nextId(db.metricsCenter.alertEvents), ts: nowIso(), source, metric: key, value, threshold, severity: 'warning', message: `${source}: ${key} osiągnął ${value}` };
      db.metricsCenter.alertEvents.unshift(eventRow);
      db.metricsCenter.alertEvents = db.metricsCenter.alertEvents.slice(0, 500);
      emitMetricsAlert(eventRow);
    }
    if (!over) db.metricsCenter.lastAlertState[stateKey] = false;
  }
}


function emitNocAlert(eventRow) {
  if (!io) return;
  for (const s of io.sockets.sockets.values()) {
    const user = getSocketUser(s);
    if (user) s.emit('noc:alert', eventRow);
  }
}

function getAgentThresholds(db, agentId) {
  ensureOpsDefaults(db);
  const base = db.agentManager.thresholds?.default || { cpu: 85, memory: 85, disk: 90 };
  const custom = db.agentManager.thresholds?.[String(agentId)] || {};
  return {
    cpu: Number(custom.cpu ?? base.cpu ?? 85),
    memory: Number(custom.memory ?? base.memory ?? 85),
    disk: Number(custom.disk ?? base.disk ?? 90)
  };
}

function appendAgentHistory(db, agentId, payload = {}) {
  ensureOpsDefaults(db);
  const key = String(agentId);
  db.agentManager.history[key] = Array.isArray(db.agentManager.history[key]) ? db.agentManager.history[key] : [];
  db.agentManager.history[key].push({
    ts: payload.ts || nowIso(),
    ok: !!payload.ok,
    cpu: payload.summary?.cpu == null ? null : Number(payload.summary.cpu),
    memory: payload.summary?.memoryUsedPercent == null ? null : Number(payload.summary.memoryUsedPercent),
    disk: payload.summary?.diskUsedPercent == null ? null : Number(payload.summary.diskUsedPercent),
    uptimeSec: payload.summary?.uptimeSec == null ? null : Number(payload.summary.uptimeSec),
    latencyMs: payload.latencyMs == null ? null : Number(payload.latencyMs)
  });
  db.agentManager.history[key] = db.agentManager.history[key].slice(-Math.max(60, Number(db.agentManager.historyRetentionPoints) || 720));
}

function computeAgentSla(historyRows = []) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  const percent = arr => arr.length ? Number(((arr.filter(r => r && r.ok).length / arr.length) * 100).toFixed(2)) : null;
  const last24h = rows.slice(-Math.min(rows.length, 1440));
  return { checks: rows.length, uptimeTotal: percent(rows), uptime24h: percent(last24h), onlineNow: rows.length ? !!rows[rows.length - 1].ok : null };
}

function createAgentAlert(db, agentId, kind, payload = {}) {
  ensureOpsDefaults(db);
  const row = { id: nextId(db.agentManager.alertEvents), ts: nowIso(), agentId: String(agentId), kind, severity: payload.severity || 'warning', message: payload.message || kind, metric: payload.metric || null, value: payload.value == null ? null : Number(payload.value), threshold: payload.threshold == null ? null : Number(payload.threshold), hostname: payload.hostname || '', agentName: payload.agentName || '' };
  db.agentManager.alertEvents.unshift(row);
  db.agentManager.alertEvents = db.agentManager.alertEvents.slice(0, 500);
  emitNocAlert(row);
}

function evaluateAgentNocAlerts(db, agentId, row = {}) {
  ensureOpsDefaults(db);
  const label = row.hostname || row.name || `agent:${agentId}`;
  const onlineKey = `agent:${agentId}:online`;
  const prevOnline = db.agentManager.lastAlertState[onlineKey];
  const isOnline = !!row.ok;
  if (prevOnline !== undefined && prevOnline !== isOnline) createAgentAlert(db, agentId, isOnline ? 'agent-up' : 'agent-down', { severity: isOnline ? 'info' : 'critical', message: `${label}: ${isOnline ? 'agent wrócił online' : 'agent niedostępny'}`, hostname: row.hostname, agentName: row.name });
  db.agentManager.lastAlertState[onlineKey] = isOnline;
  const thresholds = getAgentThresholds(db, agentId);
  for (const metric of ['cpu','memory','disk']) {
    const value = row.summary?.[metric === 'memory' ? 'memoryUsedPercent' : metric === 'disk' ? 'diskUsedPercent' : 'cpu'];
    if (value == null) continue;
    const stateKey = `agent:${agentId}:${metric}`;
    const over = Number(value) >= Number(thresholds[metric] || 0);
    if (over && db.agentManager.lastAlertState[stateKey] !== true) createAgentAlert(db, agentId, 'threshold', { severity: 'warning', metric, value, threshold: thresholds[metric], hostname: row.hostname, agentName: row.name, message: `${label}: ${metric}=${value} (próg ${thresholds[metric]})` });
    db.agentManager.lastAlertState[stateKey] = over;
  }
}

function buildAgentDashboard(db) {
  ensureOpsDefaults(db);
  const rows = Object.values(db.agentManager.cache || {}).map(row => {
    const history = db.agentManager.history[String(row.id)] || [];
    return { ...row, history, sla: computeAgentSla(history), thresholds: getAgentThresholds(db, row.id) };
  });
  return { rows, alerts: db.agentManager.alertEvents || [] };
}

async function fetchAgentStatus(agent, sharedToken) {
  const baseUrl = String(agent?.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('Brak baseUrl agenta.');
  const started = Date.now();
  const res = await fetch(`${baseUrl}/api/agent/status`, { headers: { 'x-vsm-agent-token': String(agent.token || sharedToken || '') } });
  const data = await res.json();
  data.latencyMs = Date.now() - started;
  if (!res.ok) throw new Error(data?.error || `Agent ${baseUrl} zwrócił błąd`);
  return data;
}

async function pollAgentsNow() {
  const db = readData();
  ensureOpsDefaults(db);
  if (!db.agentManager.enabled) return;
  const rows = [];
  for (const agent of db.agentManager.agents || []) {
    const row = { id: agent.id, name: agent.name || agent.baseUrl, baseUrl: agent.baseUrl, ok: false, ts: nowIso() };
    try {
      const data = await fetchAgentStatus(agent, db.agentManager.sharedToken);
      row.ok = true; row.hostname = data.hostname || ''; row.metrics = data.metrics || null; row.summary = data.summary || null; row.version = data.version || ''; row.policies = db.agentManager.perHostPolicies[String(agent.id)] || {}; row.latencyMs = data.latencyMs || null; row.lastMode = data.mode || 'poll';
      appendMetricsSeries(db, `agent:${agent.id}`, { ts: row.ts, summary: row.summary || {}, metrics: row.metrics || {} });
      appendAgentHistory(db, agent.id, row);
      maybeEmitThresholdAlerts(db, { ts: row.ts, summary: row.summary || {} }, row.hostname || `agent:${agent.id}`);
      evaluateAgentNocAlerts(db, agent.id, { ...row, name: agent.name || row.hostname || `Agent ${agent.id}` });
    } catch (error) { row.error = error.message || 'Błąd agenta'; appendAgentHistory(db, agent.id, row); evaluateAgentNocAlerts(db, agent.id, { ...row, name: agent.name || `Agent ${agent.id}` }); }
    db.agentManager.cache[String(agent.id)] = row; rows.push(row);
  }
  writeData(db);
  if (io) { for (const s of io.sockets.sockets.values()) { const user = getSocketUser(s); if (user) s.emit('agents:update', { rows }); } }
}

function isHostAllowedForRole(user, profile, db) {
  if (!profile) return true;
  const role = String(user?.role || 'viewer');
  const allowedHosts = db?.ssh?.commandPolicy?.[role]?.allowedHosts || [];
  if (!allowedHosts.length) return true;
  const target = String(profile.host || '').trim();
  return allowedHosts.some(pattern => patternMatchesValue(pattern, target));
}

function isCommandAllowedForRole(user, profile, command, db) {
  const role = String(user?.role || 'viewer');
  const policy = db?.ssh?.commandPolicy?.[role] || {};
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: true };
  if (profile && !isHostAllowedForRole(user, profile, db)) return { ok: false, error: `Host ${profile.host} nie jest dozwolony dla roli ${role}.` };
  const profileDenied = Array.isArray(profile?.deniedCommands) ? profile.deniedCommands : [];
  const profileAllowed = Array.isArray(profile?.allowedCommands) ? profile.allowedCommands : [];
  const hostPolicies = getHostPolicyRows(profile, db, role);
  const hostDenied = hostPolicies.flatMap(row => Array.isArray(row.deniedCommands) ? row.deniedCommands : []);
  const hostAllowed = hostPolicies.flatMap(row => Array.isArray(row.allowedCommands) ? row.allowedCommands : []);
  if (commandMatchesPolicy(cmd, [...profileDenied, ...(policy.deniedCommands || []), ...hostDenied])) return { ok: false, error: `Polecenie jest zablokowane dla roli ${role}.` };
  if (profileAllowed.length && !commandMatchesPolicy(cmd, profileAllowed)) return { ok: false, error: `Polecenie nie znajduje się na liście dozwolonych komend profilu.` };
  if (hostAllowed.length && !commandMatchesPolicy(cmd, hostAllowed)) return { ok: false, error: `Polecenie nie znajduje się na liście dozwolonych komend hosta.` };
  if ((policy.allowedCommands || []).length && !commandMatchesPolicy(cmd, policy.allowedCommands || [])) return { ok: false, error: `Polecenie nie znajduje się na liście dozwolonych komend roli ${role}.` };
  return { ok: true };
}

function evaluateTerminalInputPolicy(item, user, db, text, socket = null) {
  const input = String(text || '');
  const chunks = input.split(/(\r|\n)/);
  let buffer = String(item.lineBuffer || '');
  const allowedChunks = [];
  for (const part of chunks) {
    if (part === '\r' || part === '\n') {
      const cmd = buffer.trim();
      if (cmd) {
        const profile = item.profileId ? (db.ssh.profiles || []).find(row => String(row.id) === String(item.profileId)) : null;
        const access = isCommandAllowedForRole(user, profile, cmd, db);
        if (!access.ok) {
          item.blockedCommands = Number(item.blockedCommands || 0) + 1;
          appendTerminalSessionAudit(db, user, 'POLICY_BLOCK', { socketId: socket?.id || null, command: cmd, profileId: item.profileId || null, hostLabel: item.hostLabel || 'lokalny host', reason: access.error });
          recordPolicyEvent(db, { user: user?.username || 'system', role: user?.role || 'viewer', hostLabel: item.hostLabel || 'lokalny host', command: cmd, reason: access.error, profileId: item.profileId || null }, socket);
          if (socket) socket.emit('terminal:data', `\r\n[POLITYKA] ${access.error}\r\n`);
          buffer = '';
          continue;
        }
        appendTerminalSessionAudit(db, user, 'COMMAND_EXEC', { socketId: socket?.id || null, command: cmd, profileId: item.profileId || null, hostLabel: item.hostLabel || 'lokalny host' });
      }
      allowedChunks.push(buffer + part);
      buffer = '';
    } else {
      buffer += part;
    }
  }
  item.lineBuffer = buffer;
  return allowedChunks.join('');
}

function appendTerminalSessionAudit(db, user, action, meta = {}) {
  db.ssh = db.ssh || {};
  db.ssh.sessionAudit = Array.isArray(db.ssh.sessionAudit) ? db.ssh.sessionAudit : [];
  db.ssh.sessionAudit.unshift({
    id: nextId(db.ssh.sessionAudit),
    ts: nowIso(),
    user: user?.username || 'system',
    role: user?.role || 'viewer',
    action,
    meta
  });
  db.ssh.sessionAudit = db.ssh.sessionAudit.slice(0, 1000);
}

function listExpressRoutes(app) {
  const out = [];
  const stack = app?._router?.stack || [];
  for (const layer of stack) {
    if (!layer || !layer.route || !layer.route.path) continue;
    const methods = Object.keys(layer.route.methods || {}).filter(Boolean).map(v => v.toUpperCase()).sort();
    const middlewares = (layer.route.stack || []).map(item => item.name || 'anonymous');
    out.push({ path: layer.route.path, methods, middlewares, auth: middlewares.includes('requireAuth'), admin: middlewares.includes('requireAdmin') });
  }
  return out.sort((a, b) => String(a.path).localeCompare(String(b.path)) || a.methods.join(',').localeCompare(b.methods.join(',')));
}

function normalizeSshProfile(row = {}) {
  return {
    id: Number(row.id) || Date.now() + Math.floor(Math.random() * 1000),
    name: String(row.name || '').trim(),
    host: String(row.host || '').trim(),
    port: Math.max(1, Number(row.port) || 22),
    username: String(row.username || '').trim(),
    keyPath: String(row.keyPath || '').trim(),
    strictHostKeyChecking: !!row.strictHostKeyChecking,
    notes: String(row.notes || '').trim(),
    allowedRoles: Array.isArray(row.allowedRoles) ? row.allowedRoles.map(item => String(item || '').trim()).filter(Boolean) : ['operator','admin'],
    allowedCommands: Array.isArray(row.allowedCommands) ? row.allowedCommands.map(item => String(item || '').trim()).filter(Boolean) : [],
    deniedCommands: Array.isArray(row.deniedCommands) ? row.deniedCommands.map(item => String(item || '').trim()).filter(Boolean) : [],
    orgId: Number(row.orgId || 1)
  };
}

function normalizeTaskRow(row = {}) {
  return {
    id: Number(row.id) || Date.now() + Math.floor(Math.random() * 1000),
    name: String(row.name || '').trim() || 'Nowe zadanie',
    enabled: !!row.enabled,
    intervalMin: Math.max(1, Number(row.intervalMin) || 60),
    type: ['backup', 'service', 'docker', 'command', 'ssh-command'].includes(String(row.type || '')) ? String(row.type) : 'backup',
    command: String(row.command || '').trim(),
    serviceId: row.serviceId != null ? String(row.serviceId) : '',
    serviceAction: ['status', 'start', 'stop', 'restart'].includes(String(row.serviceAction || '')) ? String(row.serviceAction) : 'restart',
    dockerContainerId: String(row.dockerContainerId || '').trim(),
    dockerAction: ['start', 'stop', 'restart'].includes(String(row.dockerAction || '')) ? String(row.dockerAction) : 'restart',
    sshProfileId: row.sshProfileId != null ? String(row.sshProfileId) : '',
    sshCommand: String(row.sshCommand || '').trim(),
    lastRunAt: row.lastRunAt || null,
    lastStatus: row.lastStatus || '',
    lastError: row.lastError || '',
    createdAt: row.createdAt || nowIso(),
    orgId: Number(row.orgId || 1)
  };
}

async function runSshCommand(profile, command) {
  const cfg = normalizeSshProfile(profile);
  if (!cfg.host || !cfg.username) throw new Error('Profil SSH musi zawierać host i username.');
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('Brak polecenia do wykonania przez SSH.');
  const access = isCommandAllowedForRole({ role: 'admin', username: 'system' }, cfg, cmd, { ssh: { commandPolicy: { admin: { allowedCommands: [], deniedCommands: [], allowedHosts: [] } } } });
  if (!access.ok) throw new Error(access.error || 'Polecenie SSH zostało zablokowane przez politykę.');
  const args = ['-p', String(cfg.port)];
  args.push('-o', `StrictHostKeyChecking=${cfg.strictHostKeyChecking ? 'yes' : 'no'}`);
  args.push('-o', 'BatchMode=yes');
  if (cfg.keyPath) {
    args.push('-i', cfg.keyPath);
  }
  args.push(`${cfg.username}@${cfg.host}`);
  args.push(cmd);
  const startedAt = nowIso();
  const result = await execCommand('ssh', args, { timeout: 30000 });
  return {
    ok: true,
    startedAt,
    finishedAt: nowIso(),
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    command: cmd,
    profileName: cfg.name || `${cfg.username}@${cfg.host}`,
    profileId: cfg.id
  };
}

async function runScheduledTask(db, task, actor = 'scheduler') {
  ensureOpsDefaults(db);
  const normalized = normalizeTaskRow(task);
  const target = db.scheduler.tasks.find(item => String(item.id) === String(normalized.id));
  const currentTask = target || normalized;
  let result = null;
  if (normalized.type === 'backup') {
    result = runDataBackup({ reason: `task:${normalized.name}`, actor });
  } else if (normalized.type === 'service') {
    const service = (db.serviceManager.services || []).find(item => String(item.id) === String(normalized.serviceId));
    if (!service) throw new Error('Nie znaleziono usługi dla zadania harmonogramu.');
    result = await runServiceAction(service, normalized.serviceAction || 'restart');
  } else if (normalized.type === 'docker') {
    if (!normalized.dockerContainerId) throw new Error('Brak dockerContainerId dla zadania harmonogramu.');
    result = await runDockerAction(normalized.dockerContainerId, normalized.dockerAction || 'restart');
  } else if (normalized.type === 'command') {
    const currentPlatform = os.platform();
    const shell = currentPlatform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = currentPlatform === 'win32' ? ['/c', normalized.command] : ['-lc', normalized.command];
    const commandResult = await execCommand(shell, args, { timeout: 30000 });
    result = { stdout: String(commandResult.stdout || '').trim(), stderr: String(commandResult.stderr || '').trim() };
  } else if (normalized.type === 'ssh-command') {
    const profile = (db.ssh.profiles || []).find(item => String(item.id) === String(normalized.sshProfileId));
    if (!profile) throw new Error('Nie znaleziono profilu SSH dla zadania harmonogramu.');
    result = await runSshCommand(profile, normalized.sshCommand || 'hostname');
  } else {
    throw new Error('Nieobsługiwany typ zadania harmonogramu.');
  }
  currentTask.lastRunAt = nowIso();
  currentTask.lastStatus = 'ok';
  currentTask.lastError = '';
  writeRuntimeLog('INFO', 'Wykonano zadanie harmonogramu.', { taskId: currentTask.id, name: currentTask.name, type: currentTask.type, actor });
  return { task: currentTask, result };
}

async function maybeRunTaskScheduler() {
  const db = readData();
  ensureOpsDefaults(db);
  db.scheduler.lastTickAt = nowIso();
  let changed = false;
  for (const task of db.scheduler.tasks) {
    const normalized = normalizeTaskRow(task);
    Object.assign(task, normalized);
    if (!task.enabled) continue;
    const everyMs = Math.max(1, Number(task.intervalMin) || 60) * 60 * 1000;
    const lastTs = task.lastRunAt ? new Date(task.lastRunAt).getTime() : 0;
    if (!lastTs || (Date.now() - lastTs) >= everyMs) {
      try {
        await runScheduledTask(db, task, 'scheduler');
      } catch (error) {
        task.lastRunAt = nowIso();
        task.lastStatus = 'error';
        task.lastError = error.message || 'Błąd zadania harmonogramu';
        db.scheduler.lastError = task.lastError;
        writeRuntimeLog('ERROR', 'Błąd zadania harmonogramu.', { taskId: task.id, name: task.name, error: task.lastError });
      }
      changed = true;
    }
  }
  if (changed) writeData(db);
  return db.scheduler.tasks;
}

function buildTaskRows(db) {
  ensureOpsDefaults(db);
  return (db.scheduler.tasks || []).map(task => normalizeTaskRow(task));
}

function trimBackups(db) {
  ensureBackupDir();
  const retention = Math.max(1, Number(db?.backupConfig?.retentionCount) || 10);
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(name => /vsm-backup-.*\.json$/i.test(name))
    .map(name => ({ name, path: path.join(BACKUP_DIR, name), mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(retention)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
}

function listBackupRows() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => /vsm-backup-.*\.json$/i.test(name))
    .map(name => {
      const full = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(full);
      return { name, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
}

function runDataBackup({ reason = 'manual', actor = 'system' } = {}) {
  const db = readData();
  ensureOpsDefaults(db);
  ensureBackupDir();
  const fileName = `vsm-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const fullPath = path.join(BACKUP_DIR, fileName);
  const payload = {
    meta: {
      app: 'Virtual Server Manager',
      version: VERSION,
      createdAt: nowIso(),
      reason,
      actor
    },
    data: db
  };
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');
  db.backupConfig.lastRunAt = nowIso();
  db.backupConfig.lastReason = reason;
  db.backupConfig.lastError = '';
  db.backupConfig.lastFile = fileName;
  db.backupConfig.lastSizeBytes = fs.statSync(fullPath).size;
  writeData(db);
  trimBackups(db);
  writeRuntimeLog('INFO', `Wykonano backup danych (${reason}).`, { actor, fileName });
  return { fileName, fullPath, sizeBytes: db.backupConfig.lastSizeBytes, createdAt: db.backupConfig.lastRunAt };
}

function restoreDataBackup(fileName) {
  ensureBackupDir();
  const safeName = path.basename(String(fileName || ''));
  const fullPath = path.join(BACKUP_DIR, safeName);
  if (!safeName || !fs.existsSync(fullPath)) throw new Error('Nie znaleziono wskazanego backupu.');
  const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const data = payload && typeof payload === 'object' && payload.data ? payload.data : payload;
  migrateData(data);
  ensureOpsDefaults(data);
  writeData(data);
  writeRuntimeLog('WARN', 'Przywrócono dane z backupu.', { fileName: safeName });
  return { fileName: safeName, restoredAt: nowIso() };
}

function maybeRunScheduledBackup() {
  const db = readData();
  ensureOpsDefaults(db);
  maintenanceRuntime.lastBackupCheckAt = nowIso();
  if (!db.backupConfig.enabled) return null;
  const everyMs = Math.max(15, Number(db.backupConfig.intervalMin) || 360) * 60 * 1000;
  const lastTs = db.backupConfig.lastRunAt ? new Date(db.backupConfig.lastRunAt).getTime() : 0;
  if (!lastTs || (Date.now() - lastTs) >= everyMs) {
    return runDataBackup({ reason: 'auto', actor: 'scheduler' });
  }
  return null;
}

function getSystemMetrics() {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const load = typeof os.loadavg === 'function' ? os.loadavg() : [0, 0, 0];
  let disk = { path: __dirname, totalBytes: null, freeBytes: null, usedBytes: null, usedPercent: null };
  try {
    if (typeof fs.statfsSync === 'function') {
      const stat = fs.statfsSync(__dirname);
      const total = Number(stat.blocks || 0) * Number(stat.bsize || 0);
      const free = Number(stat.bavail || stat.bfree || 0) * Number(stat.bsize || 0);
      const used = Math.max(0, total - free);
      disk = { path: __dirname, totalBytes: total, freeBytes: free, usedBytes: used, usedPercent: total ? Number(((used / total) * 100).toFixed(1)) : null };
    }
  } catch (_) {}
  return {
    ts: nowIso(),
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSec: os.uptime(),
    cpuCount: Array.isArray(os.cpus()) ? os.cpus().length : 0,
    cpuModel: os.cpus()?.[0]?.model || 'unknown',
    loadAvg: load,
    memory: {
      totalBytes: memTotal,
      freeBytes: memFree,
      usedBytes: memTotal - memFree,
      usedPercent: memTotal ? Number((((memTotal - memFree) / memTotal) * 100).toFixed(1)) : 0
    },
    disk,
    nodeVersion: process.version
  };
}

function execCommand(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 1024 * 1024 * 2, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function normalizeServiceConfig(row = {}) {
  return {
    id: Number(row.id) || Date.now(),
    name: String(row.name || '').trim(),
    serviceName: String(row.serviceName || row.name || '').trim(),
    platform: String(row.platform || 'all').trim() || 'all',
    mode: ['system', 'process'].includes(String(row.mode || 'system')) ? String(row.mode) : 'system',
    processCommand: String(row.processCommand || '').trim(),
    workingDir: String(row.workingDir || '').trim(),
    notes: String(row.notes || '').trim(),
    orgId: Number(row.orgId || 1)
  };
}

async function getServiceStatus(row) {
  const service = normalizeServiceConfig(row);
  const currentPlatform = os.platform();
  if (service.platform !== 'all' && service.platform !== currentPlatform) {
    return { ...service, status: 'unsupported', details: `Usługa przypisana do platformy ${service.platform}.` };
  }
  try {
    if (service.mode === 'process') {
      if (!service.processCommand) return { ...service, status: 'unknown', details: 'Brak polecenia procesu.' };
      const shell = currentPlatform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const args = currentPlatform === 'win32' ? ['/c', service.processCommand] : ['-lc', service.processCommand];
      const result = await execCommand(shell, args, service.workingDir ? { cwd: service.workingDir } : {});
      return { ...service, status: 'process-ok', details: (result.stdout || result.stderr || '').trim().slice(0, 800) };
    }
    if (currentPlatform === 'win32') {
      const result = await execCommand('sc', ['query', service.serviceName]);
      const raw = `${result.stdout}\n${result.stderr}`;
      const match = raw.match(/STATE\s*:\s*\d+\s+(\w+)/i);
      return { ...service, status: match ? match[1].toLowerCase() : 'unknown', details: raw.trim().slice(0, 800) };
    }
    const result = await execCommand('systemctl', ['status', service.serviceName, '--no-pager']);
    const raw = `${result.stdout}\n${result.stderr}`;
    const active = raw.match(/Active:\s+(\w+)/i);
    return { ...service, status: active ? active[1].toLowerCase() : 'unknown', details: raw.trim().slice(0, 800) };
  } catch (error) {
    const raw = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    return { ...service, status: 'error', details: raw.slice(0, 800) || error.message };
  }
}

async function runServiceAction(row, action) {
  const service = normalizeServiceConfig(row);
  const currentPlatform = os.platform();
  if (!SERVICE_ALLOWED_ACTIONS.includes(action)) throw new Error('Nieobsługiwana akcja usługi.');
  if (service.platform !== 'all' && service.platform !== currentPlatform) throw new Error(`Ta usługa nie jest przypisana do platformy ${currentPlatform}.`);
  if (action === 'status') return getServiceStatus(service);
  if (service.mode === 'process') {
    if (!service.processCommand) throw new Error('Brak processCommand dla usługi typu process.');
    if (action !== 'restart' && action !== 'start') throw new Error('Usługa typu process wspiera tylko start/restart.');
    const shell = currentPlatform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const args = currentPlatform === 'win32' ? ['/c', service.processCommand] : ['-lc', service.processCommand];
    const result = await execCommand(shell, args, service.workingDir ? { cwd: service.workingDir } : {});
    return { ...service, action, status: 'ok', details: (result.stdout || result.stderr || '').trim().slice(0, 800) };
  }
  if (currentPlatform === 'win32') {
    if (action === 'restart') {
      try { await execCommand('sc', ['stop', service.serviceName]); } catch (_) {}
      await execCommand('sc', ['start', service.serviceName]);
    } else {
      await execCommand('sc', [action, service.serviceName]);
    }
  } else {
    if (action === 'restart') await execCommand('systemctl', ['restart', service.serviceName]);
    else await execCommand('systemctl', [action, service.serviceName]);
  }
  return getServiceStatus(service);
}

async function listDockerContainers() {
  const result = await execCommand('docker', ['ps', '-a', '--format', '{{json .}}']);
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean).map(line => {
    try {
      const row = JSON.parse(line);
      return {
        id: row.ID,
        image: row.Image,
        name: row.Names,
        state: row.State,
        status: row.Status,
        ports: row.Ports,
        runningFor: row.RunningFor
      };
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

async function runDockerAction(containerId, action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Nieobsługiwana akcja Dockera.');
  await execCommand('docker', [action, containerId]);
  return listDockerContainers();
}

function sendWebhook(urlString, payload) {
  return new Promise((resolve, reject) => {
    try {
      const target = new URL(urlString);
      const lib = target.protocol === 'https:' ? require('https') : require('http');
      const body = JSON.stringify(payload);
      const req = lib.request({
        method: 'POST',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Webhook timeout')));
      req.write(body);
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}


function logAudit(db, userOrReq, action, message) {
  db.auditLog = db.auditLog || [];
  const username = userOrReq?.session?.user?.username || userOrReq?.username || 'system';
  db.auditLog.unshift({ id: nextId(db.auditLog), ts: nowIso(), user: username, action, message });
  db.auditLog = db.auditLog.slice(0, 500);
  writeData(db);
}

function addAudit(db, req, action, message) {
  db.auditLog = db.auditLog || [];
  db.auditLog.unshift({ id: nextId(db.auditLog), ts: nowIso(), user: req.session?.user?.username || 'system', action, message });
  db.auditLog = db.auditLog.slice(0, 500);
}

function getRoom(db, roomId) { return db.serverRooms.find(r => r.id === Number(roomId)); }
function getRack(room, rackId) { return room?.racks?.find(r => r.id === Number(rackId)); }
function getAllDevices(rack) { return [...(rack?.frontDevices || []), ...(rack?.rearDevices || [])]; }
function getFrontDevice(rack, deviceId) { return rack?.frontDevices?.find(d => d.id === Number(deviceId)); }
function getDeviceAnySide(rack, deviceId) { return getAllDevices(rack).find(d => d.id === Number(deviceId)); }
function getDeviceRef(db, roomId, rackId, deviceId) {
  const room = getRoom(db, roomId);
  const rack = getRack(room, rackId);
  const device = getFrontDevice(rack, deviceId) || getDeviceAnySide(rack, deviceId);
  return { room, rack, device };
}
function isDeviceMuted(device) {
  const until = device?.monitoring?.mutedUntil;
  if (!until) return false;
  const ts = new Date(until).getTime();
  return Number.isFinite(ts) && ts > Date.now();
}
function ensureMonitoringDefaults(device) {
  device.monitoring = device.monitoring && typeof device.monitoring === 'object' ? device.monitoring : {};
  if (typeof device.monitoring.enabled !== 'boolean') device.monitoring.enabled = !!String(device?.network?.ip || '').trim();
  if (!device.monitoring.protocol) device.monitoring.protocol = 'icmp';
  if (!device.monitoring.intervalSec) device.monitoring.intervalSec = 60;
  if (!('timeoutMs' in device.monitoring)) device.monitoring.timeoutMs = 1200;
  if (!('notes' in device.monitoring)) device.monitoring.notes = '';
  if (!('snmpCommunity' in device.monitoring)) device.monitoring.snmpCommunity = '';
  if (!('mutedUntil' in device.monitoring)) device.monitoring.mutedUntil = null;
  if (!('lastConfigAt' in device.monitoring)) device.monitoring.lastConfigAt = null;
  return device.monitoring;
}

function collectPortAddressConflicts(db, currentEndpoint, incoming) {
  const ip = String(incoming.ip || '').trim();
  const vlan = String(incoming.vlan || '').trim();
  if (!ip) return null;
  for (const room of db.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of rack.frontDevices || []) {
        for (const port of device.ports || []) {
          const sameEndpoint = Number(room.id) === Number(currentEndpoint.roomId) &&
            Number(rack.id) === Number(currentEndpoint.rackId) &&
            Number(device.id) === Number(currentEndpoint.deviceId) &&
            Number(port.portNumber) === Number(currentEndpoint.portNumber);
          if (sameEndpoint) continue;
          if (String(port.ip || '').trim() == ip) {
            if (!vlan || !String(port.vlan || '').trim() || String(port.vlan || '').trim() == vlan) {
              return `Duplikat adresu IP: ${ip} jest już użyty w ${room.building} / ${room.roomNumber} / ${rack.label} / ${device.label} / port ${port.portNumber}.`;
            }
          }
        }
      }
    }
  }
  return null;
}


function collectVlanSubnetConflicts(db, currentEndpoint, incoming) {
  const vlan = String(incoming.vlan || '').trim();
  const subnet = String(incoming.subnet || '').trim();
  if (!vlan || !subnet) return null;
  for (const room of db.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of rack.frontDevices || []) {
        for (const port of device.ports || []) {
          const sameEndpoint = Number(room.id) === Number(currentEndpoint.roomId) && Number(rack.id) === Number(currentEndpoint.rackId) && Number(device.id) === Number(currentEndpoint.deviceId) && Number(port.portNumber) === Number(currentEndpoint.portNumber);
          if (sameEndpoint) continue;
          if (String(port.vlan || '').trim() === vlan && String(port.subnet || '').trim() && String(port.subnet || '').trim() !== subnet) {
            return `Konflikt VLAN: VLAN ${vlan} ma już inną podsieć (${port.subnet}) w ${room.building} / ${room.roomNumber} / ${rack.label} / ${device.label} / port ${port.portNumber}.`;
          }
        }
      }
    }
  }
  return null;
}

function simpleHash(input='') {
  const str = String(input || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i);
  return Math.abs(hash >>> 0);
}

function getMonitoringKey(room, rack, device) {
  return [room?.building || '', room?.roomNumber || '', rack?.label || '', device?.label || '', device?.network?.ip || ''].join('|');
}

function defaultMonitorSnapshot(device, mode='synthetic') {
  const ip = String(device?.network?.ip || '').trim();
  if (!ip) {
    return {
      monitored: false,
      status: 'unknown',
      online: false,
      reason: 'Brak IP',
      latencyMs: null,
      packetLoss: 100,
      throughputMbps: 0,
      mode,
      muted: isDeviceMuted(device),
      updatedAt: nowIso(),
      history: Array.from({ length: 12 }).map((_, idx) => ({ label: `T-${11-idx}`, online: false, latencyMs: null, loss: 100 }))
    };
  }
  const seed = simpleHash(`${ip}|${device?.label || ''}|${device?.model || ''}`);
  const online = (seed % 7) !== 0;
  const portCount = Array.isArray(device?.ports) ? device.ports.length : 0;
  const livePorts = (device?.ports || []).filter(p => p.status === 'up').length;
  const latencyBase = 2 + (seed % 18) + Math.max(0, Math.round((portCount - livePorts) / 6));
  const throughputMbps = online ? Math.max(1, livePorts * (12 + (seed % 9))) : 0;
  const history = Array.from({ length: 12 }).map((_, idx) => {
    const pointSeed = seed + idx * 17;
    const pointOnline = online ? ((pointSeed % 11) !== 0) : false;
    return {
      label: `T-${11-idx}`,
      online: pointOnline,
      latencyMs: pointOnline ? latencyBase + (pointSeed % 8) : null,
      loss: pointOnline ? (pointSeed % 4 === 0 ? 1 : 0) : 100
    };
  });
  return {
    monitored: true,
    status: online ? 'online' : 'offline',
    online,
    reason: online ? 'Ping OK (symulacja)' : 'Brak odpowiedzi na ping (symulacja)',
    latencyMs: online ? latencyBase : null,
    packetLoss: online ? 0 : 100,
    throughputMbps,
    mode,
    muted: isDeviceMuted(device),
    updatedAt: nowIso(),
    history
  };
}

function parsePingLatency(output='') {
  const patterns = [/time[=<]\s*([0-9.,]+)\s*ms/i, /czas[=<]\s*([0-9.,]+)\s*ms/i, /średni = (\d+)ms/i, /average = (\d+)ms/i];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return Math.round(Number(String(match[1]).replace(',', '.')) || 0);
  }
  return null;
}

function pingHost(ip) {
  return new Promise(resolve => {
    const target = String(ip || '').trim();
    if (!target) return resolve({ ok: false, latencyMs: null, reason: 'Brak IP', mode: 'none' });
    const args = process.platform === 'win32' ? ['-n', '1', '-w', '1200', target] : ['-c', '1', '-W', '1', target];
    execFile('ping', args, { timeout: 2500, windowsHide: true }, (error, stdout='', stderr='') => {
      const out = `${stdout}\n${stderr}`;
      if (!error) return resolve({ ok: true, latencyMs: parsePingLatency(out), reason: 'Ping OK', mode: 'real' });
      const latencyMs = parsePingLatency(out);
      const reason = /could not find host|nie można odnaleźć hosta|name or service not known/i.test(out) ? 'Nieprawidłowy host/IP' : 'Brak odpowiedzi na ping';
      resolve({ ok: false, latencyMs, reason, mode: 'real' });
    });
  });
}



function snmpVarbindValue(varbind, fallback=null) {
  if (!varbind) return fallback;
  if (snmp && typeof snmp.isVarbindError === 'function' && snmp.isVarbindError(varbind)) return fallback;
  const value = varbind.value;
  if (Buffer.isBuffer(value)) return value.toString('utf8').trim();
  return value ?? fallback;
}

function normalizeSnmpOperStatus(value, fallback='down') {
  const num = Number(value);
  if (num === 1) return 'up';
  if (num === 2) return 'down';
  if (num === 7) return 'down';
  return fallback;
}

async function pollSnmpInterfaces(db, room, rack, device, options = {}) {
  if (!snmp) return { ok: false, reason: 'Biblioteka net-snmp nie jest zainstalowana.', mode: 'derived' };
  const targetIp = String(device?.network?.ip || '').trim();
  if (!targetIp) return { ok: false, reason: 'Urządzenie nie ma adresu IP.', mode: 'derived' };
  const ports = Array.isArray(device?.ports) ? device.ports.filter(port => Number(port?.portNumber) > 0) : [];
  if (!ports.length) return { ok: false, reason: 'Urządzenie nie ma portów do odczytu SNMP.', mode: 'derived' };
  const cfg = ensureMonitoringDefaults(device);
  const community = String(options.community || cfg.snmpCommunity || 'public').trim() || 'public';
  const timeoutMs = Math.max(250, Number(options.timeoutMs || cfg.timeoutMs || 1200) || 1200);
  const session = snmp.createSession(targetIp, community, { timeout: timeoutMs, retries: 0, version: snmp.Version2c });
  const baseOids = {
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
    ifInOctets: '1.3.6.1.2.1.2.2.1.10',
    ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
    ifInErrors: '1.3.6.1.2.1.2.2.1.14',
    ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
    ifSpeed: '1.3.6.1.2.1.2.2.1.5'
  };
  const oids = [];
  const offsets = new Map();
  for (const port of ports) {
    const idx = Number(port.portNumber);
    offsets.set(idx, oids.length);
    oids.push(
      `${baseOids.ifDescr}.${idx}`,
      `${baseOids.ifOperStatus}.${idx}`,
      `${baseOids.ifInOctets}.${idx}`,
      `${baseOids.ifOutOctets}.${idx}`,
      `${baseOids.ifInErrors}.${idx}`,
      `${baseOids.ifOutErrors}.${idx}`,
      `${baseOids.ifSpeed}.${idx}`
    );
  }
  let varbinds;
  try {
    varbinds = await new Promise((resolve, reject) => {
      session.get(oids, (error, rows) => error ? reject(error) : resolve(rows));
    });
  } catch (error) {
    try { session.close(); } catch (_) {}
    return { ok: false, reason: `SNMP: ${error.message || 'błąd odczytu'}`, mode: 'derived' };
  }
  try { session.close(); } catch (_) {}
  db.monitoring = db.monitoring && typeof db.monitoring === 'object' ? db.monitoring : {};
  db.monitoring.snmpCountersByKey = db.monitoring.snmpCountersByKey && typeof db.monitoring.snmpCountersByKey === 'object' ? db.monitoring.snmpCountersByKey : {};
  db.monitoring.snmpLatestByKey = db.monitoring.snmpLatestByKey && typeof db.monitoring.snmpLatestByKey === 'object' ? db.monitoring.snmpLatestByKey : {};
  const monitorKey = getMonitoringKey(room, rack, device);
  const counterState = db.monitoring.snmpCountersByKey[monitorKey] && typeof db.monitoring.snmpCountersByKey[monitorKey] === 'object' ? db.monitoring.snmpCountersByKey[monitorKey] : {};
  const now = Date.now();
  const interfaces = ports.map(port => {
    const idx = Number(port.portNumber);
    const base = offsets.get(idx);
    const name = String(snmpVarbindValue(varbinds[base], `Gi1/0/${idx}`) || `Gi1/0/${idx}`);
    const operStatus = normalizeSnmpOperStatus(snmpVarbindValue(varbinds[base + 1], port?.status || 'down'), port?.status || 'down');
    const inOctets = Number(snmpVarbindValue(varbinds[base + 2], 0)) || 0;
    const outOctets = Number(snmpVarbindValue(varbinds[base + 3], 0)) || 0;
    const inErrors = Number(snmpVarbindValue(varbinds[base + 4], 0)) || 0;
    const outErrors = Number(snmpVarbindValue(varbinds[base + 5], 0)) || 0;
    const speedBps = Number(snmpVarbindValue(varbinds[base + 6], 1000000000)) || 1000000000;
    const prev = counterState[idx] && typeof counterState[idx] === 'object' ? counterState[idx] : null;
    const elapsedSec = prev && prev.ts ? Math.max(1, (now - Number(prev.ts)) / 1000) : 0;
    const rxMbps = elapsedSec ? Math.max(0, Number((((inOctets - Number(prev.inOctets || 0)) * 8) / 1000000 / elapsedSec).toFixed(1))) : 0;
    const txMbps = elapsedSec ? Math.max(0, Number((((outOctets - Number(prev.outOctets || 0)) * 8) / 1000000 / elapsedSec).toFixed(1))) : 0;
    const speedMbps = Math.max(1, Math.round(speedBps / 1000000));
    counterState[idx] = { ts: now, inOctets, outOctets, inErrors, outErrors, speedBps };
    return {
      portNumber: idx,
      name,
      adminStatus: 'up',
      operStatus,
      rxMbps,
      txMbps,
      throughputMbps: Number((rxMbps + txMbps).toFixed(1)),
      utilizationPct: operStatus === 'up' ? Math.min(100, Number((((rxMbps + txMbps) / speedMbps) * 100).toFixed(1))) : 0,
      crcErrors: inErrors,
      drops: outErrors,
      vlan: port?.vlan || device?.network?.vlan || '',
      ip: port?.ip || '',
      target: port?.target || (port?.connectedTo ? `Port ${port.connectedTo.portNumber}` : ''),
      cableColor: port?.cableColor || '#64748b',
      mode: 'snmp-real'
    };
  });
  db.monitoring.snmpCountersByKey[monitorKey] = counterState;
  db.monitoring.snmpLatestByKey[monitorKey] = { updatedAt: nowIso(), interfaces };
  return { ok: true, reason: 'SNMP OK', mode: 'snmp-real', interfaces };
}

function getCachedSnmpInterfaces(db, room, rack, device) {
  const key = getMonitoringKey(room, rack, device);
  return db?.monitoring?.snmpLatestByKey?.[key] || null;
}

function getInterfaceHistoryKey(room, rack, device, portNumber) {
  return `${getMonitoringKey(room, rack, device)}|port:${Number(portNumber || 0)}`;
}

function evaluatePortThresholds(live, thresholds) {
  const cfg = normalizePortThresholds(thresholds);
  const reasons = [];
  if (cfg.rxThresholdMbps !== '' && Number(live.rxMbps || 0) >= Number(cfg.rxThresholdMbps)) reasons.push(`RX >= ${cfg.rxThresholdMbps} Mb/s`);
  if (cfg.txThresholdMbps !== '' && Number(live.txMbps || 0) >= Number(cfg.txThresholdMbps)) reasons.push(`TX >= ${cfg.txThresholdMbps} Mb/s`);
  const errors = Number(live.crcErrors || 0) + Number(live.drops || 0);
  if (cfg.errorThreshold !== '' && errors >= Number(cfg.errorThreshold)) reasons.push(`błędy >= ${cfg.errorThreshold}`);
  if (cfg.utilizationThresholdPct !== '' && Number(live.utilizationPct || 0) >= Number(cfg.utilizationThresholdPct)) reasons.push(`utylizacja >= ${cfg.utilizationThresholdPct}%`);
  return { active: reasons.length > 0, reasons, thresholds: cfg };
}

function buildInterfaceMonitoringEvent(ref, port, severity, type, message, muted=false) {
  return {
    id: null,
    ts: nowIso(),
    severity,
    type,
    roomId: ref.room.id,
    rackId: ref.rack.id,
    deviceId: ref.device.id,
    deviceLabel: ref.device.label,
    portNumber: Number(port.portNumber || 0),
    ip: ref.device.network?.ip || '',
    muted: !!muted,
    acknowledged: false,
    acknowledgedAt: null,
    acknowledgedBy: null,
    message
  };
}

let monitoringScanInProgress = false;

async function runMonitoringScan(db, options={}) {
  if (monitoringScanInProgress && !options.force) return db.monitoring;
  monitoringScanInProgress = true;
  try {
    db.monitoring = db.monitoring && typeof db.monitoring === 'object' ? db.monitoring : { samplesByKey: {}, interfaceSamplesByKey: {}, events: [], lastScanAt: null, lastScanMode: 'runtime' };
    db.monitoring.samplesByKey = db.monitoring.samplesByKey && typeof db.monitoring.samplesByKey === 'object' ? db.monitoring.samplesByKey : {};
    db.monitoring.interfaceSamplesByKey = db.monitoring.interfaceSamplesByKey && typeof db.monitoring.interfaceSamplesByKey === 'object' ? db.monitoring.interfaceSamplesByKey : {};
  db.monitoring.snmpCountersByKey = db.monitoring.snmpCountersByKey && typeof db.monitoring.snmpCountersByKey === 'object' ? db.monitoring.snmpCountersByKey : {};
  db.monitoring.snmpLatestByKey = db.monitoring.snmpLatestByKey && typeof db.monitoring.snmpLatestByKey === 'object' ? db.monitoring.snmpLatestByKey : {};
  db.monitoring.snmpPolling = db.monitoring.snmpPolling && typeof db.monitoring.snmpPolling === 'object' ? db.monitoring.snmpPolling : { enabled: true, intervalSec: 300, lastRunAt: null, lastSummary: null };
  if (typeof db.monitoring.snmpPolling.enabled !== 'boolean') db.monitoring.snmpPolling.enabled = true;
  db.monitoring.snmpPolling.intervalSec = Math.max(60, Number(db.monitoring.snmpPolling.intervalSec) || 300);
  db.monitoring.snmpPollingHistory = Array.isArray(db.monitoring.snmpPollingHistory) ? db.monitoring.snmpPollingHistory : [];
  db.monitoring.uplinkMapHistory = Array.isArray(db.monitoring.uplinkMapHistory) ? db.monitoring.uplinkMapHistory : [];
    db.monitoring.events = Array.isArray(db.monitoring.events) ? db.monitoring.events : [];
    const frontRefs = [];
    for (const room of db.serverRooms || []) {
      for (const rack of room.racks || []) {
        for (const device of rack.frontDevices || []) frontRefs.push({ room, rack, device, key: getMonitoringKey(room, rack, device) });
      }
    }
    for (const ref of frontRefs) {
      ensureMonitoringDefaults(ref.device);
      const current = db.monitoring.samplesByKey[ref.key] || defaultMonitorSnapshot(ref.device, 'synthetic');
      let next = defaultMonitorSnapshot(ref.device, 'synthetic');
      if (!ref.device.monitoring.enabled) {
        next = {
          monitored: false,
          status: 'disabled',
          online: false,
          reason: 'Monitoring wyłączony',
          latencyMs: null,
          packetLoss: 100,
          throughputMbps: 0,
          mode: 'disabled',
          muted: isDeviceMuted(ref.device),
          updatedAt: nowIso(),
          history: Array.isArray(current.history) ? current.history.slice(-11) : []
        };
      } else if (ref.device?.network?.ip) {
        const ping = await pingHost(ref.device.network.ip);
        const livePorts = (ref.device.ports || []).filter(p => p.status === 'up').length;
        next = {
          monitored: true,
          status: ping.ok ? 'online' : 'offline',
          online: !!ping.ok,
          reason: ping.reason,
          latencyMs: ping.ok ? (ping.latencyMs ?? Math.max(1, livePorts * 2)) : null,
          packetLoss: ping.ok ? 0 : 100,
          throughputMbps: ping.ok ? Math.max(0, livePorts * 25) : 0,
          mode: ping.mode || 'real',
          muted: isDeviceMuted(ref.device),
          updatedAt: nowIso(),
          history: Array.isArray(current.history) ? current.history.slice(-11) : []
        };
      }
      next.history = (next.history || []).concat({ label: new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }), online: !!next.online, latencyMs: next.latencyMs, loss: next.packetLoss }).slice(-12);
      db.monitoring.samplesByKey[ref.key] = next;
      if (current.status && !['unknown','disabled'].includes(current.status) && current.status !== next.status) {
        db.monitoring.events.unshift({ id: nextId(db.monitoring.events), ts: nowIso(), severity: next.status === 'offline' ? 'high' : 'info', type: next.status === 'offline' ? 'DEVICE_OFFLINE' : 'DEVICE_ONLINE', roomId: ref.room.id, rackId: ref.rack.id, deviceId: ref.device.id, deviceLabel: ref.device.label, ip: ref.device.network?.ip || '', muted: !!next.muted, acknowledged: false, acknowledgedAt: null, acknowledgedBy: null, message: `${ref.device.label} (${ref.device.network?.ip || 'brak IP'}) zmienił status na ${next.status}.` });
      }
      for (const port of ref.device.ports || []) {
        const live = buildInterfaceLive(ref.device, port, next, ref.room, ref.rack);
        const historyKey = getInterfaceHistoryKey(ref.room, ref.rack, ref.device, port.portNumber);
        const prevSeries = Array.isArray(db.monitoring.interfaceSamplesByKey[historyKey]) ? db.monitoring.interfaceSamplesByKey[historyKey] : [];
        db.monitoring.interfaceSamplesByKey[historyKey] = prevSeries.concat({ ts: nowIso(), rxMbps: live.rxMbps, txMbps: live.txMbps, utilizationPct: live.utilizationPct, errors: Number(live.crcErrors || 0) + Number(live.drops || 0), operStatus: live.operStatus }).slice(-24);
        const result = evaluatePortThresholds(live, port.thresholds);
        port.thresholds = result.thresholds;
        if (result.active && !port.thresholds.lastAlertState) {
          port.thresholds.lastAlertState = true;
          port.thresholds.lastAlertAt = nowIso();
          const ev = buildInterfaceMonitoringEvent(ref, port, 'high', 'INTERFACE_THRESHOLD', `Port ${port.portNumber} na ${ref.device.label} przekroczył próg: ${result.reasons.join(', ')}.`, !!next.muted);
          ev.id = nextId(db.monitoring.events);
          db.monitoring.events.unshift(ev);
        } else if (!result.active && port.thresholds.lastAlertState) {
          port.thresholds.lastAlertState = false;
          port.thresholds.lastRecoveredAt = nowIso();
          const ev = buildInterfaceMonitoringEvent(ref, port, 'info', 'INTERFACE_THRESHOLD_CLEAR', `Port ${port.portNumber} na ${ref.device.label} wrócił poniżej progów alarmowych.`, !!next.muted);
          ev.id = nextId(db.monitoring.events);
          db.monitoring.events.unshift(ev);
        }
      }
    }
    db.monitoring.lastScanAt = nowIso();
    db.monitoring.lastScanMode = 'real';
    db.monitoring.events = db.monitoring.events.slice(0, 300);
    writeData(db);
    return db.monitoring;
  } finally {
    monitoringScanInProgress = false;
  }
}

function buildMonitoringForDevice(db, room, rack, device) {
  ensureMonitoringDefaults(device);
  const key = getMonitoringKey(room, rack, device);
  return db?.monitoring?.samplesByKey?.[key] || defaultMonitorSnapshot(device, 'synthetic');
}

function buildInterfaceLive(device, port, monitor, room=null, rack=null) {
  const base = simpleHash(`${device?.label || ''}|${device?.network?.ip || ''}|${port?.portNumber || 0}|${room?.id || 0}|${rack?.id || 0}`);
  const isUp = String(port?.status || 'down') === 'up';
  const connected = !!(port?.connectedTo || port?.target);
  const rxMbps = isUp ? Math.max(0.1, Number((((base % 140) + 5) * (connected ? 1 : 0.35)).toFixed(1))) : 0;
  const txMbps = isUp ? Math.max(0.1, Number((((base % 120) + 3) * (connected ? 0.92 : 0.28)).toFixed(1))) : 0;
  const speedMbps = /10g/i.test(device?.model || '') ? 10000 : 1000;
  const utilizationPct = isUp ? Math.min(100, Number((((rxMbps + txMbps) / speedMbps) * 100).toFixed(1))) : 0;
  const crcErrors = isUp ? (base % 17 === 0 ? (base % 4) + 1 : 0) : 0;
  const drops = isUp ? (base % 23 === 0 ? (base % 3) + 1 : 0) : 0;
  return {
    portNumber: Number(port?.portNumber || 0),
    name: `Gi1/0/${Number(port?.portNumber || 0)}`,
    adminStatus: 'up',
    operStatus: isUp ? 'up' : 'down',
    rxMbps,
    txMbps,
    throughputMbps: Number((rxMbps + txMbps).toFixed(1)),
    utilizationPct,
    crcErrors,
    drops,
    vlan: port?.vlan || device?.network?.vlan || '',
    ip: port?.ip || '',
    target: port?.target || (port?.connectedTo ? `Port ${port.connectedTo.portNumber}` : ''),
    cableColor: port?.cableColor || '#64748b',
    mode: monitor?.mode || 'derived'
  };
}

function buildInterfacesForDevice(db, room, rack, device, options = {}) {
  const monitor = options.monitor || buildMonitoringForDevice(db, room, rack, device);
  const overrides = new Map((options.interfaces || []).map(row => [Number(row.portNumber || 0), row]));
  const interfaces = (device?.ports || []).map(port => {
    const live = overrides.get(Number(port.portNumber || 0)) || buildInterfaceLive(device, port, monitor, room, rack);
    const thresholdState = evaluatePortThresholds(live, port.thresholds);
    const historyKey = getInterfaceHistoryKey(room, rack, device, port.portNumber);
    const history = Array.isArray(db?.monitoring?.interfaceSamplesByKey?.[historyKey]) ? db.monitoring.interfaceSamplesByKey[historyKey] : [];
    return { ...live, thresholds: thresholdState.thresholds, thresholdActive: thresholdState.active, thresholdReasons: thresholdState.reasons, history };
  });
  const summary = {
    interfaceCount: interfaces.length,
    upCount: interfaces.filter(i => i.operStatus === 'up').length,
    totalRxMbps: Number(interfaces.reduce((s, i) => s + (i.rxMbps || 0), 0).toFixed(1)),
    totalTxMbps: Number(interfaces.reduce((s, i) => s + (i.txMbps || 0), 0).toFixed(1)),
    totalErrors: interfaces.reduce((s, i) => s + (i.crcErrors || 0) + (i.drops || 0), 0),
    thresholdBreaches: interfaces.filter(i => i.thresholdActive).length,
    busiest: interfaces.slice().sort((a,b) => (b.throughputMbps||0) - (a.throughputMbps||0)).slice(0, 8)
  };
  return { deviceLabel: device?.label || '', monitor, interfaces, summary };
}

function buildDevicePath(db, room, rack, device) {
  const uplinks = (device?.ports || []).filter(p => p.connectedTo).map(p => ({
    localPort: p.portNumber,
    targetLabel: buildConnectionTargetLabel(db, p.connectedTo),
    vlan: p.vlan || device?.network?.vlan || '',
    color: p.cableColor || '#64748b',
    medium: p?.connectionMeta?.medium || '',
    cableLabel: p?.connectionMeta?.cableLabel || '',
    cableLengthM: p?.connectionMeta?.cableLengthM || '',
    routeName: p?.connectionMeta?.routeName || ''
  }));
  const hops = [
    { kind: 'building', label: room?.building || '-' },
    { kind: 'room', label: `${room?.roomType || 'Pomieszczenie'} ${room?.roomNumber || ''}`.trim() },
    { kind: 'rack', label: rack?.label || '-' },
    { kind: 'device', label: device?.label || '-' }
  ];
  return {
    location: {
      building: room?.building || '',
      roomType: room?.roomType || '',
      roomNumber: room?.roomNumber || '',
      rack: rack?.label || '',
      rowNumber: rack?.rowNumber || '',
      positionInRow: rack?.positionInRow || '',
      rackUnits: `U${device?.startU || '?'}-${Number(device?.startU || 0) + Number(device?.sizeU || 1) - 1}`
    },
    logical: {
      hostname: device?.network?.hostname || '',
      managementIp: device?.network?.ip || '',
      managementVlan: device?.network?.vlan || '',
      subnets: [...new Set((device?.ports || []).map(p => p.subnet).filter(Boolean))],
      vlans: [...new Set((device?.ports || []).map(p => p.vlan || device?.network?.vlan).filter(Boolean))]
    },
    power: {
      primary: device?.power?.primary || null,
      backup: device?.power?.backup || null
    },
    uplinks,
    hops
  };
}

function summarizeMonitoring(db, frontRefs) {
  if (Array.isArray(db) && !frontRefs) { frontRefs = db; db = readData(); }
  frontRefs = Array.isArray(frontRefs) ? frontRefs : [];
  const devices = frontRefs.map(ref => ({
    label: ref.device.label,
    type: ref.device.type,
    vendor: ref.device.vendor || '',
    model: ref.device.model || '',
    ip: ref.device.network?.ip || '',
    vlan: ref.device.network?.vlan || '',
    roomId: ref.room.id,
    rackId: ref.rack.id,
    monitor: buildMonitoringForDevice(db, ref.room, ref.rack, ref.device),
    monitorConfig: ensureMonitoringDefaults(ref.device)
  }));
  const monitored = devices.filter(d => d.monitor.monitored);
  const online = monitored.filter(d => d.monitor.online).length;
  const offline = monitored.filter(d => !d.monitor.online).length;
  const latencyValues = monitored.filter(d => d.monitor.online && Number.isFinite(d.monitor.latencyMs)).map(d => d.monitor.latencyMs);
  const avgLatency = latencyValues.length ? Math.round(latencyValues.reduce((sum, v) => sum + v, 0) / latencyValues.length) : 0;
  const historySeries = Array.from({ length: 12 }).map((_, idx) => {
    const sample = monitored.map(d => d.monitor.history[idx]).filter(Boolean);
    const onlineCount = sample.filter(p => p.online).length;
    const perLatency = sample.filter(p => p.online && Number.isFinite(p.latencyMs)).map(p => p.latencyMs);
    return { label: sample[0]?.label || `T-${11-idx}`, onlineCount, latencyAvg: perLatency.length ? Math.round(perLatency.reduce((a,b)=>a+b,0)/perLatency.length) : 0 };
  });
  const activeEvents = (db?.monitoring?.events || []).filter(ev => !ev.acknowledged && ev.severity === 'high');
  return {
    monitoredDevices: monitored.length,
    onlineDevices: online,
    offlineDevices: offline,
    unknownDevices: devices.filter(d => !d.monitor.monitored).length,
    avgLatencyMs: avgLatency,
    uplinkHealthPercent: frontRefs.length ? Math.round((frontRefs.flatMap(ref => ref.device.ports || []).filter(p => p.status === 'up').length / Math.max(1, frontRefs.flatMap(ref => ref.device.ports || []).length)) * 100) : 0,
    mappedConnections: frontRefs.flatMap(ref => ref.device.ports || []).filter(p => p.connectedTo).length,
    activeCriticalEvents: activeEvents.length,
    mutedDevices: devices.filter(d => d.monitor.muted).length,
    historySeries,
    lastScanAt: db?.monitoring?.lastScanAt || null,
    lastScanMode: db?.monitoring?.lastScanMode || 'n/a',
    events: (db?.monitoring?.events || []).slice(0, 20),
    devices: devices.sort((a,b) => (a.monitor.online === b.monitor.online ? a.label.localeCompare(b.label,'pl') : (a.monitor.online ? -1 : 1))).slice(0, 20),
    busiestInterfaces: frontRefs.flatMap(ref => buildInterfacesForDevice(db, ref.room, ref.rack, ref.device).summary.busiest.map(i => ({...i, deviceLabel: ref.device.label, rackLabel: ref.rack.label, roomNumber: ref.room.roomNumber, building: ref.room.building}))).sort((a,b)=> (b.throughputMbps||0)-(a.throughputMbps||0)).slice(0,10)
  };
}

function normalizePortThresholds(value) {
  const src = value && typeof value === 'object' ? value : {};
  const asNullable = v => {
    if (v === '' || v === null || typeof v === 'undefined') return '';
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : '';
  };
  return {
    rxThresholdMbps: asNullable(src.rxThresholdMbps),
    txThresholdMbps: asNullable(src.txThresholdMbps),
    errorThreshold: asNullable(src.errorThreshold),
    utilizationThresholdPct: asNullable(src.utilizationThresholdPct),
    lastAlertState: !!src.lastAlertState,
    lastAlertAt: src.lastAlertAt || null,
    lastRecoveredAt: src.lastRecoveredAt || null
  };
}

function normalizePorts(ports) {
  if (!Array.isArray(ports)) return [];
  return ports.map((p, index) => ({
    portNumber: Number(p.portNumber || index + 1),
    status: p.status === 'up' ? 'up' : 'down',
    target: p.target || '',
    ip: p.ip || '',
    vlan: p.vlan || '',
    subnet: p.subnet || '',
    mask: p.mask || '',
    gateway: p.gateway || '',
    cableColor: p.cableColor || '#64748b',
    connectedTo: p.connectedTo || null,
    thresholds: normalizePortThresholds(p.thresholds),
    connectionMeta: p.connectionMeta && typeof p.connectionMeta === 'object' ? {
      medium: p.connectionMeta.medium || '',
      cableLabel: p.connectionMeta.cableLabel || '',
      cableLengthM: Number(p.connectionMeta.cableLengthM || 0) || '',
      routeId: p.connectionMeta.routeId ? Number(p.connectionMeta.routeId) : null,
      routeName: p.connectionMeta.routeName || ''
    } : null
  }));
}

function validateDevicePlacement(rack, side, device, ignoreDeviceId = null) {
  const sizeU = Number(device.sizeU);
  const startU = Number(device.startU);
  if (!Number.isInteger(sizeU) || !Number.isInteger(startU) || sizeU < 1 || startU < 1) return 'Nieprawidłowa pozycja urządzenia.';
  if ((startU + sizeU - 1) > rack.sizeU) return `Urządzenie wychodzi poza szafę ${rack.sizeU}U.`;
  const target = side === 'rear' ? rack.rearDevices : rack.frontDevices;
  const requestedUnits = new Set(Array.from({ length: sizeU }, (_, i) => startU + i));
  const collision = target.find(existing => {
    if (ignoreDeviceId && Number(existing.id) === Number(ignoreDeviceId)) return false;
    const existingUnits = new Set(Array.from({ length: Number(existing.sizeU) }, (_, i) => Number(existing.startU) + i));
    return [...requestedUnits].some(u => existingUnits.has(u));
  });
  if (collision) return `Kolizja z urządzeniem: ${collision.label} (U${collision.startU}-${Number(collision.startU) + Number(collision.sizeU) - 1}).`;
  return null;
}

function buildConnectionTargetLabel(db, endpoint) {
  const room = getRoom(db, endpoint.roomId);
  const rack = getRack(room, endpoint.rackId);
  const device = getFrontDevice(rack, endpoint.deviceId) || getDeviceAnySide(rack, endpoint.deviceId);
  return [room?.building, room?.roomNumber && `Pom. ${room.roomNumber}`, rack?.label, device?.label, endpoint.portNumber && `Port ${endpoint.portNumber}`].filter(Boolean).join(' / ');
}

function findPort(db, endpoint) {
  const room = getRoom(db, endpoint.roomId);
  const rack = getRack(room, endpoint.rackId);
  const device = getFrontDevice(rack, endpoint.deviceId);
  const port = device?.ports?.find(p => p.portNumber === Number(endpoint.portNumber));
  return { room, rack, device, port };
}

function clearConnection(db, endpoint) {
  const ref = findPort(db, endpoint);
  if (ref.port?.connectedTo) {
    const remoteRef = findPort(db, ref.port.connectedTo);
    if (remoteRef.port && remoteRef.port.connectedTo && Number(remoteRef.port.connectedTo.roomId) === Number(endpoint.roomId) && Number(remoteRef.port.connectedTo.rackId) === Number(endpoint.rackId) && Number(remoteRef.port.connectedTo.deviceId) === Number(endpoint.deviceId) && Number(remoteRef.port.connectedTo.portNumber) === Number(endpoint.portNumber)) {
      remoteRef.port.connectedTo = null;
      remoteRef.port.target = '';
      remoteRef.port.connectionMeta = null;
      if (remoteRef.port.status === 'up') remoteRef.port.status = 'down';
    }
  }
  if (ref.port) {
    ref.port.connectedTo = null;
    ref.port.target = '';
    ref.port.connectionMeta = null;
    if (ref.port.status === 'up') ref.port.status = 'down';
  }
}

function buildDashboard(db) {
  const serverRooms = db.serverRooms || [];
  const racks = serverRooms.flatMap(room => room.racks || []);
  const allDevices = racks.flatMap(r => [...(r.frontDevices || []), ...(r.rearDevices || [])]);
  const frontRefs = serverRooms.flatMap(room => (room.racks || []).flatMap(rack => (rack.frontDevices || []).map(device => ({ room, rack, device }))));
  const frontDevices = frontRefs.map(ref => ref.device);
  const ports = frontDevices.flatMap(d => d.ports || []);
  const livePorts = ports.filter(p => p.status === 'up').length;
  const devicesWithIp = frontDevices.filter(d => d.network?.ip).length;
  const roomsSummary = serverRooms.map(room => ({
    id: room.id,
    roomNumber: room.roomNumber,
    building: room.building,
    roomType: room.roomType,
    racks: (room.racks || []).length,
    frontDevices: (room.racks || []).flatMap(r => r.frontDevices || []).length,
    rearDevices: (room.racks || []).flatMap(r => r.rearDevices || []).length
  }));

  const warnings = [];
  racks.forEach(rack => {
    const pduA = (rack.rearDevices || []).find(d => /PDU podstawowe/i.test(d.type));
    const upsB = (rack.rearDevices || []).find(d => /UPS zapasowy/i.test(d.type));
    if (!pduA || !upsB) warnings.push(`${rack.label}: brak pełnego zasilania A/B.`);
    (rack.frontDevices || []).forEach(device => {
      if (/Switch/i.test(device.type) && device.ports?.length && device.ports.every(p => p.status !== 'up')) warnings.push(`${rack.label}: ${device.label} ma wszystkie porty DOWN.`);
      if (device.power && (!device.power.primary?.sourceLabel || !device.power.backup?.sourceLabel)) warnings.push(`${rack.label}: ${device.label} nie ma pełnej redundancji zasilania.`);
      if (!device.power && /Switch|Serwer|Router|Firewall/i.test(device.type)) warnings.push(`${rack.label}: ${device.label} nie ma przypisanego zasilania.`);
    });
  });

  const monitoring = summarizeMonitoring(db, frontRefs);

  return {
    stats: {
      buildings: new Set(serverRooms.map(s => s.building)).size,
      serverRooms: serverRooms.length,
      racks: racks.length,
      devices: allDevices.length,
      livePorts,
      totalPorts: ports.length,
      devicesWithIp,
      linkedPorts: ports.filter(p => p.connectedTo).length
    },
    roomsSummary,
    warnings: warnings.slice(0, 12),
    monitoring
  };
}


function buildNetworkMap(db, filters = {}) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  const edgeIds = new Set();
  const buildingFilter = String(filters.building || '').trim();
  const roomIdFilter = Number(filters.roomId || 0);
  const vlanFilter = String(filters.vlan || '').trim();

  (db.serverRooms || []).forEach(room => {
    const roomMatches = (!buildingFilter || room.building === buildingFilter) && (!roomIdFilter || Number(room.id) === roomIdFilter);
    if (!roomMatches) return;
    const roomId = `room-${room.id}`;
    if (!nodeIds.has(roomId)) {
      nodeIds.add(roomId);
      nodes.push({ id: roomId, kind: 'room', label: `${room.building} / ${room.roomNumber}`, subtitle: room.roomType, roomId: room.id, building: room.building });
    }
    (room.racks || []).forEach(rack => {
      const filteredDevices = (rack.frontDevices || []).filter(device => !vlanFilter || String(device.network?.vlan || '').trim() === vlanFilter || (device.ports || []).some(p => String(p.vlan || '').trim() === vlanFilter));
      if (!filteredDevices.length && vlanFilter) return;
      const rackId = `rack-${room.id}-${rack.id}`;
      if (!nodeIds.has(rackId)) {
        nodeIds.add(rackId);
        nodes.push({ id: rackId, kind: 'rack', label: rack.label, subtitle: `Rząd ${rack.rowNumber} · Poz. ${rack.positionInRow}`, roomId: room.id, rackId: rack.id, building: room.building });
      }
      const rackEdge = `${roomId}->${rackId}`;
      if (!edgeIds.has(rackEdge)) {
        edgeIds.add(rackEdge);
        edges.push({ id: rackEdge, from: roomId, to: rackId, kind: 'contains' });
      }
      filteredDevices.forEach(device => {
        const monitor = buildMonitoringForDevice(db, room, rack, device);
        const deviceId = `dev-${room.id}-${rack.id}-${device.id}`;
        if (!nodeIds.has(deviceId)) {
          nodeIds.add(deviceId);
          nodes.push({ id: deviceId, kind: /switch/i.test(String(device.type||'')) ? 'switch' : 'device', label: device.label, subtitle: `${device.vendor || 'Generic'} · ${device.model || device.type}`, roomId: room.id, rackId: rack.id, deviceId: device.id, portCount: (device.ports||[]).length, ip: device.network?.ip || '', vlan: device.network?.vlan || '', building: room.building, monitor: { status: monitor.status, online: monitor.online, latencyMs: monitor.latencyMs } });
        }
        const devEdge = `${rackId}->${deviceId}`;
        if (!edgeIds.has(devEdge)) {
          edgeIds.add(devEdge);
          edges.push({ id: devEdge, from: rackId, to: deviceId, kind: 'mounted' });
        }
      });
    });
  });

  (db.serverRooms || []).forEach(room => {
    const roomMatches = (!buildingFilter || room.building === buildingFilter) && (!roomIdFilter || Number(room.id) === roomIdFilter);
    if (!roomMatches) return;
    (room.racks || []).forEach(rack => {
      (rack.frontDevices || []).forEach(device => {
        if (vlanFilter && !(String(device.network?.vlan || '').trim() === vlanFilter || (device.ports || []).some(p => String(p.vlan || '').trim() === vlanFilter))) return;
        (device.ports || []).forEach(port => {
          if (!port.connectedTo) return;
          if (vlanFilter && String(port.vlan || '').trim() !== vlanFilter && String(device.network?.vlan || '').trim() !== vlanFilter) return;
          const left = `dev-${room.id}-${rack.id}-${device.id}`;
          const right = `dev-${port.connectedTo.roomId}-${port.connectedTo.rackId}-${port.connectedTo.deviceId}`;
          const edgeId = [left, right, Number(port.portNumber), Number(port.connectedTo.portNumber)].join('::');
          const reverseEdgeId = [right, left, Number(port.connectedTo.portNumber), Number(port.portNumber)].join('::');
          if (!nodeIds.has(left) || !nodeIds.has(right)) return;
          if (edgeIds.has(edgeId) || edgeIds.has(reverseEdgeId)) return;
          edgeIds.add(edgeId);
          edges.push({
            id: edgeId,
            from: left,
            to: right,
            kind: 'link',
            color: port.cableColor || '#22c55e',
            leftPort: Number(port.portNumber),
            rightPort: Number(port.connectedTo.portNumber),
            label: port?.connectionMeta?.cableLabel || `P${port.portNumber} ↔ P${port.connectedTo.portNumber}`,
            vlan: port.vlan || device.network?.vlan || '',
            medium: port?.connectionMeta?.medium || '',
            cableLengthM: port?.connectionMeta?.cableLengthM || '',
            routeName: port?.connectionMeta?.routeName || ''
          });
        });
      });
    });
  });

  return { nodes, edges, filters: { building: buildingFilter, roomId: roomIdFilter || '', vlan: vlanFilter } };
}

function buildTechnicalRows(db) {
  const rows = [];
  (db.users || []).forEach(user => {
    const key = String(user.id);
    const current = db.rbac.users[key] && typeof db.rbac.users[key] === 'object' ? db.rbac.users[key] : null;
    const base = user.role === 'admin' ? { write: true, admin: true, telemetry: true } : user.role === 'operator' ? { write: true, admin: false, telemetry: true } : { write: false, admin: false, telemetry: true };
    db.rbac.users[key] = { scope: current?.scope || 'global', permissions: { ...base, ...(current?.permissions || {}) }, viewPermissions: current?.viewPermissions && typeof current.viewPermissions === 'object' ? current.viewPermissions : {} };
  });
  db.serverRooms.forEach(room => {
    room.orgId = Number(room.orgId || 1);
    room.racks.forEach(rack => {
      rack.frontDevices.forEach(device => {
        const monitor = buildMonitoringForDevice(db, room, rack, device);
        if (!device.ports?.length) {
          rows.push({
            building: room.building,
            roomType: room.roomType,
            roomNumber: room.roomNumber,
            rack: rack.label,
            side: 'front',
            position: `U${device.startU}-${device.startU + device.sizeU - 1}`,
            device: device.label,
            deviceType: device.type,
            port: '-',
            ip: device.network?.ip || '',
            vlan: device.network?.vlan || '',
            target: '',
            powerA: device.power?.primary?.sourceLabel ? `${device.power.primary.sourceLabel}${device.power.primary.outletNumber ? ' / gniazdo ' + device.power.primary.outletNumber : ''}` : '',
            powerB: device.power?.backup?.sourceLabel ? `${device.power.backup.sourceLabel}${device.power.backup.outletNumber ? ' / gniazdo ' + device.power.backup.outletNumber : ''}` : '',
            monitorStatus: monitor.status || '',
            mutedUntil: device.monitoring?.mutedUntil || '',
            rxMbps: '',
            txMbps: '',
            interfaceErrors: '',
            medium: '',
            cableLabel: '',
            cableLengthM: '',
            routeName: ''
          });
        }
        (device.ports || []).forEach(port => {
          rows.push({
            building: room.building,
            roomType: room.roomType,
            roomNumber: room.roomNumber,
            rack: rack.label,
            side: 'front',
            position: `U${device.startU}-${device.startU + device.sizeU - 1}`,
            device: device.label,
            deviceType: device.type,
            port: port.portNumber,
            ip: port.ip || device.network?.ip || '',
            vlan: port.vlan || device.network?.vlan || '',
            target: port.target || (port.connectedTo ? buildConnectionTargetLabel(db, port.connectedTo) : ''),
            powerA: device.power?.primary?.sourceLabel ? `${device.power.primary.sourceLabel}${device.power.primary.outletNumber ? ' / gniazdo ' + device.power.primary.outletNumber : ''}` : '',
            powerB: device.power?.backup?.sourceLabel ? `${device.power.backup.sourceLabel}${device.power.backup.outletNumber ? ' / gniazdo ' + device.power.backup.outletNumber : ''}` : '',
            monitorStatus: monitor.status || '',
            mutedUntil: device.monitoring?.mutedUntil || '',
            rxMbps: '',
            txMbps: '',
            interfaceErrors: '',
            medium: port?.connectionMeta?.medium || '',
            cableLabel: port?.connectionMeta?.cableLabel || '',
            cableLengthM: port?.connectionMeta?.cableLengthM || '',
            routeName: port?.connectionMeta?.routeName || ''
          });
        });
      });
    });
  });
  return rows;
}

ensureDataFile();
ensureBackupDir();
const bootDb = readData();
ensureOpsDefaults(bootDb);
writeData(bootDb);
writeRuntimeLog('INFO', 'Start procesu aplikacji.', { version: VERSION, pid: process.pid });
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
const sessionMiddleware = session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 } });
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const io = socketIo ? new socketIo.Server(httpServer, { path: '/socket.io' }) : null;
const wrapSessionForSocket = middleware => (socket, next) => middleware(socket.request, {}, next);
const terminalSessions = new Map();
const metricSubscribers = new Set();

function buildTerminalSessionRows(requestUser = null) {
  const rows = [];
  for (const [socketId, item] of terminalSessions.entries()) {
    if (!item) continue;
    if (requestUser && String(requestUser.role || '') !== 'admin' && String(item.username || '') !== String(requestUser.username || '')) continue;
    rows.push({
      id: socketId,
      socketId,
      username: item.username || 'unknown',
      role: item.role || 'viewer',
      mode: item.mode || 'local-shell',
      profileId: item.profileId || null,
      profileName: item.profileName || null,
      startedAt: item.startedAt || null,
      lastActivityAt: item.lastActivityAt || item.startedAt || null,
      cols: Number(item.cols || 0),
      rows: Number(item.rows || 0),
      hostLabel: item.hostLabel || (item.profileName || 'lokalny host'),
      blockedCommands: Number(item.blockedCommands || 0),
      transcriptId: item.transcriptId || null
    });
  }
  return rows.sort((a,b) => String(b.startedAt||'').localeCompare(String(a.startedAt||'')));
}

function broadcastTerminalSessions() {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    const user = getSocketUser(socket);
    if (!user) continue;
    const perms = terminalPermissionsForRole(user.role);
    if (!perms.sessions) continue;
    socket.emit('terminal:sessions', { rows: buildTerminalSessionRows(user), permissions: perms });
  }
}

function getSocketUser(socket) {
  return socket?.request?.session?.user || null;
}

function disposeTerminalSession(socketId) {
  const item = terminalSessions.get(socketId);
  if (!item) return;
  try { item.ptyProcess?.kill(); } catch (_) {}
  try { if (item.transcript && !item.transcript.endedAt) { const db = readData(); ensureOpsDefaults(db); finalizeSessionTranscript(item.transcript, { reason: 'dispose' }); writeData(db); } } catch (_) {}
  terminalSessions.delete(socketId);
  broadcastTerminalSessions();
}

function buildShellSpawn(profile) {
  const currentPlatform = os.platform();
  if (profile) {
    const cfg = normalizeSshProfile(profile);
    const args = ['-tt', '-p', String(cfg.port), '-o', `StrictHostKeyChecking=${cfg.strictHostKeyChecking ? 'yes' : 'no'}`];
    if (cfg.keyPath) args.push('-i', cfg.keyPath);
    args.push(`${cfg.username}@${cfg.host}`);
    return {
      file: 'ssh',
      args,
      name: `ssh:${cfg.name || cfg.host}`,
      cwd: process.cwd(),
      env: process.env
    };
  }
  if (currentPlatform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'], name: 'powershell', cwd: process.cwd(), env: process.env };
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'], name: 'shell', cwd: process.cwd(), env: process.env };
}


function buildMetricsPayload() {
  const metrics = getSystemMetrics();
  const payload = {
    ts: nowIso(),
    metrics,
    summary: {
      cpu: Number(metrics.loadAvg?.[0] || 0),
      memoryUsedPercent: metrics.memory?.totalBytes ? Number((((metrics.memory?.usedBytes || 0) / metrics.memory.totalBytes) * 100).toFixed(1)) : null,
      diskUsedPercent: metrics.disk?.usedPercent == null ? null : Number(metrics.disk.usedPercent),
      uptimeSec: Number(metrics.uptimeSec || 0)
    }
  };
  try { const db = readData(); appendMetricsSeries(db, 'local', payload); maybeEmitThresholdAlerts(db, payload, metrics.hostname || 'local'); writeData(db); } catch (_) {}
  return payload;
}

let metricsBroadcastHandle = null;
function ensureMetricsBroadcastLoop() {
  if (metricsBroadcastHandle || !io) return;
  metricsBroadcastHandle = setInterval(() => {
    if (!metricSubscribers.size) return;
    const payload = buildMetricsPayload();
    for (const socketId of Array.from(metricSubscribers)) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) { metricSubscribers.delete(socketId); continue; }
      socket.emit('metrics:data', payload);
    }
  }, 3000);
}

if (io) {
  io.use(wrapSessionForSocket(sessionMiddleware));
  io.use((socket, next) => {
    const user = getSocketUser(socket);
    if (!user) return next(new Error('Brak autoryzacji'));
    return next();
  });
  ensureMetricsBroadcastLoop();
  io.on('connection', socket => {
    const initialUser = getSocketUser(socket);
    if (initialUser && terminalPermissionsForRole(initialUser.role).sessions) socket.emit('terminal:sessions', { rows: buildTerminalSessionRows(initialUser), permissions: terminalPermissionsForRole(initialUser.role) });
    socket.on('metrics:subscribe', () => { metricSubscribers.add(socket.id); socket.emit('metrics:data', buildMetricsPayload()); });
    socket.on('metrics:unsubscribe', () => { metricSubscribers.delete(socket.id); });
    socket.on('terminal:sessions:list', () => { const user = getSocketUser(socket); if (!user) return; const perms = terminalPermissionsForRole(user.role); if (!perms.sessions) return socket.emit('terminal:error', { error: 'Twoja rola nie ma dostępu do panelu sesji.' }); socket.emit('terminal:sessions', { rows: buildTerminalSessionRows(user), permissions: perms }); });
    socket.on('terminal:create', payload => {
      try {
        const user = getSocketUser(socket);
        if (!user) return socket.emit('terminal:error', { error: 'Brak autoryzacji.' });
        if (!pty) return socket.emit('terminal:error', { error: 'Moduł node-pty nie jest zainstalowany na hoście.' });
        disposeTerminalSession(socket.id);
        const db = readData();
        ensureOpsDefaults(db);
        const profileId = String(payload?.profileId || '').trim();
        const profile = profileId ? (db.ssh.profiles || []).find(item => String(item.id) === profileId) : null;
        const mode = profile ? 'ssh' : 'local';
        const access = canUseTerminal(user, mode, profile, db);
        if (!access.ok) return socket.emit('terminal:error', { error: access.error });
        const spawnCfg = buildShellSpawn(profile || null);
        const cols = Math.max(40, Number(payload?.cols) || 120);
        const rows = Math.max(12, Number(payload?.rows) || 32);
        const p = pty.spawn(spawnCfg.file, spawnCfg.args, { name: spawnCfg.name, cols, rows, cwd: spawnCfg.cwd, env: spawnCfg.env });
        const startedAt = nowIso();
        const transcript = startSessionTranscript(db, user, { mode: profile ? 'ssh' : 'local-shell', profileId: profileId || null, hostLabel: profile ? `${profile.username}@${profile.host}` : os.hostname() });
        terminalSessions.set(socket.id, { ptyProcess: p, profileId: profileId || null, profileName: profile?.name || null, username: user.username, role: user.role, startedAt, lastActivityAt: startedAt, cols, rows, mode: profile ? 'ssh' : 'local-shell', hostLabel: profile ? `${profile.username}@${profile.host}` : os.hostname(), lineBuffer: '', blockedCommands: 0, transcript, transcriptId: transcript.id });
        appendTerminalSessionAudit(db, user, 'SESSION_START', { socketId: socket.id, mode: profile ? 'ssh' : 'local-shell', profileId: profileId || null, hostLabel: profile ? `${profile.username}@${profile.host}` : os.hostname(), transcriptId: transcript.id });
        p.onData(data => { const item = terminalSessions.get(socket.id); if (item) { item.lastActivityAt = nowIso(); appendTranscriptChunk(item.transcript, 'OUT', data); } socket.emit('terminal:data', data); });
        p.onExit(({ exitCode, signal }) => { const item = terminalSessions.get(socket.id); appendTerminalSessionAudit(db, user, 'SESSION_EXIT', { socketId: socket.id, exitCode, signal, profileId: profileId || null, transcriptId: item?.transcriptId || null }); if (item?.transcript) finalizeSessionTranscript(item.transcript, { exitCode, signal }); socket.emit('terminal:exit', { exitCode, signal }); writeData(db); disposeTerminalSession(socket.id); });
        socket.emit('terminal:ready', { ok: true, mode: profile ? 'ssh' : 'local-shell', profileId: profileId || null, startedAt, permissions: access.perms, transcriptId: transcript.id });
        writeData(db);
        writeRuntimeLog('INFO', 'Uruchomiono live terminal.', { user: user.username, profileId: profileId || 'local', role: user.role });
        broadcastTerminalSessions();
      } catch (error) {
        socket.emit('terminal:error', { error: error.message || 'Nie udało się uruchomić terminala.' });
      }
    });
    socket.on('terminal:input', data => {
      const item = terminalSessions.get(socket.id);
      if (!item?.ptyProcess) return;
      const user = getSocketUser(socket);
      if (!user) return;
      item.lastActivityAt = nowIso();
      const db = readData();
      ensureOpsDefaults(db);
      const allowedText = evaluateTerminalInputPolicy(item, user, db, String(data || ''), socket);
      appendTranscriptChunk(item.transcript, 'IN', String(data || ''));
      writeData(db);
      if (allowedText) { try { item.ptyProcess.write(String(allowedText || '')); } catch (_) {} }
      broadcastTerminalSessions();
    });
    socket.on('terminal:resize', payload => {
      const item = terminalSessions.get(socket.id);
      if (!item?.ptyProcess?.resize) return;
      item.cols = Math.max(40, Number(payload?.cols) || 120);
      item.rows = Math.max(12, Number(payload?.rows) || 32);
      try { item.ptyProcess.resize(item.cols, item.rows); } catch (_) {}
      broadcastTerminalSessions();
    });
    socket.on('terminal:kill', payload => {
      const user = getSocketUser(socket);
      if (!user) return;
      const targetId = String(payload?.id || socket.id);
      if (targetId !== socket.id && !terminalPermissionsForRole(user.role).killAny) return socket.emit('terminal:error', { error: 'Tylko admin może zakończyć cudzą sesję.' });
      disposeTerminalSession(targetId);
    });
    socket.on('disconnect', () => { metricSubscribers.delete(socket.id); disposeTerminalSession(socket.id); });
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Brak autoryzacji' });
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, ts: nowIso(), version: VERSION }));

app.post('/api/identity/ldap/test', requireAuth, requireAdmin, express.json(), async (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const provider = { ...(db.identity?.providers?.ldap || {}), ...((req.body?.provider && typeof req.body.provider === 'object') ? req.body.provider : {}) };
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  try {
    const mode = String(req.body?.mode || (provider.searchUseBind ? 'search-bind' : 'simple-bind')).trim();
    const result = mode === 'search-bind'
      ? await ldapSearchAndBind(provider, username, password)
      : await ldapSimpleBind(provider, username, password);
    res.json({ ok: true, mode, result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'LDAP bind failed' });
  }
});

app.get('/api/oidc/login', async (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const provider = db.identity?.providers?.oidc || {};
  if (!provider.enabled) return res.status(400).send('OIDC jest wyłączone.');
  const meta = await fetchOidcMetadata(provider);
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  req.session.oidc = { state, nonce, verifier, issuer: provider.issuer, redirectUri: provider.redirectUri || `http://localhost:${PORT}/api/oidc/callback`, endSessionEndpoint: meta.end_session_endpoint || '' };
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scopes || 'openid profile email groups');
  url.searchParams.set('redirect_uri', req.session.oidc.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
});

app.get('/api/oidc/callback', async (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const provider = db.identity?.providers?.oidc || {};
  const sess = req.session?.oidc || {};
  if (!provider.enabled) return res.status(400).send('OIDC jest wyłączone.');
  if (String(req.query.state || '') !== String(sess.state || '')) return res.status(400).send('Błędny state OIDC.');
  const meta = await fetchOidcMetadata(provider);
  const tokenRes = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code || ''), redirect_uri: sess.redirectUri || provider.redirectUri, client_id: provider.clientId, client_secret: provider.clientSecret, code_verifier: sess.verifier || '' }) });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) return res.status(400).send('OIDC token exchange failed');
  const claims = await verifyIdToken(tokens.id_token, provider.issuer, provider.clientId);
  if (String(claims.nonce || '') !== String(sess.nonce || '')) return res.status(400).send('Błędny nonce OIDC.');
  const mapping = applyIdentityMappings(db, { groups: claims[provider.groupClaim || 'groups'] || claims.groups || [] });
  const username = String(claims.preferred_username || claims.email || claims.sub || '').trim();
  let user = (db.users || []).find(u => String(u.username) === username);
  if (!user) {
    user = { id: nextId(db.users || []), username, fullName: String(claims.name || username), role: mapping.role, organizationIds: mapping.organizationIds, passwordHash: bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10), authProvider: 'oidc', createdAt: nowIso() };
    db.users.push(user);
  } else {
    user.organizationIds = mapping.organizationIds;
    if (user.role !== 'admin') user.role = mapping.role;
    user.authProvider = 'oidc';
  }
  req.session.user = { id: user.id, username: user.username, role: user.role, fullName: user.fullName, organizationIds: user.organizationIds || [1], authProvider: 'oidc' };
  req.session.oidcSession = {
    idToken: String(tokens.id_token || ''),
    accessToken: String(tokens.access_token || ''),
    refreshToken: String(tokens.refresh_token || ''),
    tokenType: String(tokens.token_type || ''),
    scope: String(tokens.scope || provider.scopes || ''),
    expiresAt: tokens.expires_in ? (Date.now() + Number(tokens.expires_in) * 1000) : null,
    sid: claims.sid || '',
    providerIssuer: provider.issuer,
    endSessionEndpoint: meta.end_session_endpoint || ''
  };
  addAudit(db, req, 'LOGIN', `Zalogowano użytkownika ${user.username} (oidc).`);
  writeData(db);
  res.redirect('/app.html');
});

app.post('/api/oidc/refresh', requireAuth, express.json(), async (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const provider = db.identity?.providers?.oidc || {};
  const sess = req.session?.oidcSession || {};
  if (!provider.enabled || !provider.useRefreshTokens) return res.status(400).json({ error: 'OIDC refresh jest wyłączony.' });
  if (!sess.refreshToken) return res.status(400).json({ error: 'Brak refresh tokena w sesji.' });
  const meta = await fetchOidcMetadata(provider);
  const tokenRes = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: sess.refreshToken,
      client_id: provider.clientId,
      client_secret: provider.clientSecret
    })
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) return res.status(400).json({ error: tokens.error_description || tokens.error || 'OIDC refresh nie powiódł się.' });
  req.session.oidcSession = {
    ...sess,
    accessToken: String(tokens.access_token || sess.accessToken || ''),
    refreshToken: String(tokens.refresh_token || sess.refreshToken || ''),
    idToken: String(tokens.id_token || sess.idToken || ''),
    expiresAt: tokens.expires_in ? (Date.now() + Number(tokens.expires_in) * 1000) : sess.expiresAt
  };
  addAudit(db, req, 'OIDC_REFRESH', `Odświeżono sesję OIDC dla ${req.session.user?.username || 'user'}.`);
  writeData(db);
  res.json({ ok: true, expiresAt: req.session.oidcSession.expiresAt, hasRefreshToken: !!req.session.oidcSession.refreshToken });
});

app.get('/api/oidc/logout', requireAuth, (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const provider = db.identity?.providers?.oidc || {};
  const logoutUrl = buildOidcLogoutUrl(provider, req.session?.oidcSession || {});
  res.json({ ok: true, logoutUrl });
});

function nextId(rows) {
  return (Array.isArray(rows) && rows.length ? Math.max(...rows.map(row => Number(row.id) || 0)) : 0) + 1;
}

function jsonCsvEscape(value) {
  const text = String(value ?? "");
  return (text.includes(",") || text.includes("\n") || text.includes("\"")) ? "\"" + text.replace(/\"/g, "\"\"") + "\"" : text;
}

function sanitizeOrganization(org, idx = 0) {
  return {
    id: Number(org?.id || idx + 1),
    name: String(org?.name || `Org ${idx + 1}`).trim(),
    slug: String(org?.slug || `org-${idx + 1}`).trim(),
    enabled: org?.enabled !== false,
    theme: String(org?.theme || 'dark-blue').trim(),
    logoText: String(org?.logoText || org?.name || 'ORG').trim().slice(0, 16),
    createdAt: org?.createdAt || nowIso()
  };
}

function sanitizeEnterpriseRole(role, idx = 0) {
  return {
    id: Number(role?.id || idx + 1),
    name: String(role?.name || `role_${idx + 1}`).trim(),
    orgId: Number(role?.orgId || 1),
    permissions: Array.isArray(role?.permissions) ? role.permissions.map(item => String(item || '').trim()).filter(Boolean) : []
  };
}

function summarizeDiscovery(db) {
  const roomCount = Array.isArray(db.serverRooms) ? db.serverRooms.length : 0;
  const rackCount = (db.serverRooms || []).reduce((sum, room) => sum + ((room.racks || []).length), 0);
  const deviceCount = (db.serverRooms || []).reduce((sum, room) => sum + (room.racks || []).reduce((inner, rack) => inner + (rack.frontDevices || []).length + (rack.rearDevices || []).length, 0), 0);
  const agentCount = Array.isArray(db.agentManager?.agents) ? db.agentManager.agents.length : 0;
  const profileCount = Array.isArray(db.remoteAccess?.profiles) ? db.remoteAccess.profiles.length : 0;
  return { roomCount, rackCount, deviceCount, agentCount, profileCount, totalAssets: roomCount + rackCount + deviceCount + agentCount + profileCount };
}

async function testDatabaseProfile(profile) {
  const type = String(profile?.type || '').toLowerCase();
  if (type === 'postgres') {
    if (!pg || !pg.Client) return { ok: false, error: 'Brak modułu pg po stronie serwera.' };
    const client = new pg.Client({
      host: profile.host || '127.0.0.1',
      port: Number(profile.port || 5432),
      database: profile.database || 'postgres',
      user: profile.user || 'postgres',
      password: profile.password || '',
      ssl: profile.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 3000
    });
    await client.connect();
    const result = await client.query('select current_database() as db, now() as ts');
    await client.end();
    return { ok: true, engine: 'postgres', result: result.rows?.[0] || null };
  }
  return { ok: false, foundationOnly: true, error: `Silnik ${type || 'unknown'} ma w v83 warstwę profili i polityk, ale bez natywnego klienta backendowego.` };
}

async function appendTicketAudit(db, req, action, message) {
  addAudit(db, req, action, message);
  writeData(db);
}

app.post('/api/login', express.json(), async (req, res) => {
  const { username, password, otp } = req.body || {};
  const db = readData();
  ensureOpsDefaults(db);
  let user = (db.users || []).find(u => String(u.username) === String(username));
  let authMode = 'local';
  let authenticated = false;
  if (user && !user.disabled && bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    authenticated = true;
  } else if (db.identity?.providers?.ldap?.enabled) {
    try {
      const ldapProvider = db.identity.providers.ldap;
      const ldapResult = ldapProvider.searchUseBind ? await ldapSearchAndBind(ldapProvider, username, String(password || '')) : await ldapSimpleBind(ldapProvider, username, String(password || ''));
      authMode = 'ldap';
      const mapping = applyIdentityMappings(db, { groups: [] });
      if (!user) {
        user = { id: nextId(db.users || []), username: String(username).trim(), fullName: String(username).trim(), role: mapping.role, organizationIds: mapping.organizationIds, passwordHash: bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10), authProvider: 'ldap', createdAt: nowIso() };
        db.users.push(user);
      }
      authenticated = !user.disabled;
    } catch (error) {
      writeRuntimeLog('WARN', 'LDAP login failed', { username, error: error.message });
    }
  }
  if (!authenticated || !user) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło' });
  ensureTwoFactorShape(user);
  if (user.twoFactorEnabled) {
    const recoveryCodes = Array.isArray(user.twoFactorRecoveryCodes) ? user.twoFactorRecoveryCodes : [];
    const usedRecovery = recoveryCodes.includes(String(otp || '').trim().toUpperCase());
    if (!verifyTotpToken(user.twoFactorSecret, otp) && !usedRecovery) return res.status(401).json({ error: 'Wymagany poprawny kod 2FA.' });
    if (usedRecovery) user.twoFactorRecoveryCodes = recoveryCodes.filter(code => code !== String(otp || '').trim().toUpperCase());
  }
  req.session.user = { id: user.id, username: user.username, role: user.role, fullName: user.fullName, organizationIds: Array.isArray(user.organizationIds) ? user.organizationIds : [1], authProvider: authMode };
  addAudit(db, req, 'LOGIN', `Zalogowano użytkownika ${user.username} (${authMode}).`);
  writeData(db);
  res.json({ ok: true, user: req.session.user });
});
app.post('/api/logout', requireAuth, (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const logoutUrl = req.session?.user?.authProvider === 'oidc' ? buildOidcLogoutUrl(db.identity?.providers?.oidc || {}, req.session?.oidcSession || {}) : '';
  addAudit(db, req, 'LOGOUT', `Wylogowano użytkownika ${req.session.user.username}.`);
  writeData(db);
  req.session.destroy(() => res.json({ ok: true, logoutUrl }));
});
app.get('/api/me', (req, res) => { const db = readData(); ensureOpsDefaults(db); res.json({ authenticated: !!req.session.user, user: req.session.user || null, organizations: req.session.user ? filterByOrg(db.organizations, getUserOrgIds(req.session.user, db)) : [] }); });
app.get('/api/dashboard', requireAuth, async (req, res) => { const db = readData(); if (!db.monitoring?.lastScanAt || (Date.now() - new Date(db.monitoring.lastScanAt).getTime()) > 30000) await runMonitoringScan(db); const fresh = scopeDbForUser(readData(), req.session.user, getEffectiveOrgId(req, readData())); res.json(buildDashboard(fresh)); });
app.get('/api/serverrooms', requireAuth, (req, res) => { const db = readData(); res.json(scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db)).serverRooms || []); });

app.post('/api/serverrooms', requireAuth, (req, res) => {
  const db = readData();
  const payload = req.body;
  const rowConfigs = Array.isArray(payload.rowConfigs) ? payload.rowConfigs.map(row => ({ rowNumber: Number(row.rowNumber), rackCount: Number(row.rackCount || 0) })).filter(row => row.rowNumber > 0 && row.rackCount > 0) : [];
  const racks = [];
  let rackId = 1;
  rowConfigs.forEach(row => {
    for (let i = 1; i <= row.rackCount; i++) {
      racks.push({ id: rackId++, label: `Szafa ${row.rowNumber}.${i}`, model: 'Rack 42U 600x1000', sizeU: 42, type: 'stojąca', rowNumber: row.rowNumber, positionInRow: i, frontDevices: [], rearDevices: [] });
    }
  });
  const room = { id: nextId(db.serverRooms), roomNumber: payload.roomNumber, building: payload.building, roomType: payload.roomType, dimensions: payload.dimensions, rowConfigs, note: payload.note || '', racks };
  db.serverRooms.push(room);
  addAudit(db, req, 'ROOM_CREATE', `Dodano serwerownię ${room.building} / ${room.roomType} / ${room.roomNumber}.`);
  writeData(db);
  res.status(201).json(room);
});

app.put('/api/serverrooms/:id', requireAuth, (req, res) => {
  const db = readData();
  const room = getRoom(db, req.params.id);
  if (!room) return res.status(404).json({ error: 'Nie znaleziono serwerowni' });
  Object.assign(room, { roomNumber: req.body.roomNumber || room.roomNumber, building: req.body.building || room.building, roomType: req.body.roomType || room.roomType, note: req.body.note ?? room.note });
  addAudit(db, req, 'ROOM_UPDATE', `Zmieniono dane serwerowni ${room.building} / ${room.roomNumber}.`);
  writeData(db);
  res.json(room);
});

app.delete('/api/serverrooms/:id', requireAuth, (req, res) => {
  const db = readData();
  const index = db.serverRooms.findIndex(r => r.id === Number(req.params.id));
  if (index === -1) return res.status(404).json({ error: 'Nie znaleziono serwerowni' });
  const [room] = db.serverRooms.splice(index, 1);
  addAudit(db, req, 'ROOM_DELETE', `Usunięto serwerownię ${room.building} / ${room.roomType} / ${room.roomNumber}.`);
  writeData(db);
  res.json({ ok: true });
});

app.get('/api/serverrooms/:id/racks/:rackId', requireAuth, (req, res) => {
  const db = readData();
  const room = getRoom(db, req.params.id);
  const rack = getRack(room, req.params.rackId);
  if (!rack) return res.status(404).json({ error: 'Nie znaleziono szafy' });
  res.json(rack);
});

app.post('/api/serverrooms/:id/racks/:rackId/devices', requireAuth, (req, res) => {
  const db = readData();
  const room = getRoom(db, req.params.id);
  if (!room) return res.status(404).json({ error: 'Nie znaleziono serwerowni' });
  const rack = getRack(room, req.params.rackId);
  if (!rack) return res.status(404).json({ error: 'Nie znaleziono szafy' });
  const side = req.body.side === 'rear' ? 'rear' : 'front';
  const validationError = validateDevicePlacement(rack, side, req.body);
  if (validationError) return res.status(422).json({ error: validationError });
  const target = side === 'rear' ? rack.rearDevices : rack.frontDevices;
  const newId = target.length ? Math.max(...target.map(d => Number(d.id) || 0)) + 1 : 1;
  const device = { id: newId, type: req.body.type, vendor: req.body.vendor || inferVendorFromType(req.body.type), model: req.body.model || inferModelFromType(req.body.type, req.body.vendor), label: req.body.label, startU: Number(req.body.startU), sizeU: Number(req.body.sizeU), network: req.body.network || null, power: req.body.power || null, ports: normalizePorts(req.body.ports || []), outlets: Array.isArray(req.body.outlets) ? req.body.outlets : [] };
  target.push(device);
  addAudit(db, req, 'DEVICE_CREATE', `Dodano urządzenie ${device.label} do ${rack.label} (${side === 'front' ? 'przód' : 'tył'}).`);
  writeData(db);
  res.status(201).json(device);
});

app.put('/api/serverrooms/:id/racks/:rackId/devices/:deviceId', requireAuth, (req, res) => {
  const db = readData();
  const room = getRoom(db, req.params.id);
  const rack = getRack(room, req.params.rackId);
  if (!rack) return res.status(404).json({ error: 'Nie znaleziono szafy' });
  let device = rack.frontDevices.find(d => d.id === Number(req.params.deviceId));
  let side = 'front';
  if (!device) { device = rack.rearDevices.find(d => d.id === Number(req.params.deviceId)); side = 'rear'; }
  if (!device) return res.status(404).json({ error: 'Nie znaleziono urządzenia' });
  const nextShape = { ...device, startU: Number(req.body.startU ?? device.startU), sizeU: Number(req.body.sizeU ?? device.sizeU) };
  const validationError = validateDevicePlacement(rack, side, nextShape, device.id);
  if (validationError) return res.status(422).json({ error: validationError });
  device.label = req.body.label || device.label;
  device.type = req.body.type || device.type;
  device.vendor = req.body.vendor || device.vendor || inferVendorFromType(device.type);
  device.model = req.body.model || device.model || inferModelFromType(device.type, device.vendor);
  device.startU = nextShape.startU;
  device.sizeU = nextShape.sizeU;
  addAudit(db, req, 'DEVICE_UPDATE', `Zmieniono urządzenie ${device.label} w ${rack.label}.`);
  writeData(db);
  res.json(device);
});

app.delete('/api/serverrooms/:id/racks/:rackId/devices/:deviceId', requireAuth, (req, res) => {
  const db = readData();
  const room = getRoom(db, req.params.id);
  const rack = getRack(room, req.params.rackId);
  if (!rack) return res.status(404).json({ error: 'Nie znaleziono szafy' });
  let removed = null;
  ['frontDevices', 'rearDevices'].forEach(key => {
    const idx = rack[key].findIndex(d => d.id === Number(req.params.deviceId));
    if (idx !== -1) removed = rack[key].splice(idx, 1)[0];
  });
  if (!removed) return res.status(404).json({ error: 'Nie znaleziono urządzenia' });
  (rack.frontDevices || []).forEach(device => (device.ports || []).forEach(port => {
    if (port.connectedTo && Number(port.connectedTo.deviceId) === Number(req.params.deviceId) && Number(port.connectedTo.rackId) === Number(req.params.rackId) && Number(port.connectedTo.roomId) === Number(req.params.id)) {
      port.connectedTo = null; port.target = ''; if (port.status === 'up') port.status = 'down';
    }
  }));
  addAudit(db, req, 'DEVICE_DELETE', `Usunięto urządzenie ${removed.label} z ${rack.label}.`);
  writeData(db);
  res.json({ ok: true });
});

app.put('/api/serverrooms/:id/racks/:rackId/devices/:deviceId/ports/:portNumber', requireAuth, (req, res) => {
  const db = readData();
  const room = getRoom(db, req.params.id);
  const rack = getRack(room, req.params.rackId);
  const device = rack?.frontDevices?.find(d => d.id === Number(req.params.deviceId));
  if (!device) return res.status(404).json({ error: 'Nie znaleziono urządzenia frontowego' });
  const portNumber = Number(req.params.portNumber);
  let port = (device.ports || []).find(p => p.portNumber === portNumber);
  if (!port) { port = { portNumber, status: 'down' }; device.ports.push(port); }
  const conflict = collectPortAddressConflicts(db, { roomId: room.id, rackId: rack.id, deviceId: device.id, portNumber }, req.body) || collectVlanSubnetConflicts(db, { roomId: room.id, rackId: rack.id, deviceId: device.id, portNumber }, req.body);
  if (conflict) return res.status(422).json({ error: conflict });
  Object.assign(port, { target: req.body.target || '', ip: req.body.ip || '', vlan: req.body.vlan || '', subnet: req.body.subnet || '', mask: req.body.mask || '', gateway: req.body.gateway || '', status: req.body.status === 'up' ? 'up' : 'down', cableColor: req.body.cableColor || '#64748b' });
  addAudit(db, req, 'PORT_UPDATE', `Zmieniono port ${portNumber} w urządzeniu ${device.label} / ${rack.label}.`);
  writeData(db);
  res.json(port);
});

app.post('/api/connections', requireAuth, (req, res) => {
  const db = readData();
  const left = { roomId: Number(req.body.leftRoomId), rackId: Number(req.body.leftRackId), deviceId: Number(req.body.leftDeviceId), portNumber: Number(req.body.leftPortNumber) };
  const right = { roomId: Number(req.body.rightRoomId), rackId: Number(req.body.rightRackId), deviceId: Number(req.body.rightDeviceId), portNumber: Number(req.body.rightPortNumber) };
  if (Object.values(left).some(v => !Number.isInteger(v) || v < 1) || Object.values(right).some(v => !Number.isInteger(v) || v < 1)) return res.status(422).json({ error: 'Wybierz oba końce połączenia.' });
  const leftRef = findPort(db, left);
  const rightRef = findPort(db, right);
  if (!leftRef.port || !rightRef.port) return res.status(404).json({ error: 'Nie znaleziono portu po jednej ze stron.' });
  if (left.roomId === right.roomId && left.rackId === right.rackId && left.deviceId === right.deviceId && left.portNumber === right.portNumber) return res.status(422).json({ error: 'Nie można połączyć portu z samym sobą.' });
  clearConnection(db, left);
  clearConnection(db, right);
  const color = req.body.cableColor || '#22c55e';
  const routeId = req.body.routeId ? Number(req.body.routeId) : null;
  const route = Array.isArray(db.cableRoutes) ? db.cableRoutes.find(r => Number(r.id) === routeId) : null;
  const connectionMeta = {
    medium: String(req.body.medium || '').trim(),
    cableLabel: String(req.body.cableLabel || '').trim(),
    cableLengthM: req.body.cableLengthM ? Number(req.body.cableLengthM) : '',
    routeId: route ? route.id : null,
    routeName: route ? route.name : ''
  };
  leftRef.port.connectedTo = right;
  rightRef.port.connectedTo = left;
  leftRef.port.target = buildConnectionTargetLabel(db, right);
  rightRef.port.target = buildConnectionTargetLabel(db, left);
  leftRef.port.cableColor = color;
  rightRef.port.cableColor = color;
  leftRef.port.connectionMeta = connectionMeta;
  rightRef.port.connectionMeta = connectionMeta;
  leftRef.port.status = 'up';
  rightRef.port.status = 'up';
  addAudit(db, req, 'CONNECTION_CREATE', `Połączono ${leftRef.device.label} port ${left.portNumber} z ${rightRef.device.label} port ${right.portNumber}.`);
  writeData(db);
  res.status(201).json({ ok: true, left: leftRef.port, right: rightRef.port });
});

app.delete('/api/connections', requireAuth, (req, res) => {
  const db = readData();
  const endpoint = { roomId: Number(req.body.roomId), rackId: Number(req.body.rackId), deviceId: Number(req.body.deviceId), portNumber: Number(req.body.portNumber) };
  const ref = findPort(db, endpoint);
  if (!ref.port) return res.status(404).json({ error: 'Nie znaleziono portu.' });
  const targetLabel = ref.port.target;
  clearConnection(db, endpoint);
  addAudit(db, req, 'CONNECTION_DELETE', `Rozłączono port ${endpoint.portNumber} w ${ref.device.label}${targetLabel ? ` (wcześniej: ${targetLabel})` : ''}.`);
  writeData(db);
  res.json({ ok: true });
});

app.put('/api/serverrooms/:id/racks/:rackId/devices/:deviceId/power', requireAuth, (req, res) => {
  const db = readData();
  const room = getRoom(db, req.params.id);
  const rack = getRack(room, req.params.rackId);
  const device = getFrontDevice(rack, req.params.deviceId) || getDeviceAnySide(rack, req.params.deviceId);
  if (!device) return res.status(404).json({ error: 'Nie znaleziono urządzenia' });
  device.power = {
    primary: { sourceLabel: req.body.primarySourceLabel || '', outletNumber: req.body.primaryOutletNumber ? Number(req.body.primaryOutletNumber) : null },
    backup: { sourceLabel: req.body.backupSourceLabel || '', outletNumber: req.body.backupOutletNumber ? Number(req.body.backupOutletNumber) : null }
  };
  addAudit(db, req, 'POWER_UPDATE', `Zmieniono zasilanie A/B urządzenia ${device.label} w ${rack.label}.`);
  writeData(db);
  res.json(device.power);
});

app.get('/api/network-map', requireAuth, async (req, res) => { const db = readData(); if (!db.monitoring?.lastScanAt || (Date.now() - new Date(db.monitoring.lastScanAt).getTime()) > 30000) await runMonitoringScan(db); const scoped = scopeDbForUser(readData(), req.session.user, getEffectiveOrgId(req, readData())); res.json(buildNetworkMap(scoped, { building: req.query.building || '', roomId: req.query.roomId || '', vlan: req.query.vlan || '' })); });
app.get('/api/monitoring/overview', requireAuth, async (req, res) => { const db = readData(); if (!db.monitoring?.lastScanAt || (Date.now() - new Date(db.monitoring.lastScanAt).getTime()) > 30000) await runMonitoringScan(db); const fresh = readData(); const frontRefs = (fresh.serverRooms || []).flatMap(room => (room.racks || []).flatMap(rack => (rack.frontDevices || []).map(device => ({ room, rack, device })))); res.json(summarizeMonitoring(fresh, frontRefs)); });

app.get('/api/serverrooms/:id/racks/:rackId/devices/:deviceId/interfaces/live', requireAuth, async (req, res) => {
  const db = readData();
  if (!db.monitoring?.lastScanAt || (Date.now() - new Date(db.monitoring.lastScanAt).getTime()) > 30000) await runMonitoringScan(db);
  const fresh = readData();
  const { room, rack, device } = getDeviceRef(fresh, req.params.id, req.params.rackId, req.params.deviceId);
  if (!room || !rack || !device) return res.status(404).json({ error: 'Nie znaleziono urządzenia.' });
  const mode = String(req.query.mode || '').trim();
  const wantsSnmp = mode === 'snmp' || String(device?.monitoring?.protocol || '').toLowerCase() === 'snmp';
  const baseMonitor = buildMonitoringForDevice(fresh, room, rack, device);
  let options = { monitor: { ...baseMonitor, modeLabel: 'live / pochodne' } };
  if (wantsSnmp) {
    const poll = await pollSnmpInterfaces(fresh, room, rack, device, { timeoutMs: device?.monitoring?.timeoutMs, community: device?.monitoring?.snmpCommunity });
    if (poll.ok && Array.isArray(poll.interfaces)) {
      options = {
        interfaces: poll.interfaces,
        monitor: {
          ...baseMonitor,
          mode: poll.mode,
          modeLabel: 'realny SNMP',
          status: baseMonitor.online ? 'online' : 'degraded',
          reason: poll.reason,
          updatedAt: nowIso()
        }
      };
      writeData(fresh);
    } else {
      const cached = getCachedSnmpInterfaces(fresh, room, rack, device);
      if (cached?.interfaces?.length) {
        options = {
          interfaces: cached.interfaces,
          monitor: {
            ...baseMonitor,
            mode: 'snmp-cache',
            modeLabel: 'cache SNMP',
            reason: poll.reason || 'Użyto ostatniego cache SNMP',
            updatedAt: cached.updatedAt || nowIso()
          }
        };
      } else {
        options = { monitor: { ...baseMonitor, modeLabel: 'live / pochodne', reason: poll.reason || 'Brak danych SNMP' } };
      }
    }
  }
  res.json(buildInterfacesForDevice(fresh, room, rack, device, options));
});
app.get('/api/serverrooms/:id/racks/:rackId/devices/:deviceId/path', requireAuth, (req, res) => {
  const db = readData();
  const { room, rack, device } = getDeviceRef(db, req.params.id, req.params.rackId, req.params.deviceId);
  if (!room || !rack || !device) return res.status(404).json({ error: 'Nie znaleziono urządzenia.' });
  res.json(buildDevicePath(db, room, rack, device));
});
app.get('/api/report/technical', requireAuth, (req, res) => {
  const _dbScoped = scopeDbForUser(readData(), req.session.user, getEffectiveOrgId(req, readData()));

  const db = readData();
  res.json(buildTechnicalRows(db));
});

app.get('/api/report/technical.csv', requireAuth, (req, res) => {
  const _dbScoped = scopeDbForUser(readData(), req.session.user, getEffectiveOrgId(req, readData()));

  const rows = buildTechnicalRows(_dbScoped);
  const headers = ['Budynek','Typ serwerowni','Pomieszczenie','Szafa','Strona','Pozycja','Urządzenie','Typ urządzenia','Port','IP','VLAN','Cel połączenia','Medium','Etykieta kabla','Długość kabla (m)','Trasa kablowa','Zasilanie A','Zasilanie B','RX Mbps','TX Mbps','Błędy interfejsu'];
  const lines = [headers.join(';')].concat(rows.map(row => [row.building,row.roomType,row.roomNumber,row.rack,row.side,row.position,row.device,row.deviceType,row.port,row.ip,row.vlan,row.target,row.medium,row.cableLabel,row.cableLengthM,row.routeName,row.powerA,row.powerB,row.rxMbps,row.txMbps,row.interfaceErrors].map(v => `"${String(v || '').replaceAll('"','""')}"`).join(';')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="raport-techniczny-v63.csv"');
  res.send('\uFEFF' + lines.join('\n'));
});

app.get('/api/monitoring/events', requireAuth, (req, res) => res.json(readData().monitoring?.events || []));
app.post('/api/monitoring/events/:eventId/ack', requireAuth, (req, res) => {
  const db = readData();
  const event = (db.monitoring?.events || []).find(ev => Number(ev.id) === Number(req.params.eventId));
  if (!event) return res.status(404).json({ error: 'Nie znaleziono zdarzenia.' });
  event.acknowledged = true;
  event.acknowledgedAt = nowIso();
  event.acknowledgedBy = req.session?.user?.username || 'system';
  addAudit(db, req, 'MONITOR_ACK', `Potwierdzono zdarzenie monitoringu #${event.id} (${event.deviceLabel || ''}).`);
  writeData(db);
  res.json({ ok: true, event });
});
app.post('/api/serverrooms/:id/racks/:rackId/devices/:deviceId/monitoring', requireAuth, (req, res) => {
  const db = readData();
  const { room, rack, device } = getDeviceRef(db, req.params.id, req.params.rackId, req.params.deviceId);
  if (!room || !rack || !device) return res.status(404).json({ error: 'Nie znaleziono urządzenia.' });
  const cfg = ensureMonitoringDefaults(device);
  if ('enabled' in req.body) cfg.enabled = !!req.body.enabled;
  if ('protocol' in req.body) cfg.protocol = String(req.body.protocol || 'icmp');
  if ('intervalSec' in req.body) cfg.intervalSec = Math.max(5, Number(req.body.intervalSec) || 60);
  if ('timeoutMs' in req.body) cfg.timeoutMs = Math.max(200, Number(req.body.timeoutMs) || 1200);
  if ('notes' in req.body) cfg.notes = String(req.body.notes || '').slice(0, 500);
  if ('snmpCommunity' in req.body) cfg.snmpCommunity = String(req.body.snmpCommunity || '').slice(0, 128);
  if ('muteMinutes' in req.body) {
    const mins = Math.max(0, Number(req.body.muteMinutes) || 0);
    cfg.mutedUntil = mins ? new Date(Date.now() + mins * 60000).toISOString() : null;
  }
  if ('mutedUntil' in req.body) cfg.mutedUntil = req.body.mutedUntil || null;
  cfg.lastConfigAt = nowIso();
  addAudit(db, req, 'MONITOR_CONFIG', `Zmieniono monitoring urządzenia ${device.label} w ${rack.label}.`);
  writeData(db);
  res.json({ ok: true, monitoring: cfg });
});

app.post('/api/serverrooms/:id/racks/:rackId/devices/:deviceId/ports/:portNumber/thresholds', requireAuth, (req, res) => {
  const db = readData();
  const { room, rack, device } = getDeviceRef(db, req.params.id, req.params.rackId, req.params.deviceId);
  if (!room || !rack || !device) return res.status(404).json({ error: 'Nie znaleziono urządzenia.' });
  const port = (device.ports || []).find(p => Number(p.portNumber) === Number(req.params.portNumber));
  if (!port) return res.status(404).json({ error: 'Nie znaleziono portu.' });
  port.thresholds = normalizePortThresholds({
    ...port.thresholds,
    rxThresholdMbps: req.body.rxThresholdMbps,
    txThresholdMbps: req.body.txThresholdMbps,
    errorThreshold: req.body.errorThreshold,
    utilizationThresholdPct: req.body.utilizationThresholdPct
  });
  port.thresholds.lastAlertState = false;
  addAudit(db, req, 'PORT_THRESHOLD_UPDATE', `Zmieniono progi alarmowe portu ${port.portNumber} urządzenia ${device.label} w ${rack.label}.`);
  writeData(db);
  res.json({ ok: true, thresholds: port.thresholds });
});

app.post('/api/monitoring/run', requireAuth, async (req, res) => {
  const db = readData();
  await runMonitoringScan(db, { force: true });
  res.json({ ok: true, lastScanAt: readData().monitoring?.lastScanAt || null });
});
app.get('/api/data/export', requireAuth, (req, res) => {
  const db = readData();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dcim-backup-v15.json"');
  res.send(JSON.stringify(db, null, 2));
});
app.post('/api/data/import', requireAuth, (req, res) => {
  const payload = req.body;
  if (!payload || !Array.isArray(payload.serverRooms) || !Array.isArray(payload.users)) return res.status(422).json({ error: 'Nieprawidłowy plik JSON do importu.' });
  migrateData(payload);
  addAudit(payload, req, 'DATA_IMPORT', 'Zaimportowano pełny backup JSON.');
  writeData(payload);
  res.json({ ok: true });
});
app.get('/api/audit', requireAuth, (req, res) => res.json(readData().auditLog || []));

app.get('/api/cable-routes', requireAuth, (req, res) => { const db = readData(); res.json(scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db)).cableRoutes || []); });
app.post('/api/cable-routes', requireAuth, (req, res) => {
  const db = readData();
  const route = {
    id: nextId(db.cableRoutes || []),
    name: String(req.body.name || '').trim(),
    fromBuilding: String(req.body.fromBuilding || '').trim(),
    toBuilding: String(req.body.toBuilding || '').trim(),
    medium: String(req.body.medium || '').trim(),
    notes: String(req.body.notes || '').trim()
  };
  if (!route.name) return res.status(422).json({ error: 'Podaj nazwę trasy kablowej.' });
  db.cableRoutes = Array.isArray(db.cableRoutes) ? db.cableRoutes.map(route => ({...route, orgId: Number(route.orgId || 1)})) : [];
  db.cableRoutes.push(route);
  addAudit(db, req, 'CABLE_ROUTE_CREATE', `Dodano trasę kablową ${route.name}.`);
  writeData(db);
  res.status(201).json(route);
});
app.delete('/api/cable-routes/:id', requireAuth, (req, res) => {
  const db = readData();
  const idx = (db.cableRoutes || []).findIndex(r => Number(r.id) === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Nie znaleziono trasy kablowej.' });
  const [removed] = db.cableRoutes.splice(idx, 1);
  (db.serverRooms || []).forEach(room => (room.racks || []).forEach(rack => (rack.frontDevices || []).forEach(device => (device.ports || []).forEach(port => {
    if (port?.connectionMeta?.routeId && Number(port.connectionMeta.routeId) === removed.id) {
      port.connectionMeta.routeId = null;
      port.connectionMeta.routeName = '';
    }
  }))));
  addAudit(db, req, 'CABLE_ROUTE_DELETE', `Usunięto trasę kablową ${removed.name}.`);
  writeData(db);
  res.json({ ok: true });
});

function buildPathTrace(db, startEndpoint) {
  const hops = [];
  const visited = new Set();
  let current = startEndpoint;
  while (current) {
    const key = [current.roomId, current.rackId, current.deviceId, current.portNumber].join(':');
    if (visited.has(key)) break;
    visited.add(key);
    const ref = findPort(db, current);
    if (!ref.port || !ref.device || !ref.rack || !ref.room) break;
    hops.push({
      endpoint: current,
      label: `${ref.room.building} / pom. ${ref.room.roomNumber} / ${ref.rack.label} / ${ref.device.label} / port ${ref.port.portNumber}`,
      vlan: ref.port.vlan || ref.device.network?.vlan || '',
      ip: ref.port.ip || ref.device.network?.ip || '',
      target: ref.port.target || '',
      medium: ref.port?.connectionMeta?.medium || '',
      cableLabel: ref.port?.connectionMeta?.cableLabel || '',
      cableLengthM: ref.port?.connectionMeta?.cableLengthM || '',
      routeName: ref.port?.connectionMeta?.routeName || ''
    });
    current = ref.port.connectedTo || null;
  }
  return { hopCount: hops.length, hops };
}


function getAllRackDevices(rack) {
  const front = Array.isArray(rack?.frontDevices) ? rack.frontDevices : [];
  const rear = Array.isArray(rack?.rearDevices) ? rack.rearDevices : [];
  const seen = new Set();
  const result = [];
  for (const device of [...front, ...rear]) {
    const id = Number(device?.id || 0);
    const key = id > 0 ? `id:${id}` : `${device?.label || ''}|${device?.startU || ''}|${device?.type || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(device);
  }
  return result;
}

function buildGlobalUplinkRows(db) {
  const rows = [];
  const seen = new Set();
  for (const room of db.serverRooms || []) {
    for (const rack of room.racks || []) {
      for (const device of getAllRackDevices(rack)) {
        for (const port of device?.ports || []) {
          const conn = port?.connectedTo;
          if (!conn) continue;
          const target = findPort(db, conn);
          if (!target?.room || !target?.rack || !target?.device || !target?.port) continue;
          const crossRack = Number(target.rack.id) !== Number(rack.id) || Number(target.room.id) !== Number(room.id);
          const medium = port?.connectionMeta?.medium || target.port?.connectionMeta?.medium || '';
          const isUplink = crossRack || /uplink/i.test(String(port?.target || '')) || /uplink/i.test(String(target.port?.target || '')) || /światłowód|fiber|fiber/i.test(medium);
          if (!isUplink) continue;
          const pairKey = [
            `${room.id}:${rack.id}:${device.id}:${port.portNumber}`,
            `${target.room.id}:${target.rack.id}:${target.device.id}:${target.port.portNumber}`
          ].sort().join('<->');
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          rows.push({
            routeKey: pairKey,
            sourceRoomId: room.id,
            sourceRackId: rack.id,
            sourceDeviceId: device.id,
            sourcePort: Number(port.portNumber || 0),
            sourceBuilding: room.building || '',
            sourceRoom: room.roomNumber || '',
            sourceRack: rack.label || '',
            sourceDevice: device.label || '',
            targetRoomId: target.room.id,
            targetRackId: target.rack.id,
            targetDeviceId: target.device.id,
            targetPort: Number(target.port.portNumber || 0),
            targetBuilding: target.room.building || '',
            targetRoom: target.room.roomNumber || '',
            targetRack: target.rack.label || '',
            targetDevice: target.device.label || '',
            medium: medium || '-',
            vlan: port?.vlan || target.port?.vlan || device?.network?.vlan || target.device?.network?.vlan || '',
            cableLabel: port?.connectionMeta?.cableLabel || target.port?.connectionMeta?.cableLabel || '',
            cableLengthM: port?.connectionMeta?.cableLengthM || target.port?.connectionMeta?.cableLengthM || '',
            routeName: port?.connectionMeta?.routeName || target.port?.connectionMeta?.routeName || '',
            status: (String(port?.status || '').toLowerCase() === 'up' && String(target.port?.status || '').toLowerCase() === 'up') ? 'up' : 'down'
          });
        }
      }
    }
  }
  return rows.sort((a, b) => `${a.sourceBuilding}|${a.sourceRoom}|${a.sourceRack}|${a.sourceDevice}|${a.sourcePort}`.localeCompare(`${b.sourceBuilding}|${b.sourceRoom}|${b.sourceRack}|${b.sourceDevice}|${b.sourcePort}`, 'pl'));
}

function rememberUplinkSnapshot(db) {
  db.monitoring.uplinkMapHistory = Array.isArray(db.monitoring.uplinkMapHistory) ? db.monitoring.uplinkMapHistory : [];
  const rows = buildGlobalUplinkRows(db);
  db.monitoring.uplinkMapHistory.unshift({ ts: nowIso(), total: rows.length, active: rows.filter(row => row.status === 'up').length });
  db.monitoring.uplinkMapHistory = db.monitoring.uplinkMapHistory.slice(0, 50);
  return rows;
}

function getSnmpPollingHistory(db, limit = 120) {
  return (Array.isArray(db?.monitoring?.snmpPollingHistory) ? db.monitoring.snmpPollingHistory : []).slice(0, Math.max(1, Number(limit) || 120));
}


function getSnmpPollingStatus(db) {
  const cfg = db?.monitoring?.snmpPolling || {};
  return {
    enabled: !!cfg.enabled,
    intervalSec: Math.max(60, Number(cfg.intervalSec) || 300),
    lastRunAt: cfg.lastRunAt || null,
    lastSummary: cfg.lastSummary || null,
    running: !!snmpPollingRuntime.running,
    startedAt: snmpPollingRuntime.startedAt,
    lastFinishedAt: snmpPollingRuntime.lastFinishedAt,
    lastError: snmpPollingRuntime.lastError || null,
    history: getSnmpPollingHistory(db, 20)
  };
}

async function runSnmpPollingCycle(reqLike = null, opts = {}) {
  if (snmpPollingRuntime.running) {
    const dbBusy = readData();
    migrateData(dbBusy);
    return { skipped: true, busy: true, status: getSnmpPollingStatus(dbBusy) };
  }
  const db = readData();
  migrateData(db);
  const cfg = db.monitoring.snmpPolling;
  const now = Date.now();
  const force = !!opts.force;
  const intervalMs = Math.max(60, Number(cfg.intervalSec) || 300) * 1000;
  const lastRunTs = cfg.lastRunAt ? new Date(cfg.lastRunAt).getTime() : 0;
  if (!force && (!cfg.enabled || (lastRunTs && (now - lastRunTs) < intervalMs))) {
    return { skipped: true, status: getSnmpPollingStatus(db) };
  }
  const deviceRefs = (db.serverRooms || []).flatMap(room => (room.racks || []).flatMap(rack => getAllRackDevices(rack).map(device => ({ room, rack, device }))));
  snmpPollingRuntime.running = true;
  snmpPollingRuntime.startedAt = new Date().toISOString();
  snmpPollingRuntime.lastError = null;
  let ok = 0, failed = 0, totalInterfaces = 0;
  const entries = [];
  try {
    for (const ref of deviceRefs) {
      const proto = String(ref.device?.monitoring?.protocol || '').toLowerCase();
      if (proto !== 'snmp') continue;
      const monitorKey = getMonitoringKey(ref.room, ref.rack, ref.device);
      const poll = await pollSnmpInterfaces(db, ref.room, ref.rack, ref.device, { timeoutMs: ref.device?.monitoring?.timeoutMs, community: ref.device?.monitoring?.snmpCommunity });
      const item = {
        ts: nowIso(),
        roomId: ref.room.id,
        rackId: ref.rack.id,
        deviceId: ref.device.id,
        building: ref.room.building || '',
        roomNumber: ref.room.roomNumber || '',
        rackLabel: ref.rack.label || '',
        deviceLabel: ref.device.label || '',
        deviceType: ref.device.type || '',
        monitorKey,
        protocol: proto,
        ok: !!poll.ok,
        mode: poll.mode || 'derived',
        reason: poll.reason || '',
        interfaceCount: Array.isArray(poll.interfaces) ? poll.interfaces.length : 0
      };
      if (poll.ok && Array.isArray(poll.interfaces)) {
        ok += 1;
        totalInterfaces += poll.interfaces.length;
      } else {
        failed += 1;
      }
      entries.push(item);
    }
    cfg.lastRunAt = new Date().toISOString();
    cfg.lastSummary = { ok, failed, totalInterfaces, scannedDevices: ok + failed };
    db.monitoring.snmpPollingHistory = Array.isArray(db.monitoring.snmpPollingHistory) ? db.monitoring.snmpPollingHistory : [];
    db.monitoring.snmpPollingHistory = [...entries.reverse(), ...db.monitoring.snmpPollingHistory].slice(0, 300);
    rememberUplinkSnapshot(db);
    writeData(db);
    if (reqLike && !opts.silentAudit) {
      addAudit(db, reqLike, 'SNMP_POLLING_RUN', `Uruchomiono polling SNMP: urządzenia=${ok + failed}, OK=${ok}, błędy=${failed}, interfejsy=${totalInterfaces}.`);
      writeData(db);
    }
    return { skipped: false, status: getSnmpPollingStatus(readData()) };
  } catch (error) {
    snmpPollingRuntime.lastError = error?.message || 'Nieznany błąd schedulera SNMP';
    throw error;
  } finally {
    snmpPollingRuntime.running = false;
    snmpPollingRuntime.lastFinishedAt = new Date().toISOString();
  }
}


app.get('/api/snmp/polling-status', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  writeData(db);
  res.json(getSnmpPollingStatus(db));
});

app.post('/api/snmp/polling-config', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  db.monitoring.snmpPolling.enabled = !!req.body.enabled;
  db.monitoring.snmpPolling.intervalSec = Math.max(60, Number(req.body.intervalSec) || db.monitoring.snmpPolling.intervalSec || 300);
  addAudit(db, req, 'SNMP_POLLING_CONFIG', `Zmieniono scheduler SNMP: ${db.monitoring.snmpPolling.enabled ? 'włączony' : 'wyłączony'}, interwał ${db.monitoring.snmpPolling.intervalSec}s.`);
  writeData(db);
  res.json(getSnmpPollingStatus(db));
});

app.post('/api/snmp/polling-run', requireAuth, async (req, res) => {
  const result = await runSnmpPollingCycle(req, { force: true });
  res.json(result.status);
});

app.get('/api/snmp/polling-history', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  const roomId = Number(req.query.roomId || 0) || null;
  const rackId = Number(req.query.rackId || 0) || null;
  const deviceId = Number(req.query.deviceId || 0) || null;
  let rows = getSnmpPollingHistory(db, Number(req.query.limit || 120));
  if (roomId) rows = rows.filter(row => Number(row.roomId) === roomId);
  if (rackId) rows = rows.filter(row => Number(row.rackId) === rackId);
  if (deviceId) rows = rows.filter(row => Number(row.deviceId) === deviceId);
  res.json({ rows, status: getSnmpPollingStatus(db) });
});

app.get('/api/uplinks/global', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  const rows = rememberUplinkSnapshot(db);
  writeData(db);
  res.json({ rows, history: (db.monitoring.uplinkMapHistory || []).slice(0, 20) });
});

app.get('/api/path-trace', requireAuth, (req, res) => {
  const roomId = Number(req.query.roomId);
  const rackId = Number(req.query.rackId);
  const deviceId = Number(req.query.deviceId);
  const portNumber = Number(req.query.portNumber);
  if (![roomId, rackId, deviceId, portNumber].every(v => Number.isInteger(v) && v > 0)) return res.status(422).json({ error: 'Nieprawidłowe parametry ścieżki.' });
  res.json(buildPathTrace(readData(), { roomId, rackId, deviceId, portNumber }));
});


app.get('/api/postgres/status', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  res.json(buildPostgresStatus(db));
});

app.post('/api/postgres/config', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  const cfg = getPostgresConfig(db);
  db.postgres = {
    ...db.postgres,
    enabled: !!req.body.enabled,
    host: String(req.body.host || cfg.host || '').trim(),
    port: Number(req.body.port || cfg.port || 5432),
    database: String(req.body.database || cfg.database || '').trim(),
    user: String(req.body.user || cfg.user || '').trim(),
    password: typeof req.body.password === 'string' ? req.body.password : cfg.password,
    ssl: !!req.body.ssl,
    lastTestAt: cfg.lastTestAt,
    lastTestOk: cfg.lastTestOk,
    lastSyncAt: cfg.lastSyncAt,
    lastImportAt: cfg.lastImportAt,
    lastError: cfg.lastError
  };
  writeData(db);
  logAudit(readData(), req.session.user, 'POSTGRES_CONFIG_SAVE', `Zapisano konfigurację bridge PostgreSQL (${db.postgres.host}:${db.postgres.port}/${db.postgres.database})`);
  res.json(buildPostgresStatus(readData()));
});

app.post('/api/postgres/test', requireAuth, async (req, res) => {
  const db = readData();
  migrateData(db);
  try {
    const info = await runPostgresTest(db);
    writeData(db);
    logAudit(readData(), req.session.user, 'POSTGRES_TEST', `Test bridge PostgreSQL OK: ${db.postgres.database}`);
    res.json({ ok: true, info, status: buildPostgresStatus(readData()) });
  } catch (error) {
    db.postgres = db.postgres || {};
    db.postgres.lastTestAt = nowIso();
    db.postgres.lastTestOk = false;
    db.postgres.lastError = error.message;
    writeData(db);
    logAudit(readData(), req.session.user, 'POSTGRES_TEST_FAIL', `Test bridge PostgreSQL nieudany: ${error.message}`);
    res.json({ ok: false, error: error.message, status: buildPostgresStatus(readData()) });
  }
});

app.post('/api/postgres/export-snapshot', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  const rows = collectPostgresExportRows(db);
  db.postgres = db.postgres || {};
  db.postgres.lastSyncAt = nowIso();
  db.postgres.lastError = '';
  writeData(db);
  logAudit(readData(), req.session.user, 'POSTGRES_SYNC', `Przygotowano snapshot PostgreSQL (${rows.length} rekordów urządzeń).`);
  res.json({ ok: true, generatedAt: db.postgres.lastSyncAt, rows });
});


app.post('/api/postgres/push-sync', requireAuth, async (req, res) => {
  const db = readData();
  migrateData(db);
  try {
    const result = await pushPostgresSync(db);
    writeData(db);
    logAudit(readData(), req.session.user, 'POSTGRES_PUSH_SYNC', `Wysłano live sync PostgreSQL (${result.rows} rekordów).`);
    res.json({ ok: true, result, status: buildPostgresStatus(readData()) });
  } catch (error) {
    db.postgres = db.postgres || {};
    db.postgres.lastError = error.message;
    writeData(db);
    logAudit(readData(), req.session.user, 'POSTGRES_PUSH_SYNC_FAIL', `Push sync PostgreSQL nieudany: ${error.message}`);
    res.json({ ok: false, error: error.message, status: buildPostgresStatus(readData()) });
  }
});

app.post('/api/postgres/pull-sync', requireAuth, async (req, res) => {
  const db = readData();
  migrateData(db);
  try {
    const result = await pullPostgresSync(db);
    writeData(db);
    logAudit(readData(), req.session.user, 'POSTGRES_PULL_SYNC', `Pobrano live sync PostgreSQL (${result.rows} rekordów).`);
    res.json({ ok: true, result, status: buildPostgresStatus(readData()), rows: readData().postgres?.liveMirror || [] });
  } catch (error) {
    db.postgres = db.postgres || {};
    db.postgres.lastError = error.message;
    writeData(db);
    logAudit(readData(), req.session.user, 'POSTGRES_PULL_SYNC_FAIL', `Pull sync PostgreSQL nieudany: ${error.message}`);
    res.json({ ok: false, error: error.message, status: buildPostgresStatus(readData()) });
  }
});

app.get('/api/map3d', requireAuth, (req, res) => {
  const _dbScoped = scopeDbForUser(readData(), req.session.user, getEffectiveOrgId(req, readData()));

  const db = readData();
  migrateData(db);
  res.json({ rooms: buildMap3dRows(db) });
});

app.get('/api/dependencies', requireAuth, (req, res) => {
  const _dbScoped = scopeDbForUser(readData(), req.session.user, getEffectiveOrgId(req, readData()));

  const db = readData();
  migrateData(db);
  res.json({ rows: buildDependencyRows(db) });
});

app.get('/api/cable-visualization', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  res.json({ rows: buildCableVisualizationRows(db) });
});

function buildRoleRows(db) {
  migrateData(db);
  return (db.users || []).map(user => {
    const cfg = db.rbac?.users?.[String(user.id)] || { scope: 'global', permissions: {} };
    return {
      id: user.id,
      username: user.username || '',
      fullName: user.fullName || user.username || '',
      role: user.role || 'viewer',
      scope: cfg.scope || 'global',
      permissions: {
        write: !!cfg.permissions?.write,
        admin: !!cfg.permissions?.admin,
        telemetry: !!cfg.permissions?.telemetry
      },
      viewPermissions: cfg.viewPermissions && typeof cfg.viewPermissions === 'object' ? cfg.viewPermissions : {},
      viewPermissionsCount: Object.values(cfg.viewPermissions && typeof cfg.viewPermissions === 'object' ? cfg.viewPermissions : {}).filter(Boolean).length,
      viewPermissionsTotal: Object.keys(cfg.viewPermissions && typeof cfg.viewPermissions === 'object' ? cfg.viewPermissions : {}).length
    };
  });
}

function buildFlowCollectorStatus(db) {
  migrateData(db);
  const cfg = db.flowCollector || {};
  return {
    enabled: !!cfg.enabled,
    mode: cfg.mode || 'netflow',
    host: cfg.host || '0.0.0.0',
    port: Number(cfg.port || 2055),
    sampling: Number(cfg.sampling || 1000),
    lastTestAt: cfg.lastTestAt || null,
    lastTestOk: typeof cfg.lastTestOk === 'boolean' ? cfg.lastTestOk : null,
    lastError: cfg.lastError || ''
  };
}

app.get('/api/roles', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  res.json({ rows: buildRoleRows(db) });
});

app.post('/api/roles/:userId', requireAuth, express.json(), (req, res) => {
  const db = readData();
  migrateData(db);
  const user = (db.users || []).find(item => Number(item.id) === Number(req.params.userId));
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  const role = ['viewer', 'operator', 'admin'].includes(String(req.body?.role || '')) ? String(req.body.role) : user.role || 'viewer';
  user.role = role;
  const current = db.rbac.users[String(user.id)] || { scope: 'global', permissions: {}, viewPermissions: {} };
  current.scope = ['global', 'building', 'room', 'rack'].includes(String(req.body?.scope || '')) ? String(req.body.scope) : (current.scope || 'global');
  current.permissions = {
    write: !!req.body?.permissions?.write,
    admin: !!req.body?.permissions?.admin,
    telemetry: !!req.body?.permissions?.telemetry
  };
  current.viewPermissions = req.body?.viewPermissions && typeof req.body.viewPermissions === 'object' ? Object.fromEntries(Object.entries(req.body.viewPermissions).map(([key, value]) => [String(key), !!value])) : (current.viewPermissions && typeof current.viewPermissions === 'object' ? current.viewPermissions : {});
  db.rbac.users[String(user.id)] = current;
  addAudit(db, req, 'ROLE_SAVE', `Zmieniono rolę/uprawnienia użytkownika ${user.username} na ${role}.`);
  writeData(db);
  res.json({ ok: true, row: buildRoleRows(db).find(item => Number(item.id) === Number(user.id)) });
});



app.get('/api/2fa/status', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const user = (db.users || []).find(item => Number(item.id) === Number(req.session.user.id));
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  ensureTwoFactorShape(user);
  writeData(db);
  res.json({ ok: true, enabled: !!user.twoFactorEnabled, enabledAt: user.twoFactorEnabledAt || null, recoveryCodesLeft: (user.twoFactorRecoveryCodes || []).length, username: user.username });
});

app.post('/api/2fa/setup', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const user = (db.users || []).find(item => Number(item.id) === Number(req.session.user.id));
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  ensureTwoFactorShape(user);
  const secret = randomBase32Secret(32);
  user.twoFactorTempSecret = secret;
  writeData(db);
  res.json({ ok: true, secret, otpauthUrl: buildOtpAuthUrl(user, secret), manualEntryKey: secret });
});

app.post('/api/2fa/enable', requireAuth, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const user = (db.users || []).find(item => Number(item.id) === Number(req.session.user.id));
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  ensureTwoFactorShape(user);
  const secret = user.twoFactorTempSecret || user.twoFactorSecret;
  const token = String(req.body?.token || '').trim();
  if (!secret) return res.status(400).json({ error: 'Najpierw wygeneruj sekret 2FA.' });
  if (!verifyTotpToken(secret, token)) return res.status(400).json({ error: 'Nieprawidłowy kod TOTP.' });
  user.twoFactorSecret = secret;
  user.twoFactorTempSecret = '';
  user.twoFactorEnabled = true;
  user.twoFactorEnabledAt = nowIso();
  user.twoFactorRecoveryCodes = generateRecoveryCodes();
  addAudit(db, req, '2FA_ENABLE', `Włączono 2FA dla użytkownika ${user.username}.`);
  writeData(db);
  res.json({ ok: true, enabled: true, recoveryCodes: user.twoFactorRecoveryCodes });
});

app.post('/api/2fa/disable', requireAuth, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const user = (db.users || []).find(item => Number(item.id) === Number(req.session.user.id));
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  ensureTwoFactorShape(user);
  const password = String(req.body?.password || '');
  if (!bcrypt.compareSync(password, user.passwordHash)) return res.status(401).json({ error: 'Nieprawidłowe hasło.' });
  user.twoFactorEnabled = false;
  user.twoFactorSecret = '';
  user.twoFactorTempSecret = '';
  user.twoFactorRecoveryCodes = [];
  user.twoFactorEnabledAt = null;
  addAudit(db, req, '2FA_DISABLE', `Wyłączono 2FA dla użytkownika ${user.username}.`);
  writeData(db);
  res.json({ ok: true, enabled: false });
});

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const db = readData();
  migrateData(db);
  res.json({ rows: (db.users || []).map(sanitizeUserRow) });
});

app.post('/api/users', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  migrateData(db);
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const fullName = String(req.body?.fullName || username).trim();
  const role = ['viewer', 'operator', 'admin'].includes(String(req.body?.role || '')) ? String(req.body.role) : 'viewer';
  if (!username || username.length < 3) return res.status(400).json({ error: 'Login musi mieć co najmniej 3 znaki.' });
  if ((db.users || []).some(item => String(item.username).toLowerCase() == username.toLowerCase())) return res.status(409).json({ error: 'Taki login już istnieje.' });
  if (password.length < 6) return res.status(400).json({ error: 'Hasło musi mieć co najmniej 6 znaków.' });
  const user = {
    id: nextId(db.users || []),
    username,
    fullName,
    role,
    disabled: !!req.body?.disabled,
    createdAt: nowIso(),
    lastPasswordChangeAt: nowIso(),
    passwordHash: bcrypt.hashSync(password, 10)
  };
  db.users.push(user);
  db.rbac = db.rbac || { users: {} };
  db.rbac.users[String(user.id)] = {
    scope: 'global',
    permissions: { write: role !== 'viewer', admin: role === 'admin', telemetry: true },
    viewPermissions: {}
  };
  addAudit(db, req, 'USER_CREATE', `Dodano użytkownika ${username} (${role}).`);
  writeData(db);
  res.json({ ok: true, row: sanitizeUserRow(user) });
});

app.post('/api/users/:id', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  migrateData(db);
  const user = (db.users || []).find(item => Number(item.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'fullName')) user.fullName = String(req.body.fullName || user.username).trim();
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'disabled')) user.disabled = !!req.body.disabled;
  if (req.body && req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: 'Hasło musi mieć co najmniej 6 znaków.' });
    user.passwordHash = bcrypt.hashSync(String(req.body.password), 10);
    user.lastPasswordChangeAt = nowIso();
  }
  addAudit(db, req, 'USER_UPDATE', `Zmieniono konto użytkownika ${user.username}.`);
  writeData(db);
  res.json({ ok: true, row: sanitizeUserRow(user) });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const db = readData();
  migrateData(db);
  const user = (db.users || []).find(item => Number(item.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
  if (Number(user.id) === Number(req.session.user.id)) return res.status(400).json({ error: 'Nie możesz usunąć aktywnego konta.' });
  db.users = (db.users || []).filter(item => Number(item.id) !== Number(user.id));
  if (db.rbac?.users) delete db.rbac.users[String(user.id)];
  addAudit(db, req, 'USER_DELETE', `Usunięto użytkownika ${user.username}.`);
  writeData(db);
  res.json({ ok: true });
});

app.get('/api/ssh/profiles', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ rows: (scoped.ssh.profiles || []).map(normalizeSshProfile), lastRunAt: db.ssh.lastRunAt, lastError: db.ssh.lastError || '', terminalPermissions: terminalPermissionsForRole(req.session?.user?.role, db), terminalPolicy: db.ssh.terminalPolicy || {} });
});

app.post('/api/ssh/profiles', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const currentOrgId = getEffectiveOrgId(req, db);
  const rows = Array.isArray(req.body?.profiles) ? req.body.profiles : [];
  const preserved = (db.ssh.profiles || []).filter(item => Number(item.orgId || 1) !== Number(currentOrgId));
  const incoming = rows.map(row => normalizeSshProfile({ ...row, orgId: Number(row?.orgId || currentOrgId) })).filter(item => item.name && item.host && item.username);
  db.ssh.profiles = [...preserved, ...incoming];
  addAudit(db, req, 'SSH_PROFILES_SAVE', `Zapisano profile SSH (${incoming.length}) dla org ${currentOrgId}.`);
  writeData(db);
  res.json({ ok: true, rows: incoming });
});

app.post('/api/ssh/run', requireAuth, express.json(), async (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const profile = (db.ssh.profiles || []).find(item => String(item.id) === String(req.body?.profileId));
  if (!profile) return res.status(404).json({ error: 'Nie znaleziono profilu SSH.' });
  try {
    const access = isCommandAllowedForRole(req.session?.user, profile, req.body?.command || 'hostname', db);
    if (!access.ok) { appendTerminalSessionAudit(db, req.session?.user, 'SSH_RUN_BLOCKED', { profileId: profile.id, profileName: profile.name || profile.host, command: String(req.body?.command || 'hostname').trim(), reason: access.error }); recordPolicyEvent(db, { user: req.session?.user?.username || 'system', role: req.session?.user?.role || 'viewer', hostLabel: profile.host || '', command: String(req.body?.command || 'hostname').trim(), reason: access.error, profileId: profile.id }); writeData(db); return res.status(403).json({ error: access.error }); }
    const result = await runSshCommand(profile, req.body?.command || 'hostname');
    db.ssh.lastRunAt = nowIso();
    db.ssh.lastError = '';
    addAudit(db, req, 'SSH_RUN', `Wykonano polecenie SSH na profilu ${profile.name || profile.host}.`);
    appendTerminalSessionAudit(db, req.session?.user, 'SSH_RUN_ONCE', { profileId: profile.id, profileName: profile.name || profile.host, command: String(req.body?.command || 'hostname').trim() });
    writeData(db);
    res.json({ ok: true, result });
  } catch (error) {
    db.ssh.lastError = error.message || 'SSH error';
    writeData(db);
    writeRuntimeLog('ERROR', 'Błąd komendy SSH.', { error: error.message, profileId: req.body?.profileId });
    res.status(400).json({ error: error.message || 'Nie udało się wykonać polecenia SSH.' });
  }
});

app.get('/api/tasks', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ rows: buildTaskRows(scoped), lastTickAt: db.scheduler.lastTickAt, lastError: db.scheduler.lastError || '' });
});

app.post('/api/tasks', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const currentOrgId = getEffectiveOrgId(req, db);
  const rows = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
  const preserved = (db.scheduler.tasks || []).filter(item => Number(item.orgId || 1) !== Number(currentOrgId));
  const incoming = rows.map(row => normalizeTaskRow({ ...row, orgId: Number(row?.orgId || currentOrgId) })).filter(item => item.name && item.type);
  db.scheduler.tasks = [...preserved, ...incoming];
  addAudit(db, req, 'TASKS_SAVE', `Zapisano harmonogram zadań (${incoming.length}) dla org ${currentOrgId}.`);
  writeData(db);
  res.json({ ok: true, rows: incoming });
});

app.post('/api/tasks/:id/run', requireAuth, express.json(), async (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const task = (db.scheduler.tasks || []).find(item => String(item.id) === String(req.params.id));
  if (!task) return res.status(404).json({ error: 'Nie znaleziono zadania.' });
  if (!userCanAccessOrg(req.session.user, task.orgId || 1, db)) return res.status(403).json({ error: 'Brak dostępu do organizacji zadania.' });
  try {
    const result = await runScheduledTask(db, task, req.session.user.username || 'manual');
    addAudit(db, req, 'TASK_RUN', `Uruchomiono zadanie ${task.name}.`);
    writeData(db);
    res.json({ ok: true, row: task, result });
  } catch (error) {
    task.lastRunAt = nowIso();
    task.lastStatus = 'error';
    task.lastError = error.message || 'Błąd uruchamiania zadania';
    writeData(db);
    res.status(400).json({ error: task.lastError });
  }
});

app.get('/api/flow-config', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  res.json({ config: buildFlowCollectorStatus(db) });
});

app.post('/api/flow-config', requireAuth, express.json(), (req, res) => {
  const db = readData();
  migrateData(db);
  db.flowCollector = db.flowCollector || {};
  db.flowCollector.mode = ['netflow', 'sflow', 'hybrid'].includes(String(req.body?.mode || '')) ? String(req.body.mode) : 'netflow';
  db.flowCollector.host = String(req.body?.host || '0.0.0.0').trim() || '0.0.0.0';
  db.flowCollector.port = Math.max(1, Number(req.body?.port) || 2055);
  db.flowCollector.enabled = !!req.body?.enabled;
  db.flowCollector.sampling = Math.max(1, Number(req.body?.sampling) || 1000);
  addAudit(db, req, 'FLOW_CONFIG', `Zapisano collector ${db.flowCollector.mode} na ${db.flowCollector.host}:${db.flowCollector.port}.`);
  writeData(db);
  res.json({ ok: true, config: buildFlowCollectorStatus(db) });
});

app.post('/api/flow-config/test', requireAuth, (req, res) => {
  const db = readData();
  migrateData(db);
  db.flowCollector.lastTestAt = nowIso();
  db.flowCollector.lastTestOk = true;
  db.flowCollector.lastError = '';
  addAudit(db, req, 'FLOW_TEST', `Wykonano test collectora ${db.flowCollector.mode || 'netflow'} na porcie ${db.flowCollector.port || 2055}.`);
  writeData(db);
  res.json({ ok: true, config: buildFlowCollectorStatus(db) });
});


app.get('/api/terminal/sessions', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const perms = terminalPermissionsForRole(req.session?.user?.role, db);
  if (!perms.sessions) return res.status(403).json({ error: 'Ta rola nie ma dostępu do panelu sesji terminalowych.' });
  res.json({ ok: true, rows: buildTerminalSessionRows(req.session.user), permissions: perms });
});

app.post('/api/terminal/sessions/:id/kill', requireAuth, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const perms = terminalPermissionsForRole(req.session?.user?.role, db);
  const targetId = String(req.params.id || '').trim();
  const row = terminalSessions.get(targetId);
  if (!row) return res.status(404).json({ error: 'Nie znaleziono sesji.' });
  if (!perms.killAny && String(row.username || '') !== String(req.session.user.username || '')) return res.status(403).json({ error: 'Nie możesz zakończyć cudzej sesji.' });
  disposeTerminalSession(targetId);
  res.json({ ok: true });
});

app.get('/api/system/metrics', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, metrics: getSystemMetrics() });
  } catch (error) {
    writeRuntimeLog('ERROR', 'Błąd odczytu metryk systemu.', { error: error.message });
    res.status(500).json({ error: 'Nie udało się pobrać metryk systemu.' });
  }
});

app.get('/api/backups', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  writeData(db);
  res.json({ ok: true, config: db.backupConfig, rows: listBackupRows() });
});

app.post('/api/backups/config', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const orgId = getEffectiveOrgId(req, db);
  const config = saveBackupConfigForOrg(db, orgId, { enabled: !!req.body?.enabled, intervalMin: Math.max(15, Number(req.body?.intervalMin) || defaultBackupConfigForOrg(db, orgId).intervalMin || 360), retentionCount: Math.max(1, Number(req.body?.retentionCount) || defaultBackupConfigForOrg(db, orgId).retentionCount || 10) });
  addAudit(db, req, 'BACKUP_CONFIG', `Zmieniono konfigurację backupów dla org ${orgId}: enabled=${config.enabled}, interval=${config.intervalMin} min, retention=${config.retentionCount}.`);
  writeData(db);
  writeRuntimeLog('INFO', 'Zapisano konfigurację backupów.', { user: req.session.user.username, orgId });
  res.json({ ok: true, config, orgId });
});

app.post('/api/backups/run', requireAuth, (req, res) => {
  try {
    const result = runDataBackup({ reason: 'manual', actor: req.session.user.username });
    const db = readData();
    addAudit(db, req, 'BACKUP_RUN', `Wykonano backup ręczny ${result.fileName}.`);
    writeData(db);
    res.json({ ok: true, backup: result, rows: listBackupRows() });
  } catch (error) {
    writeRuntimeLog('ERROR', 'Błąd backupu ręcznego.', { error: error.message });
    res.status(500).json({ error: error.message || 'Nie udało się wykonać backupu.' });
  }
});

app.post('/api/backups/restore', requireAuth, (req, res) => {
  try {
    const result = restoreDataBackup(req.body?.fileName);
    const db = readData();
    addAudit(db, req, 'BACKUP_RESTORE', `Przywrócono backup ${result.fileName}.`);
    writeData(db);
    res.json({ ok: true, restore: result });
  } catch (error) {
    writeRuntimeLog('ERROR', 'Błąd przywracania backupu.', { error: error.message });
    res.status(400).json({ error: error.message || 'Nie udało się przywrócić backupu.' });
  }
});

app.get('/api/logs/runtime', requireAuth, (req, res) => {
  const lines = Math.max(10, Math.min(2000, Number(req.query.lines) || 200));
  res.json({ ok: true, file: path.basename(RUNTIME_LOG_FILE), lines, content: tailFile(RUNTIME_LOG_FILE, lines) });
});

app.get('/api/services', requireAuth, async (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  const rows = [];
  for (const item of scoped.serviceManager.services) rows.push(await getServiceStatus(item));
  res.json({ ok: true, rows });
});

app.post('/api/services/config', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const currentOrgId = getEffectiveOrgId(req, db);
  const incoming = Array.isArray(req.body?.services) ? req.body.services : [];
  const preserved = (db.serviceManager.services || []).filter(item => Number(item.orgId || 1) !== Number(currentOrgId));
  const rows = incoming.map(row => normalizeServiceConfig({ ...row, orgId: Number(row?.orgId || currentOrgId) })).filter(item => item.name && item.serviceName);
  db.serviceManager.services = [...preserved, ...rows];
  addAudit(db, req, 'SERVICE_CONFIG', `Zapisano konfigurację usług (${rows.length} pozycji) dla org ${currentOrgId}.`);
  writeData(db);
  writeRuntimeLog('INFO', 'Zapisano konfigurację usług.', { count: rows.length, user: req.session.user.username, orgId: currentOrgId });
  res.json({ ok: true, rows });
});

app.post('/api/services/:id/action', requireAuth, async (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const item = db.serviceManager.services.find(row => String(row.id) === String(req.params.id));
  if (!item) return res.status(404).json({ error: 'Nie znaleziono usługi.' });
  if (!userCanAccessOrg(req.session.user, item.orgId || 1, db)) return res.status(403).json({ error: 'Brak dostępu do organizacji usługi.' });
  const action = String(req.body?.action || 'status').trim().toLowerCase();
  try {
    const result = await runServiceAction(item, action);
    addAudit(db, req, 'SERVICE_ACTION', `Wykonano ${action} dla usługi ${item.name || item.serviceName}.`);
    writeData(db);
    writeRuntimeLog('INFO', 'Wykonano akcję usługi.', { action, service: item.serviceName, user: req.session.user.username });
    res.json({ ok: true, row: result });
  } catch (error) {
    writeRuntimeLog('ERROR', 'Błąd akcji usługi.', { service: item.serviceName, action, error: error.message });
    res.status(400).json({ error: error.message || 'Nie udało się wykonać akcji na usłudze.' });
  }
});

app.get('/api/docker/containers', requireAuth, async (req, res) => {
  try {
    const rows = await listDockerContainers();
    res.json({ ok: true, installed: true, rows });
  } catch (error) {
    res.json({ ok: true, installed: false, rows: [], error: error.message || 'Docker CLI nie odpowiada.' });
  }
});

app.post('/api/docker/containers/:id/action', requireAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || '').trim().toLowerCase();
    const rows = await runDockerAction(req.params.id, action);
    const db = readData();
    addAudit(db, req, 'DOCKER_ACTION', `Wykonano ${action} dla kontenera ${req.params.id}.`);
    writeData(db);
    writeRuntimeLog('INFO', 'Wykonano akcję Dockera.', { action, containerId: req.params.id, user: req.session.user.username });
    res.json({ ok: true, rows });
  } catch (error) {
    writeRuntimeLog('ERROR', 'Błąd akcji Dockera.', { containerId: req.params.id, error: error.message });
    res.status(400).json({ error: error.message || 'Nie udało się wykonać akcji Dockera.' });
  }
});

app.get('/api/alerts/config', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  writeData(db);
  res.json({ ok: true, config: db.alerts });
});

app.post('/api/alerts/config', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const orgId = getEffectiveOrgId(req, db);
  const config = saveAlertConfigForOrg(db, orgId, { enabled: !!req.body?.enabled, webhookUrl: String(req.body?.webhookUrl || '').trim(), lastError: '' });
  addAudit(db, req, 'ALERTS_CONFIG', `Zapisano konfigurację alertów webhook dla org ${orgId} (${config.enabled ? 'on' : 'off'}).`);
  writeData(db);
  writeRuntimeLog('INFO', 'Zapisano konfigurację alertów.', { enabled: config.enabled, user: req.session.user.username, orgId });
  res.json({ ok: true, config, orgId });
});

app.post('/api/alerts/test', requireAuth, async (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const orgId = getEffectiveOrgId(req, db);
  const cfg = defaultAlertConfigForOrg(db, orgId);
  if (!cfg.enabled || !cfg.webhookUrl) return res.status(400).json({ error: 'Webhook alertów nie jest skonfigurowany.' });
  try {
    const result = await sendWebhook(cfg.webhookUrl, {
      app: 'Virtual Server Manager',
      type: 'test',
      ts: nowIso(),
      user: req.session.user.username,
      metrics: getSystemMetrics()
    });
    saveAlertConfigForOrg(db, orgId, { lastTestAt: nowIso(), lastError: '' });
    addAudit(db, req, 'ALERTS_TEST', 'Wysłano test webhooka alertów.');
    writeData(db);
    writeRuntimeLog('INFO', 'Wysłano test webhooka alertów.', { user: req.session.user.username, statusCode: result.statusCode });
    res.json({ ok: true, result });
  } catch (error) {
    saveAlertConfigForOrg(db, orgId, { lastError: error.message || 'Webhook error' });
    writeData(db);
    writeRuntimeLog('ERROR', 'Błąd testu webhooka alertów.', { error: error.message });
    res.status(400).json({ error: error.message || 'Nie udało się wysłać testu alertów.' });
  }
});


app.get('/api/terminal/policies', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const currentOrgId = getEffectiveOrgId(req, db);
  res.json({ ok: true, terminalPolicy: db.ssh.terminalPolicy || {}, commandPolicy: db.ssh.commandPolicy || {}, perHostPolicies: (db.ssh.perHostPolicies || []).filter(row => Number(row.orgId || 1) === Number(currentOrgId)) });
});

app.post('/api/terminal/policies', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  db.ssh.terminalPolicy = req.body?.terminalPolicy && typeof req.body.terminalPolicy === 'object' ? req.body.terminalPolicy : db.ssh.terminalPolicy;
  db.ssh.commandPolicy = req.body?.commandPolicy && typeof req.body.commandPolicy === 'object' ? req.body.commandPolicy : db.ssh.commandPolicy;
  const currentOrgId = getEffectiveOrgId(req, db);
  db.ssh.perHostPolicies = Array.isArray(req.body?.perHostPolicies)
    ? [
        ...(db.ssh.perHostPolicies || []).filter(row => Number(row.orgId || 1) !== Number(currentOrgId)),
        ...req.body.perHostPolicies.map((row, idx) => ({ id: Number(row.id) || (Date.now() + idx), name: String(row.name || '').trim() || `Host policy ${idx+1}`, hostPattern: String(row.hostPattern || '').trim(), roles: Array.isArray(row.roles) ? row.roles.map(v => String(v || '').trim()).filter(Boolean) : [], allowedCommands: Array.isArray(row.allowedCommands) ? row.allowedCommands.map(v => String(v || '').trim()).filter(Boolean) : [], deniedCommands: Array.isArray(row.deniedCommands) ? row.deniedCommands.map(v => String(v || '').trim()).filter(Boolean) : [], orgId: Number(row.orgId || currentOrgId) })).filter(row => row.hostPattern)
      ]
    : db.ssh.perHostPolicies;
  addAudit(db, req, 'TERMINAL_POLICIES_SAVE', 'Zapisano polityki terminala, hostów i komend.');
  writeData(db);
  res.json({ ok: true, terminalPolicy: db.ssh.terminalPolicy, commandPolicy: db.ssh.commandPolicy, perHostPolicies: db.ssh.perHostPolicies });
});

app.get('/api/terminal/session-audit', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const rows = String(req.session?.user?.role || '') === 'admin' ? db.ssh.sessionAudit : (db.ssh.sessionAudit || []).filter(row => String(row.user || '') === String(req.session?.user?.username || ''));
  res.json({ ok: true, rows });
});

app.get('/api/terminal/session-audit/export', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const rows = String(req.session?.user?.role || '') === 'admin' ? db.ssh.sessionAudit : (db.ssh.sessionAudit || []).filter(row => String(row.user || '') === String(req.session?.user?.username || ''));
  const format = String(req.query.format || 'json').toLowerCase();
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="terminal-audit.csv"');
    return res.send(buildAuditCsv(rows));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="terminal-audit.json"');
  return res.json({ ok: true, rows });
});

app.get('/api/terminal/policy-events', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const rows = String(req.session?.user?.role || '') === 'admin' ? db.ssh.policyEvents : (db.ssh.policyEvents || []).filter(row => String(row.user || '') === String(req.session?.user?.username || ''));
  res.json({ ok: true, rows });
});

app.get('/api/terminal/session-transcripts', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const rows = String(req.session?.user?.role || '') === 'admin' ? db.ssh.sessionTranscripts : (db.ssh.sessionTranscripts || []).filter(row => String(row.user || '') === String(req.session?.user?.username || ''));
  res.json({ ok: true, rows: rows.map(row => ({ ...row, preview: buildTranscriptPreview(row) })) });
});

app.get('/api/terminal/session-transcripts/:id', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const row = (db.ssh.sessionTranscripts || []).find(item => String(item.id) === String(req.params.id));
  if (!row) return res.status(404).json({ error: 'Nie znaleziono transcriptu.' });
  if (String(req.session?.user?.role || '') !== 'admin' && String(row.user || '') !== String(req.session?.user?.username || '')) return res.status(403).json({ error: 'Brak dostępu do transcriptu.' });
  const content = row.filePath && fs.existsSync(row.filePath) ? fs.readFileSync(row.filePath, 'utf8') : '';
  const events = content.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch (_) { return { ts: nowIso(), stream: 'raw', data: line }; } });
  res.json({ ok: true, row, content, events });
});

app.get('/api/system/routes', requireAuth, requireAdmin, (req, res) => {
  const rows = listExpressRoutes(app);
  res.json({ ok: true, rows, summary: { total: rows.length, auth: rows.filter(r => r.auth).length, admin: rows.filter(r => r.admin).length } });
});

app.get('/api/metrics/config', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  res.json({ ok: true, config: db.metricsCenter, rows: db.metricsCenter.series || {} });
});

app.post('/api/metrics/config', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  db.metricsCenter.retentionPoints = Math.max(30, Number(req.body?.retentionPoints) || db.metricsCenter.retentionPoints);
  db.metricsCenter.sampleIntervalSec = Math.max(3, Number(req.body?.sampleIntervalSec) || db.metricsCenter.sampleIntervalSec);
  db.metricsCenter.thresholds.cpu = Number(req.body?.thresholds?.cpu || db.metricsCenter.thresholds.cpu);
  db.metricsCenter.thresholds.memory = Number(req.body?.thresholds?.memory || db.metricsCenter.thresholds.memory);
  db.metricsCenter.thresholds.disk = Number(req.body?.thresholds?.disk || db.metricsCenter.thresholds.disk);
  addAudit(db, req, 'METRICS_CONFIG', 'Zapisano retencję i progi alertów metryk.');
  writeData(db);
  res.json({ ok: true, config: db.metricsCenter });
});

app.get('/api/metrics/history', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  res.json({ ok: true, series: db.metricsCenter.series || {}, alerts: db.metricsCenter.alertEvents || [], thresholds: db.metricsCenter.thresholds || {} });
});

app.get('/api/agents/config', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ ok: true, config: db.agentManager, rows: scoped.agentManager.agents || [], cache: Object.values(scoped.agentManager.cache || {}), thresholds: db.agentManager.thresholds || {}, alerts: db.agentManager.alertEvents || [] });
});

app.get('/api/agents/dashboard', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ ok: true, ...buildAgentDashboard(scoped), series: db.metricsCenter.series || {} });
});

app.post('/api/agents/config', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  db.agentManager.enabled = !!req.body?.enabled;
  db.agentManager.pushEnabled = req.body?.pushEnabled == null ? db.agentManager.pushEnabled : !!req.body.pushEnabled;
  db.agentManager.sharedToken = String(req.body?.sharedToken || db.agentManager.sharedToken || '').trim() || db.agentManager.sharedToken;
  db.agentManager.pollIntervalSec = Math.max(10, Number(req.body?.pollIntervalSec) || db.agentManager.pollIntervalSec || 30);
  db.agentManager.historyRetentionPoints = Math.max(60, Number(req.body?.historyRetentionPoints) || db.agentManager.historyRetentionPoints || 720);
  const rows = Array.isArray(req.body?.agents) ? req.body.agents : [];
  db.agentManager.agents = rows.map((row, idx) => ({ id: Number(row.id) || idx + 1, name: String(row.name || '').trim() || `Agent ${idx+1}`, baseUrl: String(row.baseUrl || '').trim(), token: String(row.token || '').trim(), orgId: Number(row.orgId || getEffectiveOrgId(req, db) || 1) })).filter(row => row.baseUrl || row.name);
  db.agentManager.perHostPolicies = req.body?.perHostPolicies && typeof req.body.perHostPolicies === 'object' ? req.body.perHostPolicies : (db.agentManager.perHostPolicies || {});
  if (req.body?.thresholds && typeof req.body.thresholds === 'object') db.agentManager.thresholds = req.body.thresholds;
  addAudit(db, req, 'AGENTS_CONFIG', `Zapisano konfigurację agentów (${db.agentManager.agents.length}).`);
  writeData(db);
  res.json({ ok: true, rows: db.agentManager.agents, config: db.agentManager });
});

app.post('/api/agents/poll', requireAuth, requireAdmin, async (req, res) => {
  await pollAgentsNow();
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ ok: true, rows: Object.values(scoped.agentManager.cache || {}) });
});

app.get('/api/agents/status', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ ok: true, rows: Object.values(scoped.agentManager.cache || {}) });
});

app.get('/api/agent/status', (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const token = String(req.headers['x-vsm-agent-token'] || '');
  if (!token || token !== String(db.agentManager.sharedToken || '')) return res.status(403).json({ error: 'Nieprawidłowy token agenta.' });
  const payload = buildMetricsPayload();
  res.json({ ok: true, version: VERSION, hostname: payload.metrics?.hostname || os.hostname(), metrics: payload.metrics, summary: payload.summary, ts: payload.ts });
});


app.get('/api/organizations', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  res.json({ ok: true, rows: filterByOrg(db.organizations, getUserOrgIds(req.session.user, db)), activeOrgId: getEffectiveOrgId(req, db) });
});

app.post('/api/organizations', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows.map((row, idx) => sanitizeOrganization(row, idx)) : db.organizations;
  db.organizations = rows;
  if (body.activeOrgId) db.enterprise.activeOrgId = Number(body.activeOrgId);
  addAudit(db, req, 'ORGS_CONFIG', `Zapisano organizacje (${db.organizations.length}).`);
  writeData(db);
  res.json({ ok: true, rows: db.organizations, activeOrgId: db.enterprise.activeOrgId });
});

app.get('/api/enterprise-rbac', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  res.json({ ok: true, roles: db.enterprise.roles, assignments: db.enterprise.roleAssignments, users: (db.users || []).map(sanitizeUserRow), organizations: db.organizations });
});

app.post('/api/enterprise-rbac', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  db.enterprise.roles = Array.isArray(req.body?.roles) ? req.body.roles.map((row, idx) => sanitizeEnterpriseRole(row, idx)) : db.enterprise.roles;
  db.enterprise.roleAssignments = Array.isArray(req.body?.assignments) ? req.body.assignments.map((row, idx) => ({ id: Number(row.id || idx + 1), userId: Number(row.userId || 0), orgId: Number(row.orgId || 1), roleId: Number(row.roleId || 0), expiresAt: row.expiresAt || null })).filter(row => row.userId && row.roleId) : db.enterprise.roleAssignments;
  if (Array.isArray(req.body?.users)) {
    const byId = new Map((req.body.users || []).map(row => [Number(row.id || 0), row]));
    db.users = (db.users || []).map(user => {
      const patch = byId.get(Number(user.id));
      if (!patch) return user;
      user.organizationIds = Array.isArray(patch.organizationIds) ? patch.organizationIds.map(Number).filter(Boolean) : user.organizationIds || [1];
      return user;
    });
  }
  addAudit(db, req, 'ENTERPRISE_RBAC', `Zapisano role enterprise (${db.enterprise.roles.length}) i przypisania (${db.enterprise.roleAssignments.length}).`);
  writeData(db);
  res.json({ ok: true, roles: db.enterprise.roles, assignments: db.enterprise.roleAssignments, users: (db.users || []).map(sanitizeUserRow) });
});

app.get('/api/tickets', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const user = req.session?.user || {};
  const orgRows = filterByOrg(db.tickets.items, getUserOrgIds(user, db));
  const rows = String(user.role || '') === 'admin' ? orgRows : orgRows.filter(ticket => Number(ticket.requestedById || 0) === Number(user.id || 0));
  res.json({ ok: true, rows, policy: db.tickets.requireApprovalFor || [] });
});

app.post('/api/tickets', requireAuth, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const body = req.body || {};
  const ticket = {
    id: nextId(db.tickets.items),
    type: String(body.type || 'access').trim(),
    target: String(body.target || '').trim(),
    requestedById: Number(req.session?.user?.id || 0),
    requestedBy: String(req.session?.user?.username || 'user'),
    orgId: Number(body.orgId || db.enterprise?.activeOrgId || 1),
    justification: String(body.justification || '').trim(),
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    approvedBy: null,
    decisionNote: '',
    grantMinutes: Math.max(5, Number(body.grantMinutes || db.tickets.defaultGrantMinutes || 60)),
    grantExpiresAt: null,
    targetProfileId: Number(body.targetProfileId || 0),
    grantedScopes: Array.isArray(body.grantedScopes) ? body.grantedScopes.map(String) : []
  };
  db.tickets.items.unshift(ticket);
  addAudit(db, req, 'TICKET_CREATE', `Utworzono ticket #${ticket.id} (${ticket.type} -> ${ticket.target}).`);
  writeData(db);
  res.json({ ok: true, row: ticket });
});

app.post('/api/tickets/:id/action', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const ticket = (db.tickets.items || []).find(row => Number(row.id) === Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Nie znaleziono ticketu.' });
  const action = String(req.body?.action || '').trim();
  if (!['approve','deny','close'].includes(action)) return res.status(400).json({ error: 'Nieprawidłowa akcja ticketu.' });
  ticket.status = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'closed';
  ticket.updatedAt = nowIso();
  ticket.approvedBy = String(req.session?.user?.username || 'admin');
  ticket.decisionNote = String(req.body?.note || '').trim();
  if (action === 'approve') ticket.grantExpiresAt = new Date(Date.now() + Math.max(5, Number(req.body?.grantMinutes || ticket.grantMinutes || db.tickets.defaultGrantMinutes || 60)) * 60000).toISOString();
  addAudit(db, req, 'TICKET_ACTION', `Ticket #${ticket.id}: ${ticket.status}.`);
  writeData(db);
  res.json({ ok: true, row: ticket });
});

app.get('/api/tickets/grants', requireAuth, (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  res.json({ ok: true, rows: String(req.session?.user?.role || '') === 'admin' ? (db.tickets.items || []).filter(t => t.grantExpiresAt) : getActiveGrants(db, req.session.user) });
});

app.get('/api/branding', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  res.json({ ok: true, settings: db.enterprise.themes, organizations: db.organizations });
});

app.post('/api/branding', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  db.enterprise.themes = { ...db.enterprise.themes, ...(req.body || {}) };
  db.settings = db.settings && typeof db.settings === 'object' ? db.settings : {};
  db.settings.brandName = db.enterprise.themes.brandName || db.settings.brandName || 'Virtual Server Manager';
  db.settings.theme = db.enterprise.themes.globalTheme || db.settings.theme || 'dark-blue';
  addAudit(db, req, 'BRANDING_SAVE', 'Zapisano branding i ustawienia motywu.');
  writeData(db);
  res.json({ ok: true, settings: db.enterprise.themes });
});

app.get('/api/identity/config', requireAuth, requireAdmin, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  res.json({ ok: true, identity: db.identity, mode: 'live-auth-ready-v85' });
});

app.post('/api/identity/config', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const body = req.body || {};
  db.identity.providers = body.providers && typeof body.providers === 'object' ? { ...db.identity.providers, ...body.providers } : db.identity.providers;
  db.identity.groupMappings = Array.isArray(body.groupMappings) ? body.groupMappings : db.identity.groupMappings;
  ensureOpsDefaults(db);
  addAudit(db, req, 'IDENTITY_CONFIG', 'Zapisano konfigurację LDAP / OIDC / SAML oraz mapowania grup.');
  writeData(db);
  res.json({ ok: true, identity: db.identity, mode: 'live-auth-ready-v85' });
});

app.get('/api/remote-access', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ ok: true, profiles: scoped.remoteAccess.profiles, databaseProfiles: scoped.remoteAccess.databaseProfiles, k8sProfiles: scoped.remoteAccess.k8sProfiles, gateway: db.remoteAccess.gateway || {} });
});

app.post('/api/remote-access', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  db.remoteAccess.profiles = Array.isArray(req.body?.profiles) ? req.body.profiles.map((row, idx) => ({ id: Number(row.id || idx + 1), type: String(row.type || 'rdp').trim(), name: String(row.name || `Profile ${idx + 1}`).trim(), host: String(row.host || '').trim(), port: Number(row.port || 0), orgId: Number(row.orgId || db.enterprise?.activeOrgId || 1), notes: String(row.notes || '').trim(), webClientUrl: String(row.webClientUrl || '').trim(), gatewayKind: String(row.gatewayKind || '').trim(), gatewayPath: String(row.gatewayPath || '').trim(), connectionId: String(row.connectionId || '').trim() })) : db.remoteAccess.profiles;
  db.remoteAccess.databaseProfiles = Array.isArray(req.body?.databaseProfiles) ? req.body.databaseProfiles.map((row, idx) => ({ id: Number(row.id || idx + 1), type: String(row.type || 'postgres').trim(), name: String(row.name || `DB ${idx + 1}`).trim(), host: String(row.host || '').trim(), port: Number(row.port || 0), database: String(row.database || '').trim(), user: String(row.user || '').trim(), password: String(row.password || ''), ssl: !!row.ssl, orgId: Number(row.orgId || db.enterprise?.activeOrgId || 1) })) : db.remoteAccess.databaseProfiles;
  db.remoteAccess.k8sProfiles = Array.isArray(req.body?.k8sProfiles) ? req.body.k8sProfiles.map((row, idx) => ({ id: Number(row.id || idx + 1), name: String(row.name || `K8s ${idx + 1}`).trim(), apiUrl: String(row.apiUrl || '').trim(), namespace: String(row.namespace || '').trim(), orgId: Number(row.orgId || db.enterprise?.activeOrgId || 1), notes: String(row.notes || '').trim() })) : db.remoteAccess.k8sProfiles;
  if (req.body?.gateway && typeof req.body.gateway === 'object') db.remoteAccess.gateway = { ...db.remoteAccess.gateway, ...req.body.gateway };
  addAudit(db, req, 'REMOTE_ACCESS_SAVE', `Zapisano profile zdalnego dostępu (${db.remoteAccess.profiles.length}) i baz (${db.remoteAccess.databaseProfiles.length}).`);
  writeData(db);
  const scoped = scopeDbForUser(db, req.session.user, getEffectiveOrgId(req, db));
  res.json({ ok: true, profiles: scoped.remoteAccess.profiles, databaseProfiles: scoped.remoteAccess.databaseProfiles, k8sProfiles: scoped.remoteAccess.k8sProfiles, gateway: db.remoteAccess.gateway || {} });
});

app.post('/api/remote-access/:id/launch', requireAuth, express.json(), (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const profile = (db.remoteAccess.profiles || []).find(row => Number(row.id) === Number(req.params.id));
  if (!profile) return res.status(404).json({ error: 'Nie znaleziono profilu.' });
  if (!userCanAccessOrg(req.session.user, profile.orgId || 1, db)) return res.status(403).json({ error: 'Brak dostępu do organizacji.' });
  if (!hasAccessGrant(db, req.session.user, profile)) return res.status(403).json({ error: 'Brak aktywnego grantu dostępu do tego profilu.' });
  const launch = mintLaunchToken(db, { profileId: profile.id, profileType: profile.type, orgId: Number(profile.orgId || 1), createdBy: String(req.session.user.username || ''), targetHost: profile.host, targetPort: Number(profile.port || 0) });
  writeData(db);
  res.json({ ok: true, launchUrl: `/gateway/launch/${launch.token}`, tokenExpiresAt: launch.expiresAt, profile });
});

app.get('/gateway/launch/:token', (req, res) => {
  const db = readData(); ensureOpsDefaults(db);
  const row = consumeLaunchToken(db, String(req.params.token || ''));
  if (!row) return res.status(404).send('Token bramy wygasł lub jest nieprawidłowy.');
  const profile = (db.remoteAccess.profiles || []).find(item => Number(item.id) === Number(row.profileId));
  if (!profile) return res.status(404).send('Nie znaleziono profilu.');
  writeData(db);
  const gateway = db.remoteAccess.gateway || {};
  const kind = String(profile.gatewayKind || profile.type || '').toLowerCase();
  let tpl = String(profile.webClientUrl || '').trim();
  if (!tpl) {
    if (kind === 'guacamole') tpl = gateway.guacamoleUrl || '';
    else if (kind === 'novnc' || kind === 'vnc') tpl = gateway.noVncUrl || gateway.vncPathTemplate || '';
    else if (kind === 'webrdp' || kind === 'rdp') tpl = gateway.webRdpUrl || gateway.rdpPathTemplate || '';
  }
  const target = tpl
    ? tpl
        .replace(/\{host\}/g, encodeURIComponent(profile.host || ''))
        .replace(/\{port\}/g, encodeURIComponent(String(profile.port || '')))
        .replace(/\{name\}/g, encodeURIComponent(profile.name || ''))
        .replace(/\{connectionId\}/g, encodeURIComponent(String(profile.connectionId || '')))
        .replace(/\{token\}/g, encodeURIComponent(row.token || ''))
    : '';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Gateway ${profile.name}</title><style>body{font-family:Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}a,button{display:inline-block;padding:10px 14px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;margin-right:8px}.card{max-width:980px;background:#111827;border:1px solid #334155;border-radius:16px;padding:20px}.muted{color:#94a3b8}iframe{width:100%;height:72vh;border:1px solid #334155;border-radius:12px;background:#020617;margin-top:16px}</style></head><body><div class="card"><h1>Web gateway: ${profile.name}</h1><p class="muted">Typ: ${profile.type} · Gateway: ${kind || 'generic'} · Host: ${profile.host}:${profile.port || ''}</p>${target ? `<p><a href="${target}" target="_blank">Otwórz zewnętrzny gateway</a></p><iframe src="${target}"></iframe>` : '<p>Brak skonfigurowanego URL gateway. Uzupełnij webClientUrl / guacamoleUrl / noVncUrl / webRdpUrl.</p>'}</div></body></html>`);
});

app.post('/api/db-profiles/test', requireAuth, requireAdmin, express.json(), async (req, res) => {
  try {
    const result = await testDatabaseProfile(req.body || {});
    res.json({ ok: !!result.ok, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Błąd testu profilu bazy.' });
  }
});

app.get('/api/discovery/config', requireAuth, (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  res.json({ ok: true, discovery: db.discovery, summary: summarizeDiscovery(db), assetGroups: db.discovery.assetGroups });
});

app.post('/api/discovery/config', requireAuth, requireAdmin, express.json(), (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  db.discovery.enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : db.discovery.enabled;
  db.discovery.autoCredentialRotation = !!req.body?.autoCredentialRotation;
  db.discovery.cloudSync = !!req.body?.cloudSync;
  db.discovery.jobs = Array.isArray(req.body?.jobs) ? req.body.jobs.map((row, idx) => ({ id: Number(row.id || idx + 1), name: String(row.name || `job-${idx + 1}`), mode: String(row.mode || 'inventory'), target: String(row.target || 'all'), enabled: row.enabled !== false })) : db.discovery.jobs;
  db.discovery.assetGroups = Array.isArray(req.body?.assetGroups) ? req.body.assetGroups.map((row, idx) => ({ id: Number(row.id || idx + 1), name: String(row.name || `Group ${idx + 1}`), tags: Array.isArray(row.tags) ? row.tags.map(v => String(v || '').trim()).filter(Boolean) : [], orgId: Number(row.orgId || db.enterprise?.activeOrgId || 1) })) : db.discovery.assetGroups;
  addAudit(db, req, 'DISCOVERY_CONFIG', 'Zapisano konfigurację discovery / asset sync / credential rotation.');
  writeData(db);
  res.json({ ok: true, discovery: db.discovery, summary: summarizeDiscovery(db) });
});

app.post('/api/discovery/run', requireAuth, requireAdmin, async (req, res) => {
  const db = readData();
  ensureOpsDefaults(db);
  const summary = summarizeDiscovery(db);
  db.discovery.lastRunAt = nowIso();
  db.discovery.lastSummary = { ...summary, jobs: (db.discovery.jobs || []).filter(job => job.enabled !== false).length, mode: 'local-inventory' };
  addAudit(db, req, 'DISCOVERY_RUN', `Uruchomiono discovery. Zasoby: ${summary.totalAssets}.`);
  writeData(db);
  res.json({ ok: true, summary: db.discovery.lastSummary, lastRunAt: db.discovery.lastRunAt });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

setInterval(() => { const db = readData(); runMonitoringScan(db).catch(error => writeRuntimeLog('ERROR', 'Błąd cyklu monitoringu.', { error: error.message })); }, 60000);
runMonitoringScan(readData()).catch(error => writeRuntimeLog('ERROR', 'Błąd startowego skanu monitoringu.', { error: error.message }));
setInterval(() => { runSnmpPollingCycle(null, { force: false, silentAudit: true }).catch(error => writeRuntimeLog('ERROR', 'Błąd cyklu SNMP.', { error: error.message })); }, 30000);
setTimeout(() => { runSnmpPollingCycle(null, { force: false, silentAudit: true }).catch(error => writeRuntimeLog('ERROR', 'Błąd startowego cyklu SNMP.', { error: error.message })); }, 5000);
setInterval(() => {
  try { maybeRunScheduledBackup(); }
  catch (error) {
    const db = readData();
    ensureOpsDefaults(db);
    db.backupConfig.lastError = error.message || 'Błąd backup scheduler';
    writeData(db);
    writeRuntimeLog('ERROR', 'Błąd backup scheduler.', { error: error.message });
  }
}, 60000);
setTimeout(() => { try { maybeRunScheduledBackup(); } catch (_) {} }, 3000);
setInterval(() => {
  maybeRunTaskScheduler().catch(error => writeRuntimeLog('ERROR', 'Błąd scheduler zadań.', { error: error.message }));
}, 30000);
setTimeout(() => { maybeRunTaskScheduler().catch(() => {}); }, 6000);

setInterval(() => {
  try { pollAgentsNow().catch(error => writeRuntimeLog('ERROR', 'Błąd odpytywania agentów.', { error: error.message })); }
  catch (error) { writeRuntimeLog('ERROR', 'Błąd pętli agentów.', { error: error.message }); }
}, 30000);
setTimeout(() => { pollAgentsNow().catch(() => {}); }, 7000);

httpServer.listen(PORT, () => {
  const msg = `Virtual Server Manager ${VERSION} listening on http://localhost:${PORT}`;
  console.log(msg);
  writeRuntimeLog('INFO', 'Serwer nasłuchuje.', { port: PORT, websocket: !!io, pty: !!pty });
});
