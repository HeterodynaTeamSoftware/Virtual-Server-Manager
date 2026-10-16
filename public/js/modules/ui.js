(function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderTopology(container, payload, options = {}) {
    if (!container) return;
    const width = Math.max(container.clientWidth || 920, 920);
    const height = Math.max(container.clientHeight || 470, 470);
    const nodes = payload?.nodes || [];
    const edges = payload?.edges || [];

    if (!nodes.length) {
      container.innerHTML = '<div class="device-inspector-empty">Brak urządzeń do narysowania topologii.</div>';
      return;
    }

    const edgeMarkup = edges.map(edge => {
      const source = nodes.find(node => node.nodeId === edge.source);
      const target = nodes.find(node => node.nodeId === edge.target);
      if (!source || !target) return '';
      const midX = (source.x + target.x) / 2;
      const midY = (source.y + target.y) / 2;
      return `
        <g class="topology-edge" data-edge-id="${escapeHtml(edge.id)}">
          <line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="${edge.color}" stroke-width="3" stroke-linecap="round"></line>
          <text x="${midX}" y="${midY - 8}" text-anchor="middle" class="topology-edge-label">P${escapeHtml(edge.sourcePort)} → P${escapeHtml(edge.targetPort)}</text>
        </g>`;
    }).join('');

    const nodeMarkup = nodes.map(node => `
      <g class="topology-node" data-device-id="${escapeHtml(node.id)}" tabindex="0">
        <rect x="${node.x - 92}" y="${node.y - 32}" rx="16" ry="16" width="184" height="64"></rect>
        <text x="${node.x}" y="${node.y - 6}" text-anchor="middle" class="topology-node-title">${escapeHtml(node.label)}</text>
        <text x="${node.x}" y="${node.y + 15}" text-anchor="middle" class="topology-node-subtitle">${escapeHtml(node.vendor)} · ${escapeHtml(node.type)}</text>
      </g>`).join('');

    container.innerHTML = `
      <svg class="topology-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Topologia urządzeń w racku">
        <defs>
          <filter id="topologyShadow"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#020617" flood-opacity="0.35"/></filter>
        </defs>
        <rect class="topology-backdrop" x="12" y="12" width="${width - 24}" height="${height - 24}" rx="24" ry="24"></rect>
        <g filter="url(#topologyShadow)">${edgeMarkup}${nodeMarkup}</g>
      </svg>`;

    container.querySelectorAll('.topology-node').forEach(nodeEl => {
      const handler = () => options.onSelect?.(Number(nodeEl.dataset.deviceId));
      nodeEl.addEventListener('click', handler);
      nodeEl.addEventListener('keydown', evt => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          handler();
        }
      });
    });
  }

  window.DCIMModules?.register('dcim-ui', {
    version: '0.27.0',
    description: 'Widoki pomocnicze UI wydzielone pod moduły.',
    renderTopology
  });
})();
