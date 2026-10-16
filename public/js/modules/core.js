(function () {
  const registry = {
    modules: {},
    register(name, api) { this.modules[name] = api || {}; },
    get(name) { return this.modules[name] || null; },
    list() { return Object.keys(this.modules); }
  };
  window.DCIMModules = registry;
  registry.register('dcim-core', {
    version: '0.27.0',
    description: 'Warstwa bazowa: stan aplikacji, helpery UI i rejestr modułów.'
  });
})();
