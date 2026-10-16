/*
Nazwa programu: Virtual Server Manager
Producent: Heterodyna Team Software
Wersja softu: v65
Programista: Adrian Podłucki
Tester app/network: Grześ :)
*/

const SWITCH_FACEPLATE_LIBRARY = {
  vendors: {
    "Cisco": { models: ["Catalyst 2960X 24TS-L","Catalyst 2960X 48TS-L","Catalyst 3560X 24T","Catalyst 3560X 48T","Catalyst 3650 24TS","Catalyst 3650 48TS","Catalyst 3850 24T","Catalyst 3850 48T","Catalyst 9200 24T","Catalyst 9200 48T","Catalyst 9300 24T","Catalyst 9300 48T","Catalyst 9300L 24T-4G","Catalyst 9300L 48T-4G"] },
    "Aruba": { models: ["2530 24G","2530 48G","2540 24G","2540 48G","2930F 24G","2930F 48G","3810M 24G","3810M 48G","CX 6100 24G","CX 6100 48G","CX 6200F 24G","CX 6200F 48G"] },
    "Juniper": { models: ["EX2200 24T","EX2200 48T","EX2300 24T","EX2300 48T","EX3400 24T","EX3400 48T","EX4100 24P","EX4100 48P","EX4300 24T","EX4300 48T"] },
    "MikroTik": { models: ["CRS326-24G-2S+","CRS328-24P-4S+","CRS354-48G-4S+2Q+","CRS354-48P-4S+2Q+","CSS326-24G-2S+","CRS518-16XS-2XQ"] },
    "Ubiquiti": { models: ["UniFi Switch 24","UniFi Switch 48","USW 24 PoE","USW 48 PoE","USW Pro 24","USW Pro 48","Enterprise 24 PoE","Enterprise 48 PoE"] },
    "HPE / OfficeConnect": { models: ["OfficeConnect 1920S 24G","OfficeConnect 1920S 48G","OfficeConnect 1950 24G","OfficeConnect 1950 48G","Aruba 2530 24G","Aruba 2530 48G"] },
    "Dell EMC": { models: ["N1524","N1548","N2024","N2048","N3048","N3248","S3048-ON","S4128F-ON"] },
    "TP-Link": { models: ["TL-SG3428","TL-SG3452","TL-SX3008F","TL-SG3428XMP"] },
    "Netgear": { models: ["GS724T","GS748T","M4300-24X","M4300-48X"] },
    "Inne / Generic": { models: ["Generic 8-port","Generic 16-port","Generic 24-port","Generic 48-port"] }
  }
};
function getVendorCatalog() { return SWITCH_FACEPLATE_LIBRARY.vendors; }
function inferPortCount(device = {}) {
  const explicit = Number(device.ports?.length || 0);
  if (explicit) return explicit;
  const source = `${device.type || ''} ${device.model || ''}`;
  if (/48/i.test(source)) return 48;
  if (/24/i.test(source)) return 24;
  return /switch/i.test(source) ? 24 : 0;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function vendorTone(vendor='') {
  if (/cisco/i.test(vendor)) return {accent:'#2dd4bf', text:'#d5fff8'};
  if (/aruba|hpe/i.test(vendor)) return {accent:'#38bdf8', text:'#dbeafe'};
  if (/juniper/i.test(vendor)) return {accent:'#22c55e', text:'#eaffef'};
  if (/mikrotik/i.test(vendor)) return {accent:'#f59e0b', text:'#fff4d6'};
  if (/ubiquiti|unifi/i.test(vendor)) return {accent:'#60a5fa', text:'#e0f2fe'};
  if (/dell/i.test(vendor)) return {accent:'#a78bfa', text:'#f3e8ff'};
  return {accent:'#64748b', text:'#e5eefc'};
}
function renderSwitchFaceplateSvg(device={}, opts={}) {
  const ports = device.ports || Array.from({length: inferPortCount(device)}).map((_,i)=>({portNumber:i+1,status:'down'}));
  const width = opts.width || 860; const height = opts.height || 150;
  const vendor = device.vendor || 'Inne / Generic'; const model = device.model || device.type || 'Generic switch';
  const tone = vendorTone(vendor); const padding = 24; const sfpCount = ports.length >= 48 ? 4 : 2;
  const leftLabelWidth = 150; const rightBlockWidth = 118; const portsRegionX = padding + leftLabelWidth; const portsRegionY = 44;
  const portsRegionWidth = width - padding*2 - leftLabelWidth - rightBlockWidth;
  const cols = ports.length > 24 ? 24 : Math.max(ports.length,1); const rows = ports.length > 24 ? 2 : 1; const gap = 6;
  const portW = Math.max(14, Math.floor((portsRegionWidth - gap*(cols-1))/cols)); const portH = rows === 2 ? 26 : 34;
  const portBlocks = ports.map((port, idx) => {
    const row = rows === 2 ? Math.floor(idx / cols) : 0; const col = rows === 2 ? idx % cols : idx;
    const x = portsRegionX + col * (portW + gap); const y = portsRegionY + row * (portH + 10);
    const fill = port.connectedTo ? (port.cableColor || tone.accent) : (port.status === 'up' ? '#22c55e' : '#334155');
    return `
      <rect x="${x}" y="${y}" rx="3" ry="3" width="${portW}" height="${portH}" fill="#0f172a" stroke="#475569" stroke-width="1.2"/>
      <rect x="${x+2}" y="${y+3}" rx="2" ry="2" width="${Math.max(8,portW-4)}" height="${Math.max(10,portH-10)}" fill="${fill}" opacity="0.92"/>
      <text x="${x + portW/2}" y="${y + portH - 4}" font-size="9" text-anchor="middle" fill="#dbeafe">${port.portNumber}</text>`;
  }).join('');
  const sfpBlocks = Array.from({length: sfpCount}).map((_, idx) => {
    const x = width - padding - rightBlockWidth + 18 + (idx%2)*34; const y = 52 + Math.floor(idx/2)*34;
    return `<rect x="${x}" y="${y}" width="24" height="18" rx="2" fill="#111827" stroke="${tone.accent}" stroke-width="1.1"/><rect x="${x+3}" y="${y+4}" width="18" height="8" rx="1" fill="#0ea5e9" opacity="0.65"/>`;
  }).join('');
  return `
  <svg class="switch-faceplate-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(vendor)} ${escapeHtml(model)}">
    <defs>
      <linearGradient id="panelBg" x1="0" x2="1"><stop offset="0%" stop-color="#131b2e"/><stop offset="50%" stop-color="#1f2937"/><stop offset="100%" stop-color="#111827"/></linearGradient>
      <linearGradient id="brandGlow" x1="0" x2="1"><stop offset="0%" stop-color="${tone.accent}" stop-opacity="0.85"/><stop offset="100%" stop-color="#1e293b" stop-opacity="0.2"/></linearGradient>
    </defs>
    <rect x="4" y="8" width="${width-8}" height="${height-16}" rx="16" fill="url(#panelBg)" stroke="#4b5563" stroke-width="2"/>
    <rect x="10" y="14" width="${width-20}" height="${height-28}" rx="14" fill="transparent" stroke="rgba(255,255,255,0.07)"/>
    <rect x="${padding}" y="${padding}" width="${leftLabelWidth-20}" height="${height-48}" rx="12" fill="url(#brandGlow)" opacity="0.55"/>
    <circle cx="${padding+18}" cy="${padding+20}" r="7" fill="#22c55e"/>
    <circle cx="${padding+18}" cy="${padding+42}" r="7" fill="#f59e0b" opacity="0.7"/>
    <text x="${padding+38}" y="${padding+26}" font-size="15" font-weight="700" fill="${tone.text}">${escapeHtml(vendor)}</text>
    <text x="${padding+38}" y="${padding+49}" font-size="13" fill="#cbd5e1">${escapeHtml(model)}</text>
    <text x="${padding+38}" y="${padding+70}" font-size="11" fill="#94a3b8">${ports.length}x RJ45 · szablon wizualny</text>
    ${portBlocks}
    <text x="${width - padding - rightBlockWidth + 20}" y="36" font-size="11" fill="#94a3b8">Uplink / SFP</text>
    ${sfpBlocks}
  </svg>`;
}
window.SWITCH_FACEPLATE_LIBRARY = SWITCH_FACEPLATE_LIBRARY;
window.getVendorCatalog = getVendorCatalog;
window.renderSwitchFaceplateSvg = renderSwitchFaceplateSvg;
window.inferPortCount = inferPortCount;


function getPortLayout(device={}, opts={}) {
  const width = opts.width || 860; const height = opts.height || 150;
  const ports = device.ports || Array.from({length: inferPortCount(device)}).map((_,i)=>({portNumber:i+1,status:"down"}));
  const leftLabelWidth = 150; const rightBlockWidth = 118; const padding = 24;
  const portsRegionX = padding + leftLabelWidth; const portsRegionY = 44;
  const portsRegionWidth = width - padding*2 - leftLabelWidth - rightBlockWidth;
  const cols = ports.length > 24 ? 24 : Math.max(ports.length,1); const rows = ports.length > 24 ? 2 : 1; const gap = 6;
  const portW = Math.max(14, Math.floor((portsRegionWidth - gap*(cols-1))/cols)); const portH = rows === 2 ? 26 : 34;
  return ports.map((port, idx) => {
    const row = rows === 2 ? Math.floor(idx / cols) : 0; const col = rows === 2 ? idx % cols : idx;
    const x = portsRegionX + col * (portW + gap); const y = portsRegionY + row * (portH + 10);
    return { portNumber: port.portNumber, x, y, width: portW, height: portH };
  });
}
window.getPortLayout = getPortLayout;
