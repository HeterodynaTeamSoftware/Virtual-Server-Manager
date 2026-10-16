(function () {
  const actionMap = {
    LOGIN: 'Logowanie', LOGOUT: 'Wylogowanie', ROOM_CREATE: 'Dodanie serwerowni', ROOM_UPDATE: 'Edycja serwerowni', ROOM_DELETE: 'Usunięcie serwerowni',
    DEVICE_CREATE: 'Dodanie urządzenia', DEVICE_UPDATE: 'Edycja urządzenia', DEVICE_DELETE: 'Usunięcie urządzenia',
    PORT_UPDATE: 'Edycja portu', PORT_THRESHOLD_UPDATE: 'Progi portu', CONNECTION_CREATE: 'Nowe połączenie', CONNECTION_DELETE: 'Usunięcie połączenia',
    POWER_UPDATE: 'Zasilanie A/B', MONITOR_ACK: 'Ack monitoringu', MONITOR_CONFIG: 'Konfiguracja monitoringu', DATA_IMPORT: 'Import danych',
    CABLE_ROUTE_CREATE: 'Dodanie trasy', CABLE_ROUTE_DELETE: 'Usunięcie trasy', INIT: 'Inicjalizacja'
  };
  const entityMap = {
    room: 'Serwerownia', device: 'Urządzenie', port: 'Port', connection: 'Połączenie', monitoring: 'Monitoring', power: 'Zasilanie', route: 'Trasa', data: 'Dane', system: 'System'
  };

  function formatAction(action) { return actionMap[action] || action || '-'; }
  function getEntityLabel(item) {
    const type = item?.entityType || 'system';
    return entityMap[type] || type;
  }

  window.DCIMModules?.register('dcim-audit', {
    version: '0.29.0',
    description: 'Moduł audytu i historii zmian z filtrowaniem.',
    formatAction,
    getEntityLabel
  });
})();
