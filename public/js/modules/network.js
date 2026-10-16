(function () {
  function normalizeNodeId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  }

  function colorForConnection(row) {
    const speed = String(row?.port?.speed || row?.meta?.speed || '').toLowerCase();
    const status = String(row?.port?.status || '').toLowerCase();
    if (status === 'error') return '#ef4444';
    if (speed.includes('10g')) return '#38bdf8';
    if (speed.includes('1g')) return '#facc15';
    if (status === 'up') return '#22c55e';
    return '#64748b';
  }

  function buildRackTopologyPayload(devices, connectionRows, filters = {}) {
    const nodes = (devices || []).map((device, index) => ({
      id: Number(device.id),
      nodeId: `device-${normalizeNodeId(device.id)}`,
      label: device.label || `Urządzenie ${index + 1}`,
      type: device.type || 'device',
      vendor: device.vendor || 'Generic',
      model: device.model || '',
      startU: Number(device.startU || 0),
      sizeU: Number(device.sizeU || 1),
      x: 0,
      y: 0
    }));

    const nodeMap = new Map(nodes.map(node => [Number(node.id), node]));
    const edges = [];
    (connectionRows || []).forEach((row, index) => {
      const source = nodeMap.get(Number(row.device?.id));
      const target = nodeMap.get(Number(row.connectedTo?.deviceId));
      if (!source || !target) return;
      const vlan = String(row.port?.vlan || row.connectedTo?.vlan || '').trim();
      if (filters.vlan && vlan && vlan !== String(filters.vlan).trim()) return;
      if (filters.activeOnly && String(row.port?.status || '').toLowerCase() !== 'up') return;
      const medium = String(row.meta?.medium || '').toLowerCase();
      if (filters.medium && medium && medium !== String(filters.medium).toLowerCase()) return;
      edges.push({
        id: `edge-${index}-${source.id}-${target.id}`,
        source: source.nodeId,
        target: target.nodeId,
        sourceDeviceId: source.id,
        targetDeviceId: target.id,
        sourcePort: Number(row.port?.portNumber || 0),
        targetPort: Number(row.connectedTo?.portNumber || 0),
        label: row.meta?.cableLabel || row.meta?.routeName || '',
        color: colorForConnection(row),
        status: row.port?.status || 'down',
        speed: row.port?.speed || row.meta?.speed || '',
        vlan,
        medium: row.meta?.medium || ''
      });
    });

    const switchNodes = nodes.filter(node => /switch/i.test(node.type));
    const otherNodes = nodes.filter(node => !/switch/i.test(node.type));
    const ordered = [...switchNodes, ...otherNodes];
    const centerX = 520;
    const centerY = 230;
    const radiusX = 280;
    const radiusY = 145;

    ordered.forEach((node, index) => {
      if (index === 0 && switchNodes.length) {
        node.x = centerX;
        node.y = centerY;
        return;
      }
      const orbitIndex = switchNodes.length ? index - 1 : index;
      const orbitSize = Math.max(1, ordered.length - (switchNodes.length ? 1 : 0));
      const angle = ((Math.PI * 2) / orbitSize) * orbitIndex - Math.PI / 2;
      node.x = centerX + Math.cos(angle) * radiusX;
      node.y = centerY + Math.sin(angle) * radiusY;
    });

    return { nodes, edges };
  }

  window.DCIMModules?.register('dcim-network', {
    version: '0.27.0',
    description: 'Topologia 2D i helpery połączeń.',
    buildRackTopologyPayload,
    colorForConnection
  });
})();
