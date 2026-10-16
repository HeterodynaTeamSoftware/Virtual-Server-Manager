-- DCIM / Rack Manager v17
-- Start migracji pod PostgreSQL

CREATE TABLE IF NOT EXISTS dcim_users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role_name TEXT NOT NULL,
  full_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dcim_server_rooms (
  id INTEGER PRIMARY KEY,
  building TEXT NOT NULL,
  room_number TEXT NOT NULL,
  room_type TEXT NOT NULL,
  note TEXT,
  width_m NUMERIC,
  depth_m NUMERIC,
  height_m NUMERIC
);

CREATE TABLE IF NOT EXISTS dcim_racks (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES dcim_server_rooms(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  model TEXT,
  size_u INTEGER,
  rack_type TEXT,
  row_number INTEGER,
  position_in_row INTEGER
);

CREATE TABLE IF NOT EXISTS dcim_devices (
  id INTEGER NOT NULL,
  room_id INTEGER NOT NULL REFERENCES dcim_server_rooms(id) ON DELETE CASCADE,
  rack_id INTEGER NOT NULL REFERENCES dcim_racks(id) ON DELETE CASCADE,
  side_name TEXT NOT NULL,
  label TEXT NOT NULL,
  device_type TEXT NOT NULL,
  vendor_name TEXT,
  model_name TEXT,
  start_u INTEGER,
  size_u INTEGER,
  mgmt_ip TEXT,
  mgmt_vlan TEXT,
  PRIMARY KEY (id, room_id, rack_id, side_name)
);

CREATE TABLE IF NOT EXISTS dcim_ports (
  room_id INTEGER NOT NULL,
  rack_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  side_name TEXT NOT NULL,
  port_number INTEGER NOT NULL,
  oper_status TEXT,
  ip TEXT,
  vlan TEXT,
  subnet TEXT,
  mask TEXT,
  gateway TEXT,
  target TEXT,
  cable_color TEXT,
  PRIMARY KEY (room_id, rack_id, device_id, side_name, port_number)
);
