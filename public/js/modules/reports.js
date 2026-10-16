(function () {
  function buildRackReportPayload(state) {
    const room = (state.serverRooms || []).find(item => Number(item.id) === Number(state.currentRoomId));
    const rack = room?.racks?.find(item => Number(item.id) === Number(state.currentRackId));
    if (!room || !rack) return null;
    return {
      exportedAt: new Date().toISOString(),
      room: {
        id: room.id,
        building: room.building,
        roomNumber: room.roomNumber,
        roomType: room.roomType
      },
      rack: {
        id: rack.id,
        label: rack.label,
        model: rack.model,
        sizeU: rack.sizeU,
        type: rack.type,
        rowNumber: rack.rowNumber,
        positionInRow: rack.positionInRow
      },
      frontDevices: rack.frontDevices || [],
      rearDevices: rack.rearDevices || []
    };
  }

  function downloadJson(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  window.DCIMModules?.register('dcim-reports', {
    version: '0.28.0',
    description: 'Raporty techniczne i eksport JSON dla bieżącego racka.',
    buildRackReportPayload,
    downloadJson
  });
})();
