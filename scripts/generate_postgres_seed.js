const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const input = path.join(root, 'data', 'storage.json');
const output = path.join(root, 'sql', 'dcim-postgres-seed-generated.sql');

function q(value) {
  if (value === null || typeof value === 'undefined') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const db = JSON.parse(fs.readFileSync(input, 'utf8'));
const lines = ['BEGIN;'];

for (const user of db.users || []) {
  lines.push(`INSERT INTO dcim_users (id, username, password_hash, role_name, full_name) VALUES (${Number(user.id)}, ${q(user.username)}, ${q(user.passwordHash)}, ${q(user.role)}, ${q(user.fullName)});`);
}
for (const room of db.serverRooms || []) {
  lines.push(`INSERT INTO dcim_server_rooms (id, building, room_number, room_type, note, width_m, depth_m, height_m) VALUES (${Number(room.id)}, ${q(room.building)}, ${q(room.roomNumber)}, ${q(room.roomType)}, ${q(room.note || '')}, ${Number(room.dimensions?.width || 0)}, ${Number(room.dimensions?.depth || 0)}, ${Number(room.dimensions?.height || 0)});`);
  for (const rack of room.racks || []) {
    lines.push(`INSERT INTO dcim_racks (id, room_id, label, model, size_u, rack_type, row_number, position_in_row) VALUES (${Number(rack.id)}, ${Number(room.id)}, ${q(rack.label)}, ${q(rack.model || '')}, ${Number(rack.sizeU || 0)}, ${q(rack.type || '')}, ${Number(rack.rowNumber || 0)}, ${Number(rack.positionInRow || 0)});`);
    for (const sideName of ['frontDevices', 'rearDevices']) {
      for (const device of rack[sideName] || []) {
        lines.push(`INSERT INTO dcim_devices (id, room_id, rack_id, side_name, label, device_type, vendor_name, model_name, start_u, size_u, mgmt_ip, mgmt_vlan) VALUES (${Number(device.id)}, ${Number(room.id)}, ${Number(rack.id)}, ${q(sideName === 'frontDevices' ? 'front' : 'rear')}, ${q(device.label)}, ${q(device.type)}, ${q(device.vendor || '')}, ${q(device.model || '')}, ${Number(device.startU || 0)}, ${Number(device.sizeU || 0)}, ${q(device.network?.ip || '')}, ${q(device.network?.vlan || '')});`);
        for (const port of device.ports || []) {
          lines.push(`INSERT INTO dcim_ports (room_id, rack_id, device_id, side_name, port_number, oper_status, ip, vlan, subnet, mask, gateway, target, cable_color) VALUES (${Number(room.id)}, ${Number(rack.id)}, ${Number(device.id)}, ${q(sideName === 'frontDevices' ? 'front' : 'rear')}, ${Number(port.portNumber || 0)}, ${q(port.liveStatus || port.status || '')}, ${q(port.ip || '')}, ${q(port.vlan || '')}, ${q(port.subnet || '')}, ${q(port.mask || '')}, ${q(port.gateway || '')}, ${q(port.target || '')}, ${q(port.cableColor || '')});`);
        }
      }
    }
  }
}

lines.push('COMMIT;');
fs.writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`Wygenerowano: ${output}`);
